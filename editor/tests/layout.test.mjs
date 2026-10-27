import assert from 'node:assert/strict';
import {test} from 'node:test';
import {layoutOf,normalizeRow,placedByLayout} from '../src/layout.mjs';

test('a frame whose layout the engine left out is horizontal, every other node has none', () => {
	assert.equal(layoutOf({type:'frame'}),'horizontal');
	assert.equal(layoutOf({type:'frame',layout:null}),'horizontal');
	assert.equal(layoutOf({type:'frame',layout:'vertical'}),'vertical');
	assert.equal(layoutOf({type:'frame',layout:'none'}),'none');
	assert.equal(layoutOf({type:'group'}),'none');
	assert.equal(layoutOf({type:'rectangle'}),'none');
	assert.equal(layoutOf(undefined),'none');
});

test('normalizeRow names the layout and leaves the rest of the row alone', () => {
	const row={path:'a',type:'frame',layout:null,x:1};
	assert.deepEqual(normalizeRow(row),{path:'a',type:'frame',layout:'horizontal',x:1});
	assert.equal(row.layout,null,'the engine row is not changed');
});

test('a layout places a child unless the child is detached from it', () => {
	const stack={type:'frame',layout:'vertical'};
	assert.equal(placedByLayout(stack,{type:'rectangle'}),true);
	assert.equal(placedByLayout(stack,{type:'rectangle',layout_position:'absolute'}),false);
	assert.equal(placedByLayout(stack,{type:'rectangle',layout_position:'auto'}),true);
	assert.equal(placedByLayout({type:'frame'},{type:'rectangle'}),true,'a frame with no layout key lays out horizontally');
	assert.equal(placedByLayout({type:'frame',layout:'none'},{type:'rectangle'}),false);
	assert.equal(placedByLayout({type:'group'},{type:'rectangle'}),false);
	assert.equal(placedByLayout(undefined,{type:'frame'}),false,'a top-level node has no parent to place it');
	assert.equal(placedByLayout(null,{type:'frame'}),false);
});
