import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,copyFile,mkdir,open,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {EditorError} from './errors.mjs';
import {boundTextPaths,worldGeometry} from './geometry.mjs';
import {layoutOf,normalizeRow,placedByLayout} from './layout.mjs';

const MAX_SIDE=4096;
const MAX_PAGE_NODES=64;
const MAX_PAGE_BYTES=32*1024;

function renderError(code,message,details) {
	return new EditorError(code,message,details);
}

function assertOptions(document,dir) {
	if (!document
		||typeof document.info!=='function'
		||typeof document.readModel!=='function'
		||typeof document.withEngine!=='function'
		||typeof document.onCommit!=='function') {
		throw renderError('RENDER_OPTIONS_INVALID','document does not implement the renderer contract');
	}
	if (typeof dir!=='string'||dir.length===0) {
		throw renderError('RENDER_OPTIONS_INVALID','dir must be a nonempty string');
	}
}

function safeFrameId(id) {
	return typeof id==='string'
		&&id.length>0
		&&!/[\\/:\u0000-\u001f]/.test(id)
		&&!id.includes('..');
}

function stableHash(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scaleFor(bounds,maxSide) {
	const largest=Math.max(bounds.width,bounds.height);
	if (!Number.isFinite(largest)||largest<=0) {
		throw renderError('RENDER_BOUNDS_INVALID','Frame must have positive finite bounds',{frame_id:bounds.id});
	}
	const scale=Math.min(1,MAX_SIDE/largest,maxSide/largest);
	const quantized=Math.floor(scale*1000000)/1000000;
	if (!Number.isFinite(quantized)||quantized<=0) {
		throw renderError('RENDER_SCALE_INVALID','Calculated render scale is invalid',{frame_id:bounds.id});
	}
	return quantized;
}

function scaleKey(scale) {
	return scale.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
}

function currentRevision(document) {
	return document.info().revision;
}

function normalizeRows(value) {
	if (!value||!Array.isArray(value.rows)) {
		throw renderError('RENDER_PROTOCOL','Engine returned invalid render metadata');
	}
	return value.rows.map(row=>{
		if (!row||typeof row.path!=='string'||typeof row.type!=='string') {
			throw renderError('RENDER_PROTOCOL','Engine returned an invalid metadata row');
		}
		return normalizeRow(row);
	});
}

function groupRows(rows,frameIds) {
	const byPath=new Map(rows.map(row=>[row.path,row]));
	const groups=new Map([...frameIds].map(id=>[id,[]]));
	for (const row of rows) {
		let root=row;
		const seen=new Set();
		while (root.parent_path!==null&&root.parent_path!==undefined) {
			if (seen.has(root.path)) {
				throw renderError('RENDER_PROTOCOL','Engine metadata ancestry is cyclic');
			}
			seen.add(root.path);
			root=byPath.get(root.parent_path);
			if (!root) break;
		}
		const group=root&&groups.get(root.path);
		if (group) group.push(row);
	}
	return groups;
}

/** The longest text of a node the board takes as a label to edit; a longer one is left to the panel fields. */
const MAX_BOARD_TEXT=1000;

/** The rows of one frame as the window sees them, with what the document lets the board change: the position of an element
 * no auto-layout places (`placedByLayout`), whether a direct child an auto-layout places can be dropped elsewhere among
 * its siblings (`reorderable`), each size that is a fixed number in the schema (not fit, fill or a variable) and, of a
 * text node outside any instance, its text and font size (what the board offers as the label to edit). */
export function projectionRows(rows,frameId) {
	const byPath=new Map(rows.map(row=>[row.path,row]));
	return rows.map(row=>{
		const ancestors=[];
		const seen=new Set([row.path]);
		let parentPath=row.parent_path;
		while (parentPath!==null&&parentPath!==undefined) {
			if (seen.has(parentPath)) throw renderError('RENDER_PROTOCOL','Projection ancestry is cyclic');
			seen.add(parentPath);
			const parent=byPath.get(parentPath);
			if (!parent) throw renderError('RENDER_PROTOCOL','Projection ancestry is incomplete');
			ancestors.unshift(parent);
			parentPath=parent.parent_path;
		}
		const parent=ancestors.at(-1);
		return {
			path:row.path,
			parent_path:row.parent_path,
			type:row.type,
			layout:layoutOf(row),
			geometry:worldGeometry(row,ancestors),
			movable:parent!==undefined&&!placedByLayout(parent,row),
			reorderable:parent!==undefined&&placedByLayout(parent,row)&&!row.path.includes('/'),
			resizable:{width:typeof row.schema?.width==='number',height:typeof row.schema?.height==='number'},
			frame_id:frameId,
			...(row.type==='text'&&!row.text_bound&&!row.path.includes('/')&&typeof row.schema?.content==='string'&&row.schema.content.length<=MAX_BOARD_TEXT
				? {text:row.schema.content,...(typeof row.schema.fontSize==='number' ? {font_size:row.schema.fontSize} : {})} : {}),
		};
	});
}

// The layout is reported raw: `normalizeRow` names the default (layout.mjs).
function metadataBody() {
	return `const rows=Get((n,c)=>{
 const {children,...schema}=n;
 const b=c.bounds;
 return {path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,type:n.type,
  layout:typeof n.layout==='string'?n.layout:null,layout_position:n.layoutPosition,enabled:n.enabled,
  x:b.x,y:b.y,width:b.width,height:b.height,
  visible:n.visible,opacity:n.opacity,clip:n.clip,rotation:n.rotation,transform:n.transform,
  scaleX:n.scaleX,scaleY:n.scaleY,schema};
},{resolveVariables:true,resolveInstances:true});
return {rows};`;
}

function exportBody(ids,dir,scale) {
	return `Export(${JSON.stringify(ids)},'png',${JSON.stringify(dir)},{scale:${scale}});`+
		`return {ids:${JSON.stringify(ids)}};`;
}

async function requireFile(path,frameId) {
	try {
		await access(path);
	} catch (cause) {
		throw renderError('RENDER_MISSING','Engine did not produce the requested PNG',{frame_id:frameId,cause});
	}
}

function pngSize(bytes,frameId) {
	if (bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') {
		throw renderError('RENDER_INVALID_PNG','Engine produced an invalid PNG',{frame_id:frameId});
	}
	return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

async function validateCachedImage(image,frameId) {
	let handle;
	try {
		const metadata=await stat(image.path);
		if (metadata.size!==image.bytes) {
			throw renderError('RENDER_MISSING','Current rendered PNG has an invalid size',{frame_id:frameId});
		}
		handle=await open(image.path,'r');
		const header=Buffer.alloc(8);
		const {bytesRead}=await handle.read(header,0,header.length,0);
		if (bytesRead!==header.length||header.toString('hex')!=='89504e470d0a1a0a') {
			throw renderError('RENDER_MISSING','Current rendered PNG has an invalid header',{frame_id:frameId});
		}
	} catch (cause) {
		if (cause?.code==='RENDER_MISSING') throw cause;
		throw renderError('RENDER_MISSING','Current rendered PNG is missing',{frame_id:frameId,cause});
	} finally {
		if (handle) await handle.close();
	}
	return image;
}

class Renderer {
	constructor(document,dir) {
		this.document=document;
		this.dir=dir;
		this.closed=false;
		this.tail=Promise.resolve();
		this.pending=new Map();
		this.frames=new Map();
		this.invalidFrames=new Set();
		this.renderedRevision=null;
		this.refreshingRevision=null;
		this.lastExported=[];
		this.affectedFrameIds=null;
		this.error=null;
		this.ownedOutputs=new Map();
		this.reservedPaths=new Set();
		this.publications=new Set();
		this.closePromise=null;
		this.unsubscribe=document.onCommit(info=>{
			void this.refresh(info.revision).catch(()=>{});
		});
	}

	state() {
		return {
			rendered_revision:this.renderedRevision,
			refreshing_revision:this.refreshingRevision,
			error:this.error ? {...this.error} : null,
			frame_ids:[...this.frames.keys()],
			exported_frame_ids:[...this.lastExported],
			affected_frame_ids:this.affectedFrameIds===null ? null : [...this.affectedFrameIds],
		};
	}

	setError(error) {
		this.error={
			code:typeof error?.code==='string' ? error.code : 'RENDER_FAILED',
			message:error instanceof Error ? error.message : String(error),
		};
	}

	enqueue(fn) {
		const operation=this.tail.then(fn);
		this.tail=operation.then(()=>undefined,()=>undefined);
		return operation;
	}

	async reserveImages(nodes) {
		for (const node of nodes) {
			const path=node.image?.path;
			if (!path||this.reservedPaths.has(path)) continue;
			const image=await open(path,'r+');
			try {
				await image.sync();
			} finally {
				await image.close();
			}
			// The sidecar outlives this renderer; another owner may still have this path on a saved board.
			const reservation=await open(`${path}.published`,'a',0o600);
			try {
				await reservation.sync();
			} finally {
				await reservation.close();
			}
			this.reservedPaths.add(path);
		}
	}

	async cleanOutputs() {
		for (const [path,owned] of this.ownedOutputs) {
			try {
				await access(`${path}.published`);
				continue;
			} catch (error) {
				if (error?.code!=='ENOENT') continue;
			}
			let current;
			try {
				current=await stat(path);
			} catch (error) {
				if (error?.code==='ENOENT') continue;
				throw error;
			}
			if (['dev','ino','size','mtimeMs','ctimeMs'].every(key=>current[key]===owned[key])) {
				await rm(path,{force:true});
			}
		}
		this.ownedOutputs.clear();
	}

	async exportFrames(engine,descriptors,revision,maxSide) {
		const groups=new Map();
		for (const descriptor of descriptors) {
			const scale=scaleFor(descriptor.bounds,maxSide);
			const key=scaleKey(scale);
			if (!groups.has(key)) groups.set(key,{scale,descriptors:[]});
			groups.get(key).descriptors.push(descriptor);
		}
		const images=new Map();
		for (const group of groups.values()) {
			if (this.closed||currentRevision(this.document)!==revision) return {stale:true,images};
			const batchDir=join(this.dir,`.batch-${randomUUID()}`);
			await mkdir(this.dir,{recursive:true});
			await mkdir(batchDir);
			try {
				if (this.closed) return {stale:true,images};
				const ids=group.descriptors.map(descriptor=>descriptor.id);
				const {value}=await engine.exec(exportBody(ids,batchDir,group.scale),{kind:'read'});
				if (this.closed) return {stale:true,images};
				if (!value||!Array.isArray(value.ids)||value.ids.length!==ids.length) {
					throw renderError('RENDER_PROTOCOL','Engine returned invalid export confirmation');
				}
				for (const descriptor of group.descriptors) {
					const temporary=join(batchDir,`${descriptor.id}.png`);
					await requireFile(temporary,descriptor.id);
					const bytes=await readFile(temporary);
					const size=pngSize(bytes,descriptor.id);
					const path=join(this.dir,`${descriptor.key}-${scaleKey(group.scale)}.png`);
					let owned=this.ownedOutputs.has(path);
					try {
						await copyFile(temporary,path,constants.COPYFILE_EXCL);
						owned=true;
					} catch (error) {
						if (error?.code!=='EEXIST') throw error;
						try {
							await validateCachedImage({path,bytes:bytes.length},descriptor.id);
						} catch {
							await copyFile(temporary,path);
						}
					}
					if (owned) this.ownedOutputs.set(path,await stat(path));
					images.set(descriptor.id,{
						path,scale:group.scale,width:size.width,height:size.height,bytes:bytes.length,
					});
				}
			} finally {
				await rm(batchDir,{recursive:true,force:true});
			}
		}
		return {stale:false,images};
	}

	async runRefresh(revision) {
		if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
		if (!Number.isSafeInteger(revision)||revision<0) {
			throw renderError('RENDER_REVISION_INVALID','revision must be a nonnegative safe integer');
		}
		if (this.renderedRevision===revision&&this.invalidFrames.size===0&&!this.error) return this.state();
		if (currentRevision(this.document)!==revision) return this.state();
		this.refreshingRevision=revision;
		this.affectedFrameIds=null;
		this.error=null;
		try {
			const model=await this.document.readModel();
			if (this.closed||currentRevision(this.document)!==revision) return this.state();
			const rootRows=new Map(model.rows.map(row=>[row.path,row]));
			const roots=model.roots.filter(root=>root&&root.type==='frame');
			const frameIds=new Set();
			const bounds=new Map();
			for (const root of roots) {
				if (!safeFrameId(root.id)) {
					throw renderError('RENDER_FRAME_ID','Frame ID cannot be used for an official export',{frame_id:root.id});
				}
				const row=rootRows.get(root.id);
				if (!row) throw renderError('RENDER_PROTOCOL','Top-level frame has no resolved bounds',{frame_id:root.id});
				frameIds.add(root.id);
				bounds.set(root.id,{
					id:root.id,x:row.x,y:row.y,width:row.width,height:row.height,
				});
			}
			const result=await this.document.withEngine(revision,async engine=>{
				const metadata=normalizeRows((await engine.exec(metadataBody(),{kind:'measure'})).value);
				// The metadata is read with variables resolved: which texts are bound comes from the unresolved model.
				const bound=boundTextPaths(model);
				for (const row of metadata) if (bound.has(row.path)) row.text_bound=true;
				if (this.closed||currentRevision(this.document)!==revision) return {stale:true};
				const groups=groupRows(metadata,frameIds);
				const nextFrames=new Map();
				const dirty=[];
				for (const id of frameIds) {
					const rows=groups.get(id);
					const content=rows.map(row=>({
						path:row.path,parent_path:row.parent_path,type:row.type,schema:row.schema,
					}));
					const key=stableHash(content);
					const previous=this.frames.get(id);
					const descriptor={id,key,bounds:bounds.get(id),rows};
					let reusable=previous
						&&previous.key===key
						&&previous.images.size>0
						&&!this.invalidFrames.has(id);
					if (reusable) {
						for (const image of previous.images.values()) {
							try {
								await validateCachedImage(image,id);
							} catch {
								reusable=false;
								break;
							}
						}
					}
					if (reusable) {
						nextFrames.set(id,{...descriptor,images:new Map(previous.images)});
					} else {
						nextFrames.set(id,{...descriptor,images:new Map()});
						dirty.push(descriptor);
					}
				}
				if (this.closed||currentRevision(this.document)!==revision) return {stale:true};
				this.affectedFrameIds=dirty.map(descriptor=>descriptor.id);
				const exported=await this.exportFrames(engine,dirty,revision,MAX_SIDE);
				if (exported.stale) return {stale:true};
				for (const descriptor of dirty) {
					const image=exported.images.get(descriptor.id);
					if (!image) throw renderError('RENDER_MISSING','No current image was published',{frame_id:descriptor.id});
					nextFrames.get(descriptor.id).images.set(scaleKey(image.scale),image);
				}
				return {stale:false,nextFrames,dirty:dirty.map(descriptor=>descriptor.id)};
			});
			if (result.stale||currentRevision(this.document)!==revision||this.closed) return this.state();
			this.frames=result.nextFrames;
			this.invalidFrames.clear();
			this.lastExported=result.dirty;
			this.renderedRevision=revision;
			this.error=null;
			return this.state();
		} catch (error) {
			if (!this.closed) this.setError(error);
			throw error;
		} finally {
			if (this.refreshingRevision===revision) this.refreshingRevision=null;
		}
	}

	/** @param {number} revision @returns {Promise<ReturnType<Renderer['state']>>} */
	refresh(revision) {
		const existing=this.pending.get(revision);
		if (existing) return existing;
		const operation=this.enqueue(()=>this.runRefresh(revision));
		this.pending.set(revision,operation);
		void operation.finally(()=>{
			if (this.pending.get(revision)===operation) this.pending.delete(revision);
		}).catch(()=>{});
		return operation;
	}

	async renderRequestedScale(frame,maxSide) {
		const scale=scaleFor(frame.bounds,maxSide);
		const key=scaleKey(scale);
		const cached=frame.images.get(key);
		if (cached) {
			try {
				await validateCachedImage(cached,frame.id);
				if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
				return cached;
			} catch (error) {
				if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
				frame.images.clear();
				this.invalidFrames.add(frame.id);
				this.setError(error);
				throw error;
			}
		}
		const revision=this.renderedRevision;
		const result=await this.document.withEngine(revision,engine=>this.exportFrames(
			engine,[{id:frame.id,key:frame.key,bounds:frame.bounds}],revision,maxSide,
		));
		if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
		if (result.stale||currentRevision(this.document)!==revision) {
			throw renderError('RENDER_NOT_CURRENT','Requested image revision is no longer current');
		}
		const image=result.images.get(frame.id);
		if (!image) throw renderError('RENDER_MISSING','No current image was published',{frame_id:frame.id});
		frame.images.set(key,image);
		return image;
	}

	/**
	 * Return an official current PNG, rendering a smaller engine-owned scale when requested.
	 * @param {{frame_id:string,revision:number,max_side:number}} request
	 * @returns {Promise<{frame_id:string,revision:number,path:string,width:number,height:number,scale:number,key:string}>}
	 */
	frameImage({frame_id:frameId,revision,max_side:maxSide}) {
		return this.enqueue(async()=>{
			if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
			if (!Number.isFinite(maxSide)||maxSide<=0) {
				throw renderError('RENDER_SCALE_INVALID','max_side must be a positive finite number');
			}
			if (revision!==this.renderedRevision||revision!==currentRevision(this.document)) {
				throw renderError('RENDER_NOT_CURRENT','An old image cannot represent the requested revision');
			}
			const frame=this.frames.get(frameId);
			if (!frame) throw renderError('RENDER_FRAME_MISSING','frame_id is not a current top-level frame');
			const image=await this.renderRequestedScale(frame,Math.min(MAX_SIDE,maxSide));
			if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
			return {
				frame_id:frameId,revision,path:image.path,width:image.width,height:image.height,
				scale:image.scale,key:frame.key,
			};
		});
	}

	/**
	 * One bounded page of `allNodes`: at most 64 nodes and 32 KiB, so the Luau window never decodes more.
	 * @param {object[]} allNodes
	 * @param {string} frameId the focus the page is tagged with
	 * @param {number|null|undefined} cursor
	 */
	page(allNodes,frameId,cursor) {
		const start=cursor===null||cursor===undefined ? 0 : cursor;
		if (!Number.isSafeInteger(start)||start<0||start>allNodes.length) {
			throw renderError('RENDER_CURSOR_INVALID','Projection cursor is invalid');
		}
		const nodes=[];
		let index=start;
		while (index<allNodes.length&&nodes.length<MAX_PAGE_NODES) {
			const candidate=[...nodes,allNodes[index]];
			const candidateNext=index+1<allNodes.length ? index+1 : null;
			const page={
				frame_id:frameId,revision:this.renderedRevision,nodes:candidate,
				cursor:start,next_cursor:candidateNext,
			};
			if (Buffer.byteLength(JSON.stringify(page),'utf8')>MAX_PAGE_BYTES) {
				if (nodes.length===0) {
					throw renderError('RENDER_PAGE_LIMIT','One projection node exceeds the 32 KiB page limit');
				}
				break;
			}
			nodes.push(allNodes[index]);
			index+=1;
		}
		return {
			frame_id:frameId,
			revision:this.renderedRevision,
			nodes,
			cursor:start,
			next_cursor:index<allNodes.length ? index : null,
		};
	}

	/**
	 * Return one bounded page of focused-frame projection metadata.
	 * @param {{frame_id:string,cursor:number|null}} request
	 * @returns {{frame_id:string,revision:number,nodes:any[],cursor:number,next_cursor:number|null}}
	 */
	projection({frame_id:frameId,cursor}) {
		if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
		const frame=this.frames.get(frameId);
		if (!frame||this.renderedRevision===null) {
			throw renderError('RENDER_FRAME_MISSING','frame_id is not in the current rendered projection');
		}
		return this.page(projectionRows(frame.rows,frameId),frameId,cursor);
	}

	/**
	 * Return one bounded page of the top-level frames with their page boxes and published PNG, so the whiteboard can
	 * show every frame as an image. A frame whose image is not available has `image:null`; it is never dropped.
	 * Reserve each returned PNG durably before exposing its path; pending refreshes do not delay this page.
	 * @param {{frame_id:string,cursor:number|null}} request frame_id only tags the page with the view's focus
	 * @returns {Promise<{frame_id:string,revision:number,nodes:any[],cursor:number,next_cursor:number|null}>}
	 */
	async frameList({frame_id:frameId,cursor}) {
		if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
		if (this.renderedRevision===null) throw renderError('RENDER_FRAME_MISSING','No rendered projection yet');
		const nodes=[...this.frames.values()].map(frame=>{
			const image=[...frame.images.values()].sort((a,b)=>b.scale-a.scale)[0];
			const root=frame.rows.find(row=>row.path===frame.id);
			return {
				id:frame.id,x:frame.bounds.x,y:frame.bounds.y,w:frame.bounds.width,h:frame.bounds.height,
				key:frame.key,fill:root?.schema?.fill!==undefined&&root?.schema?.fill!==null,
				image:image ? {path:image.path,width:image.width,height:image.height} : null,
			};
		});
		const page=this.page(nodes,frameId,cursor);
		const reservation=this.reserveImages(page.nodes);
		this.publications.add(reservation);
		try {
			await reservation;
			if (this.closed) throw renderError('RENDER_CLOSED','Renderer is closed');
			return page;
		} finally {
			this.publications.delete(reservation);
		}
	}

	/** @returns {ReturnType<Renderer['state']>} */
	status() {
		return this.state();
	}

	/** @returns {Promise<void>} */
	close() {
		if (this.closePromise) return this.closePromise;
		this.closed=true;
		this.refreshingRevision=null;
		this.unsubscribe();
		this.closePromise=(async()=>{
			await Promise.allSettled([this.tail,...this.publications]);
			await this.cleanOutputs();
		})();
		return this.closePromise;
	}
}

/**
 * Create the official incremental renderer for one document session.
 * @param {{document:any,dir:string}} options
 * @returns {Renderer}
 */
export function createRenderer({document,dir}) {
	assertOptions(document,dir);
	return new Renderer(document,dir);
}
