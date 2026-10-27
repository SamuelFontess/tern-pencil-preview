import assert from 'node:assert/strict';
import {test} from 'node:test';
import {worldGeometry} from '../src/geometry.mjs';
import {createDispatcher} from '../src/server.mjs';
import {expected,withDocument} from './fixtures.mjs';

function boardOf(doc,frameId) {
	const page=()=>({frame_id:frameId,revision:doc.info().revision,nodes:[],cursor:0,next_cursor:null});
	const renderer={status:()=>({frame_ids:[frameId]}),refresh:async()=>({}),projection:page,frameList:page};
	return createDispatcher(doc,renderer,{focus:()=>({frame_id:frameId,selected_node:null})});
}

async function worldOf(doc,path) {
	const {rows}=await doc.readModel();
	const byPath=new Map(rows.map(row=>[row.path,row]));
	const ancestors=[];
	for (let parent=byPath.get(path).parent_path;parent;parent=byPath.get(parent).parent_path) ancestors.unshift(byPath.get(parent));
	return worldGeometry(byPath.get(path),ancestors);
}

test('a gesture the board ended applies x/y and width/height as one history step that undo takes back whole', {timeout:120000}, async () => withDocument(async doc => {
	const frame=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Free',x:2000,y:0,width:400,height:300,layout:'none'}},
	]})).created[0].path;
	const made=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:frame,node:{type:'rectangle',name:'A',x:10,y:20,width:100,height:50,fill:'#ff0000'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'B',x:200,y:100,width:80,height:40,fill:'#00aa00'}},
	]});
	const [a,b]=made.created.map(item=>item.path);
	const {dispatch}=boardOf(doc,frame);
	const tag={view_id:'v',view_generation:1};
	await dispatch('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:frame,holder:'window-1'});
	await dispatch('poll_view',{request_id:'p',...tag,cursor:null});

	const worldA=await worldOf(doc,a);
	const worldB=await worldOf(doc,b);
	const before=doc.info();
	const reply=await dispatch('submit_capture',{
		request_id:'g',capture_id:'g1',direct:true,...tag,scene_revision:before.revision,
		changes:[
			{path:a,x:worldA.x+30,y:worldA.y+40,w:worldA.width,h:worldA.height},
			{path:b,x:worldB.x,y:worldB.y,w:120,h:70},
		],
	});
	assert.equal(reply.outcome,'applied');
	assert.equal(doc.info().revision,before.revision+1,'one revision for the whole gesture');
	const moved=await doc.readNode(a);
	assert.deepEqual([moved.x,moved.y,moved.width,moved.height],[40,60,100,50]);
	const resized=await doc.readNode(b);
	assert.deepEqual([resized.x,resized.y,resized.width,resized.height],[200,100,120,70]);

	await doc.undo(expected(doc.info()));
	const backA=await doc.readNode(a);
	const backB=await doc.readNode(b);
	assert.deepEqual([backA.x,backA.y,backA.width,backA.height],[10,20,100,50]);
	assert.deepEqual([backB.x,backB.y,backB.width,backB.height],[200,100,80,40],'a single undo restores both');
}));

test('a gesture on a child of an auto-layout parent is refused and the document stays as it was', {timeout:120000}, async () => withDocument(async doc => {
	const frame=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Stack',x:3000,y:0,width:300,height:300,layout:'vertical',gap:10}},
	]})).created[0].path;
	const kid=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:frame,node:{type:'rectangle',name:'Kid',width:100,height:50,fill:'#0000ff'}},
	]})).created[0].path;
	const {dispatch}=boardOf(doc,frame);
	const tag={view_id:'v',view_generation:1};
	await dispatch('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:frame,holder:'window-1'});
	await dispatch('poll_view',{request_id:'p',...tag,cursor:null});

	const world=await worldOf(doc,kid);
	const before=doc.info();
	const reply=await dispatch('submit_capture',{
		request_id:'g',capture_id:'g1',direct:true,...tag,scene_revision:before.revision,
		changes:[{path:kid,x:world.x+50,y:world.y+80,w:world.width,h:world.height}],
	});
	assert.equal(reply.outcome,'refused');
	assert.equal(reply.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	assert.equal(doc.info().revision,before.revision);
}));

test('dropping a child of an auto-layout parent between its siblings reorders it in one undoable step', {timeout:120000}, async () => withDocument(async doc => {
	const frame=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Row',x:4000,y:0,width:400,height:100,layout:'horizontal',gap:10}},
	]})).created[0].path;
	const made=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:frame,node:{type:'rectangle',name:'A',width:60,height:50,fill:'#ff0000'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'B',width:60,height:50,fill:'#00aa00'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'C',width:60,height:50,fill:'#0000ff'}},
	]});
	const [a,b,c]=made.created.map(item=>item.path);
	const order=async()=>(await doc.readModel()).rows.filter(row=>row.parent_path===frame).map(row=>row.path);
	assert.equal((await doc.readModel()).rows.find(row=>row.path===frame).layout,'horizontal','the engine omits the default layout, the model names it');
	assert.deepEqual(await order(),[a,b,c]);
	const {dispatch}=boardOf(doc,frame);
	const tag={view_id:'v',view_generation:1};
	await dispatch('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:frame,holder:'window-1'});
	await dispatch('poll_view',{request_id:'p',...tag,cursor:null});

	const world=await worldOf(doc,a);
	const worldC=await worldOf(doc,c);
	const before=doc.info();
	// Dropped with its centre over the right half of C, so A lands last.
	const reply=await dispatch('submit_capture',{
		request_id:'g',capture_id:'g1',direct:true,...tag,scene_revision:before.revision,
		changes:[{path:a,x:worldC.x+worldC.width/2,y:world.y,w:world.width,h:world.height}],
	});
	assert.equal(reply.outcome,'applied');
	assert.equal(doc.info().revision,before.revision+1,'one revision for the reorder');
	assert.deepEqual(await order(),[b,c,a]);

	await doc.undo(expected(doc.info()));
	assert.deepEqual(await order(),[a,b,c],'one undo takes the order back');
}));

test('in a frame with no layout key an absolute child moves by x/y and a disabled sibling is no landing spot', {timeout:120000}, async () => withDocument(async doc => {
	const frame=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Card',x:6000,y:0,width:400,height:100}},
	]})).created[0].path;
	const made=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:frame,node:{type:'rectangle',name:'A',width:60,height:50,fill:'#ff0000'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'Ghost',width:60,height:50,enabled:false}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'B',width:60,height:50,fill:'#0000ff'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'Badge',x:200,y:10,width:30,height:30,layoutPosition:'absolute',fill:'#00aa00'}},
	]});
	const [a,ghost,b,badge]=made.created.map(item=>item.path);
	const rows=new Map((await doc.readModel()).rows.map(row=>[row.path,row]));
	assert.equal(rows.get(frame).layout,'horizontal');
	assert.equal(rows.get(badge).layout_position,'absolute');
	assert.equal(rows.get(ghost).enabled,false);
	const {dispatch}=boardOf(doc,frame);
	const tag={view_id:'v',view_generation:1};
	await dispatch('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:frame,holder:'window-1'});
	await dispatch('poll_view',{request_id:'p',...tag,cursor:null});

	const worldA=await worldOf(doc,a);
	const worldBadge=await worldOf(doc,badge);
	const capture=(id,changes)=>dispatch('submit_capture',{request_id:id,capture_id:id,direct:true,...tag,scene_revision:doc.info().revision,changes});
	// A nudge to the right that stays before B's centre passes only the disabled one: nothing to reorder.
	const before=doc.info();
	const nudge=await capture('g1',[{path:a,x:worldA.x+10,y:worldA.y,w:worldA.width,h:worldA.height}]);
	assert.equal(nudge.outcome,'refused');
	assert.equal(nudge.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	assert.equal(doc.info().revision,before.revision);
	// The absolute child is free: x/y change, the order does not.
	const moved=await capture('g2',[{path:badge,x:worldBadge.x+40,y:worldBadge.y+20,w:worldBadge.width,h:worldBadge.height}]);
	assert.equal(moved.outcome,'applied');
	const node=await doc.readNode(badge);
	assert.deepEqual([node.x,node.y],[240,30]);
	assert.deepEqual((await doc.readModel()).rows.filter(row=>row.parent_path===frame).map(row=>row.path),[a,ghost,b,badge]);
}));

test('a text typed on the board becomes the content of the node in one undoable step, and only a plain text node takes it', {timeout:120000}, async () => withDocument(async doc => {
	const frame=(await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Words',x:7000,y:0,width:400,height:200,layout:'none'}},
	]})).created[0].path;
	const made=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:frame,node:{type:'text',name:'Lede',x:10,y:20,content:'Old text',fontSize:17,fill:'#000000'}},
		{op:'insert',parent:frame,node:{type:'rectangle',name:'Box',x:10,y:100,width:50,height:50,fill:'#ff0000'}},
	]});
	const [lede,box]=made.created.map(item=>item.path);
	const {dispatch}=boardOf(doc,frame);
	const tag={view_id:'v',view_generation:1};
	await dispatch('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:frame,holder:'window-1'});
	await dispatch('poll_view',{request_id:'p',...tag,cursor:null});
	const capture=(id,texts)=>dispatch('submit_capture',{request_id:id,capture_id:id,direct:true,...tag,scene_revision:doc.info().revision,changes:[],texts});

	const before=doc.info();
	const refused=await capture('g1',[{path:box,content:'not text',base:''}]);
	assert.equal(refused.outcome,'refused');
	assert.equal(refused.code,'GEOMETRY_NOT_TEXT');
	assert.equal((await capture('g2',[{path:lede,content:'Old text',base:'Old text'}])).outcome,'unchanged');
	assert.equal(doc.info().revision,before.revision);

	const typed='Primeira linha\nSegunda — açaí, “aspas” & <tags> $5';
	const reply=await capture('g3',[{path:lede,content:typed,base:'Old text'}]);
	assert.equal(reply.outcome,'applied');
	assert.equal(doc.info().revision,before.revision+1,'one revision for the text');
	assert.equal((await doc.readNode(lede)).content,typed);

	await doc.undo(expected(doc.info()));
	assert.equal((await doc.readNode(lede)).content,'Old text','one undo takes the text back');
}));
