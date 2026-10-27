import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {EditorError} from './errors.mjs';
import {lockOwnerStatus} from './liveness.mjs';

const UUID_V4='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MAX_LOCK_BYTES=64*1024;

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function sourceError(code, message, details) {
	return new EditorError(code, message, details);
}

async function canonicalPath(path) {
	try {
		return await realpath(path);
	} catch (error) {
		throw sourceError('SOURCE_UNAVAILABLE', 'The original file cannot be opened', {cause: error});
	}
}

async function readOriginal(path) {
	try {
		return await readFile(path);
	} catch (error) {
		throw sourceError('SOURCE_UNAVAILABLE', 'The original file cannot be read', {cause: error});
	}
}

function lockPath(dataDir, originalPath) {
	const sourceId = sha256(Buffer.from(originalPath));
	return join(dataDir, 'sources', `${sourceId}.json`);
}

function workingPath(originalPath) {
	return join(
		dirname(originalPath),
		`.${basename(originalPath)}.tern-pencil-${randomUUID()}.pen`,
	);
}

async function readLockRecord(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw sourceError('ALREADY_OPEN', 'The source lock cannot be verified');
	}
}

async function existingLockError(path, dataDir) {
	const record = await readLockRecord(path);
	if (await lockOwnerStatus(record, dataDir) === 'missing') {
		throw sourceError('RECOVERY_REQUIRED', 'A previous source session needs recovery', {recovery: record});
	}
	throw sourceError('ALREADY_OPEN', 'The source is already open', {
		session_id: record.session_id,
		pid: record.pid,
	});
}

async function createLock(path, record, dataDir) {
	try {
		await writeFile(path, JSON.stringify(record), {encoding: 'utf8', flag: 'wx', mode: 0o600});
	} catch (error) {
		if (error?.code === 'EEXIST') await existingLockError(path, dataDir);
		throw sourceError('LOCK_UNAVAILABLE', 'The source lock cannot be created', {cause: error});
	}
}

async function captureLock(path) {
	const tombstone=`${path}.${randomUUID()}.adopting`;
	try {
		await rename(path,tombstone);
		return tombstone;
	} catch (error) {
		if (error?.code === 'ENOENT') {
			throw sourceError('ALREADY_OPEN', 'The source lock changed before adoption');
		}
		throw sourceError('LOCK_UNAVAILABLE', 'The source lock cannot be captured for adoption', {cause:error});
	}
}

async function restoreCapturedLock(tombstone,path) {
	try {
		await link(tombstone,path);
	} catch (error) {
		if (error?.code === 'ENOENT') {
			throw sourceError('ALREADY_OPEN', 'The source lock changed during adoption');
		}
		if (error?.code === 'EEXIST') {
			throw sourceError('ALREADY_OPEN', 'Another source lock appeared during adoption', {
				tombstone_path:tombstone,
			});
		}
		throw sourceError('LOCK_UNAVAILABLE', 'The captured source lock cannot be restored', {
			cause:error,
			tombstone_path:tombstone,
		});
	}
	try {
		await unlink(tombstone);
	} catch (error) {
		throw sourceError('LOCK_UNAVAILABLE', 'The restored source lock tombstone cannot be removed', {
			cause:error,
			tombstone_path:tombstone,
		});
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

// `flags` 'i' for validating a recorded name; the sweep matches case-exactly, so a sibling that differs only in case
// (its own lock on a case-sensitive file system) keeps its copy.
function workingNamePattern(canonical,flags='i') {
	return new RegExp(`^\\.${escapeRegExp(basename(canonical))}\\.tern-pencil-${UUID_V4}\\.pen$`,flags);
}

/**
 * Removes the working copies of `canonical` that no session holds: left by a crash, a kill, or a version that did not
 * clean up. The caller holds the lock of the original in this data folder, so none of them is a live owner's of this
 * plugin, and the confirmed edits live in the history store, not in a copy. Best effort: a copy that cannot be removed
 * stays, and never stops the open. shortcut: another data folder's live owner of the same file is not known here and
 * would lose its copy; upgrade if one file may be opened from two plugin data folders at once.
 */
async function sweepStaleCopies(canonical,keep) {
	const directory=dirname(canonical);
	const pattern=workingNamePattern(canonical,'');
	let names;
	try {
		names=await readdir(directory);
	} catch {
		return;
	}
	for (const name of names) {
		const path=join(directory,name);
		if (path===keep||!pattern.test(name)) continue;
		try {
			if ((await lstat(path)).isFile()) await rm(path,{force:true});
		} catch {
			// kept
		}
	}
}

function isLockRecord(record) {
	return record !== null
		&&typeof record === 'object'
		&&!Array.isArray(record)
		&&typeof record.original_path === 'string'
		&&typeof record.owner === 'string'
		&&typeof record.session_id === 'string'
		&&record.owner === record.session_id
		&&Number.isInteger(record.pid)
		&&record.pid > 0
		&&typeof record.working_path === 'string'
		&&record.working_path.length > 0;
}

async function validateOrphanRecord(record,canonical,orphanSessionId,dataDir) {
	if (!isLockRecord(record)) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan source lock is incomplete');
	}
	if (record.session_id !== orphanSessionId || await lockOwnerStatus(record,dataDir) !== 'missing') {
		throw sourceError('ALREADY_OPEN', 'The source lock cannot be adopted');
	}
	if (record.original_path !== canonical) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan source lock belongs to another original');
	}
	let originalDir;
	let workingDir;
	try {
		[originalDir,workingDir]=await Promise.all([
			realpath(dirname(canonical)),
			realpath(dirname(record.working_path)),
		]);
	} catch (error) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan working directory cannot be verified', {cause:error});
	}
	if (workingDir !== originalDir) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan working file is outside the original directory');
	}
	const expectedName=workingNamePattern(canonical);
	if (!expectedName.test(basename(record.working_path))) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan working file name is invalid');
	}
	let details;
	try {
		details=await lstat(record.working_path);
	} catch (error) {
		if (error?.code === 'ENOENT') return record;
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan working file cannot be inspected', {cause:error});
	}
	if (details.isSymbolicLink()||!details.isFile()) {
		throw sourceError('SOURCE_LOCK_INVALID', 'The orphan working path is not a regular file');
	}
	return record;
}

async function createAdoptedLock(path,record,tombstone) {
	try {
		await writeFile(path,JSON.stringify(record),{encoding:'utf8',flag:'wx',mode:0o600});
	} catch (error) {
		if (error?.code === 'EEXIST') {
			throw sourceError('ALREADY_OPEN', 'The source lock changed during adoption', {
				tombstone_path:tombstone,
			});
		}
		throw sourceError('LOCK_UNAVAILABLE', 'The adopted source lock cannot be created', {cause:error});
	}
}

async function unlinkIfExists(path) {
	try {
		await unlink(path);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
}

async function rejectCapturedLock(tombstone,path,error) {
	await restoreCapturedLock(tombstone,path);
	throw error;
}

async function rollbackAdoption(path,tombstone,record,ownership,cause) {
	try {
		await releaseLock(path,record.session_id,record.original_path);
		ownership.claimed=false;
	} catch (releaseError) {
		throw sourceError('LOCK_UNAVAILABLE', 'The failed adopted lock cannot be released', {
			cause,
			release:releaseError,
			tombstone_path:tombstone,
		});
	}
	try {
		await restoreCapturedLock(tombstone,path);
	} catch (restoreError) {
		throw sourceError('LOCK_UNAVAILABLE', 'The orphan lock cannot be restored after failed adoption', {
			cause,
			restore:restoreError,
			tombstone_path:tombstone,
		});
	}
	throw cause;
}

/**
 * Concurrent adoption of one orphan is unsupported: only one recovery decision may run at once.
 * Without an atomic filesystem lock primitive, a loser can leave a live lock until its owner restarts.
 */
async function adoptOrphanLock(path,canonical,orphanSessionId,record,ownership,dataDir) {
	const tombstone=await captureLock(path);
	let orphan;
	try {
		orphan=await readLockRecord(tombstone);
		await validateOrphanRecord(orphan,canonical,orphanSessionId,dataDir);
	} catch (error) {
		return rejectCapturedLock(tombstone,path,error);
	}
	try {
		await createAdoptedLock(path,record,tombstone);
	} catch (error) {
		if (error?.code !== 'ALREADY_OPEN') {
			return rejectCapturedLock(tombstone,path,error);
		}
		throw error;
	}
	ownership.claimed=true;
	try {
		await unlinkIfExists(orphan.working_path);
	} catch (error) {
		return rollbackAdoption(path,tombstone,record,ownership,error);
	}
	try {
		await unlink(tombstone);
		return undefined;
	} catch {
		return Object.freeze([tombstone]);
	}
}

async function removeSessionTombstones(path,sessionId,originalPath) {
	const directory=dirname(path);
	const pattern=new RegExp(`^${escapeRegExp(basename(path))}\\.${UUID_V4}\\.adopting$`,'i');
	let names;
	try {
		names=await readdir(directory);
	} catch (error) {
		if (error?.code === 'ENOENT') return;
		throw error;
	}
	let removalError;
	for (const name of names) {
		if (!pattern.test(name)) continue;
		const tombstone=join(directory,name);
		let details;
		try {
			details=await lstat(tombstone);
		} catch {
			continue;
		}
		if (details.isSymbolicLink()||!details.isFile()||details.size>MAX_LOCK_BYTES) continue;
		let record;
		try {
			record=JSON.parse(await readFile(tombstone,'utf8'));
		} catch {
			continue;
		}
		if (!isLockRecord(record)
			||record.session_id !== sessionId
			||record.original_path !== originalPath) continue;
		try {
			await unlink(tombstone);
		} catch (error) {
			if (error?.code !== 'ENOENT'&&!removalError) removalError=error;
		}
	}
	if (removalError) throw removalError;
}

/**
 * Releases a lock owned by this live session. Adoption guarantees an absent owner only after it
 * validates the captured record; it can momentarily capture another live adopter's lock. A
 * cooperating owner therefore removes exact adoption tombstones that still name its session.
 */
async function releaseLock(path,sessionId,originalPath) {
	try {
		let record;
		try {
			record=JSON.parse(await readFile(path,'utf8'));
		} catch (error) {
			if (error?.code === 'ENOENT') return;
			throw error;
		}
		if (record.session_id !== sessionId) return;
		try {
			await unlink(path);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
	} finally {
		await removeSessionTombstones(path,sessionId,originalPath);
	}
}

async function createWorkingCopy(path, bytes) {
	try {
		await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
		return path;
	} catch (error) {
		throw sourceError('WORKING_COPY_FAILED', 'A safe working copy cannot be created', {cause: error});
	}
}

async function verifyWorkingCopy(path, fingerprint) {
	let bytes;
	try {
		bytes = await readFile(path);
	} catch (error) {
		throw sourceError('SOURCE_CHANGED', 'The working copy cannot be verified', {cause: error});
	}
	if (sha256(bytes) !== fingerprint) {
		throw sourceError('SOURCE_CHANGED', 'The working copy changed while it was written');
	}
}

/**
 * Claims a canonical original file and creates an exclusive working copy beside it.
 * Concurrent adoption of one orphan is unsupported: one explicit recovery decision may run at once.
 * Without an atomic filesystem lock primitive, a loser can leave a live lock until its owner restarts.
 * @param {{original_path:string, data_dir:string, session_id:string, adopt_orphan?:string}} options
 * @returns {Promise<{
 * 	readonly original_path:string,
 * 	readonly session_id:string,
 * 	working_path:string,
 * 	source_fingerprint:string,
 * 	readonly adoption_leftovers?:readonly string[],
 * 	assertDiskBase:()=>Promise<void>,
 * 	acceptPublished:(hash:string)=>Promise<void>,
 * 	restore:(bytes:Buffer)=>Promise<void>,
 * 	release:()=>Promise<void>
 * }>}
 */
export async function claimSource({original_path: originalPath, data_dir: dataDir, session_id: sessionId, adopt_orphan: adoptOrphan}) {
	if (adoptOrphan !== undefined && typeof adoptOrphan !== 'string') {
		throw sourceError('SOURCE_OPTIONS_INVALID', 'adopt_orphan must be a session id');
	}
	const canonical = await canonicalPath(originalPath);
	const registryDir = join(dataDir, 'sources');
	try {
		await mkdir(registryDir, {recursive: true, mode: 0o700});
	} catch (error) {
		throw sourceError('LOCK_UNAVAILABLE', 'The private source registry cannot be created', {cause: error});
	}

	const lock = lockPath(dataDir, canonical);
	const nextWorkingPath = workingPath(canonical);
	const record = {
		original_path: canonical,
		owner: sessionId,
		pid: process.pid,
		session_id: sessionId,
		working_path: nextWorkingPath,
	};
	const ownership={claimed:false};
	let adoptionLeftovers;
	let releasePromise;
	function release() {
		if (releasePromise) return releasePromise;
		releasePromise = releaseLock(lock,sessionId,canonical).catch(error => {
			releasePromise = undefined;
			throw error;
		});
		return releasePromise;
	}

	try {
		if (adoptOrphan === undefined) {
			await createLock(lock, record, dataDir);
			ownership.claimed=true;
		} else {
			adoptionLeftovers=await adoptOrphanLock(lock,canonical,adoptOrphan,record,ownership,dataDir);
		}
		const bytes = await readOriginal(canonical);
		let fingerprint = sha256(bytes);
		await createWorkingCopy(nextWorkingPath, bytes);
		await verifyWorkingCopy(nextWorkingPath, fingerprint);
		if (sha256(await readOriginal(canonical)) !== fingerprint) {
			throw sourceError('SOURCE_CHANGED', 'The original changed while the working copy was captured');
		}
		await sweepStaleCopies(canonical,nextWorkingPath);
		const claimed = {
			working_path: nextWorkingPath,
			async assertDiskBase() {
				let current;
				try {
					current=sha256(await readOriginal(canonical));
				} catch (error) {
					throw sourceError('SOURCE_CHANGED', 'The original is no longer available', {cause:error});
				}
				if (current !== fingerprint) {
					throw sourceError('SOURCE_CHANGED', 'The original changed outside this session');
				}
			},
			async acceptPublished(hash) {
				if (!/^[a-f0-9]{64}$/.test(hash)) {
					throw sourceError('SOURCE_FINGERPRINT_INVALID', 'Published source fingerprint is invalid');
				}
				let current;
				try {
					current=sha256(await readOriginal(canonical));
				} catch (error) {
					throw sourceError('SOURCE_CHANGED', 'The published original is no longer available', {cause:error});
				}
				if (current!==hash) {
					throw sourceError('SOURCE_CHANGED', 'The published original changed before confirmation');
				}
				fingerprint=hash;
			},
			async restore(bytes) {
				await writeFile(nextWorkingPath, bytes);
				await verifyWorkingCopy(nextWorkingPath, sha256(bytes));
			},
			/** Removes this session's own working copy; the confirmed state lives in the history store. */
			async discardWorking() {
				await rm(nextWorkingPath, {force: true, maxRetries: 5, retryDelay: 100});
			},
			release,
		};
		Object.defineProperties(claimed, {
			original_path: {value: canonical, enumerable: true},
			session_id: {value: sessionId, enumerable: true},
			source_fingerprint: {get:()=>fingerprint, enumerable: true},
			adopted_orphan: {value: adoptOrphan !== undefined, enumerable: true},
		});
		if (adoptionLeftovers) {
			Object.defineProperty(claimed,'adoption_leftovers',{
				value:adoptionLeftovers,
				enumerable:true,
			});
		}
		return claimed;
	} catch (error) {
		try {
			await rm(nextWorkingPath, {force: true});
		} finally {
			if (ownership.claimed) await release();
		}
		throw error;
	}
}
