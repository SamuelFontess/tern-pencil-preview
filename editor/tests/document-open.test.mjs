import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstat,readdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import test from 'node:test';
import {openDocument} from '../src/document.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';
import {sampleFile,withTemp} from './helpers.mjs';

test('a failed open discards its own working copy, keeps the original and releases the lock', {timeout:30000},async()=>{
	await withTemp(async dir=>{
		const original=await sampleFile(dir);
		const before=await readFile(original);
		const dataDir=join(dir,'private');
		const source=await claimSource({original_path:original,data_dir:dataDir,session_id:randomUUID()});
		// Planted after the claim: a copy that was there before it is swept (editor/tests/source.test.mjs).
		const neighbour=join(dirname(original),`.${basename(original)}.tern-pencil-${randomUUID()}.pen`);
		await writeFile(neighbour,'not ours');
		const store=await openStore({dir:join(dataDir,'history'),max_steps:50,max_bytes:200*1024*1024});
		await assert.rejects(openDocument({
			source,store,cli_argv:[process.execPath,'-e','process.exit(3)'],recovery:'prompt',
		}));
		await assert.rejects(lstat(source.working_path),error=>error.code==='ENOENT');
		assert.equal(await readFile(neighbour,'utf8'),'not ours');
		assert.deepEqual(await readFile(original),before);
		assert.deepEqual(await readdir(join(dataDir,'sources')),[]);
	});
});

test('a failing cleanup never replaces the error that stopped the open', {timeout:30000},async()=>{
	await withTemp(async dir=>{
		const original=await sampleFile(dir);
		const dataDir=join(dir,'private');
		const source=await claimSource({original_path:original,data_dir:dataDir,session_id:randomUUID()});
		const store=await openStore({dir:join(dataDir,'history'),max_steps:50,max_bytes:200*1024*1024});
		source.discardWorking=async()=>{
			throw Object.assign(new Error('busy'),{code:'EBUSY'});
		};
		let thrown;
		await assert.rejects(openDocument({
			source,store,cli_argv:[process.execPath,'-e','process.exit(3)'],recovery:'prompt',
		}),error=>{
			thrown=error;
			return true;
		});
		assert.notEqual(thrown.code,'EBUSY');
		assert.equal(thrown.cleanup_failures[0].code,'EBUSY');
		assert.deepEqual(await readdir(join(dataDir,'sources')),[],'the lock is still released');
	});
});
