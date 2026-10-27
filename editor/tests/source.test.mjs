import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,renameSync,unlinkSync,watch,writeFileSync} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,readdir,realpath,rename,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {claimSource} from '../src/source.mjs';
import {sampleFile,withTemp} from './helpers.mjs';

const run = promisify(execFile);

async function makeDirectoryReadOnly(path) {
	if (process.platform === 'win32') {
		await run('icacls', [path, '/deny', '*S-1-1-0:(W)']);
		return () => run('icacls', [path, '/remove:d', '*S-1-1-0']);
	}
	await chmod(path, 0o555);
	return () => chmod(path, 0o755);
}

async function denyFileDelete(path) {
	const parent = dirname(path);
	if (process.platform === 'win32') {
		await run('icacls', [path, '/deny', '*S-1-1-0:(DE)']);
		await run('icacls', [parent, '/deny', '*S-1-1-0:(DC)']);
		return async () => {
			await run('icacls', [path, '/remove:d', '*S-1-1-0']);
			await run('icacls', [parent, '/remove:d', '*S-1-1-0']);
		};
	}
	await chmod(parent, 0o555);
	return () => chmod(parent, 0o755);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function corruptWorkingFile(path) {
	let active = true;
	let failure;
	// The loop runs while claim() is still working and nothing awaits it yet, so it must never reject on its own: an
	// error is kept and rethrown by stop(). Windows reports EPERM/EBUSY (not ENOENT) while the claim's cleanup is
	// deleting the file under the writer, which just means the file is going away.
	const done = (async () => {
		while (active) {
			try {
				await writeFile(path, Buffer.alloc(8, 0xff), {flag: 'r+'});
			} catch (error) {
				if (['ENOENT', 'EPERM', 'EBUSY'].includes(error?.code)) return;
				failure = error;
				return;
			}
		}
	})();
	return {
		async stop() {
			active = false;
			await done;
			if (failure) throw failure;
		},
	};
}

function corruptNewWorkingFile(dir) {
	let corruptor;
	const watcher = watch(dir, (event, filename) => {
		if (event !== 'rename' || !filename?.includes('.tern-pencil-')) return;
		if (!corruptor) corruptor = corruptWorkingFile(join(dir, filename));
	});
	return {
		async stop() {
			watcher.close();
			await corruptor?.stop();
		},
	};
}

async function findLock(dataDir, sessionId) {
	const paths = await readdir(dataDir, {recursive: true});
	for (const path of paths) {
		if (!path.endsWith('.json')) continue;
		const fullPath = join(dataDir, path);
		const record = JSON.parse(await readFile(fullPath, 'utf8'));
		if (record.session_id === sessionId) return {fullPath, record};
	}
	throw Error(`No lock record for session ${sessionId}`);
}

test('second writer cannot replace the first writer lock', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	try {
		await assert.rejects(
			claimSource({original_path: original, data_dir: dataDir, session_id: 'B'}),
			error => error.code === 'ALREADY_OPEN',
		);
		assert.equal((await readFile(source.working_path)).equals(await readFile(original)), true);
	} finally {
		await source.release();
	}
}));

test('canonical-equivalent paths share one writer lock', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const equivalent = join(dirname(original), '..', 'source', 'design.pen');
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	try {
		await assert.rejects(
			claimSource({original_path: equivalent, data_dir: dataDir, session_id: 'B'}),
			error => error.code === 'ALREADY_OPEN',
		);
	} finally {
		await source.release();
	}
}));

test('separate original paths preserve identical document bytes in separate working copies', async () => withTemp(async dir => {
	const first = await sampleFile(join(dir, 'first'));
	const second = await sampleFile(join(dir, 'second'));
	const firstSource = await claimSource({
		original_path: first,
		data_dir: join(dir, 'first-private'),
		session_id: 'A',
	});
	const secondSource = await claimSource({
		original_path: second,
		data_dir: join(dir, 'second-private'),
		session_id: 'B',
	});
	try {
		assert.notEqual(firstSource.working_path, secondSource.working_path);
		assert.deepEqual(await readFile(firstSource.working_path), await readFile(secondSource.working_path));
	} finally {
		await firstSource.release();
		await secondSource.release();
	}
}));

test('claim rejects a source changed while its working copy is captured', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const originalBytes = await readFile(original);
	await writeFile(original, Buffer.concat([originalBytes, Buffer.alloc(32 * 1024 * 1024)]));
	const handle = await open(original, 'r+');
	let changing = true;
	let sequence = 0n;
	const changeSource = (async () => {
		while (changing) {
			const marker = Buffer.alloc(8);
			marker.writeBigUInt64LE(sequence++);
			await handle.write(marker, 0, marker.length, (await handle.stat()).size - marker.length);
		}
	})();
	try {
		await assert.rejects(
			claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'A'}),
			error => error.code === 'SOURCE_CHANGED',
		);
	} finally {
		changing = false;
		await changeSource;
		await handle.close();
	}
}));

test('assertDiskBase reports an external original change', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const source = await claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'A'});
	try {
		await writeFile(original, Buffer.from('external change'));
		await assert.rejects(source.assertDiskBase(), error => error.code === 'SOURCE_CHANGED');
	} finally {
		await source.release();
	}
}));

test('restore and release leave the original bytes unchanged', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const originalBytes = await readFile(original);
	const originalHash = sha256(originalBytes);
	const source = await claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'A'});
	await writeFile(source.working_path, Buffer.from('changed working copy'));
	await source.restore(originalBytes);
	await source.release();
	assert.deepEqual(await readFile(source.working_path), originalBytes);
	assert.equal(sha256(await readFile(original)), originalHash);
}));

test('discardWorking removes only the session working copy, twice without failing', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const originalBytes = await readFile(original);
	const source = await claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'A'});
	// Made after the claim: a copy that was already there when the session opened is swept, see below.
	const neighbour = join(dirname(original), `.${basename(original)}.tern-pencil-${randomUUID()}.pen`);
	await writeFile(neighbour, 'not ours');
	try {
		await source.discardWorking();
		await source.discardWorking();
		await assert.rejects(lstat(source.working_path), error => error.code === 'ENOENT');
		assert.equal(await readFile(neighbour, 'utf8'), 'not ours');
		assert.deepEqual(await readFile(original), originalBytes);
	} finally {
		await source.release();
	}
}));

test('opening a file sweeps the working copies of earlier sessions that nobody holds, and only those', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const directory = dirname(original);
	const name = id => `.${basename(original)}.tern-pencil-${id}.pen`;
	const stale = [join(directory, name(randomUUID())), join(directory, name(randomUUID()))];
	const kept = [
		join(directory, `.other.pen.tern-pencil-${randomUUID()}.pen`),
		join(directory, name('not-a-uuid')),
		join(directory, `${basename(original)}.bak`),
		join(directory, `x${name(randomUUID())}`),
	];
	for (const path of [...stale, ...kept]) await writeFile(path, 'copy');
	const folder = join(directory, name(randomUUID()));
	await mkdir(folder);
	const originalBytes = await readFile(original);
	const source = await claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'new'});
	try {
		for (const path of stale) await assert.rejects(lstat(path), error => error.code === 'ENOENT');
		for (const path of kept) assert.equal(await readFile(path, 'utf8'), 'copy');
		assert.equal((await lstat(folder)).isDirectory(), true);
		assert.deepEqual(await readFile(original), originalBytes);
		assert.deepEqual(await readFile(source.working_path), originalBytes);
	} finally {
		await source.release();
	}
}));

test('a second open of a file that is held leaves the holder\'s working copy alone', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const holder = await claimSource({original_path: original, data_dir: dataDir, session_id: 'holder'});
	try {
		await assert.rejects(claimSource({original_path: original, data_dir: dataDir, session_id: 'late'}), error => error.code === 'ALREADY_OPEN');
		assert.deepEqual(await readFile(holder.working_path), await readFile(original));
	} finally {
		await holder.release();
	}
}));

test('release does not remove a lock that belongs to a different owner', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	const lock = await findLock(dataDir, 'A');
	await writeFile(lock.fullPath, JSON.stringify({...lock.record, session_id: 'B'}));
	await source.release();
	await assert.rejects(
		claimSource({original_path: original, data_dir: dataDir, session_id: 'C'}),
		error => error.code === 'ALREADY_OPEN',
	);
}));

test('a readonly source directory preserves the original and unrelated files', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const sourceDir = dirname(original);
	const alien = join(sourceDir, 'unrelated.pen');
	const originalHash = sha256(await readFile(original));
	await writeFile(alien, Buffer.from('do not remove'));
	const restorePermissions = await makeDirectoryReadOnly(sourceDir);
	try {
		await assert.rejects(claimSource({
			original_path: original,
			data_dir: join(dir, 'private'),
			session_id: 'A',
		}));
		assert.equal(sha256(await readFile(original)), originalHash);
		assert.deepEqual(await readFile(alien), Buffer.from('do not remove'));
	} finally {
		await restorePermissions();
	}
}));


test('concurrent and repeated release calls preserve a later owner lock', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	const firstRelease = source.release();
	const concurrentRelease = source.release();
	assert.equal(concurrentRelease, firstRelease);
	await firstRelease;
	const nextSource = await claimSource({original_path: original, data_dir: dataDir, session_id: 'B'});
	try {
		await source.release();
		await assert.rejects(
			claimSource({original_path: original, data_dir: dataDir, session_id: 'C'}),
			error => error.code === 'ALREADY_OPEN',
		);
	} finally {
		await nextSource.release();
	}
}));

test('claim removes its working copy and lock when working bytes diverge', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const sourceDir = dirname(original);
	const originalBytes = await readFile(original);
	await writeFile(original, Buffer.concat([originalBytes, Buffer.alloc(32 * 1024 * 1024)]));
	const originalHash = sha256(await readFile(original));
	const dataDir = join(dir, 'private');
	const corruption = corruptNewWorkingFile(sourceDir);
	try {
		await assert.rejects(
			claimSource({original_path: original, data_dir: dataDir, session_id: 'A'}),
			error => error.code === 'SOURCE_CHANGED',
		);
	} finally {
		await corruption.stop();
	}
	assert.equal(sha256(await readFile(original)), originalHash);
	assert.deepEqual(await readdir(join(dataDir, 'sources')), []);
	assert.equal((await readdir(sourceDir)).some(path => path.includes('.tern-pencil-')), false);
}));

test('restore rejects working bytes changed during its write', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const originalHash = sha256(await readFile(original));
	const source = await claimSource({original_path: original, data_dir: join(dir, 'private'), session_id: 'A'});
	const corruption = corruptWorkingFile(source.working_path);
	try {
		await assert.rejects(
			source.restore(Buffer.alloc(32 * 1024 * 1024, 0x11)),
			error => error.code === 'SOURCE_CHANGED',
		);
		assert.equal(sha256(await readFile(original)), originalHash);
	} finally {
		await corruption.stop();
		await source.release();
	}
}));

test('release retries after a transient unlink failure', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	const lock = await findLock(dataDir, 'A');
	const allowDelete = await denyFileDelete(lock.fullPath);
	try {
		await assert.rejects(source.release());
		assert.equal((await readFile(lock.fullPath, 'utf8')).includes('"session_id":"A"'), true);
	} finally {
		await allowDelete();
	}
	await source.release();
	assert.deepEqual(await readdir(join(dataDir, 'sources')), []);
}));

test('release rejects an unreadable lock without removing or accepting it', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const dataDir = join(dir, 'private');
	const source = await claimSource({original_path: original, data_dir: dataDir, session_id: 'A'});
	const lock = await findLock(dataDir, 'A');
	await writeFile(lock.fullPath, '{not json');
	await assert.rejects(source.release());
	assert.equal(await readFile(lock.fullPath, 'utf8'), '{not json');
	await assert.rejects(
		claimSource({original_path: original, data_dir: dataDir, session_id: 'B'}),
		error => error.code === 'ALREADY_OPEN',
	);
	await writeFile(lock.fullPath, JSON.stringify(lock.record));
	await source.release();
	assert.deepEqual(await readdir(join(dataDir, 'sources')), []);
}));

test('claim exposes the canonical original path and supplied session identity', async () => withTemp(async dir => {
	const original = await sampleFile(dir);
	const equivalent = join(dirname(original), '..', 'source', '.', 'design.pen');
	const source = await claimSource({
		original_path: equivalent,
		data_dir: join(dir, 'private'),
		session_id: 'canonical-session',
	});
	try {
		assert.equal(source.original_path, await realpath(original));
		assert.equal(source.session_id, 'canonical-session');
	} finally {
		await source.release();
	}
}));


async function createOrphanedSource(dir) {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const source=await claimSource({original_path:original,data_dir:dataDir,session_id:'orphan'});
	const lock=await findLock(dataDir,'orphan');
	await source.release();
	await writeFile(lock.fullPath,JSON.stringify({
		...lock.record,
		pid:2147483647,
		working_path:source.working_path,
	}));
	return {original,dataDir,lock,workingPath:source.working_path};
}

test('claim adota somente um lock órfão confirmado e remove seu working registrado', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const adopted=await claimSource({
		original_path:orphan.original,
		data_dir:orphan.dataDir,
		session_id:'new-owner',
		adopt_orphan:'orphan',
	});
	try {
		assert.equal(adopted.session_id,'new-owner');
		assert.notEqual(adopted.working_path,orphan.workingPath);
		await assert.rejects(readFile(orphan.workingPath),error=>error.code==='ENOENT');
		assert.equal((await findLock(orphan.dataDir,'new-owner')).record.working_path,adopted.working_path);
	} finally {
		await adopted.release();
	}
}));

test('claim never adopts a lock whose owner PID is active', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'active-owner'});
	try {
		await assert.rejects(
			claimSource({original_path:original,data_dir:dataDir,session_id:'new-owner',adopt_orphan:'active-owner'}),
			error=>error.code==='ALREADY_OPEN',
		);
	} finally {
		await owner.release();
	}
}));

test('claim refuses adoption when the orphan session identity differs', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	await assert.rejects(
		claimSource({original_path:orphan.original,data_dir:orphan.dataDir,session_id:'new-owner',adopt_orphan:'other'}),
		error=>error.code==='ALREADY_OPEN',
	);
}));

test('claim refuses adoption from an unreadable lock record', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const source=await claimSource({original_path:original,data_dir:dataDir,session_id:'owner'});
	const lock=await findLock(dataDir,'owner');
	await source.release();
	await writeFile(lock.fullPath,'{broken');
	await assert.rejects(
		claimSource({original_path:original,data_dir:dataDir,session_id:'new-owner',adopt_orphan:'owner'}),
		error=>error.code==='ALREADY_OPEN',
	);
}));

async function rewriteOrphanRecord(orphan,changes) {
	const record={...orphan.lock.record,pid:2147483647,working_path:orphan.workingPath,...changes};
	await writeFile(orphan.lock.fullPath,JSON.stringify(record));
	return record;
}

function adoptionError(error) {
	return error.code==='ALREADY_OPEN'||error.code==='SOURCE_LOCK_INVALID';
}

async function rejectAdoption(orphan) {
	await assert.rejects(
		claimSource({
			original_path:orphan.original,
			data_dir:orphan.dataDir,
			session_id:'new-owner',
			adopt_orphan:'orphan',
		}),
		adoptionError,
	);
	assert.equal((await findLock(orphan.dataDir,'orphan')).record.session_id,'orphan');
	assert.equal((await readdir(join(orphan.dataDir,'sources'))).some(path=>path.endsWith('.adopting')),false);
}

test('orphan adoption refuses a working path outside the original directory without deleting it', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const outside=join(dir,`.${basename(orphan.original)}.tern-pencil-${randomUUID()}.pen`);
	await writeFile(outside,'preserve outside');
	await rewriteOrphanRecord(orphan,{working_path:outside});
	await rejectAdoption(orphan);
	assert.equal(await readFile(outside,'utf8'),'preserve outside');
}));

test('orphan adoption refuses a working path with the wrong name without deleting it', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const wrongName=join(dirname(orphan.original),'user-file.pen');
	await writeFile(wrongName,'preserve name');
	await rewriteOrphanRecord(orphan,{working_path:wrongName});
	await rejectAdoption(orphan);
	assert.equal(await readFile(wrongName,'utf8'),'preserve name');
}));

test('orphan adoption refuses a symbolic-link working path without deleting link or target', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const target=join(dirname(orphan.original),'asset-directory');
	const linkPath=join(dirname(orphan.original),`.${basename(orphan.original)}.tern-pencil-${randomUUID()}.pen`);
	await mkdir(target);
	await writeFile(join(target,'asset.txt'),'preserve target');
	await symlink(target,linkPath,'junction');
	await rewriteOrphanRecord(orphan,{working_path:linkPath});
	await rejectAdoption(orphan);
	assert.equal((await lstat(linkPath)).isSymbolicLink(),true);
	assert.equal(await readFile(join(target,'asset.txt'),'utf8'),'preserve target');
}));

test('orphan adoption refuses a directory working path without deleting it', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const directory=join(dirname(orphan.original),`.${basename(orphan.original)}.tern-pencil-${randomUUID()}.pen`);
	await mkdir(directory);
	await writeFile(join(directory,'material'),'preserve directory');
	await rewriteOrphanRecord(orphan,{working_path:directory});
	await rejectAdoption(orphan);
	assert.equal((await lstat(directory)).isDirectory(),true);
	assert.equal(await readFile(join(directory,'material'),'utf8'),'preserve directory');
}));

test('orphan adoption refuses a record for another original without removing its working file', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	await rewriteOrphanRecord(orphan,{original_path:join(dir,'other.pen')});
	await rejectAdoption(orphan);
	assert.equal((await lstat(orphan.workingPath)).isFile(),true);
}));

test('orphan adoption refuses an invalid PID without removing its working file', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	await rewriteOrphanRecord(orphan,{pid:0});
	await rejectAdoption(orphan);
	assert.equal((await lstat(orphan.workingPath)).isFile(),true);
}));

test('two concurrent orphan adopters yield exactly one owner and no tombstone', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const outcomes=await Promise.allSettled([
		claimSource({original_path:orphan.original,data_dir:orphan.dataDir,session_id:'adopter-a',adopt_orphan:'orphan'}),
		claimSource({original_path:orphan.original,data_dir:orphan.dataDir,session_id:'adopter-b',adopt_orphan:'orphan'}),
	]);
	const winners=outcomes.filter(outcome=>outcome.status==='fulfilled');
	const losers=outcomes.filter(outcome=>outcome.status==='rejected');
	assert.equal(winners.length,1);
	assert.equal(losers.length,1);
	assert.equal(losers[0].reason.code,'ALREADY_OPEN',JSON.stringify(losers[0].reason.details));
	const winner=winners[0].value;
	try {
		assert.equal((await findLock(orphan.dataDir,winner.session_id)).record.session_id,winner.session_id);
		assert.equal((await readdir(join(orphan.dataDir,'sources'))).some(path=>path.endsWith('.adopting')),false);
	} finally {
		await winner.release();
	}
}));

test('failed orphan working cleanup releases the new lock and restores recoverability', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const allowDelete=await denyFileDelete(orphan.workingPath);
	try {
		await assert.rejects(claimSource({
			original_path:orphan.original,
			data_dir:orphan.dataDir,
			session_id:'failed-adopter',
			adopt_orphan:'orphan',
		}));
	} finally {
		await allowDelete();
	}
	assert.equal((await findLock(orphan.dataDir,'orphan')).record.session_id,'orphan');
	const adopted=await claimSource({
		original_path:orphan.original,
		data_dir:orphan.dataDir,
		session_id:'later-adopter',
		adopt_orphan:'orphan',
	});
	await adopted.release();
}));

function afterAdoptedLock(orphan,action) {
	const registry=join(orphan.dataDir,'sources');
	let settled=false;
	let resolveDone;
	let rejectDone;
	const done=new Promise((resolve,reject)=>{
		resolveDone=resolve;
		rejectDone=reject;
	});
	const watcher=watch(registry,()=>{
		if (settled||!existsSync(orphan.lock.fullPath)) return;
		const tombstoneName=readdirSync(registry).find(path=>path.endsWith('.adopting'));
		if (!tombstoneName) return;
		settled=true;
		watcher.close();
		const tombstone=join(registry,tombstoneName);
		try {
			resolveDone({tombstone,...action(tombstone)});
		} catch (error) {
			rejectDone(error);
		}
	});
	return {
		done,
		close() {
			if (settled) return;
			settled=true;
			watcher.close();
			rejectDone(Error('Adopted lock was not observed'));
		},
	};
}

test('interrupted adoption keeps the new owner when tombstone cleanup fails after working removal', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const interference=afterAdoptedLock(orphan,tombstone=>{
		const captured=`${tombstone}.captured`;
		renameSync(tombstone,captured);
		mkdirSync(tombstone);
		writeFileSync(join(tombstone,'blocker'),'not empty');
		return {captured};
	});
	let adopted;
	let interferenceResult;
	try {
		[adopted,interferenceResult]=await Promise.all([
			claimSource({
				original_path:orphan.original,
				data_dir:orphan.dataDir,
				session_id:'committed-adopter',
				adopt_orphan:'orphan',
			}),
			interference.done,
		]);
		assert.equal((await findLock(orphan.dataDir,'committed-adopter')).record.session_id,'committed-adopter');
		assert.deepEqual(adopted.adoption_leftovers,[interferenceResult.tombstone]);
		assert.equal(Object.isFrozen(adopted.adoption_leftovers),true);
		assert.equal(Object.getOwnPropertyDescriptor(adopted,'adoption_leftovers').writable,false);
		await assert.rejects(lstat(orphan.workingPath),error=>error.code==='ENOENT');
	} finally {
		interference.close();
		await adopted?.release();
		if (interferenceResult) {
			await rm(interferenceResult.tombstone,{recursive:true,force:true});
			await rm(interferenceResult.captured,{force:true});
		}
	}
}));

test('interrupted adoption accepts an orphan record whose working copy is already absent', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	await unlink(orphan.workingPath);
	const adopted=await claimSource({
		original_path:orphan.original,
		data_dir:orphan.dataDir,
		session_id:'resume-adopter',
		adopt_orphan:'orphan',
	});
	try {
		assert.equal(adopted.session_id,'resume-adopter');
		assert.equal(Object.hasOwn(adopted,'adoption_leftovers'),false);
	} finally {
		await adopted.release();
	}
}));

test('interrupted adoption rolls back when working removal fails and remains adoptable', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const interference=afterAdoptedLock(orphan,()=>{
		const captured=`${orphan.workingPath}.captured`;
		renameSync(orphan.workingPath,captured);
		mkdirSync(orphan.workingPath);
		writeFileSync(join(orphan.workingPath,'blocker'),'not empty');
		return {captured};
	});
	const [claimResult,interferenceResult]=await Promise.allSettled([
		claimSource({
			original_path:orphan.original,
			data_dir:orphan.dataDir,
			session_id:'failed-after-validation',
			adopt_orphan:'orphan',
		}),
		interference.done,
	]);
	interference.close();
	assert.equal(claimResult.status,'rejected');
	assert.equal(interferenceResult.status,'fulfilled');
	assert.equal((await findLock(orphan.dataDir,'orphan')).record.session_id,'orphan');
	await rm(orphan.workingPath,{recursive:true,force:true});
	await rename(interferenceResult.value.captured,orphan.workingPath);
	const adopted=await claimSource({
		original_path:orphan.original,
		data_dir:orphan.dataDir,
		session_id:'later-adopter',
		adopt_orphan:'orphan',
	});
	await adopted.release();
}));

function adoptionTombstone(lockPath) {
	return `${lockPath}.${randomUUID()}.adopting`;
}

test('owner release removes its manually captured live-lock tombstone and leaves the source claimable', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'live-owner'});
	const lock=await findLock(dataDir,'live-owner');
	const tombstone=adoptionTombstone(lock.fullPath);
	await rename(lock.fullPath,tombstone);

	await owner.release();
	await assert.rejects(lstat(tombstone),error=>error.code==='ENOENT');
	await assert.rejects(
		claimSource({original_path:original,data_dir:dataDir,session_id:'simulated-adopter',adopt_orphan:'live-owner'}),
		error=>error.code==='ALREADY_OPEN'&&!Object.hasOwn(error.details??{},'tombstone_path'),
	);
	const next=await claimSource({original_path:original,data_dir:dataDir,session_id:'next-owner'});
	await next.release();
}));

test('release removes only its own exact adoption tombstones when another owner has the lock', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'releasing-owner'});
	const lock=await findLock(dataDir,'releasing-owner');
	const ownTombstone=adoptionTombstone(lock.fullPath);
	const otherTombstone=adoptionTombstone(lock.fullPath);
	const similar=`${lock.fullPath}.not-a-uuid.adopting`;
	const unreadable=adoptionTombstone(lock.fullPath);
	await writeFile(ownTombstone,JSON.stringify(lock.record));
	await writeFile(otherTombstone,JSON.stringify({...lock.record,owner:'other-owner',session_id:'other-owner'}));
	await writeFile(similar,JSON.stringify(lock.record));
	await writeFile(unreadable,'{broken');
	await writeFile(lock.fullPath,JSON.stringify({...lock.record,owner:'current-owner',session_id:'current-owner'}));

	await owner.release();
	await assert.rejects(lstat(ownTombstone),error=>error.code==='ENOENT');
	assert.equal((await lstat(otherTombstone)).isFile(),true);
	assert.equal((await lstat(similar)).isFile(),true);
	assert.equal((await lstat(unreadable)).isFile(),true);
	assert.equal((await findLock(dataDir,'current-owner')).record.session_id,'current-owner');
}));

function removeCapturedTombstone(orphan) {
	const registry=join(orphan.dataDir,'sources');
	let settled=false;
	let resolveDone;
	let rejectDone;
	const done=new Promise((resolve,reject)=>{
		resolveDone=resolve;
		rejectDone=reject;
	});
	const watcher=watch(registry,()=>{
		if (settled) return;
		const name=readdirSync(registry).find(path=>path.endsWith('.adopting'));
		if (!name) return;
		settled=true;
		watcher.close();
		const tombstone=join(registry,name);
		try {
			unlinkSync(tombstone);
			resolveDone(tombstone);
		} catch (error) {
			rejectDone(error);
		}
	});
	return {
		done,
		close() {
			if (settled) return;
			settled=true;
			watcher.close();
			rejectDone(Error('Captured tombstone was not observed'));
		},
	};
}

test('restoring a captured lock reports ALREADY_OPEN without a stale tombstone path after owner cleanup', async () => withTemp(async dir => {
	const orphan=await createOrphanedSource(dir);
	const removal=removeCapturedTombstone(orphan);
	const [claimResult,removalResult]=await Promise.allSettled([
		claimSource({
			original_path:orphan.original,
			data_dir:orphan.dataDir,
			session_id:'competing-adopter',
			adopt_orphan:'different-session',
		}),
		removal.done,
	]);
	removal.close();
	assert.equal(removalResult.status,'fulfilled');
	assert.equal(claimResult.status,'rejected');
	assert.equal(claimResult.reason.code,'ALREADY_OPEN');
	assert.equal(Object.hasOwn(claimResult.reason.details??{},'tombstone_path'),false);
	const next=await claimSource({original_path:orphan.original,data_dir:orphan.dataDir,session_id:'unblocked-owner'});
	await next.release();
}));



test('tombstone scan ignores an incomplete record that only matches the owner session', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'scan-owner'});
	const lock=await findLock(dataDir,'scan-owner');
	const incomplete=adoptionTombstone(lock.fullPath);
	await writeFile(incomplete,JSON.stringify({session_id:'scan-owner'}));

	await owner.release();
	assert.deepEqual(JSON.parse(await readFile(incomplete,'utf8')),{session_id:'scan-owner'});
}));

test('tombstone scan ignores a symlink or junction without following its valid owner record', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'link-owner'});
	const lock=await findLock(dataDir,'link-owner');
	const candidate=adoptionTombstone(lock.fullPath);
	let target;
	if (process.platform==='win32') {
		target=join(dataDir,'junction-target');
		await mkdir(target);
		await writeFile(join(target,'record.json'),JSON.stringify(lock.record));
		await symlink(target,candidate,'junction');
	} else {
		target=join(dataDir,'linked-record.json');
		await writeFile(target,JSON.stringify(lock.record));
		await symlink(target,candidate,'file');
	}

	await owner.release();
	assert.equal((await lstat(candidate)).isSymbolicLink(),true);
	if (process.platform==='win32') {
		assert.deepEqual(JSON.parse(await readFile(join(target,'record.json'),'utf8')),lock.record);
	} else {
		assert.deepEqual(JSON.parse(await readFile(target,'utf8')),lock.record);
	}
}));

test('tombstone scan ignores owner records larger than 64 KiB', async () => withTemp(async dir => {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const owner=await claimSource({original_path:original,data_dir:dataDir,session_id:'large-owner'});
	const lock=await findLock(dataDir,'large-owner');
	const large=adoptionTombstone(lock.fullPath);
	const record={...lock.record,padding:'x'.repeat(64*1024)};
	await writeFile(large,JSON.stringify(record));

	await owner.release();
	assert.equal((await lstat(large)).size>64*1024,true);
	assert.deepEqual(JSON.parse(await readFile(large,'utf8')),record);
}));
