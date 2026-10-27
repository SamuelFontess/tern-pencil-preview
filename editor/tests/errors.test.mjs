import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorError} from '../src/errors.mjs';

test('EditorError preserves code, message, details and name', () => {
	const error = new EditorError('X', 'msg', {a: 1});
	assert.ok(error instanceof Error);
	assert.strictEqual(error.code, 'X');
	assert.strictEqual(error.message, 'msg');
	assert.deepEqual(error.details, {a: 1});
	assert.strictEqual(error.name, 'EditorError');
});
