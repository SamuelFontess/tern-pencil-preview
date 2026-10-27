import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {SessionClient} from '../src/client.mjs';
import {ownerMode} from '../src/main.mjs';
import {systemTool} from '../src/system.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {expected,makeEngineFixture,testCliArgv} from './fixtures.mjs';

const MAIN=fileURLToPath(new URL('../src/main.mjs',import.meta.url));
const LAUNCH_ID='0123456789abcdef0123456789abcdef';

async function processesMentioning(needle) {
	const child=spawn(systemTool('powershell'),[
		'-NoProfile','-NonInteractive','-Command',
		'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:NEEDLE) } | ForEach-Object { $_.ProcessId }',
	],{env:{...process.env,NEEDLE:needle},windowsHide:true,stdio:['ignore','pipe','ignore']});
	let stdout='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	await new Promise(resolve=>child.once('close',resolve));
	return stdout.split(/\s+/).filter(Boolean);
}

async function until(label,probe,timeoutMs=120000) {
	const deadline=Date.now()+timeoutMs;
	for (;;) {
		try {
			const value=await probe();
			if (value) return value;
		} catch {
			// not there yet
		}
		if (Date.now()>deadline) throw new Error(`${label} not reached in ${timeoutMs} ms`);
		await new Promise(resolve=>setTimeout(resolve,100));
	}
}

/** The owner as Tern's `tern.process.run` starts it: a child of its own with stdin closed at once and both outputs piped. */
function startChild(manifest) {
	const child=spawn(process.execPath,[MAIN,'--launch',manifest],{windowsHide:true,stdio:['ignore','pipe','pipe']});
	let output='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
	child.stderr.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
	const exited=new Promise(resolve=>child.once('close',code=>resolve({code,output})));
	return {child,exited};
}

async function launch(dir,fixture,dataDir,name='launch.json') {
	const manifest=join(dir,name);
	await writeFile(manifest,JSON.stringify({original_path:fixture.original,argv:testCliArgv(),data_dir:dataDir,launch_id:LAUNCH_ID}));
	const owner=startChild(manifest);
	const client=await until('session record',()=>SessionClient.connect({original_path:fixture.original,data_dir:dataDir}));
	return {...owner,client};
}

async function nothingLeft(dir,fixture,dataDir) {
	assert.deepEqual(await readdir(join(dataDir,'sources')),[]);
	assert.deepEqual(await readdir(join(dataDir,'sessions')),[]);
	assert.deepEqual((await readdir(dirname(fixture.original))).filter(name=>name.includes('.tern-pencil-')),[]);
	if (process.platform==='win32') assert.deepEqual(await processesMentioning(dir),[]);
}

const edit=(fixture,info,content)=>({...expected(info),operations:[{op:'update',path:fixture.ids.text,props:{content}}]});

test('the owner Tern starts keeps running with its stdin closed, and close_editor ends it cleanly', {timeout:240000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const owner=await launch(dir,fixture,dataDir);
	try {
		await new Promise(resolve=>setTimeout(resolve,1000));
		assert.equal(owner.child.exitCode,null,'a closed stdin is how Tern starts it, not a reason to stop');
		const info=await owner.client.call('get_document');
		assert.equal(info.phase,'ready');
		assert.deepEqual(await owner.client.call('close_editor'),{closing:true});
		const {code,output}=await owner.exited;
		assert.equal(code,0);
		assert.equal(output,'','a clean end says nothing: the output the host keeps is bounded by construction');
		await assert.rejects(owner.client.call('get_document'),error=>['SESSION_UNAVAILABLE','SERVER_CLOSING'].includes(error.code));
		await nothingLeft(dir,fixture,dataDir);
	} finally {
		owner.child.kill();
		await owner.client.close();
	}
}));

test('Discard then close_editor leaves the file as it was and no recovery; Save then close_editor publishes and leaves none', {timeout:360000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const before=await readFile(fixture.original);
	let owner=await launch(dir,fixture,dataDir,'a.json');
	try {
		const info=await owner.client.call('get_document');
		await owner.client.call('apply_changes',edit(fixture,info,'Discarded'));
		const dirty=await owner.client.call('get_document');
		assert.equal(dirty.dirty,true);
		await owner.client.call('discard_unsaved',expected(dirty));
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
		await owner.client.close();
		assert.deepEqual(await readFile(fixture.original),before,'discarding never writes the original');
		await nothingLeft(dir,fixture,dataDir);

		owner=await launch(dir,fixture,dataDir,'b.json');
		const reopened=await owner.client.call('get_document');
		assert.equal(reopened.phase,'ready','a discarded edit is not offered back');
		assert.equal(reopened.dirty,false);
		await owner.client.call('apply_changes',edit(fixture,reopened,'Saved'));
		const saving=await owner.client.call('get_document');
		await owner.client.call('save_document',expected(saving));
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
		await owner.client.close();
		assert.notDeepEqual(await readFile(fixture.original),before);
		await nothingLeft(dir,fixture,dataDir);

		owner=await launch(dir,fixture,dataDir,'c.json');
		const saved=await owner.client.call('get_document');
		assert.equal(saved.phase,'ready');
		assert.equal(saved.dirty,false);
		assert.equal((await owner.client.call('get_nodes',{paths:[fixture.ids.text]})).nodes[0].node.content,'Saved');
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
	} finally {
		owner.child.kill();
		await owner.client.close();
	}
}));

test('close_editor with unsaved changes keeps them for the next opening, which can recover or discard them', {timeout:360000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	let owner=await launch(dir,fixture,dataDir,'a.json');
	try {
		const info=await owner.client.call('get_document');
		await owner.client.call('apply_changes',edit(fixture,info,'Kept'));
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
		await owner.client.close();
		await nothingLeft(dir,fixture,dataDir);

		owner=await launch(dir,fixture,dataDir,'b.json');
		const recovering=await owner.client.call('get_document');
		assert.equal(recovering.phase,'recovering');
		assert.deepEqual(recovering.recovery_choices.map(item=>item.choice),['recover','discard']);
		await owner.client.call('resolve_recovery',{choice:'discard'});
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
		await owner.client.close();

		owner=await launch(dir,fixture,dataDir,'c.json');
		assert.equal((await owner.client.call('get_document')).phase,'ready','the discarded recovery is gone');
		await owner.client.call('close_editor');
		assert.equal((await owner.exited).code,0);
	} finally {
		owner.child.kill();
		await owner.client.close();
	}
}));

test('a second launch of a document that is open stops with ALREADY_OPEN, says so for the window, and leaves the first owner serving', {timeout:240000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const owner=await launch(dir,fixture,dataDir);
	try {
		const info=await owner.client.call('get_document');
		const second=join(dir,'second.json');
		const secondId='fedcba9876543210fedcba9876543210';
		await writeFile(second,JSON.stringify({original_path:fixture.original,argv:testCliArgv(),data_dir:dataDir,launch_id:secondId}));
		const {code,output}=await startChild(second).exited;
		assert.equal(code,1);
		assert.match(output,/ALREADY_OPEN/);
		assert.deepEqual(JSON.parse(await readFile(join(dataDir,'second.failed'),'utf8')),{code:'ALREADY_OPEN'});
		assert.equal((await owner.client.call('get_document')).session_id,info.session_id,'the first owner is untouched');
		// What the window reconnects with: the live owner's record names the document it serves.
		const records=await readdir(join(dataDir,'sessions'));
		assert.equal(records.length,1);
		assert.equal(JSON.parse(await readFile(join(dataDir,'sessions',records[0]),'utf8')).original_path,info.original_path);
	} finally {
		await owner.client.call('close_editor').catch(()=>undefined);
		owner.child.kill();
		await owner.client.close();
	}
}));

/**
 * The owner as Tern leaves it once the window is gone: a child process whose stdout and stderr nobody reads any more
 * (Tern quit, or reloaded the plugin and dropped the callback), so a write to either fails with EPIPE. It runs `ownerMode`
 * with a short limit through a script of its own, and the pipes are cut as soon as the window has seen the owner.
 */
async function ownerThatExpires(dir,fixture,dataDir,onOwner,orphanMs=4000) {
	const manifest=join(dir,'expiring.json');
	await writeFile(manifest,JSON.stringify({original_path:fixture.original,argv:testCliArgv(),data_dir:dataDir,launch_id:LAUNCH_ID}));
	const script=join(dir,'expiring.mjs');
	await writeFile(script,`import {ownerMode} from ${JSON.stringify(pathToFileURL(MAIN).href)};
await ownerMode(${JSON.stringify(manifest)},${JSON.stringify(MAIN)},{orphan_ms:${orphanMs},check_ms:200});
`);
	const child=spawn(process.execPath,[script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
	const exited=new Promise(resolve=>child.once('close',code=>resolve(code)));
	try {
		const client=await until('session record',()=>SessionClient.connect({original_path:fixture.original,data_dir:dataDir}));
		try {
			await onOwner(client);
		} finally {
			await client.close();
		}
		child.stdout.destroy();
		child.stderr.destroy();
		return {code:await exited};
	} finally {
		child.kill();
	}
}

test('an owner no window asks for ends itself: a clean document leaves nothing behind, though nobody reads its output', {timeout:240000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const {code}=await ownerThatExpires(dir,fixture,dataDir,async client=>{
		assert.equal((await client.call('get_document')).phase,'ready');
	});
	assert.equal(code,0);
	await nothingLeft(dir,fixture,dataDir);
}));

test('an owner no window asks for ends itself with unsaved changes kept: the next opening offers them back', {timeout:360000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const before=await readFile(fixture.original);
	const {code}=await ownerThatExpires(dir,fixture,dataDir,async client=>{
		// The window's last word, so that the lease runs from here and not from the owner's start: a loaded machine makes the
		// edit slow, and the limit is only there to be reached afterwards.
		await client.call('attach_view',{request_id:'last',view_id:'board',view_generation:1,scene_revision:0,holder:'window'});
		const info=await client.call('get_document');
		await client.call('apply_changes',edit(fixture,info,'Left behind'));
		assert.equal((await client.call('get_document')).dirty,true);
	},10000);
	assert.equal(code,0);
	assert.deepEqual(await readFile(fixture.original),before,'expiring never saves');
	await nothingLeft(dir,fixture,dataDir);
	const owner=await launch(dir,fixture,dataDir,'again.json');
	try {
		assert.equal((await owner.client.call('get_document')).phase,'recovering');
		await owner.client.call('resolve_recovery',{choice:'recover'});
		assert.equal((await owner.client.call('get_nodes',{paths:[fixture.ids.text]})).nodes[0].node.content,'Left behind');
		await owner.client.call('close_editor');
		await owner.exited;
	} finally {
		owner.child.kill();
		await owner.client.close();
	}
}));

test('a window that keeps asking keeps the owner past its limit', {timeout:240000}, async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const manifest=join(dir,'kept.json');
	await writeFile(manifest,JSON.stringify({original_path:fixture.original,argv:testCliArgv(),data_dir:dataDir,launch_id:LAUNCH_ID}));
	const events=new EventEmitter();
	const exits=[];
	const finished=ownerMode(manifest,MAIN,{events,exit:code=>{ exits.push(code); },orphan_ms:2000,check_ms:100});
	const client=await until('session record',()=>SessionClient.connect({original_path:fixture.original,data_dir:dataDir}));
	try {
		const tag={request_id:'keep',view_id:'board',view_generation:1};
		// Asking from the first moment, as the window does: the first render takes longer than the limit.
		await client.call('attach_view',{...tag,scene_revision:0,holder:'window'});
		await until('first render',async()=>(await client.call('list_frames',{...tag,cursor:null})).activity.state==='ready');
		for (let beat=0;beat<12;beat+=1) {
			await new Promise(resolve=>setTimeout(resolve,500));
			await client.call('list_frames',{...tag,cursor:null});
		}
		assert.deepEqual(exits,[],'six seconds of asking outlast a two second limit');
	} finally {
		await client.call('close_editor').catch(()=>undefined);
		await finished;
		await client.close();
	}
	assert.deepEqual(exits,[0]);
}));
