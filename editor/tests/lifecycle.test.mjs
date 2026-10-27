import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from '../src/protocol.mjs';
import {createDispatcher} from '../src/server.mjs';
import * as server from '../src/server.mjs';
import {PanelController} from '../src/panel-model.mjs';
import {DocumentSession} from '../src/document.mjs';
import {fakeDocument,fakeRenderer} from './panel-fixtures.mjs';

function deferred() {
	let resolve;
	const promise=new Promise(done=>{ resolve=done; });
	return {promise,resolve};
}

function session(id) {
	const document=fakeDocument();
	const info=document.info.bind(document);
	document.info=()=>({...info(),session_id:id});
	const renderer=fakeRenderer(document);
	renderer.renderedRevision=3;
	renderer.frameList=({frame_id,cursor})=>({frame_id,revision:renderer.renderedRevision,nodes:[],cursor:cursor??0,next_cursor:null});
	renderer.projection=renderer.frameList;
	renderer.refresh=async()=>undefined;
	const dispatcher=createDispatcher(document,renderer,{focus:()=>({frame_id:'F1',selected_node:null})});
	return {document,renderer,...dispatcher};
}
const tag=(id='v',generation=1)=>({request_id:'request',view_id:id,view_generation:generation});
const attach=context=>context.dispatch('attach_view',{...tag(),scene_revision:3,frame_id:'F1'});

test('não anuncia pronto antes da imagem nem depois de falha no render',()=>{
	const info={phase:'ready',revision:0};
	assert.equal(protocol.activityState(info,{rendered_revision:null,error:null}),'loading');
	assert.equal(protocol.activityState({...info,revision:1},{rendered_revision:0,error:null}),'working');
	assert.equal(protocol.activityState({...info,revision:1},{rendered_revision:0,error:{code:'EXPORT_FAILED'}}),'error');
	assert.equal(protocol.activityState({...info,revision:1},{rendered_revision:1,error:null}),'ready');
	assert.equal(protocol.activityState({...info,phase:'closed'},{rendered_revision:0,error:null}),'disconnected');
	for (const [phase,want] of [['opening','loading'],['recovering','loading'],['applying','working'],['checkpointing','working'],['restoring','working'],['saving','saving'],['blocked','error'],['closing','disconnected']]) {
		assert.equal(protocol.activityState({...info,phase},{rendered_revision:0,error:null}),want,phase);
	}
});

test('MCP activity in A never marks B active, and a failed render does not announce ready',async()=>{
	const a=session('A');
	const b=session('B');
	await attach(a);
	await attach(b);
	a.document.state.phase='applying';
	a.document.state.statusSeq+=1;
	const busy=await a.dispatch('list_frames',tag());
	const idle=await b.dispatch('list_frames',tag());
	assert.equal(busy.activity.state,'working');
	assert.equal(idle.activity.state,'ready');
	assert.equal(busy.activity.affected_frame_ids,null);
	a.document.external((roots,find)=>{ find(roots,'T1').content='Confirmed by MCP'; });
	a.document.state.phase='ready';
	const status=a.renderer.status.bind(a.renderer);
	a.renderer.status=()=>({...status(),refreshing_revision:4,affected_frame_ids:['F1']});
	const known=await a.dispatch('list_frames',tag());
	assert.deepEqual(known.activity.affected_frame_ids,['F1'],'the exact post-diff frames are visible while export is pending');
	a.renderer.error={code:'EXPORT_FAILED',message:'Export failed'};
	const failed=await a.dispatch('list_frames',tag());
	assert.equal(failed.activity.state,'error');
	assert.equal(failed.activity.revision,4);
	assert.equal(failed.activity.rendered_revision,3);
	assert.equal((await b.dispatch('get_document',{})).activity.state,'ready');
});

test('activity says when the document has unsaved changes, and a save wakes a waiting view',async()=>{
	const context=session('A');
	await attach(context);
	const clean=await context.dispatch('list_frames',tag());
	assert.equal(clean.activity.dirty,false);
	context.document.state.dirty=true;
	const edited=await context.dispatch('list_frames',tag());
	assert.equal(edited.activity.dirty,true);
	assert.ok(edited.change_seq>clean.change_seq);
	context.document.state.dirty=false;
	const saved=await context.dispatch('list_frames',tag());
	assert.equal(saved.activity.dirty,false);
	assert.ok(saved.change_seq>edited.change_seq,'a save changes no revision, yet the window must hear of it');
});

test('a document that needs recovery tells the window its phase and exactly the choices it accepts, and resolves one',async()=>{
	const context=session('A');
	await attach(context);
	context.document.state.phase='recovering';
	context.document.state.recovery={source_matches:true};
	const doc=await context.dispatch('get_document',{});
	assert.deepEqual(doc.recovery_choices.map(item=>item.choice),['recover','discard']);
	for (const item of doc.recovery_choices) assert.ok(item.label&&item.detail);
	const listed=await context.dispatch('list_frames',tag());
	assert.equal(listed.activity.phase,'recovering');
	assert.equal(listed.activity.state,'loading');

	context.document.state.recovery={source_matches:false};
	assert.deepEqual((await context.dispatch('get_document',{})).recovery_choices.map(item=>item.choice),['recover','discard','copy']);
	context.document.state.recovery={save_conflict:true};
	assert.deepEqual((await context.dispatch('get_document',{})).recovery_choices.map(item=>item.choice),['copy']);

	await context.dispatch('resolve_recovery',{choice:'copy'});
	assert.deepEqual(context.document.state.calls.at(-1),{method:'resolveRecovery',request:'copy'});
	context.document.state.phase='ready';
	const ready=await context.dispatch('get_document',{});
	assert.deepEqual(ready.recovery_choices,[]);
	assert.equal((await context.dispatch('list_frames',tag())).activity.phase,'ready');
});

test('a list reports pending work without waiting for export, and wakes on status-only changes',async()=>{
	const context=session('A');
	await attach(context);
	const gate=deferred();
	context.renderer.refresh=()=>gate.promise;
	context.document.external((roots,find)=>{ find(roots,'T1').content='New'; });
	let listed=false;
	const pending=context.dispatch('list_frames',tag()).then(value=>{ listed=true; return value; });
	try {
		await new Promise(resolve=>setImmediate(resolve));
		assert.equal(listed,true,'a render must not hold back progress feedback');
		const first=await pending;
		assert.equal(first.activity.state,'working');
		context.renderer.error={code:'EXPORT_FAILED',message:'Export failed'};
		const next=await context.dispatch('list_frames',tag());
		assert.ok(next.change_seq>first.change_seq,'render failure wakes a waiting view without a new document revision');
		assert.equal(next.activity.state,'error');
	} finally {
		gate.resolve();
		await pending;
	}
});

test('detaching a view cancels its capture and old callbacks, not its document or a reopened view',async()=>{
	const context=session('A');
	await attach(context);
	const pending=context.board.request().then(value=>({value}),error=>({error}));
	assert.equal(protocol.validateCall('detach_view',tag()).view_id,'v');
	const result=await context.dispatch('detach_view',tag());
	assert.equal(result.detached,true);
	assert.equal((await pending).error.code,'VIEW_STALE');
	await assert.rejects(context.dispatch('poll_view',tag()),error=>error.code==='VIEW_STALE');
	assert.equal((await context.dispatch('get_document',{})).phase,'ready');
	await context.dispatch('attach_view',{...tag('v',2),scene_revision:3,frame_id:'F1'});
	await assert.rejects(context.dispatch('detach_view',tag()),error=>error.code==='VIEW_STALE');
	assert.equal((await context.dispatch('list_frames',tag('v',2))).view_generation,2);
});

test('a detach arriving before its attach prevents that generation from coming back',async()=>{
	const context=session('A');
	assert.equal((await context.dispatch('detach_view',tag())).detached,true);
	await assert.rejects(attach(context),error=>error.code==='VIEW_STALE');
	await context.dispatch('attach_view',{...tag('v',2),scene_revision:3,frame_id:'F1'});
	assert.equal((await context.dispatch('list_frames',tag('v',2))).view_generation,2);
	await assert.rejects(context.dispatch('detach_view',tag()),error=>error.code==='VIEW_STALE');
});

test('closing the dispatcher refuses a late capture before it can change the document',async()=>{
	const context=session('A');
	await attach(context);
	const pending=context.board.request().catch(error=>error);
	const capture=(await context.dispatch('list_frames',tag())).capture;
	context.board.close();
	assert.equal((await pending).code,'SERVER_CLOSING');
	await assert.rejects(context.dispatch('submit_capture',{...tag(),capture_id:capture.capture_id,scene_revision:3,changes:[]}),error=>error.code==='SERVER_CLOSING');
	assert.equal(context.document.state.revision,3);
});

test('a late model read cannot revive a closed panel or overwrite its visible snapshot',async()=>{
	const document=fakeDocument();
	const controller=new PanelController({document,renderer:fakeRenderer(document),poll_ms:0});
	await controller.start();
	const original=controller.model;
	const gate=deferred();
	document.readModel=()=>gate.promise;
	const pending=controller.refresh({force:true});
	controller.close();
	gate.resolve({roots:[],rows:[],variables:{}});
	await pending;
	assert.equal(controller.model,original);
	assert.equal(controller.view().activity,'disconnected');
});

test('accepted document phases reach the panel before a queued model read completes',async()=>{
	const document=new DocumentSession({source:{session_id:'s',original_path:'C:/a.pen'},index:{snapshots:['cp'],cursor:0,saved_id:'cp',revision:0},phase:'ready'});
	const renderer={status:()=>({rendered_revision:0,error:null,frame_ids:[]})};
	const controller=new PanelController({document,renderer,poll_ms:0});
	document.readModel=async()=>({roots:[],rows:[],variables:{}});
	await controller.start();
	const observed=[];
	controller.subscribe(()=>observed.push(controller.view().activity));
	document.setPhase('applying');
	document.setPhase('checkpointing');
	document.setPhase('saving');
	assert.deepEqual(observed,['working','working','saving']);
	controller.close();
	document.setPhase('ready');
	assert.equal(observed.length,3,'closed views unsubscribe from phase changes');
});

test('large or long affected-frame sets fall back to general activity without blocking metadata pages',async()=>{
	for (const ids of [Array.from({length:600},(_,i)=>`${i}`.padEnd(64,'x')),['x'.repeat(10000)]]) {
		const context=session('A');
		const status=context.renderer.status.bind(context.renderer);
		context.renderer.status=()=>({...status(),exported_frame_ids:ids});
		const attached=await attach(context);
		assert.equal(attached.activity.affected_frame_ids,null);
		const listed=await context.dispatch('list_frames',tag());
		assert.equal(listed.activity.affected_frame_ids,null);
		assert.equal(listed.page.frame_id,'F1');
		assert.ok(Buffer.byteLength(JSON.stringify(listed),'utf8')<=protocol.MAX_METADATA_BYTES);
	}
});

test('typing during an MCP model refresh cannot overwrite new content under the new revision',async()=>{
	const document=fakeDocument();
	const controller=new PanelController({document,renderer:fakeRenderer(document),poll_ms:0});
	await controller.start();
	await controller.selectNode('T1');
	const readModel=document.readModel.bind(document);
	const gate=deferred();
	document.readModel=()=>gate.promise;
	document.external((roots,find)=>{ find(roots,'T1').content='MCP replacement'; });
	const value=controller.fieldsFor('T1').find(field=>field.property==='content').value;
	controller.edit('T1','content',{from:value.length,to:value.length,len:value.length,text:'X',cursor:value.length+1});
	const pending=controller.applyField('T1','content');
	try {
		await new Promise(resolve=>setImmediate(resolve));
		assert.equal((await document.readNode('T1')).content,'MCP replacement');
		const draft=controller.drafts.get('T1\u0000content');
		assert.equal(draft.base_revision,3,'the draft revision belongs to the model that supplied the field');
		controller.keepDraft('T1','content');
		assert.equal(controller.drafts.get('T1\u0000content').base_revision,3,'Keep cannot rebase onto an unread model');
	} finally {
		gate.resolve(await readModel());
		await pending;
		await controller.refresh();
		controller.close();
	}
});

test('an MCP commit during an instance read cannot rebase another field against an old model',async()=>{
	const document=fakeDocument();
	const controller=new PanelController({document,renderer:fakeRenderer(document),poll_ms:0});
	await controller.start();
	controller.edit('T1','content',{from:4,to:4,len:4,text:'X',cursor:5});
	await controller.selectNode('I1/A1');
	const readNode=document.readNode.bind(document);
	const started=deferred();
	const gate=deferred();
	document.readNode=path=>{
		if (path!=='I1/A1') return readNode(path);
		started.resolve();
		return gate.promise;
	};
	const pending=controller.refresh({force:true});
	try {
		await started.promise;
		document.external((roots,find)=>{ find(roots,'T1').content='MCP during instance read'; });
		gate.resolve(await readNode('I1/A1'));
		await pending;
		assert.equal(controller.view().pending.find(item=>item.path==='T1').status,'stale');
		await controller.applyField('T1','content');
		assert.equal((await document.readNode('T1')).content,'MCP during instance read');
	} finally {
		gate.resolve(await readNode('I1/A1'));
		await pending;
		controller.close();
	}
});

test('a reserved older frame page never announces ready for a newer rendered revision',async()=>{
	const context=session('A');
	await attach(context);
	const started=deferred();
	const reservation=deferred();
	const frameList=context.renderer.frameList;
	context.renderer.frameList=args=>{
		const page=frameList(args);
		started.resolve();
		return reservation.promise.then(()=>page);
	};
	const pending=context.dispatch('list_frames',tag());
	await started.promise;
	context.document.external((roots,find)=>{ find(roots,'T1').content='New revision'; });
	context.renderer.renderedRevision=4;
	reservation.resolve();
	const result=await pending;
	assert.equal(result.page.revision,3);
	assert.equal(result.activity.rendered_revision,3);
	assert.equal(result.activity.revision,4);
	assert.equal(result.activity.state,'working');
});

test('retiring a view fences its capture inside the serialized document mutation',async t=>{
	for (const closing of [false,true]) await t.test(closing?'owner close':'board detach',async()=>{
		const sample=fakeDocument();
		const model=await sample.readModel();
		const document=new DocumentSession({
			source:{session_id:'s',original_path:'C:/a.pen'},
			index:{snapshots:['cp'],cursor:0,saved_id:'cp',revision:3},phase:'ready',
		});
		const gate=deferred();
		const queued=deferred();
		document.readModel=async()=>{
			void document.runExclusive(()=>gate.promise);
			return model;
		};
		let engineEntries=0;
		document.engine={exec:async()=>{ engineEntries+=1; throw Error('A retired capture reached the engine'); }};
		const apply=document.applyChanges.bind(document);
		document.applyChanges=(...args)=>{const result=apply(...args);queued.resolve();return result;};
		const renderer=fakeRenderer(document);
		renderer.renderedRevision=3;
		renderer.frameList=({frame_id})=>({frame_id,revision:3,nodes:[],cursor:0,next_cursor:null});
		const context=createDispatcher(document,renderer,{focus:()=>({frame_id:'F2',selected_node:null})});
		await context.dispatch('attach_view',{...tag(),scene_revision:3,frame_id:'F2'});
		const outcome=context.board.request().then(value=>({value}),error=>({error}));
		const capture=(await context.dispatch('list_frames',tag())).capture;
		const pending=context.dispatch('submit_capture',{...tag(),capture_id:capture.capture_id,scene_revision:3,
			changes:[{path:'R1',x:530,y:20,w:50,h:20}]}).then(value=>({value}),error=>({error}));
		await queued.promise;
		if (closing) context.board.close();
		else await context.dispatch('detach_view',tag());
		gate.resolve();
		const result=await pending;
		await outcome;
		assert.equal(result.error?.code,'VIEW_STALE');
		assert.equal(engineEntries,0,'retirement must be checked after queue waits and before engine execution');
		assert.equal(document.info().revision,3);
	});
});

// One window drives a document at a time: a view that names its holder keeps the lease while it keeps asking. The
// window that holds it uses its own view id, so a window that lost the lease cannot be mistaken for the one that has it.
const held=(holder,generation=1)=>({...tag(holder,generation),holder,scene_revision:3,frame_id:'F1'});

async function withClock(run) {
	const real=Date.now;
	let now=real();
	Date.now=()=>now;
	try {
		await run(ms=>{ now+=ms; });
	} finally {
		Date.now=real;
	}
}

test('a second window is refused while the first one is alive, and the first keeps working',async()=>{
	const context=session('A');
	await context.dispatch('attach_view',held('window-1'));
	await assert.rejects(context.dispatch('attach_view',held('window-2')),error=>error.code==='VIEW_TAKEN');
	assert.equal((await context.dispatch('list_frames',tag('window-1'))).view_generation,1);
	await assert.rejects(context.dispatch('poll_view',tag('window-2')),error=>error.code==='VIEW_STALE');
});

test('the same window attaches again with a newer generation, and views that name no holder are unaffected',async()=>{
	const context=session('A');
	await context.dispatch('attach_view',held('window-1'));
	await context.dispatch('attach_view',held('window-1',2));
	assert.equal((await context.dispatch('poll_view',tag('window-1',2))).view_generation,2);
	await context.dispatch('attach_view',{...tag('anonymous'),scene_revision:3,frame_id:'F1'});
});

test('the lease runs out when the window stops asking, and the old window is then stale',async()=>{
	await withClock(async advance=>{
		const context=session('A');
		await context.dispatch('attach_view',held('window-1'));
		advance(server.VIEW_LEASE_MS-1000);
		await context.dispatch('poll_view',tag('window-1'));
		advance(server.VIEW_LEASE_MS-1000);
		await assert.rejects(context.dispatch('attach_view',held('window-2')),error=>error.code==='VIEW_TAKEN','asking renews it');
		advance(1500);
		await context.dispatch('attach_view',held('window-2'));
		await assert.rejects(context.dispatch('poll_view',tag('window-1')),error=>error.code==='VIEW_STALE');
		assert.equal((await context.dispatch('poll_view',tag('window-2'))).view_generation,1);
	});
});

test('a window whose plugin was reloaded starts again at generation 1 once the old lease has run out',async()=>{
	await withClock(async advance=>{
		const context=session('A');
		await context.dispatch('attach_view',held('before-reload',5));
		await assert.rejects(context.dispatch('attach_view',held('after-reload')),error=>error.code==='VIEW_TAKEN');
		advance(server.VIEW_LEASE_MS+1);
		await context.dispatch('attach_view',held('after-reload'));
		assert.equal((await context.dispatch('poll_view',tag('after-reload'))).view_generation,1);
	});
});

test('detaching gives the lease up at once',async()=>{
	const context=session('A');
	await context.dispatch('attach_view',held('window-1'));
	await context.dispatch('detach_view',tag('window-1'));
	await context.dispatch('attach_view',held('window-2'));
	assert.equal((await context.dispatch('list_frames',tag('window-2'))).view_generation,1);
});

test('only the arrival of a request renews the lease: a poll stuck in a render does not keep a vanished window alive',async()=>{
	await withClock(async advance=>{
		const context=session('A');
		const stuck=deferred();
		context.renderer.refresh=()=>stuck.promise;
		await context.dispatch('attach_view',held('window-1'));
		const poll=context.dispatch('poll_view',tag('window-1'));
		advance(server.VIEW_LEASE_MS+1);
		stuck.resolve();
		await poll;
		await context.dispatch('attach_view',held('window-2'));
		assert.equal((await context.dispatch('poll_view',tag('window-2'))).view_generation,1);
	});
});

test('taking the lease over rejects at once the capture that was waiting for the old window',async()=>{
	await withClock(async advance=>{
		const context=session('A');
		await context.dispatch('attach_view',held('window-1'));
		const outcome=context.board.request().then(value=>({value}),error=>({error}));
		advance(server.VIEW_LEASE_MS+1);
		await context.dispatch('attach_view',held('window-2'));
		assert.equal((await outcome).error?.code,'VIEW_STALE');
		const next=context.board.request().then(value=>({value}),error=>({error}));
		const capture=(await context.dispatch('list_frames',tag('window-2'))).capture;
		assert.ok(capture,'the new window is asked for a capture, not told the board is busy');
		context.board.close();
		await next;
	});
});

test('the window can ask for the MCP configuration without a view tag, and MCP agents cannot',async()=>{
	const document=fakeDocument();
	const renderer=fakeRenderer(document);
	const mcp={command:'node',args:['/p/mcp.mjs','--document','/d/a.pen','--data-dir','/data']};
	const withConfig=createDispatcher(document,renderer,{},mcp);
	assert.deepEqual(await withConfig.dispatch('get_mcp_config',protocol.validateCall('get_mcp_config',{})),{mcp});
	assert.ok(!protocol.MCP_METHODS.includes('get_mcp_config'));
	assert.throws(()=>protocol.validateCall('get_mcp_config',{request_id:'r'}),error=>error.code==='INVALID_REQUEST');
	await assert.rejects(createDispatcher(document,renderer,{}).dispatch('get_mcp_config',{}),error=>error.code==='METHOD_NOT_FOUND');
});

function closable(onClose) {
	const document=fakeDocument();
	const renderer=fakeRenderer(document);
	renderer.renderedRevision=3;
	renderer.frameList=({frame_id,cursor})=>({frame_id,revision:3,nodes:[],cursor:cursor??0,next_cursor:null});
	renderer.projection=renderer.frameList;
	renderer.refresh=async()=>undefined;
	return createDispatcher(document,renderer,{focus:()=>({frame_id:'F1',selected_node:null})},undefined,onClose);
}

test('close_editor answers, then asks the owner to end once, however often the window asks',async()=>{
	let asked=0;
	const context=closable(()=>{ asked+=1; });
	assert.deepEqual(await context.dispatch('close_editor',{}),{closing:true});
	assert.equal(asked,0,'the answer leaves before the owner starts closing');
	await new Promise(resolve=>setImmediate(resolve));
	assert.equal(asked,1);
	await context.dispatch('close_editor',{}).catch(()=>undefined);
	await new Promise(resolve=>setImmediate(resolve));
	assert.equal(asked,1);
});

test('an owner that was given no way to end refuses close_editor',async()=>{
	const context=closable(undefined);
	await assert.rejects(context.dispatch('close_editor',{}),error=>error.code==='METHOD_NOT_FOUND');
});

test('only the window renews the owner\'s lease: its view calls count, an agent reading the document does not',async()=>{
	const context=closable(()=>{});
	const first=context.window.idle_ms();
	await new Promise(resolve=>setTimeout(resolve,30));
	await context.dispatch('get_document',{});
	await context.dispatch('get_nodes',{paths:[]}).catch(()=>undefined);
	assert.ok(context.window.idle_ms()>=first+25,'agent reads leave the owner idle');
	await context.dispatch('attach_view',{...tag(),scene_revision:3,frame_id:'F1'});
	assert.ok(context.window.idle_ms()<25,'attaching a view is the window asking');
	await new Promise(resolve=>setTimeout(resolve,30));
	await context.dispatch('list_frames',tag());
	assert.ok(context.window.idle_ms()<25,'every view call renews it');
	await new Promise(resolve=>setTimeout(resolve,30));
	const polled=await context.dispatch('poll_document',{});
	assert.equal(polled.phase,'ready','it answers as get_document does');
	assert.ok(context.window.idle_ms()<25,'a window with no board still asks, and that keeps its owner');
	await new Promise(resolve=>setTimeout(resolve,30));
	context.window.renew();
	assert.ok(context.window.idle_ms()<25);
});
