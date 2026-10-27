import {EditorError} from './errors.mjs';

/**
 * @typedef {{snapshots:string[], cursor:number, saved_id:string, revision:number,
 * sizes:Record<string,number>, [key:string]: unknown}} HistoryIndex
 */

/**
 * @param {HistoryIndex} index
 * @returns {HistoryIndex}
 */
function copyIndex(index) {
	return {
		...index,
		snapshots: [...index.snapshots],
		sizes: {...index.sizes},
	};
}

/**
 * @param {HistoryIndex} index
 * @returns {Set<string>}
 */
export function retainedIds(index) {
	return new Set([...index.snapshots, index.saved_id]);
}

/**
 * @param {HistoryIndex} index
 * @param {{id:string, bytes:number}} checkpoint
 * @returns {HistoryIndex}
 */
export function appendHistory(index, checkpoint) {
	if (typeof checkpoint.id !== 'string' || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < 0) {
		throw new EditorError('CHECKPOINT_INVALID', 'Checkpoint metadata is invalid');
	}

	const next = copyIndex(index);
	next.snapshots = next.snapshots.slice(0, next.cursor + 1);
	next.snapshots.push(checkpoint.id);
	next.cursor = next.snapshots.length - 1;
	next.revision += 1;
	next.sizes[checkpoint.id] = checkpoint.bytes;

	const retained = retainedIds(next);
	for (const id of Object.keys(next.sizes)) {
		if (!retained.has(id)) delete next.sizes[id];
	}
	return next;
}

/**
 * @param {HistoryIndex} index
 * @param {'undo'|'redo'} direction
 * @returns {HistoryIndex}
 */
export function seekHistory(index, direction) {
	if (direction !== 'undo' && direction !== 'redo') {
		throw new EditorError('HISTORY_DIRECTION_INVALID', 'History direction must be undo or redo');
	}

	const next = copyIndex(index);
	if (direction === 'undo') next.cursor = Math.max(0, next.cursor - 1);
	else next.cursor = Math.min(next.snapshots.length - 1, next.cursor + 1);
	return next;
}
