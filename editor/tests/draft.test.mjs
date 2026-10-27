import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newTextDraft, editDraft, keyEdit, undoDraft, cancelDraft, draftOperation} from '../src/draft.mjs';
import {EditorError} from '../src/errors.mjs';

test('newTextDraft creates draft with initial values', () => {
	const draft = newTextDraft({
		session_id: 'sess1',
		base_revision: 5,
		path: 'pages/1',
		property: 'content',
		value: 'Hello world'
	});
	assert.strictEqual(draft.session_id, 'sess1');
	assert.strictEqual(draft.base_revision, 5);
	assert.strictEqual(draft.path, 'pages/1');
	assert.strictEqual(draft.property, 'content');
	assert.strictEqual(draft.text, 'Hello world');
	assert.strictEqual(draft.original, 'Hello world');
	assert.deepEqual(draft.history, []);
	assert.strictEqual(draft.conflict, false);
});

test('editDraft applies edit and updates cursor', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const edited = editDraft(draft, {from: 5, to: 5, len: 5, text: ' world', cursor: 11});
	assert.strictEqual(edited.text, 'Hello world');
	assert.strictEqual(edited.cursor, 11);
	assert.strictEqual(edited.history.length, 1);
});

test('editDraft handles UTF-16 correctly', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 2, path: 't', property: 'content', value: 'A😀éZ'
	});
	//😀 is 2 code units in UTF-16
	// positions: A(0) 😀(1-2) é(3-4) Z(5)
	// replace positions 1-3 (😀é) with 'ã'
	const next = editDraft(draft, {from: 1, to: 3, len: 5, text: 'ã', cursor: 2});
	assert.strictEqual(next.text, 'AãéZ', 'UTF-16 replacement should work');
});

test('undoDraft reverts to previous state', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 2, path: 't', property: 'content', value: 'A😀éZ'
	});
	const edited = editDraft(draft, {from: 1, to: 3, len: 5, text: 'ã', cursor: 2});
	const undone = undoDraft(edited);
	assert.strictEqual(undone.text, 'A😀éZ', 'undo should restore original');
	assert.strictEqual(undone.history.length, 0, 'history should be cleared after undo');
});

test('undoDraft on fresh draft returns same draft', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const undone = undoDraft(draft);
	assert.strictEqual(undone, draft, 'undo on fresh draft returns same object');
});

test('cancelDraft returns to original value', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Original'
	});
	const edited = editDraft(draft, {from: 0, to: 8, len: 8, text: 'Modified', cursor: 8});
	const cancelled = cancelDraft(edited);
	assert.strictEqual(cancelled.text, 'Original');
	assert.strictEqual(cancelled.history.length, 0);
	assert.strictEqual(cancelled.conflict, false);
});

test('cancelDraft on fresh draft returns fresh draft', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const cancelled = cancelDraft(draft);
	assert.strictEqual(cancelled.text, 'Hello');
	assert.strictEqual(cancelled.history.length, 0);
});

test('editDraft with divergent len marks conflict', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello world'
	});
	// The field thought the text was 5 chars but it's actually 11
	// Using len=5 which differs from draft.text.length=11 triggers conflict
	const edited = editDraft(draft, {from: 0, to: 3, len: 5, text: 'Hi', cursor: 2});
	assert.strictEqual(edited.text, 'Hello world', 'local text should be preserved');
	assert.strictEqual(edited.conflict, true, 'should mark conflict');
});

test('draftOperation returns update operation when changed', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'pages/1', property: 'text', value: 'Old'
	});
	const edited = editDraft(draft, {from: 0, to: 3, len: 3, text: 'New', cursor: 3});
	const op = draftOperation(edited, 1);
	assert.deepEqual(op, {
		op: 'update',
		path: 'pages/1',
		props: {text: 'New'}
	});
});

test('draftOperation returns null when no effective change', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const op = draftOperation(draft, 1);
	assert.strictEqual(op, null, 'no operation when text unchanged');
});

test('draftOperation throws DRAFT_STALE on revision mismatch', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const edited = editDraft(draft, {from: 0, to: 5, len: 5, text: 'World', cursor: 5});
	assert.throws(
		() => draftOperation(edited, 2), // currentRevision !== base_revision
		e => e.code === 'DRAFT_STALE' && e instanceof EditorError
	);
});

test('draftOperation works with matching revision', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const edited = editDraft(draft, {from: 0, to: 5, len: 5, text: 'World', cursor: 5});
	const op = draftOperation(edited, 1);
	assert.strictEqual(op.props.t, 'World');
});

test('multiline text is preserved', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Line1\nLine2\nLine3'
	});
	// 'Line1\nLine2\nLine3' = 17 chars, insert at position 6 (after first \n)
	const edited = editDraft(draft, {from: 6, to: 6, len: 17, text: 'New\n', cursor: 10});
	assert.strictEqual(edited.text, 'Line1\nNew\nLine2\nLine3');
	const cancelled = cancelDraft(edited);
	assert.strictEqual(cancelled.text, 'Line1\nLine2\nLine3');
});

test('draft is fixed to path/property - cannot change target', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p1', property: 't1', value: 'A'
	});
	const edited = editDraft(draft, {from: 0, to: 1, len: 1, text: 'B', cursor: 1});
	assert.strictEqual(edited.path, 'p1', 'path should not change');
	assert.strictEqual(edited.property, 't1', 'property should not change');
});

test('UTF-16 emoji pair test from brief', () => {
	// This is the exact test case from the brief
	const d = newTextDraft({session_id: 's', base_revision: 2, path: 't', property: 'content', value: 'A😀éZ'});
	const next = editDraft(d, {from: 1, to: 3, len: 5, text: 'ã', cursor: 2});
	assert.strictEqual(next.text, 'AãéZ');
	assert.strictEqual(undoDraft(next).text, 'A😀éZ');
	assert.throws(() => draftOperation(next, 3), e => e.code === 'DRAFT_STALE');
});

// --- Fix 1: Range validation tests ---

test('editDraft throws DRAFT_RANGE when from > to', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	assert.throws(
		() => editDraft(draft, {from: 5, to: 2, len: 5, text: 'X', cursor: 2}),
		e => e.code === 'DRAFT_RANGE' && e instanceof EditorError
	);
});

test('editDraft throws DRAFT_RANGE for negative from', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	assert.throws(
		() => editDraft(draft, {from: -1, to: 2, len: 5, text: 'X', cursor: 2}),
		e => e.code === 'DRAFT_RANGE' && e instanceof EditorError
	);
});

test('editDraft throws DRAFT_RANGE for fractional values', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	assert.throws(
		() => editDraft(draft, {from: 1.5, to: 3, len: 5, text: 'X', cursor: 2}),
		e => e.code === 'DRAFT_RANGE' && e instanceof EditorError
	);
});

test('editDraft throws DRAFT_RANGE when to exceeds text length', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hi'
	});
	assert.throws(
		() => editDraft(draft, {from: 0, to: 10, len: 2, text: 'X', cursor: 1}),
		e => e.code === 'DRAFT_RANGE' && e instanceof EditorError
	);
});

test('editDraft throws DRAFT_RANGE when range splits surrogate pair', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'A😀Z'
	});
	// 😀 is at positions 1-2, trying to cut at position 1 splits it
	assert.throws(
		() => editDraft(draft, {from: 1, to: 2, len: 4, text: 'B', cursor: 1}),
		e => e.code === 'DRAFT_RANGE' && e instanceof EditorError
	);
});

// --- Fix 2: undoDraft restores cursor ---

test('undoDraft restores cursor from history', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello world'
	});
	// Set cursor to 5 first
	const withCursor = editDraft(draft, {from: 5, to: 5, len: 11, text: '', cursor: 5});
	assert.strictEqual(withCursor.cursor, 5);
	// Edit shortens text
	const edited = editDraft(withCursor, {from: 0, to: 11, len: 11, text: 'Hi', cursor: 2});
	assert.strictEqual(edited.text, 'Hi');
	assert.strictEqual(edited.cursor, 2);
	// Undo should restore cursor to previous position (5)
	const undone = undoDraft(edited);
	assert.strictEqual(undone.text, 'Hello world');
	assert.strictEqual(undone.cursor, 5, 'cursor should be restored to previous position');
	assert.ok(undone.cursor <= undone.text.length, 'cursor should be <= text length');
});

// --- Fix 3: conflict preserves local cursor ---

test('conflict preserves local cursor', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello world'
	});
	// Create edit with a different len (10 instead of 11) to trigger conflict
	const edited = editDraft(draft, {from: 0, to: 3, len: 10, text: 'Hi', cursor: 5});
	assert.strictEqual(edited.conflict, true, 'should be in conflict');
	// Cursor should be preserved from the local draft (0 by default)
	assert.strictEqual(edited.cursor, 0, 'local cursor should be preserved');
});

test('conflict preserves local cursor when draft has existing cursor', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello world'
	});
	// Set cursor via edit first
	const withCursor = editDraft(draft, {from: 5, to: 5, len: 11, text: '', cursor: 10});
	assert.strictEqual(withCursor.cursor, 10);
	// Now trigger conflict with different len
	const edited = editDraft(withCursor, {from: 0, to: 3, len: 5, text: 'Hi', cursor: 5});
	assert.strictEqual(edited.conflict, true);
	assert.strictEqual(edited.cursor, 10, 'local cursor should be preserved in conflict');
});


test('conflict persists through a valid edit and undo until cancel', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const conflicted = editDraft(draft, {from: 0, to: 1, len: 4, text: 'Y', cursor: 1});
	const edited = editDraft(conflicted, {from: 0, to: 1, len: 5, text: 'Y', cursor: 1});
	assert.strictEqual(edited.conflict, true);
	assert.strictEqual(undoDraft(edited).conflict, true);
	assert.strictEqual(cancelDraft(edited).conflict, false);
});

test('draftOperation rejects a conflicted draft, after checking staleness', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const conflicted = editDraft(draft, {from: 0, to: 1, len: 4, text: 'Y', cursor: 1});
	assert.throws(() => draftOperation(conflicted, 1), e => e.code === 'DRAFT_CONFLICT');
	assert.throws(() => draftOperation(conflicted, 2), e => e.code === 'DRAFT_STALE');
});

test('editDraft clamps cursor to the resulting text bounds', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	assert.strictEqual(editDraft(draft, {from: 0, to: 5, len: 5, text: 'Hi', cursor: 100}).cursor, 2);
	assert.strictEqual(editDraft(draft, {from: 0, to: 5, len: 5, text: 'Hi', cursor: -5}).cursor, 0);
});

test('undoDraft restores a cursor within the restored text bounds', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const first = editDraft(draft, {from: 0, to: 0, len: 5, text: '', cursor: 100});
	const shortened = editDraft(first, {from: 0, to: 5, len: 5, text: 'Hi', cursor: 2});
	const undone = undoDraft(shortened);
	assert.strictEqual(undone.cursor, 5);
	assert.ok(undone.cursor <= undone.text.length);
});


test('cancelDraft clamps the cursor to the original text', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hi'
	});
	const edited = editDraft(draft, {from: 2, to: 2, len: 2, text: ' there', cursor: 8});
	const cancelled = cancelDraft(edited);
	assert.strictEqual(cancelled.text, 'Hi');
	assert.strictEqual(cancelled.cursor, 2);
	assert.ok(cancelled.cursor <= cancelled.original.length);
	assert.strictEqual(cancelled.conflict, false);
});

test('len divergence takes precedence over an invalid edit range', () => {
	const draft = newTextDraft({
		session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'
	});
	const conflicted = editDraft(draft, {from: 4, to: 1, len: 4, text: 'X', cursor: 1});
	assert.strictEqual(conflicted.text, 'Hello');
	assert.strictEqual(conflicted.conflict, true);
});
test('a caret-only edit moves the caret and is not an undo step', () => {
	const draft = newTextDraft({session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'Hello'});
	const typed = editDraft(draft, {from: 5, to: 5, len: 5, text: '!', cursor: 6});
	const moved = editDraft(typed, {from: 2, to: 2, len: 6, text: '', cursor: 2});
	assert.strictEqual(moved.cursor, 2);
	assert.strictEqual(moved.history.length, 1);
	assert.strictEqual(undoDraft(moved).text, 'Hello');
});

test('keyEdit turns typing, deletes and arrows into edits that never split an emoji', () => {
	const at = (value, cursor) => ({...newTextDraft({session_id: 's', base_revision: 1, path: 'p', property: 't', value}), cursor});
	const apply = (draft, key, options) => editDraft(draft, keyEdit(draft, key, options));
	const typed = apply(at('A😀Z', 3), {name: 'b', text: 'b'});
	assert.deepStrictEqual([typed.text, typed.cursor], ['A😀bZ', 4]);
	const removed = apply(at('A😀Z', 3), {name: 'backspace'});
	assert.deepStrictEqual([removed.text, removed.cursor], ['AZ', 1]);
	const forward = apply(at('A😀Z', 1), {name: 'delete'});
	assert.deepStrictEqual([forward.text, forward.cursor], ['AZ', 1]);
	assert.strictEqual(apply(at('A😀Z', 1), {name: 'right'}).cursor, 3);
	assert.strictEqual(apply(at('A😀Z', 3), {name: 'left'}).cursor, 1);
	assert.strictEqual(apply(at('abc', 0), {name: 'paste', text: 'x\ny'}).text, 'x yabc');
	assert.strictEqual(apply(at('abc', 3), {name: 'enter'}, {multiline: true}).text, 'abc\n');
	assert.strictEqual(apply(at('abc', 0), {name: 'paste', text: 'x\ny'}, {multiline: true}).text, 'x\nyabc');
});

test('keyEdit ignores keys that are not text for the field', () => {
	const draft = {...newTextDraft({session_id: 's', base_revision: 1, path: 'p', property: 't', value: 'abc'}), cursor: 0};
	for (const key of [
		{name: 'backspace'}, {name: 'left'}, {name: 'enter'}, {name: 'tab'}, {name: 'escape'}, {name: 'x', text: '\u001b'},
		{name: 'a', text: 'a', ctrl: true}, {name: 'a', text: 'a', meta: true}, {name: 'f5'},
	]) {
		assert.strictEqual(keyEdit(draft, key), null, JSON.stringify(key));
	}
	assert.strictEqual(keyEdit({...draft, cursor: 3}, {name: 'delete'}), null);
	assert.strictEqual(keyEdit({...draft, cursor: 3}, {name: 'right'}), null);
});
