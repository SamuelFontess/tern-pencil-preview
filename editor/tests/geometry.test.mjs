import assert from 'node:assert/strict';
import {test} from 'node:test';
import {geometryChanges,worldGeometry} from '../src/geometry.mjs';

test('worldGeometry composes ancestor translations', () => {
	const row={path:'child',x:10,y:5,width:20,height:10};
	const ancestors=[
		{path:'root',x:100,y:50,width:200,height:100},
		{path:'parent',x:7,y:3,width:80,height:60},
	];
	assert.deepEqual(worldGeometry(row,ancestors),{
		x:117,y:58,width:20,height:10,
		clip:null,opacity:1,visible:true,captures:true,ambiguous:false,
	});
});

test('worldGeometry intersects partial clips and hides fully clipped targets', () => {
	const partial=worldGeometry(
		{path:'child',x:40,y:40,width:20,height:20},
		[{path:'root',x:100,y:50,width:50,height:50,clip:true}],
	);
	assert.deepEqual(partial.clip,{x:140,y:90,width:10,height:10});
	assert.equal(partial.visible,true);
	assert.equal(partial.captures,true);

	const hidden=worldGeometry(
		{path:'child',x:60,y:60,width:20,height:20},
		[{path:'root',x:100,y:50,width:50,height:50,clip:true}],
	);
	assert.deepEqual(hidden.clip,{x:160,y:110,width:0,height:0});
	assert.equal(hidden.visible,false);
	assert.equal(hidden.captures,false);
});

test('worldGeometry treats a disabled element or a disabled ancestor as hidden', () => {
	const own=worldGeometry({path:'child',x:0,y:0,width:20,height:20,enabled:false},[]);
	assert.equal(own.visible,false);
	assert.equal(own.captures,false);
	const inherited=worldGeometry({path:'child',x:0,y:0,width:20,height:20},[{path:'root',x:0,y:0,width:50,height:50,enabled:false}]);
	assert.equal(inherited.visible,false);
	assert.equal(worldGeometry({path:'child',x:0,y:0,width:20,height:20,enabled:true},[]).visible,true);
});

test('worldGeometry applies target and ancestor visibility and opacity', () => {
	const transparent=worldGeometry(
		{path:'child',x:0,y:0,width:20,height:20,opacity:0.5},
		[{path:'root',x:0,y:0,width:30,height:30,opacity:0}],
	);
	assert.equal(transparent.opacity,0);
	assert.equal(transparent.visible,false);
	assert.equal(transparent.captures,false);

	const invisible=worldGeometry(
		{path:'child',x:0,y:0,width:20,height:20,visible:false},
		[],
	);
	assert.equal(invisible.visible,false);
	assert.equal(invisible.captures,false);
});

test('worldGeometry marks non-translation transforms as ambiguous', () => {
	const geometry=worldGeometry(
		{path:'child',x:0,y:0,width:20,height:20},
		[{path:'root',x:0,y:0,width:30,height:30,rotation:15}],
	);
	assert.equal(geometry.ambiguous,true);
	assert.equal(geometry.captures,false);
});

test('geometryChanges converts a world delta back to local numeric geometry', () => {
	const model={variables:{},roots:[{
		id:'parent',type:'frame',width:400,height:300,children:[
			{id:'child',type:'frame',x:10,y:20,width:100,height:40},
		],
	}],rows:[
		{path:'parent',parent_path:null,type:'frame',layout:'none',x:100,y:200,width:400,height:300},
		{path:'child',parent_path:'parent',type:'frame',layout:'none',x:10,y:20,width:100,height:40},
	]};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	const capture={...view,changes:[{path:'child',x:130,y:250,w:120,h:45}]};
	assert.deepEqual(geometryChanges({model,view,capture}),[
		{op:'update',path:'child',props:{x:30,y:50,width:120,height:45}},
	]);
});

test('não transforma movimento de filho em auto-layout em x/y', () => {
	const model={roots:[],variables:{},rows:[
		{path:'parent',parent_path:null,type:'frame',layout:'horizontal',x:0,y:0,width:400,height:100},
		{path:'child',parent_path:'parent',type:'text',x:0,y:0,width:100,height:40},
	]};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	const capture={...view,changes:[{path:'child',x:80,y:20,w:100,h:40}]};
	assert.throws(()=>geometryChanges({model,view,capture}),
		e=>e.code==='GEOMETRY_CONTROLLED_BY_LAYOUT');
});

test('geometryChanges rejects stale view captures', () => {
	const model={roots:[],variables:{},rows:[]};
	const view={view_id:'v',view_generation:2,scene_revision:4};
	for (const capture of [
		{view_id:'other',view_generation:2,scene_revision:4,changes:[]},
		{view_id:'v',view_generation:1,scene_revision:4,changes:[]},
		{view_id:'v',view_generation:2,scene_revision:3,changes:[]},
	]) {
		assert.throws(
			()=>geometryChanges({model,view,capture}),
			error=>error.code==='GEOMETRY_CAPTURE_STALE',
		);
	}
});

test('geometryChanges does not replace an intrinsic size with resolved numbers', () => {
	const model={variables:{},roots:[{
		id:'child',type:'frame',width:'fit_content',height:'fit_content',children:[],
	}],rows:[
		{path:'child',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:100,height:40},
	]};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	const capture={...view,changes:[{path:'child',x:0,y:0,w:120,h:40}]};
	assert.throws(
		()=>geometryChanges({model,view,capture}),
		error=>error.code==='GEOMETRY_SIZE_AMBIGUOUS',
	);
});



test('worldGeometry rejects even tiny non-translation transforms', () => {
	for (const transform of [
		{rotation:0.0004},
		{scaleX:1.0004},
		{scaleY:0.9996},
	]) {
		const geometry=worldGeometry(
			{path:'child',x:0,y:0,width:20,height:20},
			[{path:'root',x:0,y:0,width:30,height:30,...transform}],
		);
		assert.equal(geometry.ambiguous,true);
		assert.equal(geometry.captures,false);
	}
});

test('a resize that keeps the position writes only the size, even inside an auto-layout parent', () => {
	const model={
		roots:[{id:'row',type:'frame',children:[{id:'kid',type:'rectangle',width:20,height:20}]}],
		variables:{},
		rows:[
			{path:'row',parent_path:null,type:'frame',layout:'horizontal',x:0,y:0,width:100,height:40},
			{path:'kid',parent_path:'row',type:'rectangle',x:5,y:5,width:20,height:20},
		],
	};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	const capture={...view,changes:[{path:'kid',x:5,y:5,w:30,h:20}]};
	assert.deepEqual(geometryChanges({model,view,capture}),[{op:'update',path:'kid',props:{width:30}}]);
});

test('geometryChanges refuses a cropped or rotated board shape and ignores an untouched cropped one', () => {
	const model={
		roots:[{id:'clipper',type:'frame',children:[{id:'wide',type:'rectangle',width:200,height:20}]}],
		variables:{},
		rows:[
			{path:'clipper',parent_path:null,type:'frame',x:0,y:0,width:50,height:50,clip:true},
			{path:'wide',parent_path:'clipper',type:'rectangle',x:0,y:0,width:200,height:20},
		],
	};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	const cropped={...view,changes:[{path:'wide',x:10,y:0,w:40,h:20}]};
	assert.throws(()=>geometryChanges({model,view,capture:cropped}),e=>e.code==='GEOMETRY_AMBIGUOUS');
	const rotated={...view,changes:[{path:'clipper',x:0,y:0,w:50,h:50,rotation:15}]};
	assert.throws(()=>geometryChanges({model,view,capture:rotated}),e=>e.code==='GEOMETRY_AMBIGUOUS');
	const untouched={...view,changes:[{path:'clipper',x:0,y:0,w:50,h:50}]};
	assert.deepEqual(geometryChanges({model,view,capture:untouched}),[]);
});

test('a layout refusal points at reordering and an automatic-size refusal at the panel fields', () => {
	const model={
		roots:[{id:'row',type:'frame',children:[{id:'kid',type:'rectangle',width:'fill_container',height:20}]}],
		variables:{},
		rows:[
			{path:'row',parent_path:null,type:'frame',layout:'horizontal',x:0,y:0,width:100,height:40},
			{path:'kid',parent_path:'row',type:'rectangle',x:5,y:5,width:100,height:20},
		],
	};
	const view={view_id:'v',view_generation:1,scene_revision:2};
	for (const [change,code,hint] of [
		[{path:'kid',x:9,y:5,w:100,h:20},'GEOMETRY_CONTROLLED_BY_LAYOUT',/between its siblings/],
		[{path:'kid',x:5,y:5,w:90,h:20},'GEOMETRY_SIZE_AMBIGUOUS',/panel fields/],
	]) {
		assert.throws(()=>geometryChanges({model,view,capture:{...view,changes:[change]}}),
			error=>error.code===code&&hint.test(error.message));
	}
});
