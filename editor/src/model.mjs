import {EditorError} from './errors.mjs';
import {normalizeRow} from './layout.mjs';

function requirePath(path) {
	if (typeof path!=='string'||path.length===0) {
		throw new EditorError('MODEL_PATH','Node path must be a nonempty string');
	}
	return JSON.stringify(path);
}

/**
 * Read schema roots, flat resolved rows and variables from one coherent engine call.
 * @param {{exec(body:string,options?:{kind:'read'|'measure'}):Promise<{value:any}>}} engine
 * @returns {Promise<{roots:any[],rows:any[],variables:object}>}
 */
export async function readModel(engine) {
	// The engine leaves out a layout equal to its default: `normalizeRow` names it (layout.mjs).
	const {value}=await engine.exec(`
const rootIds=Get((n,c)=>{if(c.depth===0){c.skipChildren();return n.id;}});
const roots=rootIds.map(id=>Get(id));
const rows=Get((n,c)=>{
 const b=c.bounds;
 return {path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,type:n.type,
  layout:typeof n.layout==='string'?n.layout:null,layout_position:n.layoutPosition,enabled:n.enabled,
  x:b.x,y:b.y,width:b.width,height:b.height};
},{resolveVariables:true,resolveInstances:true});
return {roots,rows,variables:GetVariables()};`,{kind:'measure'});
	if (!value||!Array.isArray(value.roots)||!Array.isArray(value.rows)||!value.variables) {
		throw new EditorError('MODEL_PROTOCOL','Engine returned an invalid model');
	}
	return {...value,rows:value.rows.map(normalizeRow)};
}

/**
 * Read one node and its resolved bounds using an engine-owned canonical path.
 * @param {{exec(body:string,options?:{kind:'read'|'measure'}):Promise<{value:any}>}} engine
 * @param {string} path
 * @returns {Promise<any|null>}
 */
export async function readNode(engine,path) {
	const literal=requirePath(path);
	const {value}=await engine.exec(`
const found=Get(${literal},(n,c)=>{
 c.skipChildren();
 const {children,...schema}=n;
 const b=c.bounds;
 return {...schema,path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,
  bounds:{x:b.x,y:b.y,width:b.width,height:b.height}};
},{resolveVariables:false,resolveInstances:true});
return found[0]||null;`,{kind:'measure'});
	return value??null;
}

/**
 * Read current variables and themes from the official engine API.
 * @param {{exec(body:string,options?:{kind:'read'|'measure'}):Promise<{value:any}>}} engine
 * @returns {Promise<object>}
 */
export async function readVariables(engine) {
	const {value}=await engine.exec('return GetVariables();',{kind:'read'});
	if (!value||typeof value!=='object'||!value.variables) {
		throw new EditorError('MODEL_PROTOCOL','Engine returned invalid variables');
	}
	return value;
}
