import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectionRows} from '../src/render.mjs';
import {boundTextPaths} from '../src/geometry.mjs';
import {createDispatcher} from '../src/server.mjs';

const MODEL={
	roots:[{
		id:'frame',type:'frame',width:400,height:300,
		children:[
			{id:'rect',type:'rectangle',width:100,height:50},
			{id:'sized',type:'rectangle',width:80,height:40},
			{id:'flex',type:'rectangle',width:'fill_container',height:50},
			{id:'half',type:'rectangle',width:80,height:'fit_content'},
			{id:'auto',type:'frame',width:200,height:100,layout:'horizontal',children:[{id:'kid',type:'rectangle',width:20,height:20}]},
			{id:'strip',type:'frame',width:300,height:40,layout:'horizontal',gap:10,children:[
				{id:'s1',type:'rectangle',width:40,height:40},
				{id:'s2',type:'rectangle',width:40,height:40},
				{id:'s3',type:'rectangle',width:40,height:40},
			]},
			{id:'col',type:'frame',width:100,height:150,layout:'vertical',gap:10,children:[
				{id:'c1',type:'rectangle',width:40,height:40},
				{id:'c2',type:'rectangle',width:40,height:40},
				{id:'c3',type:'rectangle',width:40,height:40},
			]},
			// No layout key: a frame lays its children out horizontally. `badge` floats over them.
			{id:'card',type:'frame',width:300,height:40,gap:10,children:[
				{id:'k1',type:'rectangle',width:40,height:40},
				{id:'badge',type:'rectangle',width:40,height:40,layoutPosition:'absolute'},
				{id:'k2',type:'rectangle',width:40,height:40},
			]},
		],
	}],
	variables:{},
	rows:[
		{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:400,height:300},
		{path:'rect',parent_path:'frame',type:'rectangle',layout:'none',x:10,y:20,width:100,height:50},
		{path:'sized',parent_path:'frame',type:'rectangle',layout:'none',x:200,y:100,width:80,height:40},
		{path:'flex',parent_path:'frame',type:'rectangle',layout:'none',x:0,y:200,width:400,height:50},
		{path:'half',parent_path:'frame',type:'rectangle',layout:'none',x:300,y:200,width:80,height:30},
		{path:'auto',parent_path:'frame',type:'frame',layout:'horizontal',x:0,y:100,width:200,height:100},
		{path:'kid',parent_path:'auto',type:'rectangle',layout:'none',x:0,y:0,width:20,height:20},
		{path:'strip',parent_path:'frame',type:'frame',layout:'horizontal',x:0,y:250,width:300,height:40},
		{path:'s1',parent_path:'strip',type:'rectangle',layout:'none',x:0,y:0,width:40,height:40},
		{path:'s2',parent_path:'strip',type:'rectangle',layout:'none',x:50,y:0,width:40,height:40},
		{path:'s3',parent_path:'strip',type:'rectangle',layout:'none',x:100,y:0,width:40,height:40},
		{path:'col',parent_path:'frame',type:'frame',layout:'vertical',x:300,y:20,width:100,height:150},
		{path:'c1',parent_path:'col',type:'rectangle',layout:'none',x:0,y:0,width:40,height:40},
		{path:'c2',parent_path:'col',type:'rectangle',layout:'none',x:0,y:50,width:40,height:40},
		{path:'c3',parent_path:'col',type:'rectangle',layout:'none',x:0,y:100,width:40,height:40},
		{path:'card',parent_path:'frame',type:'frame',x:0,y:400,width:300,height:40},
		{path:'k1',parent_path:'card',type:'rectangle',x:0,y:0,width:40,height:40},
		{path:'badge',parent_path:'card',type:'rectangle',x:30,y:0,width:40,height:40,layout_position:'absolute'},
		{path:'k2',parent_path:'card',type:'rectangle',x:50,y:0,width:40,height:40},
	],
};

function setup(revision=3,{holdApply=false,model=MODEL}={}) {
	const state={revision,applied:[],release:null};
	const document={
		info:()=>({session_id:'s',revision:state.revision,status_seq:1}),
		readModel:async()=>model,
		applyChanges:async request=>{
			if (holdApply) await new Promise(resolve=>{ state.release=resolve; });
			state.applied.push(request);
			state.revision+=1;
			return {revision:state.revision};
		},
	};
	const page=({frame_id})=>({frame_id,revision:state.revision,nodes:[],cursor:0,next_cursor:null});
	const renderer={status:()=>({frame_ids:['frame']}),refresh:async()=>({}),projection:page,frameList:page};
	const {dispatch,board}=createDispatcher(document,renderer,{focus:()=>({frame_id:'frame',selected_node:null})});
	return {state,dispatch,board};
}

async function attach(context,{holder='window-1',generation=1}={}) {
	const args={request_id:`a${generation}`,view_id:'v',view_generation:generation,scene_revision:0,frame_id:'frame'};
	if (holder!==null) args.holder=holder;
	await context.dispatch('attach_view',args);
	await context.dispatch('poll_view',{request_id:`p${generation}`,view_id:'v',view_generation:generation,cursor:null});
}

let sequence=0;
function direct(context,changes,overrides={}) {
	sequence+=1;
	return context.dispatch('submit_capture',{
		request_id:`d${sequence}`,capture_id:`g${sequence}`,direct:true,view_id:'v',view_generation:1,
		scene_revision:context.state.revision,changes,...overrides,
	});
}

test('a gesture the window ends by itself applies without the panel asking, moves and resizes in one history step', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[
		{path:'rect',x:40,y:60,w:100,h:50},
		{path:'sized',x:200,y:100,w:120,h:70},
	]);
	assert.equal(reply.outcome,'applied');
	assert.equal(reply.revision,4);
	assert.equal(context.state.applied.length,1,'one document step for the whole gesture');
	assert.equal(context.state.applied[0].base_revision,3);
	assert.deepEqual(context.state.applied[0].operations,[
		{op:'update',path:'rect',props:{x:40,y:60}},
		{op:'update',path:'sized',props:{width:120,height:70}},
	]);
});

test('a window that does not hold the lease cannot start a capture', async () => {
	const context=setup();
	await attach(context,{holder:null});
	await assert.rejects(direct(context,[{path:'rect',x:40,y:60,w:100,h:50}]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	assert.deepEqual(context.state.applied,[]);
});

test('a direct capture of a view that was replaced or never attached applies nothing', async () => {
	const context=setup();
	await attach(context);
	await attach(context,{generation:2});
	await assert.rejects(direct(context,[{path:'rect',x:40,y:60,w:100,h:50}]),error=>error.code==='VIEW_STALE');
	await assert.rejects(
		direct(context,[{path:'rect',x:40,y:60,w:100,h:50}],{view_id:'other'}),
		error=>error.code==='VIEW_STALE',
	);
	assert.deepEqual(context.state.applied,[]);
});

test('a child of an auto-layout parent is refused, nothing is applied and the window can try again', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[{path:'kid',x:50,y:100,w:20,h:20}]);
	assert.equal(reply.outcome,'refused');
	assert.equal(reply.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await direct(context,[{path:'rect',x:40,y:60,w:100,h:50}])).outcome,'applied');
});

test('an automatic size, a rotation and a missing target are refusals, never a delete', async () => {
	const context=setup();
	await attach(context);
	const cases=[
		[{path:'flex',x:0,y:200,w:300,h:50},'GEOMETRY_SIZE_AMBIGUOUS'],
		[{path:'rect',x:10,y:20,w:100,h:50,rotation:30},'GEOMETRY_AMBIGUOUS'],
		[{path:'gone',x:1,y:1,w:5,h:5},'GEOMETRY_TARGET_MISSING'],
	];
	for (const [change,code] of cases) {
		const reply=await direct(context,[change]);
		assert.equal(reply.outcome,'refused',code);
		assert.equal(reply.code,code);
	}
	assert.deepEqual(context.state.applied,[]);
});

test('an element with one fixed size is resized on that axis only: the fixed one applies, the automatic one is refused', async () => {
	const context=setup();
	await attach(context);
	const taller=await direct(context,[{path:'half',x:300,y:200,w:80,h:90}]);
	assert.equal(taller.outcome,'refused');
	assert.equal(taller.code,'GEOMETRY_SIZE_AMBIGUOUS');
	assert.deepEqual(context.state.applied,[]);
	const wider=await direct(context,[{path:'half',x:300,y:200,w:120,h:30}]);
	assert.equal(wider.outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'update',path:'half',props:{width:120}}]);
});

test('a board read at an old revision is a conflict and overwrites nothing', async () => {
	const context=setup();
	await attach(context);
	const old=await direct(context,[{path:'rect',x:40,y:60,w:100,h:50}],{scene_revision:2});
	assert.equal(old.outcome,'conflict');
	assert.equal(old.code,'REVISION_STALE');
	context.state.revision=4;
	const mcp=await direct(context,[{path:'rect',x:40,y:60,w:100,h:50}],{scene_revision:3});
	assert.equal(mcp.outcome,'conflict');
	assert.deepEqual(context.state.applied,[]);
});

test('a capture without changes answers unchanged and applies nothing', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[]);
	assert.equal(reply.outcome,'unchanged');
	assert.equal(reply.revision,3);
	assert.deepEqual(context.state.applied,[]);
});

test('the window and the panel never capture at the same time', async () => {
	const context=setup(3,{holdApply:true});
	await attach(context);
	const first=direct(context,[{path:'rect',x:40,y:60,w:100,h:50}]);
	await new Promise(resolve=>setImmediate(resolve));
	await assert.rejects(context.board.request(),error=>error.code==='CAPTURE_BUSY');
	await assert.rejects(direct(context,[{path:'sized',x:1,y:1,w:80,h:40}]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	context.state.release();
	assert.equal((await first).outcome,'applied');
	assert.equal(context.state.applied.length,1);

	const asked=context.board.request();
	asked.catch(()=>undefined);
	await assert.rejects(direct(context,[{path:'sized',x:1,y:1,w:80,h:40}]),error=>error.code==='GEOMETRY_CAPTURE_STALE');
	context.board.close();
});

test('a direct capture is refused while the editor is closing', async () => {
	const context=setup();
	await attach(context);
	context.board.close();
	await assert.rejects(direct(context,[{path:'rect',x:40,y:60,w:100,h:50}]),error=>error.code==='SERVER_CLOSING');
	assert.deepEqual(context.state.applied,[]);
});

// World boxes: s1 0..40, s2 50..90, s3 100..140 at y 250; c1, c2, c3 at x 300, y 20, 70, 120.
test('a layout child dropped with its centre between other siblings is reordered in one history step', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[{path:'s1',x:60,y:250,w:40,h:40}]);
	assert.equal(reply.outcome,'applied');
	assert.equal(context.state.applied.length,1);
	assert.equal(context.state.applied[0].base_revision,3);
	assert.deepEqual(context.state.applied[0].operations,[{op:'move',path:'s1',index:1}]);
});

test('dropped past the last sibling it becomes the last, before the first the first', async () => {
	for (const [change,index] of [
		[{path:'s2',x:230,y:250,w:40,h:40},2],
		[{path:'s3',x:-5,y:250,w:40,h:40},0],
	]) {
		const context=setup();
		await attach(context);
		assert.equal((await direct(context,[change])).outcome,'applied',change.path);
		assert.deepEqual(context.state.applied[0].operations,[{op:'move',path:change.path,index}]);
	}
});

test('a vertical layout reorders along y and ignores the other axis', async () => {
	const context=setup();
	await attach(context);
	const sideways=await direct(context,[{path:'c2',x:360,y:70,w:40,h:40}]);
	assert.equal(sideways.outcome,'refused','the same index, only moved across the layout');
	assert.deepEqual(context.state.applied,[]);
	const reply=await direct(context,[{path:'c1',x:330,y:80,w:40,h:40}]);
	assert.equal(reply.outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'move',path:'c1',index:1}]);
});

test('a drop outside the parent or at the same index is refused naming the layout, and nothing is applied', async () => {
	const context=setup();
	await attach(context);
	for (const change of [
		{path:'s1',x:0,y:100,w:40,h:40},
		{path:'s1',x:10,y:250,w:40,h:40},
		{path:'s2',x:600,y:250,w:40,h:40},
	]) {
		const reply=await direct(context,[change]);
		assert.equal(reply.outcome,'refused',JSON.stringify(change));
		assert.equal(reply.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
		assert.equal(reply.layout,'horizontal');
	}
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await direct(context,[{path:'rect',x:40,y:60,w:100,h:50}])).outcome,'applied','the window can go on');
});

test('a layout child that is also resized, or two moved in the same parent, is refused whole', async () => {
	const context=setup();
	await attach(context);
	const resized=await direct(context,[{path:'s1',x:60,y:250,w:60,h:40}]);
	assert.equal(resized.outcome,'refused');
	assert.equal(resized.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	const two=await direct(context,[{path:'s1',x:60,y:250,w:40,h:40},{path:'s2',x:230,y:250,w:40,h:40}]);
	assert.equal(two.outcome,'refused');
	assert.equal(two.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	assert.deepEqual(context.state.applied,[]);
});

test('a reorder rides with a free element in one step, and a free element is never a reorder', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[
		{path:'rect',x:40,y:60,w:100,h:50},
		{path:'s1',x:60,y:250,w:40,h:40},
	]);
	assert.equal(reply.outcome,'applied');
	assert.equal(context.state.applied.length,1);
	assert.deepEqual(context.state.applied[0].operations,[
		{op:'update',path:'rect',props:{x:40,y:60}},
		{op:'move',path:'s1',index:1},
	]);
});

test('a reorder read at an old revision is a conflict and moves nothing', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[{path:'s1',x:60,y:250,w:40,h:40}],{scene_revision:2});
	assert.equal(reply.outcome,'conflict');
	assert.deepEqual(context.state.applied,[]);
});

// card (no layout key, so horizontal) at y 400: k1 0..40, badge (absolute) 30..70, k2 50..90.
test('an absolute child of an auto-layout frame moves by x and y like a free element', async () => {
	const context=setup();
	await attach(context);
	const reply=await direct(context,[{path:'badge',x:130,y:405,w:40,h:40}]);
	assert.equal(reply.outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'update',path:'badge',props:{x:130,y:5}}]);
});

test('a sibling that is laid out but invisible (opacity 0) is still a slot to reorder into', async () => {
	const model={...MODEL,rows:MODEL.rows.map(row=>row.path==='s2'?{...row,opacity:0}:row)};
	const context=setup(3,{model});
	await attach(context);
	// s1's centre goes to 80: past the invisible s2 (centre 70), before s3 (120).
	const reply=await direct(context,[{path:'s1',x:60,y:250,w:40,h:40}]);
	assert.equal(reply.outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'move',path:'s1',index:1}]);
});

test('an absolute sibling never decides where a layout child lands, and still takes a place in the index', async () => {
	const context=setup();
	await attach(context);
	// k2's centre goes to 45, before the badge's centre (50) and after k1's: it keeps its slot.
	const nudge=await direct(context,[{path:'k2',x:25,y:400,w:40,h:40}]);
	assert.equal(nudge.outcome,'refused');
	assert.equal(nudge.code,'GEOMETRY_CONTROLLED_BY_LAYOUT');
	assert.deepEqual(context.state.applied,[]);
	// k1 past k2: index 2 counts the badge between them.
	const past=await direct(context,[{path:'k1',x:80,y:400,w:40,h:40}]);
	assert.equal(past.outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'move',path:'k1',index:2}]);
});

test('the projection tells the window what the document lets it move and resize', () => {
	const row=(path,parent,layout,schema,extra={})=>({
		path,parent_path:parent,type:'rectangle',layout,x:0,y:0,width:50,height:50,schema,...extra,
	});
	const rows=projectionRows([
		row('frame',null,'none',{width:400,height:300}),
		row('free','frame','none',{width:100,height:50}),
		row('fluid','frame','none',{width:'fill_container',height:50}),
		row('fit','frame','none',{width:100,height:'fit_content'}),
		row('box','frame','vertical',{width:100,height:100}),
		row('placed','box','none',{width:20,height:20}),
		row('box/part','box','none',{width:20,height:20}),
		// A frame with no layout key lays out horizontally; its absolute child is detached from that layout.
		row('card','frame',undefined,{width:100,height:100},{type:'frame'}),
		row('inline','card',undefined,{width:20,height:20}),
		row('floating','card',undefined,{width:20,height:20},{layout_position:'absolute'}),
	],'frame');
	const flags=Object.fromEntries(rows.map(item=>[item.path,[item.movable,item.resizable.width,item.resizable.height]]));
	assert.deepEqual(flags,{
		frame:[false,true,true],
		free:[true,true,true],
		fluid:[true,false,true],
		fit:[true,true,false],
		box:[true,true,true],
		placed:[false,true,true],
		'box/part':[false,true,true],
		card:[true,true,true],
		inline:[false,true,true],
		floating:[true,true,true],
	});
	const reorderable=rows.filter(item=>item.reorderable).map(item=>item.path);
	assert.deepEqual(reorderable,['placed','inline'],'only a direct child an auto-layout parent places can be reordered');
});

const TEXT_MODEL={
	roots:[{
		id:'frame',type:'frame',width:400,height:300,
		children:[
			{id:'lede',type:'text',content:'Old text',fontSize:17,width:200,height:20},
			{id:'bound',type:'text',content:'$title',width:100,height:20},
			{id:'dollar',type:'text',content:'$5 only',width:100,height:20},
			{id:'box',type:'rectangle',width:50,height:50},
			{id:'kind',type:'ref',ref:'component',descendants:{}},
		],
	}],
	variables:{title:{type:'string',value:'Hi'}},
	rows:[
		{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:400,height:300},
		{path:'lede',parent_path:'frame',type:'text',layout:'none',x:10,y:20,width:200,height:20},
		{path:'bound',parent_path:'frame',type:'text',layout:'none',x:10,y:60,width:100,height:20},
		{path:'dollar',parent_path:'frame',type:'text',layout:'none',x:10,y:80,width:100,height:20},
		{path:'box',parent_path:'frame',type:'rectangle',layout:'none',x:10,y:100,width:50,height:50},
		{path:'kind/inner',parent_path:'frame',type:'text',layout:'none',x:10,y:200,width:50,height:20},
	],
};

const NEW_TEXT='Primeira linha\nSegunda — açaí, “aspas” & <tags> $5 \\ fim';

test('a text typed on the board is applied as the node content, in one history step', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	const reply=await direct(context,[],{texts:[{path:'lede',content:NEW_TEXT,base:'Old text'}]});
	assert.equal(reply.outcome,'applied');
	assert.equal(reply.revision,4);
	assert.equal(context.state.applied.length,1);
	assert.equal(context.state.applied[0].base_revision,3);
	assert.deepEqual(context.state.applied[0].operations,[{op:'update',path:'lede',props:{content:NEW_TEXT}}]);
});

test('an empty text is applied as empty, and the same text as the document has changes nothing', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	assert.equal((await direct(context,[],{texts:[{path:'lede',content:'Old text',base:'Old text'}]})).outcome,'unchanged');
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await direct(context,[],{texts:[{path:'lede',content:'',base:'Old text'}]})).outcome,'applied');
	assert.deepEqual(context.state.applied[0].operations,[{op:'update',path:'lede',props:{content:''}}]);
});

test('a text rides with a geometry change in the same history step', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	const reply=await direct(context,[{path:'lede',x:30,y:20,w:200,h:20}],{texts:[{path:'lede',content:'New',base:'Old text'}]});
	assert.equal(reply.outcome,'applied');
	assert.equal(context.state.applied.length,1);
	assert.deepEqual(context.state.applied[0].operations,[
		{op:'update',path:'lede',props:{x:30,y:20}},
		{op:'update',path:'lede',props:{content:'New'}},
	]);
});

test('a text read at an old revision is a conflict and overwrites nothing', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	const old=await direct(context,[],{texts:[{path:'lede',content:'New',base:'Old text'}],scene_revision:2});
	assert.equal(old.outcome,'conflict');
	assert.equal(old.code,'REVISION_STALE');
	assert.deepEqual(context.state.applied,[]);
});

test('a node that is not plain text is refused, nothing is applied and the window can go on', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	for (const [path,code] of [
		['box','GEOMETRY_NOT_TEXT'],
		['bound','GEOMETRY_NOT_TEXT'],
		['kind/inner','GEOMETRY_NOT_TEXT'],
		['gone','GEOMETRY_TARGET_MISSING'],
	]) {
		const reply=await direct(context,[],{texts:[{path,content:'x',base:'y'}]});
		assert.equal(reply.outcome,'refused',path);
		assert.equal(reply.code,code,path);
	}
	assert.deepEqual(context.state.applied,[]);
	assert.equal((await direct(context,[],{texts:[{path:'dollar',content:'$6 only',base:'$5 only'}]})).outcome,'applied','a text that merely starts with $ is plain');
});

test('a malformed text change is refused whole', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	for (const texts of [[{path:'lede',content:'x'}],[{path:'lede',base:'Old text'}],[{path:'lede',content:7,base:'Old text'}],[{path:'lede',content:'x',base:7}],[{content:'x',base:'y'}],[null]]) {
		const reply=await direct(context,[],{texts});
		assert.equal(reply.outcome,'refused',JSON.stringify(texts));
		assert.equal(reply.code,'GEOMETRY_INVALID');
	}
	assert.equal((await direct(context,[],{texts:'lede'})).code,'GEOMETRY_INVALID');
	assert.deepEqual(context.state.applied,[]);
});

test('a text whose node changed since the user started from it is a conflict: nothing is applied and the owner says what the node has', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	const reply=await direct(context,[],{texts:[{path:'lede',content:'The user text',base:'What the user saw'}]});
	assert.equal(reply.outcome,'refused');
	assert.equal(reply.code,'GEOMETRY_TEXT_CONFLICT');
	assert.equal(reply.current,'Old text');
	assert.deepEqual(context.state.applied,[]);
	const again=await direct(context,[],{texts:[{path:'lede',content:'The user text',base:reply.current}]});
	assert.equal(again.outcome,'applied','sent again on purpose, from the text the node has now');
});

test('a node that already has the text the user typed is not a conflict, whatever the base was', async () => {
	const context=setup(3,{model:TEXT_MODEL});
	await attach(context);
	const reply=await direct(context,[],{texts:[{path:'lede',content:'Old text',base:'Something older'}]});
	assert.equal(reply.outcome,'unchanged');
});

test('the paths of text nodes bound to a variable come from the unresolved model', () => {
	assert.deepEqual([...boundTextPaths(TEXT_MODEL)],['bound']);
	const rows=projectionRows([
		{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:400,height:300,schema:{}},
		{path:'bound',parent_path:'frame',type:'text',layout:'none',x:0,y:0,width:50,height:50,schema:{content:'Resolved title'},text_bound:true},
		{path:'plain',parent_path:'frame',type:'text',layout:'none',x:0,y:0,width:50,height:50,schema:{content:'Plain'}},
	],'frame');
	assert.deepEqual(rows.filter(item=>item.text!==undefined).map(item=>item.path),['plain'],'a bound text is not offered for editing on the board');
});

test('the projection hands the window the plain text of a text node and its font size', () => {
	const row=(path,type,schema,extra={})=>({path,parent_path:'frame',type,layout:'none',x:0,y:0,width:50,height:50,schema,...extra});
	const rows=projectionRows([
		{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:400,height:300,schema:{width:400,height:300}},
		row('lede','text',{content:'Hello\nWorld — açaí',fontSize:17}),
		row('empty','text',{content:''}),
		row('bare','text',{}),
		row('nested/part','text',{content:'inside an instance'}),
		row('long','text',{content:'x'.repeat(5000)}),
		row('box','rectangle',{content:'not a text node'}),
	],'frame');
	const text=Object.fromEntries(rows.map(item=>[item.path,[item.text,item.font_size]]));
	assert.deepEqual(text.lede,['Hello\nWorld — açaí',17]);
	assert.deepEqual(text.empty,['',undefined]);
	for (const path of ['frame','bare','nested/part','long','box']) {
		assert.equal(text[path][0],undefined,`${path} has no text for the board to edit`);
	}
});
