import {EditorError} from './errors.mjs';
import {draftOperation,editDraft,keyEdit,newTextDraft,undoDraft} from './draft.mjs';
import {layoutOf,placedByLayout} from './layout.mjs';
import {activityState} from './protocol.mjs';

export const HISTORY_STEPS=50;
export const HISTORY_MIB=200;
const MAX_LAYERS=500;
const COLOR=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NUMBER=/^-?\d+(?:\.\d+)?$/;
const QUERYABLE_BLOCKED=new Set(['recovering','blocked','closing','closed']);
const CHECKPOINT_CODES=/^(?:CHECKPOINT_|INDEX_|RETENTION_|STORE_|DOCUMENT_LIMIT$)/;

/** The six manual fields of the editor scope, in display order. */
export const FIELDS=Object.freeze([
	{property:'content',label:'Text',kind:'text'},
	{property:'x',label:'X',kind:'number'},
	{property:'y',label:'Y',kind:'number'},
	{property:'width',label:'Width',kind:'number'},
	{property:'height',label:'Height',kind:'number'},
	{property:'fill',label:'Solid color',kind:'color'},
]);

function readOnly(field,reason) {
	return {...field,editable:false,value:'',reason};
}

function schemaIndex(roots) {
	const index=new Map();
	const visit=node=>{
		if (!node||typeof node!=='object') return;
		if (typeof node.id==='string') index.set(node.id,index.has(node.id)?null:node);
		if (Array.isArray(node.children)) for (const child of node.children) visit(child);
	};
	for (const root of roots) visit(root);
	return index;
}

function variableName(value,variables,mustExist) {
	const match=typeof value==='string'?/^\$(\S+)$/.exec(value):null;
	return match&&(!mustExist||Object.hasOwn(variables,match[1]))?match[1]:null;
}

function instanceOf(path,index) {
	const segments=path.split('/');
	for (let length=1;length<segments.length;length+=1) {
		const candidate=index.get(segments.slice(0,length).join('/'));
		if (candidate?.type==='ref') return {instance:candidate,rest:segments.slice(length).join('/')};
	}
	return null;
}

/**
 * Decide, from the engine model only, which of the six manual fields may be edited on a node and why not.
 * A field the model controls (auto-layout, variable, automatic size, instance inheritance) is read-only
 * with its reason; it is never converted to a fixed value.
 * @param {{path:string,schema:object|null,row:object|null,parentRow:object|null}} target
 * @param {{roots:any[],variables:object}} model
 * @returns {Array<{property:string,label:string,kind:string,editable:boolean,value:string,reason?:string}>}
 */
export function describeFields({path,schema,row,parentRow},model) {
	const index=schemaIndex(model.roots);
	const variables=model.variables?.variables??model.variables??{};
	if (!schema||typeof schema!=='object') {
		return FIELDS.map(field=>readOnly(field,'Node data is unavailable'));
	}
	const owner=path.includes('/')?instanceOf(path,index):null;
	const inInstance=path.includes('/');
	return FIELDS.map(field=>{
		const {property}=field;
		const raw=schema[property];
		if (inInstance) {
			if (!owner) return readOnly(field,'Part of a component instance');
			if (!Object.hasOwn(owner.instance.descendants?.[owner.rest]??{},property)) {
				return readOnly(field,'Inherited from the component; editing would add an override');
			}
		}
		if (schema.type==='ref'&&property!=='x'&&property!=='y') {
			return readOnly(field,'Inherited from the component instance');
		}
		const bound=variableName(raw,variables,property==='content');
		if (property==='content') {
			if (schema.type!=='text') return readOnly(field,'Only text nodes have text');
			if (bound) return readOnly(field,`Bound to variable $${bound}`);
			if (raw!==undefined&&typeof raw!=='string') return readOnly(field,'Text is not a plain string');
			return {...field,editable:true,value:raw??''};
		}
		if (property==='x'||property==='y') {
			if (placedByLayout(parentRow,row??{})) {
				return readOnly(field,`Position is controlled by the parent's ${layoutOf(parentRow)} auto-layout`);
			}
			if (bound) return readOnly(field,`Bound to variable $${bound}`);
			if (typeof raw==='string') return readOnly(field,'Position is not a plain number');
			const value=raw??row?.[property];
			return typeof value==='number'?{...field,editable:true,value:String(value)}:readOnly(field,'Position is unavailable');
		}
		if (property==='width'||property==='height') {
			if (typeof raw==='number') return {...field,editable:true,value:String(raw)};
			if (bound) return readOnly(field,`Bound to variable $${bound}`);
			if (typeof raw==='string') return readOnly(field,`Automatic size (${raw})`);
			return readOnly(field,'Automatic size (fits its content)');
		}
		if (bound) return readOnly(field,`Bound to variable $${bound}`);
		if (raw===undefined) return {...field,editable:true,value:''};
		if (typeof raw==='string') {
			return COLOR.test(raw)?{...field,editable:true,value:raw}:readOnly(field,'Not a solid color');
		}
		return readOnly(field,Array.isArray(raw)?'Multiple fills, not a solid color':`Fill is a ${raw?.type??'complex value'}, not a solid color`);
	});
}

/**
 * Validate typed field text and return the value for an `update` operation.
 * @param {string} property
 * @param {string} text
 * @returns {{ok:true,value:string|number}|{ok:false,error:string}}
 */
export function coerceValue(property,text) {
	if (property==='content') return {ok:true,value:text};
	const trimmed=text.trim();
	if (property==='fill') {
		return COLOR.test(trimmed)?{ok:true,value:trimmed}:{ok:false,error:'Enter a color such as #RRGGBB or #RRGGBBAA'};
	}
	if (!NUMBER.test(trimmed)) return {ok:false,error:'Enter a number'};
	const value=Number(trimmed);
	if (!Number.isFinite(value)) return {ok:false,error:'Enter a finite number'};
	if ((property==='width'||property==='height')&&value<0) return {ok:false,error:'Size cannot be negative'};
	return {ok:true,value};
}

/**
 * Classify a failed operation so the panel can say which stage failed.
 * @param {unknown} error
 * @returns {{stage:'not_applied'|'checkpoint'|'blocked',code:string,message:string}}
 */
export function classifyError(error) {
	const code=typeof error?.code==='string'?error.code:'INTERNAL_ERROR';
	const message=error instanceof Error?error.message:String(error);
	if (code==='DOCUMENT_BLOCKED') return {stage:'blocked',code,message};
	if (CHECKPOINT_CODES.test(code)) return {stage:'checkpoint',code,message};
	return {stage:'not_applied',code,message};
}

/**
 * Recovery choices the document accepts for its current recovery record.
 * @param {{phase:string,recovery?:{save_conflict?:boolean,source_matches?:boolean}}} info
 * @returns {Array<{choice:'recover'|'discard'|'copy',label:string,detail:string}>}
 */
export function recoveryChoices(info) {
	if (info.phase!=='recovering'||!info.recovery) return [];
	const copy={choice:'copy',label:'Save a recovery copy',detail:'Writes the last confirmed edits next to the original, then continues without touching it'};
	if (info.recovery.save_conflict) return [copy];
	const choices=[
		{choice:'recover',label:'Recover my edits',detail:'Continue from the last confirmed edits of the previous session'},
		{choice:'discard',label:'Use the file on disk',detail:'Discards the unsaved edits and starts from the original as it is now'},
	];
	return info.recovery.source_matches===false?[...choices,copy]:choices;
}

/** Layer rows of one frame in document order, with depth and a bounded length. */
export function buildLayers(model,frameId,names) {
	const parent=new Map(model.rows.map(row=>[row.path,row.parent_path]));
	const layers=[];
	let total=0;
	for (const row of model.rows) {
		let depth=0;
		let cursor=row.path;
		const seen=new Set();
		while (cursor!==frameId&&parent.get(cursor)!==null&&parent.get(cursor)!==undefined&&!seen.has(cursor)) {
			seen.add(cursor);
			cursor=parent.get(cursor);
			depth+=1;
		}
		if (cursor!==frameId) continue;
		total+=1;
		if (layers.length<MAX_LAYERS) {
			layers.push({path:row.path,depth,type:row.type,name:names.get(row.path)?.name??null});
		}
	}
	return {layers,truncated:total>layers.length,total};
}

/**
 * Pure state of one draft against the confirmed document.
 * @returns {'removed'|'diverged'|'stale'|'changed'|'clean'}
 */
export function draftStatus(draft,{revision,exists}) {
	if (!exists) return 'removed';
	if (draft.conflict) return 'diverged';
	if (draft.base_revision!==revision) return 'stale';
	return draft.text!==draft.original?'changed':'clean';
}

const draftKey=(path,property)=>`${path}\u0000${property}`;

/**
 * Document-editing state machine behind the board. It owns drafts and talks to the same
 * DocumentSession and Renderer as the MCP transport; it knows nothing about Tern.
 */
export class PanelController {
	/** @param {{document:any,renderer:any,poll_ms?:number}} options */
	constructor({document,renderer,poll_ms=400}) {
		this.document=document;
		this.renderer=renderer;
		this.pollMs=poll_ms;
		this.info=document.info();
		this.render=renderer.status();
		this.model=null;
		this.modelRevision=null;
		this.index=new Map();
		this.rows=new Map();
		this.frameId=null;
		this.selectedPath=null;
		this.targetNode=null;
		this.drafts=new Map();
		this.board=null;
		this.multiline=new Set();
		this.confirmDelete=null;
		this.notice=null;
		this.busy=null;
		this.listeners=new Set();
		this.refreshing=null;
		this.again=false;
		this.forceNext=false;
		this.signature='';
		this.timer=null;
		this.unsubscribe=null;
		this.unsubscribeStatus=null;
		this.closed=false;
	}

	/** @param {()=>void} fn @returns {()=>void} */
	subscribe(fn) {
		this.listeners.add(fn);
		return ()=>this.listeners.delete(fn);
	}

	emit() {
		if (this.closed) return;
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				// A broken view cannot corrupt document state.
			}
		}
	}

	async start() {
		this.unsubscribeStatus=this.document.onStatus?.(info=>{
			if (this.closed) return;
			this.info=info;
			this.render=this.renderer.status();
			this.emit();
		});
		await this.refresh({force:true});
		if (this.closed) return;
		this.unsubscribe=this.document.onCommit(()=>void this.refresh());
		if (this.pollMs>0) {
			this.timer=setInterval(()=>void this.refresh(),this.pollMs);
			this.timer.unref?.();
		}
	}

	/** The whiteboard drafts of the owner's server: one capture request, one reset. */
	useBoard(board) {
		this.board=board;
	}

	close() {
		this.closed=true;
		clearInterval(this.timer);
		this.timer=null;
		this.unsubscribe?.();
		this.unsubscribe=null;
		this.unsubscribeStatus?.();
		this.unsubscribeStatus=null;
		this.listeners.clear();
	}

	/** Re-read document and render state; calls coalesce into one trailing pass. */
	refresh({force=false}={}) {
		if (this.closed) return Promise.resolve();
		this.forceNext||=force;
		if (this.refreshing) {
			this.again=true;
			return this.refreshing;
		}
		this.refreshing=(async()=>{
			do {
				this.again=false;
				const forced=this.forceNext;
				this.forceNext=false;
				await this.refreshOnce(forced);
			} while (this.again&&!this.closed);
		})().finally(()=>{ this.refreshing=null; });
		return this.refreshing;
	}

	async refreshOnce(force) {
		if (this.closed) return;
		const info=this.document.info();
		const render=this.renderer.status();
		const signature=JSON.stringify([info,render]);
		if (!force&&signature===this.signature&&this.modelRevision===info.revision) return;
		this.signature=signature;
		this.info=info;
		this.render=render;
		this.emit();
		if (!QUERYABLE_BLOCKED.has(info.phase)&&(force||!this.model||this.modelRevision!==info.revision)) {
			try {
				const model=await this.document.readModel();
				if (this.closed) return;
				if (this.document.info().revision!==info.revision) {
					this.again=true;
					return;
				}
				this.setModel(model,info.revision);
				await this.loadTarget();
				if (this.closed) return;
				this.reconcileDrafts();
			} catch (error) {
				if (this.closed) return;
				this.notice={kind:'error',stage:'query',code:error?.code??'INTERNAL_ERROR',message:'Document state could not be read'};
			}
		}
		this.emit();
	}

	setModel(model,revision) {
		this.model=model;
		this.modelRevision=revision;
		this.index=schemaIndex(model.roots);
		this.rows=new Map(model.rows.map(row=>[row.path,row]));
		const frames=this.frames();
		if (!frames.some(frame=>frame.id===this.frameId)) this.frameId=frames[0]?.id??null;
		if (this.selectedPath&&!this.rows.has(this.selectedPath)) {
			this.selectedPath=null;
			this.confirmDelete=null;
		}
	}

	async loadTarget() {
		this.targetNode=null;
		const path=this.selectedPath;
		if (path?.includes('/')) {
			const node=await this.document.readNode(path);
			if (!this.closed&&path===this.selectedPath) this.targetNode=node;
		}
	}

	frames() {
		return (this.model?.roots??[]).filter(root=>root?.type==='frame').map(root=>({
			id:root.id,name:root.name??null,width:this.rows.get(root.id)?.width,height:this.rows.get(root.id)?.height,
		}));
	}

	target(path) {
		const row=this.rows.get(path)??null;
		const schema=this.index.get(path)??(path===this.selectedPath?this.targetNode:null);
		const parentRow=row?.parent_path?this.rows.get(row.parent_path)??null:null;
		return {path,schema,row,parentRow,exists:row!==null};
	}

	fieldsFor(path) {
		if (!this.model) return [];
		return describeFields(this.target(path),this.model);
	}

	/** Rebase drafts whose property is unchanged; leave real conflicts for an explicit decision. */
	reconcileDrafts() {
		for (const [key,draft] of this.drafts) {
			const target=this.target(draft.path);
			if (!target.exists||draft.conflict||draft.base_revision===this.modelRevision) continue;
			const field=this.fieldsFor(draft.path).find(item=>item.property===draft.property);
			if (field?.editable&&field.value===draft.original) {
				this.drafts.set(key,{...draft,base_revision:this.modelRevision});
			}
		}
	}

	/** Select a frame as the focus; the layers list follows it. */
	selectFrame(frameId) {
		if (!this.frames().some(frame=>frame.id===frameId)) return;
		this.frameId=frameId;
		this.emit();
	}

	/** Select a layer or whiteboard target. Pending drafts stay with their own targets. */
	async selectNode(path) {
		if (this.closed) return;
		this.confirmDelete=null;
		if (typeof path!=='string'||!this.rows.has(path)) {
			this.selectedPath=null;
			this.targetNode=null;
			this.notice={kind:'error',stage:'not_applied',code:'TARGET_MISSING',message:'The selected element no longer exists'};
			this.emit();
			return;
		}
		this.selectedPath=path;
		let cursor=path;
		const seen=new Set();
		while (this.rows.get(cursor)?.parent_path&&!seen.has(cursor)) {
			seen.add(cursor);
			cursor=this.rows.get(cursor).parent_path;
		}
		if (this.frames().some(frame=>frame.id===cursor)) this.frameId=cursor;
		try {
			await this.loadTarget();
		} catch (error) {
			this.notice={kind:'error',stage:'query',code:error?.code??'INTERNAL_ERROR',message:'Element data could not be read'};
		}
		this.emit();
	}

	currentFieldValue(path,property) {
		return this.fieldsFor(path).find(field=>field.property===property);
	}

	ensureDraft(path,property) {
		const key=draftKey(path,property);
		const existing=this.drafts.get(key);
		if (existing) return existing;
		const field=this.currentFieldValue(path,property);
		if (!field?.editable) throw new EditorError('FIELD_READONLY',field?.reason??'Field is not editable');
		// Tern's own default caret is the end of the text, so typing right after focusing appends like any field.
		return {...newTextDraft({
			session_id:this.info.session_id,base_revision:this.modelRevision,path,property,value:field.value,
		}),cursor:field.value.length};
	}

	/** Apply a native field edit event to the draft of exactly this path/property. */
	edit(path,property,event) {
		let draft;
		try {
			draft=this.ensureDraft(path,property);
		} catch {
			return;
		}
		try {
			draft=editDraft(draft,event);
			delete draft.error;
		} catch (error) {
			draft={...draft,conflict:true,error:error?.message??'Edit rejected'};
		}
		this.drafts.set(draftKey(path,property),draft);
		this.emit();
	}

	/** A text key from the pty (Tern leaves typing, deletes and plain arrows to the program): edit this field's draft. */
	key(path,property,key,{multiline=false}={}) {
		let draft;
		try {
			draft=this.ensureDraft(path,property);
		} catch {
			return;
		}
		const event=keyEdit(draft,key,{multiline});
		if (event) this.edit(path,property,event);
	}

	undoField(path,property) {
		const key=draftKey(path,property);
		const draft=this.drafts.get(key);
		if (!draft) return;
		this.drafts.set(key,undoDraft(draft));
		this.emit();
	}

	/** Escape: drop the draft of this field and show the confirmed value again. */
	cancelField(path,property) {
		const key=draftKey(path,property);
		if (!this.drafts.delete(key)) return;
		this.emit();
	}

	setMultiline(path,property,on) {
		const key=draftKey(path,property);
		if (on) this.multiline.add(key);
		else this.multiline.delete(key);
		this.emit();
	}

	/** Explicit decision after a conflict: keep my text on top of the document as it is now. */
	keepDraft(path,property) {
		if (!this.requireCurrentModel()) return;
		const key=draftKey(path,property);
		const draft=this.drafts.get(key);
		const field=this.currentFieldValue(path,property);
		if (!draft||!field?.editable||draft.conflict) return;
		this.drafts.set(key,{...draft,base_revision:this.info.revision,original:field.value});
		this.emit();
	}

	/** Commit one field draft as an `update` operation against the revision it was based on. */
	async applyField(path,property,{text}={}) {
		const key=draftKey(path,property);
		if (this.busy) return;
		let draft;
		try {
			draft=this.ensureDraft(path,property);
		} catch (error) {
			this.notice={kind:'error',...classifyError(error)};
			this.emit();
			return;
		}
		if (text!==undefined&&text!==draft.text) {
			draft=editDraft(draft,{from:0,to:draft.text.length,len:draft.text.length,text,cursor:text.length});
			this.drafts.set(key,draft);
		}
		const field=this.currentFieldValue(path,property);
		if (!field?.editable) {
			this.notice={kind:'error',stage:'not_applied',code:'FIELD_READONLY',message:field?.reason??'Field is not editable'};
			this.emit();
			return;
		}
		let operation;
		try {
			operation=draftOperation(draft,this.info.revision);
		} catch (error) {
			this.notice={kind:'error',stage:'not_applied',code:error.code,message:error.code==='DRAFT_STALE'
				?'The document changed since this edit began; keep your text or discard it'
				:'The field and its draft diverged; discard the draft'};
			this.emit();
			return;
		}
		if (operation===null) {
			this.drafts.delete(key);
			this.emit();
			return;
		}
		const coerced=coerceValue(property,String(operation.props[property]));
		if (!coerced.ok) {
			this.drafts.set(key,{...draft,error:coerced.error});
			this.emit();
			return;
		}
		const done=await this.mutate(()=>this.document.applyChanges({
			session_id:draft.session_id,base_revision:draft.base_revision,
			operations:[{op:'update',path,props:{[property]:coerced.value}}],
		}),`Applying ${property}`);
		if (done) this.drafts.delete(key);
		this.emit();
	}

	/** Reorder one node inside its auto-layout parent. */
	async moveNode(path,delta) {
		const move=this.reorderInfo(path);
		if (!move) return;
		const index=move.index+delta;
		if (index<0||index>=move.count) return;
		await this.mutate(()=>this.document.applyChanges({
			session_id:this.info.session_id,base_revision:this.info.revision,
			operations:[{op:'move',path,index}],
		}),'Reordering');
	}

	/** Position among siblings when the parent is an auto-layout container. */
	reorderInfo(path) {
		const row=this.rows.get(path);
		if (!row||path.includes('/')||!row.parent_path) return null;
		const parent=this.rows.get(row.parent_path);
		if (!placedByLayout(parent,row)) return null;
		const siblings=this.model.rows.filter(item=>item.parent_path===row.parent_path);
		return {index:siblings.findIndex(item=>item.path===path),count:siblings.length};
	}

	deleteReason(path) {
		if (!this.rows.has(path)) return 'Element no longer exists';
		if (path.includes('/')) return 'Part of a component instance';
		return null;
	}

	requestDelete(path) {
		if (this.deleteReason(path)) return;
		this.confirmDelete={path,revision:this.info.revision};
		this.emit();
	}

	cancelDelete() {
		this.confirmDelete=null;
		this.emit();
	}

	async confirmDeletion() {
		const pending=this.confirmDelete;
		if (!pending||this.busy) return;
		this.confirmDelete=null;
		if (pending.revision!==this.info.revision) {
			this.notice={kind:'error',stage:'not_applied',code:'REVISION_STALE',message:'The document changed; request the deletion again'};
			this.emit();
			return;
		}
		await this.mutate(()=>this.document.applyChanges({
			session_id:this.info.session_id,base_revision:pending.revision,
			operations:[{op:'delete',path:pending.path}],
		}),'Deleting');
	}

	requireCurrentModel() {
		if (this.modelRevision===this.document.info().revision) return true;
		this.notice={kind:'error',stage:'query',code:'MODEL_STALE',message:'Wait for the current document fields before applying this action'};
		this.emit();
		return false;
	}

	/** Run one document command, report it, and refresh. Returns true when it succeeded. */
	async mutate(run,label,success) {
		if (this.closed) return false;
		if (this.document.info().phase==='ready'&&!this.requireCurrentModel()) return false;
		this.busy=label;
		this.notice=null;
		this.emit();
		try {
			const result=await run();
			if (this.closed) return false;
			this.notice=success?{kind:'info',message:success(result)}:null;
			return true;
		} catch (error) {
			if (this.closed) return false;
			this.notice={kind:'error',...classifyError(error)};
			return false;
		} finally {
			this.busy=null;
			await this.refresh({force:true});
		}
	}

	docUndo() {
		return this.mutate(()=>this.document.undo(this.expected()),'Undoing',()=>'Undid the last document step');
	}

	docRedo() {
		return this.mutate(()=>this.document.redo(this.expected()),'Redoing',()=>'Redid the next document step');
	}

	expected() {
		return {session_id:this.info.session_id,base_revision:this.info.revision};
	}

	pendingDrafts() {
		return [...this.drafts.values()]
			.map(draft=>({draft,status:draftStatus(draft,{revision:this.info.revision,exists:this.rows.has(draft.path)})}))
			.filter(item=>item.status!=='clean');
	}

	/** Save publishes only confirmed state; pending field edits must be resolved first. */
	async save() {
		if (this.pendingDrafts().length>0) {
			this.notice={kind:'error',stage:'not_applied',code:'DRAFTS_PENDING',message:'Apply or discard pending field edits before saving'};
			this.emit();
			return;
		}
		await this.mutate(()=>this.document.saveOriginal(this.expected()),'Saving',result=>
			result.saved?`Saved revision ${result.revision}`:'Nothing to save');
	}

	async saveCopy() {
		await this.mutate(()=>this.document.saveRecoveryCopy(this.expected()),'Saving a copy',result=>
			`Recovery copy written to ${result.path}`);
	}

	async resolveRecovery(choice) {
		await this.mutate(()=>this.document.resolveRecovery(choice),'Resolving recovery',result=>
			result.recovery_copy?`Recovery copy written to ${result.recovery_copy}`:'Recovery resolved');
	}

	/** Confirm the moves and resizes made on the whiteboard: one fresh capture, one document step. */
	async applyBoard() {
		if (this.busy||!this.board) return;
		await this.mutate(()=>this.board.request(),'Reading the board',outcome=>{
			const restored=outcome.reconcile?' Some board shapes were missing and are restored.':'';
			if (outcome.applied) return `Applied ${outcome.changes} board change${outcome.changes===1?'':'s'} (revision ${outcome.revision}).${restored}`;
			if (outcome.reconcile) return 'The board was missing some shapes, so it was rebuilt and nothing was applied. Move or resize again to apply.';
			return 'The board has no changes to apply';
		});
	}

	/** Drop the whiteboard drafts: the board rebuilds its own shapes from the document, which is not touched. */
	cancelBoard() {
		if (this.busy||!this.board) return;
		this.board.reset();
		this.notice={kind:'info',message:'Board edits discarded; the board shows the document again'};
		this.emit();
	}

	/** @returns {object} Plain snapshot of the document state. */
	view() {
		const info=this.closed?{...this.info,phase:'closed'}:this.document.info();
		const render=this.renderer.status();
		const names=this.index;
		const frames=this.frames();
		const layerPage=this.frameId&&this.model?buildLayers(this.model,this.frameId,names):{layers:[],truncated:false,total:0};
		const editable=info.phase==='ready'&&this.modelRevision===info.revision&&!this.busy;
		const selected=this.selectedPath&&this.rows.has(this.selectedPath)
			?{path:this.selectedPath,type:this.rows.get(this.selectedPath).type,name:this.index.get(this.selectedPath)?.name??null}
			:null;
		const fields=selected?this.fieldsFor(selected.path).map(field=>{
			const key=draftKey(selected.path,field.property);
			const draft=this.drafts.get(key);
			return {
				...field,key,multiline:this.multiline.has(key)||(draft?.text??field.value).includes('\n'),
				draft:draft?{
					text:draft.text,cursor:draft.cursor,error:draft.error??null,
					status:draftStatus(draft,{revision:info.revision,exists:true}),
					current:field.value,
				}:null,
			};
		}):[];
		return {
			info,
			phase:info.phase,
			activity:activityState(info,render),
			busy:this.busy,
			editable,
			notice:this.notice,
			render:{
				rendered_revision:render.rendered_revision,
				error:render.error,
				pending:render.error===null&&render.rendered_revision!==info.revision,
			},
			frames,
			frameId:this.frameId,
			layers:layerPage.layers,
			layersTruncated:layerPage.truncated,
			layersTotal:layerPage.total,
			selected,
			fields,
			reorder:selected&&editable?this.reorderInfo(selected.path):null,
			deleteReason:selected?this.deleteReason(selected.path):null,
			confirmDelete:this.confirmDelete,
			board:this.board!==null,
			pending:this.pendingDrafts().map(({draft,status})=>({
				path:draft.path,property:draft.property,status,
				label:this.index.get(draft.path)?.name??draft.path,
			})),
			recovery:recoveryChoices(info),
			retention:`History keeps the last ${HISTORY_STEPS} steps or ${HISTORY_MIB} MiB; the current and last saved steps are always kept.`,
		};
	}
}
