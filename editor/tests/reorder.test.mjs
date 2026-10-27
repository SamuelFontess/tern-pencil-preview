import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reorderIndex} from '../src/reorder.mjs';

// Three 40-wide siblings with a 10 gap: centres at 20, 70 and 120.
const across=[
	{path:'a',x:0,y:0,width:40,height:40},
	{path:'b',x:50,y:0,width:40,height:40},
	{path:'c',x:100,y:0,width:40,height:40},
];
// The same three stacked: centres at y 20, 70 and 120.
const down=across.map(({path,x,width,height})=>({path,x:0,y:x,width:height,height:width}));
const row={x:0,y:0,width:300,height:40};
const column={x:0,y:0,width:100,height:300};

function drop(centre,size=40) {
	return {x:centre-size/2,y:0,width:size,height:40};
}

test('a horizontal child dropped past the next sibling takes its place', () => {
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(80)}),1);
});

test('dropped before every sibling it becomes the first, after every sibling the last', () => {
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'c',dropped:drop(5)}),0);
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(250)}),2);
});

test('a drop in the middle lands between its neighbours, and the gap counts as space between them', () => {
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'c',dropped:drop(40)}),1);
	// The centre sits in the gap between b (ends at 90) and c (starts at 100).
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(95)}),1);
});

test('a vertical child is placed along the vertical axis only', () => {
	const dropped=(centre)=>({x:0,y:centre-20,width:40,height:40});
	assert.equal(reorderIndex({layout:'vertical',parent:column,siblings:down,path:'a',dropped:dropped(80)}),1);
	assert.equal(reorderIndex({layout:'vertical',parent:column,siblings:down,path:'c',dropped:dropped(10)}),0);
	// Far to the side inside the parent changes nothing on the vertical axis.
	assert.equal(reorderIndex({layout:'vertical',parent:column,siblings:down,path:'a',dropped:{x:30,y:-10,width:40,height:40}}),null);
});

test('the same index or a centre outside the parent is no reorder', () => {
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'b',dropped:drop(75)}),null);
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(5)}),null);
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(400)}),null);
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:{x:80,y:100,width:40,height:40}}),null);
	// Only the centre has to be inside: an edge hanging out is fine.
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:across,path:'a',dropped:drop(290,100)}),2);
});

test('a disabled or absolute sibling never decides where the child lands, but still takes a place in the index', () => {
	for (const odd of [{enabled:false},{absolute:true}]) {
		const siblings=[
			{path:'a',x:0,y:0,width:40,height:40},
			{path:'odd',x:0,y:0,width:40,height:40,...odd},
			{path:'b',x:50,y:0,width:40,height:40},
		];
		const label=JSON.stringify(odd);
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings,path:'a',dropped:drop(80)}),2,label);
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings,path:'b',dropped:drop(10)}),0,label);
		// Centre 15 is before the odd one's centre (20): it makes no difference to where a lands.
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings,path:'b',dropped:drop(15)}),0,label);
	}
});

test('a nudge that only passes siblings which are no landing spot changes nothing, forward or backward', () => {
	for (const odd of [{enabled:false},{absolute:true}]) {
		const forward=[
			{path:'a',x:0,y:0,width:40,height:40},
			{path:'odd',x:20,y:0,width:40,height:40,...odd},
			{path:'b',x:70,y:0,width:40,height:40},
		];
		const label=JSON.stringify(odd);
		// a is nudged right, still before b's centre (90): it keeps its place.
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:forward,path:'a',dropped:drop(30)}),null,label);
		const backward=[
			{path:'b',x:0,y:0,width:40,height:40},
			{path:'odd',x:20,y:0,width:40,height:40,...odd},
			{path:'a',x:70,y:0,width:40,height:40},
		];
		// a is nudged left, still after b's centre (20): it keeps its place.
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:backward,path:'a',dropped:drop(80)}),null,label);
		// Past b's centre both ways is a real reorder.
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:forward,path:'a',dropped:drop(120)}),2,label);
		assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:backward,path:'a',dropped:drop(5)}),0,label);
	}
});

test('a sibling that is laid out but invisible (opacity 0, clipped away) is a slot like any other', () => {
	// What the board shows as `visible:false` still occupies its place in the layout.
	const ghost={path:'ghost',x:20,y:0,width:40,height:40,visible:false};
	const forward=[{path:'a',x:0,y:0,width:40,height:40},ghost,{path:'b',x:70,y:0,width:40,height:40}];
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:forward,path:'a',dropped:drop(50)}),1,'forward, past the ghost');
	const backward=[{path:'b',x:0,y:0,width:40,height:40},ghost,{path:'a',x:70,y:0,width:40,height:40}];
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:backward,path:'a',dropped:drop(30)}),1,'backward, onto the ghost');
});

test('a lone child has nowhere to go', () => {
	assert.equal(reorderIndex({layout:'horizontal',parent:row,siblings:[across[0]],path:'a',dropped:drop(200)}),null);
});
