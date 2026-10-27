import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {createTools} from '../src/mcp.mjs';
import {
	MAX_METADATA_BYTES,
	MAX_METADATA_NODES,
	MAX_REQUEST_BYTES,
	MCP_METHODS,
	authorize,
	publicError,
	validateCall,
	validateMetadataPage,
} from '../src/protocol.mjs';
import {readJsonBody} from '../src/server.mjs';

function rejectsCode(fn,code) {
	assert.throws(fn,error=>error.code===code);
}

test('an engine refusal reaches the agent with its reason, any other internal failure stays opaque',()=>{
	assert.deepEqual(
		publicError({code:'OPERATIONS_REJECTED',message:'Node \'x\' not found!'}),
		{code:'OPERATIONS_REJECTED',message:'Node \'x\' not found!'},
	);
	assert.deepEqual(publicError({code:'ENGINE_REJECTED',message:'C:\\secret\\path'}),{code:'INTERNAL_ERROR',message:'Internal error'});
});

test('authorization rejects missing, wrong, and expired credentials',()=>{
	const token='session-secret-token';
	for (const header of [undefined,'Bearer wrong']) {
		rejectsCode(()=>authorize(header,token,true),'UNAUTHORIZED');
	}
	rejectsCode(()=>authorize(`Bearer ${token}`,token,false),'UNAUTHORIZED');
	assert.equal(authorize(`Bearer ${token}`,token,true),true);
});

test('request validation closes methods and rejects forbidden fields recursively',()=>{
	rejectsCode(()=>validateCall('unknown',{},20),'METHOD_NOT_FOUND');
	for (const key of ['filePath','original_path','shell','input','script']) {
		rejectsCode(()=>validateCall('apply_changes',{
			session_id:'s',base_revision:0,operations:[{op:'update',path:'n',props:{nested:{[key]:'x'}}}],
		},200),'FORBIDDEN_FIELD');
	}
});

test('list_frames takes a view tag and an optional cursor and nothing else',()=>{
	const tag={request_id:'r',view_id:'v',view_generation:1};
	assert.deepEqual(validateCall('list_frames',{...tag,cursor:null},100),{...tag,cursor:null});
	assert.deepEqual(validateCall('list_frames',{...tag,cursor:64},100),{...tag,cursor:64});
	rejectsCode(()=>validateCall('list_frames',{...tag,cursor:-1},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('list_frames',{...tag,frame_id:'f'},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('list_frames',{request_id:'r',view_id:'v'},100),'INVALID_REQUEST');
});

test('attach_view may name the window that holds the view, and only attach_view',()=>{
	const attach={request_id:'r',view_id:'v',view_generation:1,scene_revision:0,holder:'window-1'};
	assert.deepEqual(validateCall('attach_view',attach,100),attach);
	rejectsCode(()=>validateCall('attach_view',{...attach,holder:''},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('poll_view',{request_id:'r',view_id:'v',view_generation:1,holder:'window-1'},100),'INVALID_REQUEST');
	assert.equal(publicError({code:'VIEW_TAKEN'}).code,'VIEW_TAKEN');
});

test('submit_capture takes the window\'s own capture only as a boolean direct flag',()=>{
	const capture={request_id:'r',capture_id:'c',view_id:'v',view_generation:1,scene_revision:3,changes:[]};
	assert.deepEqual(validateCall('submit_capture',{...capture,direct:true},100),{...capture,direct:true});
	assert.deepEqual(validateCall('submit_capture',capture,100),capture);
	for (const direct of ['true',1,null,{}]) {
		rejectsCode(()=>validateCall('submit_capture',{...capture,direct},100),'INVALID_REQUEST');
	}
	rejectsCode(()=>validateCall('list_frames',{request_id:'r',view_id:'v',view_generation:1,direct:true},100),'INVALID_REQUEST');
});

test('submit_capture takes the window\'s text edits only as an array',()=>{
	const capture={request_id:'r',capture_id:'c',view_id:'v',view_generation:1,scene_revision:3,changes:[],direct:true};
	const texts=[{path:'lede',content:'New\ntext'}];
	assert.deepEqual(validateCall('submit_capture',{...capture,texts},200),{...capture,texts});
	for (const bad of ['lede',{path:'lede'},7,null]) {
		rejectsCode(()=>validateCall('submit_capture',{...capture,texts:bad},100),'INVALID_REQUEST');
	}
	rejectsCode(()=>validateCall('list_frames',{request_id:'r',view_id:'v',view_generation:1,texts},100),'INVALID_REQUEST');
});

test('discard_unsaved takes the expected session and revision and nothing else',()=>{
	const expected={session_id:'s',base_revision:3};
	assert.deepEqual(validateCall('discard_unsaved',expected,100),expected);
	rejectsCode(()=>validateCall('discard_unsaved',{session_id:'s'},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('discard_unsaved',{...expected,view_id:'v'},100),'INVALID_REQUEST');
});

test('resolve_recovery takes one choice and nothing else',()=>{
	assert.deepEqual(validateCall('resolve_recovery',{choice:'recover'},100),{choice:'recover'});
	rejectsCode(()=>validateCall('resolve_recovery',{},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('resolve_recovery',{choice:''},100),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('resolve_recovery',{choice:'recover',session_id:'s',base_revision:0},100),'INVALID_REQUEST');
});

test('streamed JSON requires an object envelope',async()=>{
	await assert.rejects(readJsonBody(Readable.from(['null'])),error=>error.code==='INVALID_REQUEST');
});

test('operation count and streamed request bytes are hard limits',async()=>{
	rejectsCode(()=>validateCall('apply_changes',{
		session_id:'s',base_revision:0,
		operations:Array.from({length:101},()=>({op:'delete',path:'n'})),
	},1000),'LIMIT_EXCEEDED');
	const body=JSON.stringify({method:'get_document',args:{},padding:'x'.repeat(MAX_REQUEST_BYTES)});
	await assert.rejects(
		readJsonBody(Readable.from([body.slice(0,700000),body.slice(700000)])),
		error=>error.code==='LIMIT_EXCEEDED',
	);
});

test('metadata pages reject more than 64 nodes and more than 32 KiB',()=>{
	rejectsCode(()=>validateMetadataPage({nodes:Array.from({length:MAX_METADATA_NODES+1},()=>({}))}),'LIMIT_EXCEEDED');
	rejectsCode(()=>validateMetadataPage({nodes:[{value:'x'.repeat(MAX_METADATA_BYTES)}]}),'LIMIT_EXCEEDED');
	assert.equal(validateMetadataPage({nodes:Array.from({length:MAX_METADATA_NODES},()=>({path:'n'}))}),true);
});

test('public errors expose stable code and message without stack or token',()=>{
	const token='do-not-leak';
	const error=Error(`failure ${token}`);
	error.code='REVISION_CONFLICT';
	error.stack=`stack ${token}`;
	const value=publicError(error,token);
	assert.deepEqual(value,{code:'REVISION_STALE',message:'Request revision is no longer current'});
	assert.equal(JSON.stringify(value).includes(token),false);
	assert.equal(JSON.stringify(value).includes('stack'),false);
});

test('unknown errors collapse to a stable internal error without private paths',()=>{
	const error=Error('ENOENT: D:\\private\\designs\\secret.pen');
	error.code='ENOENT';
	assert.deepEqual(publicError(error),{code:'INTERNAL_ERROR',message:'Internal error'});
});

test('MCP exposes exactly ten tools with closed input schemas',()=>{
	const tools=createTools();
	assert.deepEqual(tools.map(tool=>tool.name),MCP_METHODS);
	for (const tool of tools) {
		assert.equal(tool.inputSchema.type,'object');
		assert.equal(tool.inputSchema.additionalProperties,false);
	}
	for (const name of ['apply_changes','undo_document','redo_document','save_document','save_recovery_copy']) {
		const schema=tools.find(tool=>tool.name===name).inputSchema;
		assert.ok(schema.required.includes('session_id'));
		assert.ok(schema.required.includes('base_revision'));
	}
});

test('the refusal reason is the engine\'s first error line, never a warning, capped by characters',async()=>{
	const {refusalReason}=await import('../src/document.mjs');
	const stderr=(...lines)=>({details:{stderr:lines.join('\n')}});
	assert.equal(
		refusalReason(stderr('[WARN] font fallback used','[ERROR] Invalid properties:',' - /content unexpected property','[ERROR] [batch-design] failed: Update(o.path,o.props) _9 [Error]: Invalid properties:','    at Vhe.handleUpdate (file:///C:/x)')),
		'Invalid properties:\n - /content unexpected property',
	);
	assert.equal(
		refusalReason(stderr('warning: slow','[ERROR] [batch-design][t] failed: Update(o.path,o.props) _9 [Error]: Node \'nope\' not found!','    at Vhe.handleUpdate (file:///C:/x)')),
		'Node \'nope\' not found!',
	);
	assert.equal(refusalReason(stderr('warning: only a warning')),'The engine refused the operations');
	assert.equal(Array.from(refusalReason(stderr(`[ERROR] ${'😀'.repeat(400)}`))).length,300);
});

test('close_editor takes no arguments and is a window method, not an MCP tool',()=>{
	assert.deepEqual(validateCall('close_editor',{},40),{});
	rejectsCode(()=>validateCall('close_editor',{session_id:'s'},60),'INVALID_REQUEST');
	rejectsCode(()=>validateCall('close_editor',{view_id:'v'},60),'INVALID_REQUEST');
	assert.equal(MCP_METHODS.includes('close_editor'),false);
	assert.equal(createTools().some(tool=>tool.name==='close_editor'),false);
});

test('poll_document is the window\'s own read of the document: no arguments, and no MCP tool',()=>{
	assert.deepEqual(validateCall('poll_document',{},40),{});
	rejectsCode(()=>validateCall('poll_document',{holder:'w'},60),'INVALID_REQUEST');
	assert.equal(MCP_METHODS.includes('poll_document'),false);
	assert.equal(createTools().some(tool=>tool.name==='poll_document'),false);
});
