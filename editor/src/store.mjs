import {createHash, randomUUID} from 'node:crypto';
import {link, mkdir, open, readFile, rename, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {EditorError} from './errors.mjs';
import {retainedIds} from './history.mjs';

const CHECKPOINT_SUFFIX = '.checkpoint';
const INDEX_NAME = 'index.json';

/**
 * @typedef {{id:string, bytes:number}} CheckpointRef
 * @typedef {{version:1, source:{fingerprint:string}, snapshots:string[], cursor:number,
 * saved_id:string, revision:number, sizes:Record<string,number>, [key:string]: unknown}} HistoryIndex
 */

/** @param {Buffer} bytes */
function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/** @param {unknown} value */
function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {HistoryIndex} index */
function copyIndex(index) {
	return {
		...index,
		source: {...index.source},
		snapshots: [...index.snapshots],
		sizes: {...index.sizes},
	};
}

/** @param {string} id */
function assertCheckpointId(id) {
	if (!/^[a-f0-9]{64}$/.test(id)) {
		throw new EditorError('CHECKPOINT_INVALID', 'Checkpoint id is invalid');
	}
}

/** @param {string} path @param {Buffer|string} data */
async function writeDurable(path, data) {
	const handle = await open(path, 'wx', 0o600);
	try {
		await handle.writeFile(data);
		await handle.sync();
		return (await handle.stat()).size;
	} finally {
		await handle.close();
	}
}

/** @param {string} path */
async function unlinkIfExists(path) {
	try {
		await unlink(path);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
}

/** @param {unknown} value @returns {HistoryIndex} */
function validateIndex(value) {
	if (!isObject(value)
		|| value.version !== 1
		|| !isObject(value.source)
		|| typeof value.source.fingerprint !== 'string'
		|| value.source.fingerprint.length === 0
		|| !Array.isArray(value.snapshots)
		|| typeof value.saved_id !== 'string'
		|| !Number.isSafeInteger(value.cursor)
		|| !Number.isSafeInteger(value.revision)
		|| !isObject(value.sizes)) {
		throw new EditorError('INDEX_INVALID', 'History index is incomplete');
	}
	if (value.revision < 0
		|| value.cursor < 0
		|| value.cursor >= value.snapshots.length
		|| value.snapshots.some(id => typeof id !== 'string')) {
		throw new EditorError('INDEX_INVALID', 'History index has invalid history entries');
	}

	for (const id of retainedIds(/** @type {HistoryIndex} */ (value))) {
		try {
			assertCheckpointId(id);
		} catch {
			throw new EditorError('INDEX_INVALID', 'History index has invalid checkpoint ids');
		}
		if (!Object.hasOwn(value.sizes, id) || !Number.isSafeInteger(value.sizes[id]) || value.sizes[id] < 0) {
			throw new EditorError('INDEX_INVALID', 'History index has invalid checkpoint sizes');
		}
	}
	return copyIndex(/** @type {HistoryIndex} */ (value));
}

/**
 * @param {string} dir
 * @param {HistoryIndex} index
 */
async function validateCheckpointFiles(dir, index) {
	for (const id of retainedIds(index)) {
		let details;
		try {
			details = await stat(join(dir, `${id}${CHECKPOINT_SUFFIX}`));
		} catch (error) {
			if (error?.code === 'ENOENT') {
				throw new EditorError('INDEX_INVALID', 'History index references a missing checkpoint');
			}
			throw error;
		}
		if (!details.isFile() || details.size !== index.sizes[id]) {
			throw new EditorError('INDEX_INVALID', 'History index checkpoint size does not match');
		}
	}
}

/**
 * @param {HistoryIndex} index
 * @param {number} maxSteps
 * @param {number} maxBytes
 * @returns {HistoryIndex}
 */
function applyRetention(index, maxSteps, maxBytes) {
	const counts = new Map();
	for (const id of index.snapshots) counts.set(id, (counts.get(id) ?? 0) + 1);

	const keptIds = retainedIds(index);
	let bytes = 0;
	for (const id of keptIds) bytes += index.sizes[id];

	let first = 0;
	while ((index.snapshots.length - first > maxSteps || bytes > maxBytes) && first < index.cursor) {
		const id = index.snapshots[first];
		counts.set(id, counts.get(id) - 1);
		if (counts.get(id) === 0 && id !== index.saved_id) bytes -= index.sizes[id];
		first += 1;
	}

	const snapshots = index.snapshots.slice(first);
	const cursor = index.cursor - first;
	const sizes = {};
	for (const id of new Set([...snapshots, index.saved_id])) sizes[id] = index.sizes[id];
	return {
		...index,
		snapshots,
		cursor,
		sizes,
	};
}

class Store {
	/**
	 * @param {{dir:string, max_steps:number, max_bytes:number}} options
	 * @param {HistoryIndex|null} index
	 */
	constructor(options, index) {
		this.dir = options.dir;
		this.maxSteps = options.max_steps;
		this.maxBytes = options.max_bytes;
		this.index = index;
		this.prunable = new Set();
		this.mutationTail = Promise.resolve();
	}

	/**
	 * @template T
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<T>}
	 */
	runMutation(operation) {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	/** @param {string} id */
	checkpointPath(id) {
		assertCheckpointId(id);
		return join(this.dir, `${id}${CHECKPOINT_SUFFIX}`);
	}

	/** @param {Buffer} bytes @returns {Promise<CheckpointRef>} */
	async put(bytes) {
		if (!Buffer.isBuffer(bytes)) {
			throw new EditorError('CHECKPOINT_INVALID', 'Checkpoint bytes must be a Buffer');
		}

		const expectedBytes = bytes.length;
		const id = sha256(bytes);
		const path = this.checkpointPath(id);
		const pending = join(this.dir, `${randomUUID()}.ckpt-pending`);
		try {
			const writtenBytes = await writeDurable(pending, bytes);
			if (writtenBytes !== expectedBytes) {
				throw new EditorError('CHECKPOINT_WRITE_FAILED', 'Checkpoint write was incomplete');
			}
			try {
				await link(pending, path);
			} catch (error) {
				if (error?.code !== 'EEXIST') throw error;
				const existing = await this.read(id);
				if (existing.length !== expectedBytes || !existing.equals(bytes)) {
					throw new EditorError('CHECKPOINT_CORRUPT', 'Checkpoint bytes do not match their hash');
				}
			}
			return {id, bytes: expectedBytes};
		} finally {
			await unlinkIfExists(pending);
		}
	}

	/** @param {string} id */
	async read(id) {
		const path = this.checkpointPath(id);
		let bytes;
		try {
			bytes = await readFile(path);
		} catch (error) {
			if (error?.code === 'ENOENT') {
				throw new EditorError('CHECKPOINT_NOT_FOUND', 'Checkpoint is not available');
			}
			throw error;
		}
		if (sha256(bytes) !== id) {
			throw new EditorError('CHECKPOINT_CORRUPT', 'Checkpoint bytes do not match their hash');
		}
		return bytes;
	}

	/** @returns {Promise<HistoryIndex|null>} */
	async load() {
		return this.index === null ? null : copyIndex(this.index);
	}

	/** @param {HistoryIndex} index @returns {Promise<HistoryIndex>} */
	publish(index) {
		return this.runMutation(async () => {
			const validated = validateIndex(index);
			const next = applyRetention(validated, this.maxSteps, this.maxBytes);
			const previousIds = this.index === null ? new Set() : retainedIds(this.index);
			const nextIds = retainedIds(next);
			const pending = join(this.dir, `${randomUUID()}.pending`);
			try {
				await writeDurable(pending, JSON.stringify(next));
				await validateCheckpointFiles(this.dir, validated);
				await rename(pending, join(this.dir, INDEX_NAME));
			} finally {
				await unlinkIfExists(pending);
			}

			this.index = next;
			for (const id of previousIds) {
				if (!nextIds.has(id)) this.prunable.add(id);
			}
			return copyIndex(next);
		});
	}

	/** @param {Set<string>} keepIds */
	prune(keepIds) {
		return this.runMutation(async () => {
			if (!(keepIds instanceof Set)) {
				throw new EditorError('RETENTION_INVALID', 'Retention requires checkpoint ids');
			}
			const protectedIds = new Set([
				...keepIds,
				...(this.index === null ? [] : retainedIds(this.index)),
			]);
			for (const id of [...this.prunable]) {
				if (protectedIds.has(id)) continue;
				await unlinkIfExists(this.checkpointPath(id));
				this.prunable.delete(id);
			}
		});
	}
}

/**
 * @param {{dir:string, max_steps:number, max_bytes:number}} options
 * @returns {Promise<Store>}
 */
export async function openStore(options) {
	if (!options
		|| typeof options.dir !== 'string'
		|| !Number.isSafeInteger(options.max_steps)
		|| options.max_steps < 1
		|| !Number.isSafeInteger(options.max_bytes)
		|| options.max_bytes < 1) {
		throw new EditorError('STORE_OPTIONS_INVALID', 'Store options are invalid');
	}
	await mkdir(options.dir, {recursive: true, mode: 0o700});
	let index = null;
	try {
		index = validateIndex(JSON.parse(await readFile(join(options.dir, INDEX_NAME), 'utf8')));
		await validateCheckpointFiles(options.dir, index);
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			if (error instanceof EditorError) throw error;
			throw new EditorError('INDEX_INVALID', 'History index cannot be read');
		}
	}
	return new Store(options, index);
}
