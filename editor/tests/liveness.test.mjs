import assert from 'node:assert/strict';
import {mkdir,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {SessionClient} from '../src/client.mjs';
import {endpointRefuses,lockOwnerStatus} from '../src/liveness.mjs';
import {sessionRecordPath} from '../src/protocol.mjs';
import {startServer} from '../src/server.mjs';
import {claimSource} from '../src/source.mjs';
import {sampleFile,withTemp} from './helpers.mjs';

// The tests' own process stands for "a process that holds the pid": Windows reuses pids, so a lock whose owner died
// can name a pid that another program now holds. Only what the lock's owner published can tell the two apart.

function listening() {
	return new Promise((resolve,reject)=>{
		const server=createServer(socket=>socket.destroy());
		server.once('error',reject);
		server.listen(0,'127.0.0.1',()=>resolve({
			endpoint:`http://127.0.0.1:${server.address().port}`,
			close:()=>new Promise(done=>server.close(done)),
		}));
	});
}

/** An endpoint nobody listens on: a port that was just released. */
async function deadEndpoint() {
	const server=await listening();
	await server.close();
	return server.endpoint;
}

async function publish(dataDir,original,sessionId,endpoint) {
	const canonical=await realpath(original);
	const path=sessionRecordPath(dataDir,canonical);
	await mkdir(dirname(path),{recursive:true});
	await writeFile(path,JSON.stringify({
		version:1,original_path:canonical,endpoint,token:'t'.repeat(43),session_id:sessionId,pid:process.pid,
	}),{mode:0o600});
}

async function claimed(dir,sessionId) {
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	const source=await claimSource({original_path:original,data_dir:dataDir,session_id:sessionId});
	return {original,dataDir,source};
}

test('a lock whose pid another process now holds is a dead lock when its published endpoint refuses connections',async()=>withTemp(async dir=>{
	const {original,dataDir}=await claimed(dir,'old');
	await publish(dataDir,original,'old',await deadEndpoint());
	const error=await claimSource({original_path:original,data_dir:dataDir,session_id:'new'}).catch(value=>value);
	assert.equal(error.code,'RECOVERY_REQUIRED');
	assert.equal(error.details.recovery.session_id,'old');
	const adopted=await claimSource({original_path:original,data_dir:dataDir,session_id:'new',adopt_orphan:'old'});
	try {
		assert.equal(adopted.adopted_orphan,true);
	} finally {
		await adopted.release();
	}
	assert.deepEqual(await readdir(join(dataDir,'sources')),[]);
}));

test('a lock whose owner answers on its published endpoint is open, and cannot be adopted',async()=>withTemp(async dir=>{
	const {original,dataDir,source}=await claimed(dir,'live');
	const server=await listening();
	try {
		await publish(dataDir,original,'live',server.endpoint);
		for (const options of [{session_id:'new'},{session_id:'new',adopt_orphan:'live'}]) {
			await assert.rejects(
				claimSource({original_path:original,data_dir:dataDir,...options}),
				error=>error.code==='ALREADY_OPEN',
			);
		}
	} finally {
		await server.close();
		await source.release();
	}
}));

test('an owner that has not published yet, or a record of another session, never makes a live pid look dead',async()=>withTemp(async dir=>{
	const {original,dataDir,source}=await claimed(dir,'starting');
	try {
		await assert.rejects(
			claimSource({original_path:original,data_dir:dataDir,session_id:'new'}),
			error=>error.code==='ALREADY_OPEN',
			'no record yet: the owner is still starting',
		);
		await publish(dataDir,original,'earlier-session',await deadEndpoint());
		await assert.rejects(
			claimSource({original_path:original,data_dir:dataDir,session_id:'new'}),
			error=>error.code==='ALREADY_OPEN',
			'the leftover record belongs to another session',
		);
	} finally {
		await source.release();
	}
}));

test('the MCP client does not take a record for a session when only its pid is alive',async()=>withTemp(async dir=>{
	const original=await sampleFile(dir);
	const dataDir=join(dir,'private');
	await publish(dataDir,original,'gone',await deadEndpoint());
	await assert.rejects(
		SessionClient.connect({original_path:original,data_dir:dataDir}),
		error=>error.code==='SESSION_UNAVAILABLE',
	);
	const server=await listening();
	try {
		await publish(dataDir,original,'here',server.endpoint);
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		assert.equal(client.record.session_id,'here');
		await client.close();
	} finally {
		await server.close();
	}
}));

test('a closing owner takes its session record down before its listener goes, so it is never judged dead while it drains',async()=>withTemp(async dir=>{
	const original=await sampleFile(dir);
	const canonical=await realpath(original);
	const dataDir=join(dir,'private');
	const info={
		session_id:'closing',original_path:canonical,revision:0,checkpoint_id:'a'.repeat(64),
		dirty:false,phase:'ready',status_seq:0,rendered_revision:0,
	};
	const server=await startServer({
		document:{info:()=>({...info})},renderer:{status:()=>({frame_ids:[],rendered_revision:0})},
		registry:{data_dir:dataDir},ui:null,
	});
	const record=sessionRecordPath(dataDir,canonical);
	await stat(record);
	const closing=server.close();
	try {
		// A record that is still there must name an endpoint that still answers: otherwise the lock's owner looks dead
		// to a second launch while it is only closing.
		for (let tries=0;tries<200;tries+=1) {
			if (await endpointRefuses(server.endpoint)) break;
			await new Promise(resolve=>setTimeout(resolve,5));
		}
		await assert.rejects(stat(record),error=>error.code==='ENOENT');
	} finally {
		await closing;
	}
}));

test('a refusal only counts while the record it was read from is still there',async()=>withTemp(async dir=>{
	const original=await sampleFile(dir);
	const canonical=await realpath(original);
	const dataDir=join(dir,'private');
	const lock={pid:process.pid,session_id:'closing',original_path:canonical};
	const record=sessionRecordPath(dataDir,canonical);
	await publish(dataDir,original,'closing',await deadEndpoint());
	assert.equal(await lockOwnerStatus(lock,dataDir),'missing','a record that stays and refuses is a dead owner');
	// The owner closes between the read and the probe: it takes its record down first, so the pid decides.
	assert.equal(await lockOwnerStatus(lock,dataDir,{probe:async()=>{
		await rm(record);
		return true;
	}}),'active');
}));
