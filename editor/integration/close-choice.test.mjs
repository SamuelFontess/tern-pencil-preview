import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {SessionClient} from '../src/client.mjs';
import {openOwner} from '../src/owner.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {expected,makeEngineFixture} from './fixtures.mjs';

const ENTRY=fileURLToPath(new URL('../src/main.mjs',import.meta.url));

async function assertNothingLeft(fixture,dataDir) {
	assert.deepEqual(await readdir(join(dataDir,'sources')),[],'the lock is released');
	assert.deepEqual(await readdir(join(dataDir,'sessions')),[],'the session record is removed');
	assert.deepEqual((await readdir(dirname(fixture.original))).filter(name=>name.includes('.tern-pencil-')),[],'the working copy is removed');
}

/** The editor's board is the only window: its owner is closed by the window after the user's choice. */
async function editThenClose(dir,choose) {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const before=await readFile(fixture.original);
	const options={original_path:fixture.original,argv:fixture.argv,data_dir:dataDir};
	const owner=await openOwner(options,{entry:ENTRY,poll_ms:0});
	let client;
	let closed=false;
	try {
		client=await SessionClient.connect({original_path:fixture.original,data_dir:dataDir});
		const info=await client.call('get_document');
		await client.call('apply_changes',{...expected(info),operations:[{op:'update',path:fixture.ids.text,props:{content:'Edited on the board'}}]});
		const edited=await client.call('get_document');
		assert.equal(edited.dirty,true);
		await choose(client,edited);
		await client.close();
		client=undefined;
		await owner.close();
		closed=true;
	} finally {
		await client?.close();
		if (!closed) await owner.close();
	}
	return {fixture,dataDir,before,options};
}

async function reopened({fixture,dataDir,options}) {
	const again=await openOwner(options,{entry:ENTRY,poll_ms:0});
	try {
		return {phase:again.document.info().phase,dirty:again.document.info().dirty,text:(await again.document.readNode(fixture.ids.text)).content};
	} finally {
		await again.close();
		await assertNothingLeft(fixture,dataDir);
	}
}

test('discarding leaves the original untouched, releases lock and working copy, and nothing to recover', {timeout:180000}, async () => withTemp(async dir => {
	const result=await editThenClose(dir,async(client,edited)=>{
		const stale=await client.call('discard_unsaved',{...expected(edited),base_revision:edited.revision-1}).catch(error=>error);
		assert.equal(stale.code,'REVISION_STALE');
		assert.equal((await client.call('get_document')).dirty,true,'a refused discard keeps the changes');
		assert.equal((await client.call('discard_unsaved',expected(edited))).discarded,true);
		const after=await client.call('get_document');
		assert.equal(after.dirty,false);
		assert.equal((await client.call('discard_unsaved',expected(after))).discarded,false,'nothing left to discard');
	});
	assert.deepEqual(await readFile(result.fixture.original),result.before,'discard never writes the original');
	await assertNothingLeft(result.fixture,result.dataDir);
	const next=await reopened(result);
	assert.deepEqual(next,{phase:'ready',dirty:false,text:result.fixture.ids.originalText});
}));

test('saving then closing publishes the change, releases lock and working copy, and nothing to recover', {timeout:180000}, async () => withTemp(async dir => {
	const result=await editThenClose(dir,async(client,edited)=>{
		assert.equal((await client.call('save_document',expected(edited))).saved,true);
		assert.equal((await client.call('get_document')).dirty,false);
	});
	assert.notDeepEqual(await readFile(result.fixture.original),result.before,'save publishes the original');
	await assertNothingLeft(result.fixture,result.dataDir);
	const next=await reopened(result);
	assert.deepEqual(next,{phase:'ready',dirty:false,text:'Edited on the board'});
}));

const TEXT='Unsaved before the loss';

/** A second process that opens the document, edits it and is then killed: no close, no cleanup (a crash, a reboot). */
async function editAndKill(options,fixture) {
	const ownerUrl=new URL('../src/owner.mjs',import.meta.url).href;
	const source=`
		import {openOwner} from ${JSON.stringify(ownerUrl)};
		const config=JSON.parse(process.env.CHILD_CONFIG);
		const owner=await openOwner(config.options,{entry:config.entry,poll_ms:0});
		const info=owner.document.info();
		await owner.document.applyChanges({session_id:info.session_id,base_revision:info.revision,operations:[{op:'update',path:config.path,props:{content:config.text}}]});
		process.stdout.write('dirty\\n');
		await new Promise(()=>{});
	`;
	const child=spawn(process.execPath,['--input-type=module','--eval',source],{
		env:{...process.env,CHILD_CONFIG:JSON.stringify({options,entry:ENTRY,path:fixture.ids.text,text:TEXT})},
		stdio:['ignore','pipe','pipe'],
	});
	try {
		await new Promise((resolve,reject)=>{
			let output='';
			let errors='';
			child.stdout.setEncoding('utf8').on('data',chunk=>{
				output+=chunk;
				if (output.includes('dirty\n')) resolve();
			});
			child.stderr.setEncoding('utf8').on('data',chunk=>{ errors+=chunk; });
			child.once('close',()=>reject(Error(`child ended early: ${errors}`)));
		});
		const closed=once(child,'close');
		child.kill('SIGKILL');
		await closed;
	} finally {
		if (child.exitCode===null) child.kill('SIGKILL');
	}
}

/** An owner that ended with unsaved edits (`closed`: asked to end; `killed`: the process died): the next one starts in recovery. */
async function openAfterLoss(dir,loss,choice) {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const before=await readFile(fixture.original);
	const options={original_path:fixture.original,argv:fixture.argv,data_dir:dataDir};
	if (loss==='killed') {
		await editAndKill(options,fixture);
	} else {
		const first=await openOwner(options,{entry:ENTRY,poll_ms:0});
		try {
			const info=first.document.info();
			await first.document.applyChanges({...expected(info),operations:[{op:'update',path:fixture.ids.text,props:{content:TEXT}}]});
		} finally {
			await first.close();
		}
	}
	const owner=await openOwner(options,{entry:ENTRY,poll_ms:0});
	let client;
	let result;
	try {
		client=await SessionClient.connect({original_path:fixture.original,data_dir:dataDir});
		const recovering=await client.call('get_document');
		assert.equal(recovering.phase,'recovering');
		assert.equal(recovering.activity.phase,'recovering');
		assert.deepEqual(recovering.recovery_choices.map(item=>item.choice),['recover','discard']);
		const answer=await client.call('resolve_recovery',{choice});
		assert.equal(answer.phase,'ready');
		const after=await client.call('get_document');
		assert.deepEqual(after.recovery_choices,[]);
		result={text:(await owner.document.readNode(fixture.ids.text)).content,dirty:after.dirty,original:await readFile(fixture.original),before};
	} finally {
		await client?.close();
		await owner.close();
	}
	await assertNothingLeft(fixture,dataDir);
	// What the user does next: close again (after Discard of the recovery nothing is unsaved), and the file opens ready.
	if (!result.dirty) {
		const again=await openOwner(options,{entry:ENTRY,poll_ms:0});
		try {
			result.reopened=again.document.info().phase;
		} finally {
			await again.close();
		}
	}
	return result;
}

for (const loss of ['closed','killed']) {
	test(`after the owner ${loss} with unsaved edits, recover over the owner protocol brings them back`, {timeout:240000}, async () => withTemp(async dir => {
		const result=await openAfterLoss(dir,loss,'recover');
		assert.equal(result.text,TEXT);
		assert.equal(result.dirty,true);
		assert.deepEqual(result.original,result.before);
	}));

	test(`after the owner ${loss} with unsaved edits, discard over the owner protocol starts from the file and reopens ready`, {timeout:240000}, async () => withTemp(async dir => {
		const result=await openAfterLoss(dir,loss,'discard');
		assert.notEqual(result.text,TEXT);
		assert.equal(result.dirty,false);
		assert.deepEqual(result.original,result.before);
		assert.equal(result.reopened,'ready');
	}));
}
