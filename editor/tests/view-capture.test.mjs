import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDispatcher} from '../src/server.mjs';

const MODEL={
	roots:[{
		id:'frame',type:'frame',width:400,height:300,
		children:[
			{id:'rect',type:'rectangle',width:100,height:50},
			{id:'flex',type:'rectangle',width:'fill_container',height:50},
			{id:'auto',type:'frame',width:200,height:100,layout:'horizontal',children:[{id:'kid',type:'rectangle',width:20,height:20}]},
			{id:'clipper',type:'frame',width:50,height:50,clip:true,children:[{id:'wide',type:'rectangle',width:200,height:20}]},
		],
	}],
	variables:{},
	rows:[
		{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:400,height:300},
		{path:'rect',parent_path:'frame',type:'rectangle',layout:'none',x:10,y:20,width:100,height:50},
		{path:'flex',parent_path:'frame',type:'rectangle',layout:'none',x:0,y:200,width:400,height:50},
		{path:'auto',parent_path:'frame',type:'frame',layout:'horizontal',x:0,y:100,width:200,height:100},
		{path:'kid',parent_path:'auto',type:'rectangle',layout:'none',x:0,y:0,width:20,height:20},
		{path:'clipper',parent_path:'frame',type:'frame',layout:'none',x:250,y:0,width:50,height:50,clip:true},
		{path:'wide',parent_path:'clipper',type:'rectangle',layout:'none',x:0,y:0,width:200,height:20},
	],
};

function setup(revision=3,{model=MODEL,onRead}={}) {
	const state={revision,applied:[],reads:0,selected:[]};
	const document={
		info:()=>({session_id:'s',revision:state.revision,status_seq:1}),
		readModel:async()=>{ state.reads+=1; onRead?.(state); return model; },
		applyChanges:async request=>{ state.applied.push(request); state.revision+=1; return {revision:state.revision}; },
	};
	const page=({frame_id})=>({frame_id,revision:state.revision,nodes:[],cursor:0,next_cursor:null});
	const renderer={
		status:()=>({frame_ids:['frame']}),
		refresh:async()=>({}),
		projection:page,
		frameList:page,
	};
	const ui={selectNode:async view=>{ state.selected.push(view.path); },focus:()=>({frame_id:'frame',selected_node:'rect'})};
	const {dispatch,board}=createDispatcher(document,renderer,ui);
	return {state,dispatch,board};
}

async function attach(context,generation=1) {
	await context.dispatch('attach_view',{request_id:`a${generation}`,view_id:'v',view_generation:generation,scene_revision:0,frame_id:'frame'});
	await context.dispatch('poll_view',{request_id:`p${generation}`,view_id:'v',view_generation:generation,cursor:null});
}

/** The panel asks; the window finds the request in its next probe. */
async function ask(context,generation=1) {
	const settled=context.board.request().then(value=>({value}),error=>({error}));
	const listed=await context.dispatch('list_frames',{request_id:'l',view_id:'v',view_generation:generation});
	return {settled,capture_id:listed.capture?.capture_id};
}

function submit(context,asked,changes,overrides={}) {
	return context.dispatch('submit_capture',{
		request_id:'s1',capture_id:asked.capture_id,view_id:'v',view_generation:1,
		scene_revision:context.state.revision,changes,...overrides,
	});
}

const MOVE={path:'rect',x:40,y:60,w:100,h:50};

test('a board capture applies once, only after the panel asked, and the wait holds no document work', async () => {
	const context=setup();
	await attach(context);
	const asked=await ask(context);
	assert.equal(typeof asked.capture_id,'string');
	assert.equal(context.state.reads,0);
	assert.deepEqual(context.state.applied,[]);
	const reply=await submit(context,asked,[MOVE]);
	assert.equal(reply.outcome,'applied');
	assert.deepEqual(context.state.applied.map(call=>call.operations),[[{op:'update',path:'rect',props:{x:40,y:60}}]]);
	assert.equal(context.state.applied[0].base_revision,3);
	const outcome=await asked.settled;
	assert.deepEqual(outcome.value,{applied:true,changes:1,revision:4,reconcile:false});
	await assert.rejects(submit(context,asked,[MOVE]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	assert.equal(context.state.applied.length,1);
});

test('what an earlier poll saw is never applied without a request from the panel', async () => {
	const context=setup();
	await attach(context);
	await assert.rejects(
		context.dispatch('submit_capture',{
			request_id:'p1',capture_id:'p1',view_id:'v',view_generation:1,scene_revision:3,changes:[MOVE],
		}),
		error=>error.code==='GEOMETRY_CAPTURE_STALE',
	);
	assert.deepEqual(context.state.applied,[]);
	const asked=await ask(context);
	await assert.rejects(submit(context,{capture_id:'not-the-request'},[MOVE]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await submit(context,asked,[])).outcome,'unchanged');
});

test('a capture from another view generation or scene revision applies nothing', async () => {
	const context=setup();
	await attach(context);
	let asked=await ask(context);
	await attach(context,2);
	assert.equal((await asked.settled).error.code,'GEOMETRY_CAPTURE_STALE','a rebuilt view drops the request');
	await assert.rejects(submit(context,asked,[MOVE]),error=>error.code==='VIEW_STALE');
	await assert.rejects(
		context.dispatch('submit_capture',{
			request_id:'s2',capture_id:asked.capture_id,view_id:'v',view_generation:2,scene_revision:3,changes:[MOVE],
		}),
		error=>error.code==='GEOMETRY_CAPTURE_STALE',
	);
	asked=await ask(context,2);
	const old=await submit(context,asked,[MOVE],{view_generation:2,scene_revision:2});
	assert.equal(old.outcome,'conflict');
	assert.equal((await asked.settled).error.code,'REVISION_STALE');
	assert.deepEqual(context.state.applied,[]);
});

test('an MCP edit between asking and receiving the capture is a conflict and overwrites nothing', async () => {
	const context=setup();
	await attach(context);
	const asked=await ask(context);
	context.state.revision=4;
	const reply=await submit(context,asked,[MOVE],{scene_revision:3});
	assert.equal(reply.outcome,'conflict');
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await asked.settled).error.code,'REVISION_STALE');
});

test('a target that no longer exists is refused, never turned into a delete', async () => {
	const context=setup();
	await attach(context);
	const asked=await ask(context);
	const reply=await submit(context,asked,[{path:'gone',x:1,y:1,w:5,h:5}]);
	assert.equal(reply.outcome,'refused');
	assert.equal(reply.code,'GEOMETRY_TARGET_MISSING');
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await asked.settled).error.code,'GEOMETRY_TARGET_MISSING');
});

test('geometry the board cannot express is refused for the panel fields and the view stays usable', async () => {
	const context=setup();
	await attach(context);
	await context.dispatch('select_node',{request_id:'x',view_id:'v',view_generation:1,scene_revision:3,path:'rect'});
	const cases=[
		['child of an auto-layout parent',{path:'kid',x:50,y:100,w:20,h:20},'GEOMETRY_CONTROLLED_BY_LAYOUT'],
		['automatic size',{path:'flex',x:0,y:200,w:300,h:50},'GEOMETRY_SIZE_AMBIGUOUS'],
		['clipped part',{path:'wide',x:260,y:0,w:40,h:20},'GEOMETRY_AMBIGUOUS'],
		['rotation',{path:'rect',x:10,y:20,w:100,h:50,rotation:30},'GEOMETRY_AMBIGUOUS'],
	];
	for (const [name,change,code] of cases) {
		const asked=await ask(context);
		const reply=await submit(context,asked,[change]);
		assert.equal(reply.outcome,'refused',name);
		assert.equal(reply.code,code,name);
		assert.equal((await asked.settled).error.code,code,name);
	}
	assert.deepEqual(context.state.applied,[]);
	assert.deepEqual(context.state.selected,['rect'],'a refusal does not touch the selection');
	const again=await ask(context);
	assert.equal((await submit(context,again,[MOVE])).outcome,'applied');
});

test('one request at a time, and none without an attached board', async () => {
	const context=setup();
	await assert.rejects(context.board.request(),error=>error.code==='VIEW_NONE');
	await attach(context);
	const first=context.board.request();
	first.catch(()=>undefined);
	await assert.rejects(context.board.request(),error=>error.code==='CAPTURE_BUSY');
});

test('an unanswered request expires without applying anything', async t=>{
	t.mock.timers.enable({apis:['setTimeout','Date']});
	const context=setup();
	await attach(context);
	const asked=await ask(context);
	t.mock.timers.tick(20001);
	assert.equal((await asked.settled).error.code,'GEOMETRY_CAPTURE_STALE');
	await assert.rejects(submit(context,asked,[MOVE]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	assert.deepEqual(context.state.applied,[]);
});

test('the board reset counter reaches every view without touching the document', async () => {
	const context=setup();
	await attach(context);
	const before=await context.dispatch('list_frames',{request_id:'l1',view_id:'v',view_generation:1});
	context.board.reset();
	const after=await context.dispatch('list_frames',{request_id:'l2',view_id:'v',view_generation:1});
	assert.equal(after.reset,before.reset+1);
	assert.deepEqual(context.state.applied,[]);
});

function crowd(count) {
	const rows=[{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:4000,height:3000}];
	const children=[];
	for (let index=0;index<count;index+=1) {
		rows.push({path:`n${index}`,parent_path:'frame',type:'rectangle',layout:'none',x:index*2,y:0,width:10,height:10});
		children.push({id:`n${index}`,type:'rectangle',width:10,height:10});
	}
	return {roots:[{id:'frame',type:'frame',width:4000,height:3000,children}],variables:{},rows};
}

test('more board changes than one document step takes are refused, and the board keeps its shapes', async () => {
	const context=setup(3,{model:crowd(101)});
	await attach(context);
	const move=count=>Array.from({length:count},(_,index)=>({path:`n${index}`,x:index*2+1,y:5,w:10,h:10}));
	let asked=await ask(context);
	let reply=await submit(context,asked,move(101));
	assert.equal(reply.outcome,'refused');
	assert.equal(reply.code,'GEOMETRY_TOO_MANY');
	assert.equal((await asked.settled).error.code,'GEOMETRY_TOO_MANY');
	assert.deepEqual(context.state.applied,[]);
	asked=await ask(context);
	reply=await submit(context,asked,move(100));
	assert.equal(reply.outcome,'applied');
	assert.equal(context.state.applied[0].operations.length,100);
});

test('a revision that moves while the model is read is a conflict, not an apply', async () => {
	const context=setup(3,{onRead:state=>{ state.revision+=1; }});
	await attach(context);
	const asked=await ask(context);
	const reply=await submit(context,asked,[MOVE]);
	assert.equal(reply.outcome,'conflict');
	assert.equal(reply.code,'REVISION_STALE');
	assert.equal((await asked.settled).error.code,'REVISION_STALE');
	assert.deepEqual(context.state.applied,[]);
	assert.equal(context.state.reads,1);
});

test('the window reports missing shapes and the outcome carries it to the panel', async () => {
	const context=setup();
	await attach(context);
	let asked=await ask(context);
	let reply=await submit(context,asked,[],{needs_reconcile:true});
	assert.equal(reply.outcome,'unchanged');
	assert.equal(reply.reconcile,true);
	assert.deepEqual((await asked.settled).value,{applied:false,changes:0,revision:3,reconcile:true});
	asked=await ask(context);
	reply=await submit(context,asked,[MOVE]);
	assert.equal(reply.reconcile,false);
});

test('closing the server ends a pending board request at once and refuses new ones', async () => {
	const context=setup();
	await attach(context);
	const asked=await ask(context);
	context.board.close();
	assert.equal((await asked.settled).error.code,'SERVER_CLOSING');
	await assert.rejects(submit(context,asked,[MOVE]),error=>error.code==='SERVER_CLOSING');
	await assert.rejects(context.board.request(),error=>error.code==='SERVER_CLOSING');
	assert.deepEqual(context.state.applied,[]);
});

const list=(context,extra={})=>context.dispatch('list_frames',{request_id:`h${Math.random()}`,view_id:'v',view_generation:1,...extra});

test('an idle window waits on the owner and is woken at once by a capture request, a revision or the focus', async () => {
	const context=setup();
	await attach(context);
	const first=await list(context);
	assert.equal(typeof first.change_seq,'number');
	const quiet=Date.now();
	const idle=await list(context,{since:first.change_seq,wait_ms:300});
	assert.ok(Date.now()-quiet>=250,'nothing changed: it waits');
	assert.equal(idle.change_seq,first.change_seq);

	let held=list(context,{since:idle.change_seq,wait_ms:1500});
	const started=Date.now();
	const settled=context.board.request().catch(()=>undefined);
	let woken=await held;
	assert.ok(Date.now()-started<500,'a capture request wakes the hold');
	assert.equal(typeof woken.capture.capture_id,'string');
	assert.ok(woken.change_seq>idle.change_seq);
	context.board.close();
	await settled;

	const other=setup();
	await attach(other);
	const base=await list(other);
	held=list(other,{since:base.change_seq,wait_ms:1500});
	const at=Date.now();
	other.state.revision+=1;
	woken=await held;
	assert.ok(Date.now()-at<500,'an MCP edit wakes the hold');
	assert.ok(woken.change_seq>base.change_seq);

	const reset=setup();
	await attach(reset);
	const seen=await list(reset);
	held=list(reset,{since:seen.change_seq,wait_ms:1500});
	reset.board.reset();
	woken=await held;
	assert.ok(woken.change_seq>seen.change_seq);
	assert.equal(woken.reset,seen.reset+1);
});

test('a stale since returns at once', async () => {
	const context=setup();
	await attach(context);
	const first=await list(context);
	const at=Date.now();
	const stale=await list(context,{since:0,wait_ms:1500});
	assert.ok(Date.now()-at<300);
	assert.equal(stale.change_seq,first.change_seq);
});
