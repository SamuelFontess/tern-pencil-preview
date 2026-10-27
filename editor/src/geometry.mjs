import {EditorError} from './errors.mjs';
import {MAX_OPERATIONS} from './protocol.mjs';
import {layoutOf,placedByLayout} from './layout.mjs';
import {reorderIndex} from './reorder.mjs';

const EPSILON=0.001;

function geometryError(code,message,details) {
	return new EditorError(code,message,details);
}

function finite(value,name) {
	if (typeof value!=='number'||!Number.isFinite(value)) {
		throw geometryError('GEOMETRY_INVALID',`${name} must be finite`);
	}
	return value;
}

function opacityOf(node) {
	if (node.opacity===undefined) return 1;
	return Math.max(0,Math.min(1,finite(node.opacity,'opacity')));
}

function hasComplexTransform(node) {
	if (typeof node.rotation==='number'&&node.rotation!==0) return true;
	if (node.transform!==undefined&&node.transform!==null) return true;
	if (node.scaleX!==undefined&&node.scaleX!==1) return true;
	if (node.scaleY!==undefined&&node.scaleY!==1) return true;
	return false;
}

function intersection(bounds,clip) {
	const left=Math.max(bounds.x,clip.x);
	const top=Math.max(bounds.y,clip.y);
	const right=Math.min(bounds.x+bounds.width,clip.x+clip.width);
	const bottom=Math.min(bounds.y+bounds.height,clip.y+clip.height);
	return {
		x:left,
		y:top,
		width:Math.max(0,right-left),
		height:Math.max(0,bottom-top),
	};
}

/**
 * Resolve one row into world coordinates. Ancestors are ordered root first and may only
 * contribute translations; clips are intersected in world space.
 * @param {object} row
 * @param {object[]} ancestors
 * @returns {{x:number,y:number,width:number,height:number,clip:object|null,opacity:number,
 * visible:boolean,captures:boolean,ambiguous:boolean}}
 */
export function worldGeometry(row,ancestors) {
	if (!row||typeof row!=='object'||!Array.isArray(ancestors)) {
		throw geometryError('GEOMETRY_INVALID','A row and its ancestor list are required');
	}
	let offsetX=0;
	let offsetY=0;
	let opacity=1;
	let visible=true;
	let ambiguous=false;
	const clips=[];
	for (const ancestor of ancestors) {
		offsetX+=finite(ancestor.x,'ancestor.x');
		offsetY+=finite(ancestor.y,'ancestor.y');
		opacity*=opacityOf(ancestor);
		visible=visible&&ancestor.visible!==false&&ancestor.enabled!==false;
		ambiguous=ambiguous||hasComplexTransform(ancestor);
		if (ancestor.clip===true) {
			clips.push({
				x:offsetX,
				y:offsetY,
				width:finite(ancestor.width,'ancestor.width'),
				height:finite(ancestor.height,'ancestor.height'),
			});
		}
	}
	const x=offsetX+finite(row.x,'row.x');
	const y=offsetY+finite(row.y,'row.y');
	const width=finite(row.width,'row.width');
	const height=finite(row.height,'row.height');
	opacity*=opacityOf(row);
	visible=visible&&row.visible!==false&&row.enabled!==false&&opacity>0&&width>0&&height>0;
	ambiguous=ambiguous||hasComplexTransform(row);
	let clip=null;
	for (const ancestorClip of clips) {
		clip=intersection(clip??{x,y,width,height},ancestorClip);
	}
	if (clip&&(clip.width===0||clip.height===0)) visible=false;
	return {
		x,y,width,height,clip,opacity,visible,
		captures:visible&&!ambiguous,
		ambiguous,
	};
}

function assertTag(view,capture) {
	if (!view||!capture
		||capture.view_id!==view.view_id
		||capture.view_generation!==view.view_generation
		||capture.scene_revision!==view.scene_revision) {
		throw geometryError('GEOMETRY_CAPTURE_STALE','Geometry capture no longer belongs to the current view');
	}
	if (!Array.isArray(capture.changes)) {
		throw geometryError('GEOMETRY_INVALID','Geometry capture changes must be an array');
	}
}

function rowIndex(model) {
	if (!model||!Array.isArray(model.rows)||!Array.isArray(model.roots)) {
		throw geometryError('GEOMETRY_INVALID','Model must contain roots and rows');
	}
	return new Map(model.rows.map(row=>[row.path,row]));
}

function ancestorsOf(row,rows) {
	const ancestors=[];
	const seen=new Set([row.path]);
	let parentPath=row.parent_path;
	while (parentPath!==null&&parentPath!==undefined) {
		if (seen.has(parentPath)) throw geometryError('GEOMETRY_INVALID','Model ancestry is cyclic');
		seen.add(parentPath);
		const parent=rows.get(parentPath);
		if (!parent) throw geometryError('GEOMETRY_INVALID','Model ancestry is incomplete',{path:row.path,parent_path:parentPath});
		ancestors.unshift(parent);
		parentPath=parent.parent_path;
	}
	return ancestors;
}

function schemaIndex(roots) {
	const index=new Map();
	const visit=node=>{
		if (!node||typeof node!=='object') return;
		if (typeof node.id==='string') {
			if (index.has(node.id)) index.set(node.id,null);
			else index.set(node.id,node);
		}
		if (Array.isArray(node.children)) {
			for (const child of node.children) visit(child);
		}
	};
	for (const root of roots) visit(root);
	return index;
}

function changed(left,right) {
	return Math.abs(left-right)>EPSILON;
}

/** The index a layout child dropped in `dropped` takes among its siblings, or null when nothing would change. */
function reorderTarget(rows,parent,row,dropped) {
	const parentWorld=worldGeometry(parent,ancestorsOf(parent,rows));
	if (!parentWorld.captures) return null;
	const siblings=[...rows.values()].filter(item=>item.parent_path===parent.path)
		.map(item=>({path:item.path,enabled:item.enabled!==false,absolute:!placedByLayout(parent,item),...worldGeometry(item,ancestorsOf(item,rows))}));
	return reorderIndex({layout:layoutOf(parent),parent:parentWorld,siblings,path:row.path,dropped});
}

/** A text node's content is a variable reference when it is `$name` for a variable the document has. */
function boundToVariable(content,model) {
	const match=/^\$(\S+)$/.exec(content);
	const variables=model.variables?.variables??model.variables??{};
	return match!==null&&Object.hasOwn(variables,match[1]);
}

/** The paths of the text nodes whose content is bound to a variable, from the unresolved roots of the model. */
export function boundTextPaths(model) {
	const bound=new Set();
	const visit=node=>{
		if (!node||typeof node!=='object') return;
		if (node.type==='text'&&typeof node.id==='string'&&typeof node.content==='string'&&boundToVariable(node.content,model)) bound.add(node.id);
		if (Array.isArray(node.children)) for (const child of node.children) visit(child);
	};
	for (const root of model.roots??[]) visit(root);
	return bound;
}

/**
 * The `update` of the content a window typed on its board for each text node, or nothing for a text the document already
 * has. `base` is the text the user started from: a node that has a different text now was changed by someone else, and
 * the window's text is never applied over it (the answer names what the node has, and the user decides).
 */
function textChanges(texts,rows,schemas,model) {
	if (!Array.isArray(texts)) throw geometryError('GEOMETRY_INVALID','Text changes must be an array');
	const operations=[];
	for (const item of texts) {
		if (!item||typeof item.path!=='string'||item.path.length===0||typeof item.content!=='string'||typeof item.base!=='string') {
			throw geometryError('GEOMETRY_INVALID','Every text change requires a path, a content string and the base string it started from');
		}
		if (!rows.has(item.path)) throw geometryError('GEOMETRY_TARGET_MISSING','Text target is absent',{path:item.path});
		const schema=schemas.get(item.path);
		const content=schema?.content;
		const plain=schema?.type==='text'&&(content===undefined||(typeof content==='string'&&!boundToVariable(content,model)));
		if (!plain) {
			throw geometryError('GEOMETRY_NOT_TEXT','Only a text node with plain text can be edited on the board. Use the panel fields.',{path:item.path});
		}
		const current=content??'';
		if (current===item.content) continue;
		if (current!==item.base) {
			throw geometryError('GEOMETRY_TEXT_CONFLICT','The text of this node changed after the board started from it',{path:item.path,current});
		}
		operations.push({op:'update',path:item.path,props:{content:item.content}});
	}
	return operations;
}

/**
 * Convert a current whiteboard capture into structured operations: `update` for a free element, `move` (same parent,
 * new index) for a child an auto-layout parent places, and an `update` of the content of each text node whose text the
 * capture's `texts` change. The capture must
 * match the active view tag; parent layout and schema sizing remain authoritative. A target whose
 * board shape is cropped by an ancestor clip or was rotated has no single document position or size,
 * so the whole capture is refused (the panel fields change those); nothing is ever deleted here.
 * @param {{model:{roots:any[],rows:any[]},view:object,capture:object}} options
 * @returns {Array<{op:'update',path:string,props:object}|{op:'move',path:string,index:number}>}
 */
export function geometryChanges({model,view,capture}) {
	assertTag(view,capture);
	const rows=rowIndex(model);
	const schemas=schemaIndex(model.roots);
	const reordered=new Set();
	const operations=[];
	for (const change of capture.changes) {
		if (!change||typeof change.path!=='string'||change.path.length===0) {
			throw geometryError('GEOMETRY_INVALID','Every geometry change requires a path');
		}
		const row=rows.get(change.path);
		if (!row) throw geometryError('GEOMETRY_TARGET_MISSING','Geometry target is absent',{path:change.path});
		const ancestors=ancestorsOf(row,rows);
		const world=worldGeometry(row,ancestors);
		if (!world.captures) {
			throw geometryError('GEOMETRY_AMBIGUOUS','This element is hidden, rotated or scaled, so its board shape does not map to the document. Use the panel fields.',{path:change.path});
		}
		if (world.clip&&(changed(world.clip.x,world.x)||changed(world.clip.y,world.y)
			||changed(world.clip.width,world.width)||changed(world.clip.height,world.height))) {
			throw geometryError('GEOMETRY_AMBIGUOUS','The board shows only the clipped part of this element. Use the panel fields.',{path:change.path});
		}
		if (change.rotation!==undefined&&change.rotation!==0) {
			throw geometryError('GEOMETRY_AMBIGUOUS','Rotating on the board does not change the document. Use the panel fields.',{path:change.path});
		}
		const x=finite(change.x,'change.x');
		const y=finite(change.y,'change.y');
		const width=finite(change.w,'change.w');
		const height=finite(change.h,'change.h');
		if (width<0||height<0) throw geometryError('GEOMETRY_INVALID','Captured size cannot be negative');
		const moved=changed(x,world.x)||changed(y,world.y);
		const parent=row.parent_path===null||row.parent_path===undefined ? null : rows.get(row.parent_path);
		const widthChanged=changed(width,world.width);
		const heightChanged=changed(height,world.height);
		if (moved&&placedByLayout(parent,row)) {
			// The layout places its children: a plain move is a reorder among siblings, and only that (no resize with it,
			// one reorder per parent in a capture so that each index means what the document holds now).
			const index=widthChanged||heightChanged||row.path.includes('/')||reordered.has(parent.path)
				? null : reorderTarget(rows,parent,row,{x,y,width,height});
			if (index===null) {
				throw geometryError(
					'GEOMETRY_CONTROLLED_BY_LAYOUT',
					'Parent layout controls this child position: drop it between its siblings to reorder it.',
					{path:row.path,parent_path:parent.path,layout:layoutOf(parent)},
				);
			}
			reordered.add(parent.path);
			operations.push({op:'move',path:row.path,index});
			continue;
		}
		const props={};
		if (moved) {
			props.x=finite(row.x,'row.x')+(x-world.x);
			props.y=finite(row.y,'row.y')+(y-world.y);
		}
		if (widthChanged||heightChanged) {
			const schema=schemas.get(row.path);
			if (!schema
				||(widthChanged&&typeof schema.width!=='number')
				||(heightChanged&&typeof schema.height!=='number')) {
				throw geometryError(
					'GEOMETRY_SIZE_AMBIGUOUS',
					'This size is automatic (fit, fill or a variable), so the board cannot set it. Use the panel fields.',
					{path:row.path},
				);
			}
			if (widthChanged) props.width=width;
			if (heightChanged) props.height=height;
		}
		if (Object.keys(props).length>0) operations.push({op:'update',path:row.path,props});
	}
	if (capture.texts!==undefined) operations.push(...textChanges(capture.texts,rows,schemas,model));
	if (operations.length>MAX_OPERATIONS) {
		throw geometryError('GEOMETRY_TOO_MANY',`Apply at most ${MAX_OPERATIONS} board changes at a time`,{changes:operations.length});
	}
	return operations;
}
