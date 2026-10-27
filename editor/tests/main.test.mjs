import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseArguments,startOwner} from '../src/main.mjs';
import {readManifest} from '../src/owner.mjs';
import {withTemp} from './helpers.mjs';

const MAIN=fileURLToPath(new URL('../src/main.mjs',import.meta.url));

function run(args,env={}) {
	const child=spawn(process.execPath,args,{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	child.stderr.setEncoding('utf8').on('data',chunk=>{ stderr+=chunk; });
	return new Promise((resolve,reject)=>{
		const timer=setTimeout(()=>{
			child.kill();
			reject(new Error('process timed out'));
		},60000);
		child.once('error',reject);
		child.once('close',code=>{
			clearTimeout(timer);
			resolve({code,stdout,stderr});
		});
	}).finally(()=>child.kill());
}

test('bad arguments answer with a JSON error on stdout and a failing status', async()=>{
	for (const args of [[],['--launch'],['--launch','a','b'],['launch-command','m.json'],['frobnicate','x']]) {
		const result=await run([MAIN,...args]);
		assert.notEqual(result.code,0,args.join(' '));
		assert.equal(result.code,2);
		assert.equal(JSON.parse(result.stdout).error.code,'USAGE');
		assert.equal(result.stderr,'');
	}
});

test('the only mode is the session owner, started with a manifest',()=>{
	assert.deepEqual(parseArguments(['node','main','--launch','m.json']),{mode:'owner',manifest:'m.json'});
	assert.throws(()=>parseArguments(['node','main','--launch']),error=>error.code==='USAGE');
	assert.throws(()=>parseArguments(['node','main','launch-command','m.json']),error=>error.code==='USAGE');
});

test('the private manifest is plain data validated before anything opens', async()=>{
	await withTemp(async dir=>{
		const write=async value=>{
			const path=join(dir,'m.json');
			await writeFile(path,typeof value==='string'?value:JSON.stringify(value));
			return path;
		};
		const original=join(dir,'design.pen');
		const good=await readManifest(await write({original_path:original,argv:['node','pen.mjs'],data_dir:join(dir,'state')}));
		assert.deepEqual(good,{original_path:original,argv:['node','pen.mjs'],data_dir:join(dir,'state')});
		const launch_id='0123456789abcdef0123456789abcdef';
		const withNonce=await readManifest(await write({original_path:original,argv:['node','pen.mjs'],data_dir:join(dir,'state'),launch_id}));
		assert.equal(withNonce.launch_id,launch_id);
		for (const badId of ['','0123','0123456789ABCDEF0123456789ABCDEF',7,null,'0123456789abcdef0123456789abcdeg']) {
			await assert.rejects(
				readManifest(await write({original_path:original,argv:['pen'],data_dir:join(dir,'state'),launch_id:badId})),
				error=>error.code==='MANIFEST_INVALID',String(badId),
			);
		}
		for (const bad of [
			'not json','[]',{},{original_path:'relative.pen',argv:['pen'],data_dir:join(dir,'state')},
			{original_path:original,argv:[],data_dir:join(dir,'state')},
			{original_path:original,argv:['pen',1],data_dir:join(dir,'state')},
			{original_path:original,argv:['pen']},{original_path:original,argv:['pen'],data_dir:'relative'},
			{original_path:original,argv:['pen'],data_dir:''},
		]) {
			await assert.rejects(readManifest(await write(bad)),error=>error.code==='MANIFEST_INVALID');
		}
		await assert.rejects(readManifest(join(dir,'absent.json')),error=>error.code==='MANIFEST_INVALID');
	});
});

test('the owner deletes its manifest as soon as it has read it, even when opening then fails; a bad manifest is left alone', async()=>{
	await withTemp(async dir=>{
		const manifest=join(dir,'launch.json');
		// The original does not exist, so openOwner fails after the manifest was read: no engine is needed.
		await writeFile(manifest,JSON.stringify({
			original_path:join(dir,'missing.pen'),argv:['pen'],data_dir:join(dir,'state'),
		}));
		await assert.rejects(startOwner(manifest));
		await assert.rejects(stat(manifest),error=>error.code==='ENOENT');
		const bad=join(dir,'bad.json');
		await writeFile(bad,'not json');
		await assert.rejects(startOwner(bad),error=>error.code==='MANIFEST_INVALID');
		assert.equal((await readFile(bad,'utf8')),'not json');
	});
});

test('an owner that fails before it publishes its session leaves the reason under its launch id, and only then',async()=>{
	await withTemp(async dir=>{
		const launch_id='0123456789abcdef0123456789abcdef';
		const data_dir=join(dir,'state');
		const manifest=join(dir,'launch.json');
		await writeFile(manifest,JSON.stringify({original_path:join(dir,'missing.pen'),argv:['pen'],data_dir,launch_id}));
		await assert.rejects(startOwner(manifest),error=>error.code==='SOURCE_UNAVAILABLE');
		// Beside the manifest, under its name with `.failed` for `.json`: the folder sweep that clears stale manifests clears it too.
		assert.deepEqual(JSON.parse(await readFile(join(data_dir,'launch.failed'),'utf8')),{code:'SOURCE_UNAVAILABLE'});
		// Without a nonce the plugin has nothing to look for: nothing is written.
		const anonymous=join(dir,'anonymous.json');
		const other=join(dir,'other');
		await writeFile(anonymous,JSON.stringify({original_path:join(dir,'missing.pen'),argv:['pen'],data_dir:other}));
		await assert.rejects(startOwner(anonymous));
		assert.deepEqual(await readdir(other).catch(()=>[]),[]);
	});
});
