import {createHash,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {EditorError} from './errors.mjs';

export const MAX_OPERATIONS=100;
export const MAX_REQUEST_BYTES=1024*1024;
export const MAX_METADATA_NODES=64;
export const MAX_METADATA_BYTES=32*1024;
export const MCP_METHODS=Object.freeze([
	'get_document','get_nodes','get_variables','get_schema','apply_changes','get_frame_image',
	'undo_document','redo_document','save_document','save_recovery_copy',
]);
export const VIEW_METHODS=Object.freeze(['attach_view','detach_view','poll_view','list_frames','select_node','submit_capture','discard_unsaved','resolve_recovery','get_mcp_config','close_editor','poll_document']);
export const METHODS=Object.freeze([...MCP_METHODS,...VIEW_METHODS]);

const FORBIDDEN_FIELDS=new Set(['filePath','original_path','shell','input','script','code']);
const EXPECTED_KEYS=new Set(['session_id','base_revision']);
const METHOD_KEYS={
	get_document:[],
	get_nodes:['paths'],
	get_variables:[],
	get_schema:[],
	apply_changes:['session_id','base_revision','operations'],
	get_frame_image:['frame_id','max_side'],
	undo_document:[...EXPECTED_KEYS],
	redo_document:[...EXPECTED_KEYS],
	save_document:[...EXPECTED_KEYS],
	save_recovery_copy:[...EXPECTED_KEYS],
	discard_unsaved:[...EXPECTED_KEYS],
	get_mcp_config:[],
	close_editor:[],
	poll_document:[],
	resolve_recovery:['choice'],
	attach_view:['request_id','view_id','view_generation','scene_revision','frame_id','holder'],
	detach_view:['request_id','view_id','view_generation'],
	poll_view:['request_id','view_id','view_generation','frame_id','cursor'],
	list_frames:['request_id','view_id','view_generation','cursor','since','wait_ms'],
	select_node:['request_id','view_id','view_generation','scene_revision','path'],
	submit_capture:['request_id','capture_id','view_id','view_generation','scene_revision','changes','needs_reconcile','direct','texts'],
};
const REQUIRED_KEYS={
	get_nodes:['paths'],
	apply_changes:['session_id','base_revision','operations'],
	get_frame_image:['frame_id'],
	undo_document:[...EXPECTED_KEYS],
	redo_document:[...EXPECTED_KEYS],
	save_document:[...EXPECTED_KEYS],
	discard_unsaved:[...EXPECTED_KEYS],
	resolve_recovery:['choice'],
	save_recovery_copy:[...EXPECTED_KEYS],
	attach_view:['request_id','view_id','view_generation','scene_revision'],
	detach_view:['request_id','view_id','view_generation'],
	poll_view:['request_id','view_id','view_generation'],
	list_frames:['request_id','view_id','view_generation'],
	select_node:['request_id','view_id','view_generation','scene_revision','path'],
	submit_capture:['request_id','capture_id','view_id','view_generation','scene_revision','changes'],
};
const PUBLIC_MESSAGES={
	CLIENT_CLOSED:'Session client is closed',
	DOCUMENT_BLOCKED:'Document session is blocked',
	DOCUMENT_BUSY:'Document session is busy',
	DOCUMENT_CLOSED:'Document session is closed',
	FORBIDDEN_FIELD:'Request contains a forbidden field',
	GEOMETRY_AMBIGUOUS:'Target geometry is ambiguous',
	GEOMETRY_CAPTURE_STALE:'Geometry capture is stale',
	GEOMETRY_CONTROLLED_BY_LAYOUT:'Target geometry is controlled by layout',
	GEOMETRY_INVALID:'Geometry request is invalid',
	GEOMETRY_NOT_TEXT:'Target is not a plain text node',
	GEOMETRY_TEXT_CONFLICT:'The text of the node changed meanwhile',
	GEOMETRY_SIZE_AMBIGUOUS:'Target size is ambiguous',
	GEOMETRY_TOO_MANY:'Too many board changes to apply at once',
	GEOMETRY_TARGET_MISSING:'Geometry target is missing',
	HISTORY_UNAVAILABLE:'Document history step is unavailable',
	HOST_FORBIDDEN:'Host is forbidden',
	INTERNAL_ERROR:'Internal error',
	INVALID_REQUEST:'Request is invalid',
	LIMIT_EXCEEDED:'Request exceeds a protocol limit',
	METHOD_NOT_ALLOWED:'HTTP method is not allowed',
	METHOD_NOT_FOUND:'Method is not supported',
	OPERATIONS_INVALID:'Operations are invalid',
	OPERATIONS_REJECTED:'The engine refused the operations',
	OPERATIONS_LIMIT:'Operations exceed a protocol limit',
	ORIGIN_FORBIDDEN:'Browser-originated requests are forbidden',
	RECOVERY_CHOICE_INVALID:'Recovery choice is invalid',
	RECOVERY_NOT_REQUIRED:'Document recovery is not required',
	RECOVERY_REQUIRED:'Document recovery is required',
	RENDER_FRAME_MISSING:'Requested frame is unavailable',
	RENDER_MISSING:'Rendered image is unavailable',
	RENDER_NOT_CURRENT:'Rendered image is not current',
	RENDER_SCALE_INVALID:'Requested render scale is invalid',
	REVISION_STALE:'Request revision is no longer current',
	SAVE_CONFLICT:'Save conflicts with an external change',
	SAVE_UNCERTAIN:'Save result is uncertain',
	SESSION_MISMATCH:'Request belongs to another document session',
	SESSION_UNAVAILABLE:'Document session is unavailable',
	SOURCE_CHANGED:'Original document changed externally',
	UNAUTHORIZED:'Authorization failed',
	VIEW_STALE:'View generation is no longer current',
	VIEW_TAKEN:'Another window is showing this document',
};

function protocolError(code,message) {
	throw new EditorError(code,message);
}

function object(value,name='value') {
	if (value===null||typeof value!=='object'||Array.isArray(value)) {
		protocolError('INVALID_REQUEST',`${name} must be an object`);
	}
}

function string(value,name) {
	if (typeof value!=='string'||value.length===0) protocolError('INVALID_REQUEST',`${name} must be a nonempty string`);
}

function integer(value,name) {
	if (!Number.isSafeInteger(value)||value<0) protocolError('INVALID_REQUEST',`${name} must be a nonnegative safe integer`);
}

function inspect(value,seen=new Set()) {
	if (value===null||typeof value==='string'||typeof value==='boolean') return;
	if (typeof value==='number'&&Number.isFinite(value)) return;
	if (typeof value!=='object') protocolError('INVALID_REQUEST','Request must contain only JSON values');
	if (seen.has(value)) protocolError('INVALID_REQUEST','Request must not be cyclic');
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) inspect(item,seen);
	} else {
		for (const [key,item] of Object.entries(value)) {
			if (FORBIDDEN_FIELDS.has(key)) protocolError('FORBIDDEN_FIELD','Request contains a forbidden field');
			inspect(item,seen);
		}
	}
	seen.delete(value);
}

function expected(args) {
	string(args.session_id,'session_id');
	integer(args.base_revision,'base_revision');
}

function viewTag(args) {
	string(args.request_id,'request_id');
	string(args.view_id,'view_id');
	integer(args.view_generation,'view_generation');
	if (Object.hasOwn(args,'scene_revision')) integer(args.scene_revision,'scene_revision');
}

/** Validate a closed method/argument envelope before routing it to the document. */
export function validateCall(method,args,requestBytes=0) {
	if (!METHODS.includes(method)) protocolError('METHOD_NOT_FOUND','Method is not supported');
	if (!Number.isSafeInteger(requestBytes)||requestBytes<0||requestBytes>MAX_REQUEST_BYTES) {
		protocolError('LIMIT_EXCEEDED','Request exceeds 1 MiB');
	}
	object(args,'args');
	inspect(args);
	const allowed=new Set(METHOD_KEYS[method]);
	for (const key of Object.keys(args)) {
		if (!allowed.has(key)) protocolError('INVALID_REQUEST',`${method} contains an unsupported field`);
	}
	for (const key of REQUIRED_KEYS[method]??[]) {
		if (!Object.hasOwn(args,key)) protocolError('INVALID_REQUEST',`${method} requires ${key}`);
	}
	if (EXPECTED_KEYS.has('session_id')&&Object.hasOwn(args,'session_id')) expected(args);
	switch (method) {
		case 'get_nodes':
			if (!Array.isArray(args.paths)||args.paths.length>MAX_METADATA_NODES) protocolError('LIMIT_EXCEEDED','Node query exceeds 64 paths');
			for (const path of args.paths) string(path,'path');
			break;
		case 'resolve_recovery':
			string(args.choice,'choice');
			break;
		case 'apply_changes':
			if (!Array.isArray(args.operations)) protocolError('INVALID_REQUEST','operations must be an array');
			if (args.operations.length>MAX_OPERATIONS) protocolError('LIMIT_EXCEEDED','Batch exceeds 100 operations');
			if (Buffer.byteLength(JSON.stringify(args.operations),'utf8')>MAX_REQUEST_BYTES) {
				protocolError('LIMIT_EXCEEDED','Batch exceeds 1 MiB');
			}
			break;
		case 'get_frame_image':
			string(args.frame_id,'frame_id');
			if (Object.hasOwn(args,'max_side')&&(!Number.isFinite(args.max_side)||args.max_side<=0)) {
				protocolError('INVALID_REQUEST','max_side must be positive');
			}
			break;
		case 'attach_view':
		case 'detach_view':
		case 'poll_view':
		case 'list_frames':
		case 'select_node':
		case 'submit_capture':
			viewTag(args);
			if (method==='submit_capture') string(args.capture_id,'capture_id');
			if (Object.hasOwn(args,'frame_id')) string(args.frame_id,'frame_id');
			if (Object.hasOwn(args,'holder')) string(args.holder,'holder');
			if (Object.hasOwn(args,'cursor')&&args.cursor!==null) integer(args.cursor,'cursor');
			if (Object.hasOwn(args,'since')) integer(args.since,'since');
			if (Object.hasOwn(args,'wait_ms')) integer(args.wait_ms,'wait_ms');
			if (Object.hasOwn(args,'path')) string(args.path,'path');
			if (Object.hasOwn(args,'changes')&&!Array.isArray(args.changes)) protocolError('INVALID_REQUEST','changes must be an array');
			if (Object.hasOwn(args,'texts')&&!Array.isArray(args.texts)) protocolError('INVALID_REQUEST','texts must be an array');
			if (Object.hasOwn(args,'needs_reconcile')&&typeof args.needs_reconcile!=='boolean') protocolError('INVALID_REQUEST','needs_reconcile must be a boolean');
			if (Object.hasOwn(args,'direct')&&typeof args.direct!=='boolean') protocolError('INVALID_REQUEST','direct must be a boolean');
			break;
	}
	return args;
}

/** Enforce the Luau metadata page count and serialized byte budgets. */
export function validateMetadataPage(page) {
	object(page,'page');
	if (!Array.isArray(page.nodes)) protocolError('INVALID_REQUEST','page.nodes must be an array');
	if (page.nodes.length>MAX_METADATA_NODES||Buffer.byteLength(JSON.stringify(page),'utf8')>MAX_METADATA_BYTES) {
		protocolError('LIMIT_EXCEEDED','Metadata page exceeds its limit');
	}
	return true;
}

/** Compare a Bearer credential without data-dependent token comparison. */
export function authorize(header,token,active=true) {
	const prefix='Bearer ';
	const supplied=typeof header==='string'&&header.startsWith(prefix) ? header.slice(prefix.length) : '';
	const left=createHash('sha256').update(supplied).digest();
	const right=createHash('sha256').update(token).digest();
	const equal=timingSafeEqual(left,right);
	if (!active||!equal) protocolError('UNAUTHORIZED','Authorization failed');
	return true;
}

/** Convert internal failures to a token- and stack-free stable protocol error. */
export function publicError(error,_token='') {
	let code=typeof error?.code==='string' ? error.code : 'INTERNAL_ERROR';
	if (code==='REVISION_CONFLICT') code='REVISION_STALE';
	if (['RENDER_CLOSED','ECONNREFUSED','ECONNRESET','EPIPE'].includes(code)) code='SESSION_UNAVAILABLE';
	if (!Object.hasOwn(PUBLIC_MESSAGES,code)) code='INTERNAL_ERROR';
	// The engine's refusal reason is what an agent needs to fix its own call.
	return {code,message:code==='OPERATIONS_REJECTED'&&error.message ? error.message : PUBLIC_MESSAGES[code]};
}

/** Return the one private discovery record path for a canonical original. */
export function sessionRecordPath(dataDir,canonicalOriginal) {
	const hash=createHash('sha256').update(canonicalOriginal).digest('hex');
	return join(dataDir,'sessions',`${hash}.json`);
}

/** A confirmed document is not visually ready until its corresponding render is published. */
export function activityState(info,render) {
	if (['closing','closed'].includes(info.phase)) return 'disconnected';
	if (info.phase==='blocked'||render.error) return 'error';
	if (['opening','recovering'].includes(info.phase)||render.rendered_revision===null) return 'loading';
	if (['applying','checkpointing','restoring'].includes(info.phase)) return 'working';
	if (info.phase==='saving') return 'saving';
	return render.rendered_revision<info.revision?'working':'ready';
}
