import {EditorError} from './errors.mjs';

/**
 * Creates a new text draft for editing a property value.
 * Pure function - returns a new draft object without mutating input.
 * @param {Object} opts
 * @param {string} opts.session_id - Session identifier
 * @param {number} opts.base_revision - Base document revision
 * @param {string} opts.path - Node path in document
 * @param {string} opts.property - Property name being edited
 * @param {string} opts.value - Current text value
 * @returns {Object} New draft object
 */
export function newTextDraft({session_id, base_revision, path, property, value}) {
	return {
		session_id,
		base_revision,
		path,
		property,
		text: value,
		original: value,
		cursor: 0,
		history: [],
		conflict: false
	};
}

/**
 * Validates that a UTF-16 index is not in the middle of a surrogate pair.
 * @param {string} text - Text to check
 * @param {number} index - Index to validate
 * @returns {boolean} True if index is valid (not splitting a surrogate pair)
 */
function isValidUtf16Index(text, index) {
	if (index < 0 || index > text.length) return false;
	if (index === 0 || index === text.length) return true;
	const code = text.charCodeAt(index);
	// Check if index is between a high surrogate and low surrogate
	return !(code >= 0xDC00 && code <= 0xDFFF);
}

/**
 * Normalizes a cursor to a UTF-16 offset within text.
 * @param {number} cursor - Cursor offset
 * @param {string} text - Text containing the cursor
 * @returns {number} Cursor within the text bounds
 */
function clampCursor(cursor, text) {
	if (!Number.isFinite(cursor)) return 0;
	return Math.min(Math.max(Math.trunc(cursor), 0), text.length);
}

/**
 * Validates edit range parameters.
 * @param {Object} draft - Current draft
 * @param {number} from - Start position
 * @param {number} to - End position
 * @throws {EditorError} If validation fails
 */
function validateRange(draft, from, to) {
	// Must be integers
	if (!Number.isInteger(from) || !Number.isInteger(to)) {
		throw new EditorError('DRAFT_RANGE', 'from and to must be integers');
	}

	// Bounds check
	if (from < 0 || to > draft.text.length || from > to) {
		throw new EditorError('DRAFT_RANGE', `invalid range: ${from} to ${to} for text of length ${draft.text.length}`);
	}

	// Check for surrogate pair boundary
	if (!isValidUtf16Index(draft.text, from) || !isValidUtf16Index(draft.text, to)) {
		throw new EditorError('DRAFT_RANGE', 'range cannot split UTF-16 surrogate pair');
	}
}

/**
 * Applies an edit to a draft.
 * Pure function - returns a new draft object without mutating input.
 * Offsets are UTF-16 (JavaScript string indices).
 * @param {Object} draft - Current draft
 * @param {Object} edit - Edit operation
 * @param {number} edit.from - Start position (UTF-16 index)
 * @param {number} edit.to - End position (UTF-16 index)
 * @param {number} edit.len - Length (UTF-16) the field thought the text had
 * @param {string} edit.text - Replacement text
 * @param {number} edit.cursor - New cursor position
 * @returns {Object} New draft with edit applied
 * @throws {EditorError} If range is invalid
 */
export function editDraft(draft, {from, to, len, text, cursor}) {
	// Check for divergence: if len doesn't match the current draft text length,
	// the UI and draft have different understanding of the text state.
	// This can happen if the document changed externally.
	if (len !== draft.text.length) {
		return {
			...draft,
			cursor: clampCursor(draft.cursor, draft.text),
			conflict: true
		};
	}

	validateRange(draft, from, to);

	// Tern placing the caret (empty replacement at one point) is not a change, so Undo must not step over it.
	if (text === '' && from === to) {
		return {...draft, cursor: clampCursor(cursor, draft.text)};
	}

	const before = draft.text.slice(0, from);
	const after = draft.text.slice(to);
	const newText = before + text + after;
	const newHistory = [
		...draft.history,
		{text: draft.text, cursor: clampCursor(draft.cursor, draft.text)}
	];

	return {
		...draft,
		text: newText,
		cursor: clampCursor(cursor, newText),
		history: newHistory,
		conflict: draft.conflict
	};
}

/**
 * Undoes the last edit in a draft.
 * Pure function - returns a new draft or the same draft if no history.
 * Restores cursor to the value from the state being restored.
 * @param {Object} draft - Current draft
 * @returns {Object} New draft with last edit undone
 */
export function undoDraft(draft) {
	if (draft.history.length === 0) {
		return draft;
	}

	const lastEntry = draft.history[draft.history.length - 1];
	const previousText = typeof lastEntry === 'string' ? lastEntry : lastEntry.text;
	const previousCursor = typeof lastEntry === 'object' ? lastEntry.cursor : draft.cursor;
	const newHistory = draft.history.slice(0, -1);

	return {
		...draft,
		text: previousText,
		cursor: clampCursor(previousCursor, previousText),
		history: newHistory,
		conflict: draft.conflict
	};
}

/**
 * Cancels the draft and returns to original value.
 * Pure function - returns a new draft reset to original.
 * @param {Object} draft - Current draft
 * @returns {Object} New draft reset to original value
 */
export function cancelDraft(draft) {
	return {
		...draft,
		text: draft.original,
		cursor: clampCursor(draft.cursor, draft.original),
		history: [],
		conflict: false
	};
}

const isHigh = code => code >= 0xD800 && code <= 0xDBFF;
const isLow = code => code >= 0xDC00 && code <= 0xDFFF;

/**
 * Turns a pty key into the edit Tern would have sent for it. Tern edits nothing itself: typing, deletes and plain
 * arrows reach the program as keys (only selections, drawn-line moves and clicks come as `edit` events).
 * Pure function - returns an edit for `editDraft`, or null when the key is not a text key.
 * @param {Object} draft - Current draft
 * @param {{name?:string,text?:string,ctrl?:boolean,alt?:boolean,meta?:boolean}} key
 * @param {{multiline?:boolean}} [options]
 * @returns {{from:number,to:number,len:number,text:string,cursor:number}|null}
 */
export function keyEdit(draft, key, {multiline = false} = {}) {
	const text = draft.text;
	const at = clampCursor(draft.cursor, text);
	const edit = (from, to, insert, cursor) => ({from, to, len: text.length, text: insert, cursor});
	const back = at >= 2 && isHigh(text.charCodeAt(at - 2)) && isLow(text.charCodeAt(at - 1)) ? 2 : 1;
	const forward = isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
	if (!key.ctrl && !key.alt && !key.meta) {
		switch (key.name) {
			case 'backspace': return at > 0 ? edit(at - back, at, '', at - back) : null;
			case 'delete': return at < text.length ? edit(at, at + forward, '', at) : null;
			case 'left': return at > 0 ? edit(at - back, at - back, '', at - back) : null;
			case 'right': return at < text.length ? edit(at + forward, at + forward, '', at + forward) : null;
			case 'enter': return multiline ? edit(at, at, '\n', at + 1) : null;
		}
	}
	if ((key.ctrl && !key.alt) || key.meta || typeof key.text !== 'string') return null;
	let inserted = key.text.replace(/\r\n?/g, '\n');
	if (!multiline) inserted = inserted.replaceAll('\n', ' ');
	if (inserted === '' || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(inserted)) return null;
	return edit(at, at, inserted, at + inserted.length);
}

/**
 * Generates a document operation from a draft if there are changes.
 * Pure function - returns operation object, null, or throws EditorError.
 * @param {Object} draft - Current draft
 * @param {number} currentRevision - Current document revision
 * @returns {Object|null} Operation object or null if no effective change
 * @throws {EditorError} If currentRevision doesn't match draft's base_revision
 */
export function draftOperation(draft, currentRevision) {
	// Check revision - must match for operation to be valid
	if (currentRevision !== draft.base_revision) {
		throw new EditorError(
			'DRAFT_STALE',
			`Draft base revision ${draft.base_revision} does not match current revision ${currentRevision}`
		);
	}

	if (draft.conflict) {
		throw new EditorError('DRAFT_CONFLICT', 'Draft has a pending text conflict');
	}

	// No effective change - return null
	if (draft.text === draft.original) {
		return null;
	}

	// Return update operation
	return {
		op: 'update',
		path: draft.path,
		props: {
			[draft.property]: draft.text
		}
	};
}