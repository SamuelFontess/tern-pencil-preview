import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendHistory, retainedIds, seekHistory} from '../src/history.mjs';

function index() {
	return {
		version: 1,
		source: {fingerprint: 'source-fingerprint'},
		snapshots: ['a', 'b', 'c'],
		cursor: 1,
		saved_id: 'a',
		revision: 4,
		sizes: {a: 10, b: 10, c: 10},
	};
}

test('new edit after undo discards the old redo branch', () => {
	const next = appendHistory(index(), {id: 'd', bytes: 10});
	assert.deepEqual(next.snapshots, ['a', 'b', 'd']);
	assert.equal(next.cursor, 2);
	assert.equal(next.revision, 5);
	assert.deepEqual(next.sizes, {a: 10, b: 10, d: 10});
	assert.deepEqual(index().snapshots, ['a', 'b', 'c']);
});

test('history permits returning to an earlier content-addressed checkpoint', () => {
	const start = {...index(), snapshots: ['a', 'b'], cursor: 1, sizes: {a: 10, b: 10}};
	const next = appendHistory(start, {id: 'a', bytes: 10});
	assert.deepEqual(next.snapshots, ['a', 'b', 'a']);
	assert.equal(next.cursor, 2);
	assert.deepEqual([...retainedIds(next)].sort(), ['a', 'b']);
});

test('seek moves only the cursor within available history', () => {
	const before = index();
	const undone = seekHistory(before, 'undo');
	const redone = seekHistory(undone, 'redo');
	assert.equal(undone.cursor, 0);
	assert.equal(redone.cursor, 1);
	assert.equal(seekHistory({...before, cursor: 0}, 'undo').cursor, 0);
	assert.equal(seekHistory({...before, cursor: 2}, 'redo').cursor, 2);
	assert.equal(before.revision, 4);
});

test('retained ids include every indexed checkpoint and the saved checkpoint outside the branch', () => {
	const ids = retainedIds({
		version: 1,
		source: {fingerprint: 'source-fingerprint'},
		snapshots: ['current', 'redo'],
		cursor: 0,
		saved_id: 'saved-elsewhere',
		revision: 8,
		sizes: {current: 10, redo: 10, 'saved-elsewhere': 10},
	});
	assert.deepEqual([...ids].sort(), ['current', 'redo', 'saved-elsewhere']);
});
