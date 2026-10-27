import assert from 'node:assert/strict';
import {copyFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openOwner} from '../src/owner.mjs';
import {SessionClient} from '../src/client.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {expected,makeEngineFixture} from './fixtures.mjs';

const ENTRY=fileURLToPath(new URL('../src/main.mjs',import.meta.url));
const ADAPTER=fileURLToPath(new URL('../src/mcp.mjs',import.meta.url));
const tag=(generation=1)=>({request_id:'lifecycle',view_id:'board',view_generation:generation});

async function tool(client,name,args={}) {
	const reply=await client.callTool({name,arguments:args});
	assert.notEqual(reply.isError,true,JSON.stringify(reply.content));
	return JSON.parse(reply.content[0].text);
}

test('two owners isolate history and activity; detach leaves the engine alive; close keeps published assets and dirty recovery', {timeout:180000},async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const other=join(dir,'other.pen');
	await copyFile(fixture.original,other);
	const original=await readFile(fixture.original);
	const dataDir=join(dir,'private');
	const options=original_path=>({original_path,argv:fixture.argv,data_dir:dataDir});
	let a;
	let b;
	let reopened;
	let clientA;
	let clientB;
	let mcp;
	try {
		a=await openOwner(options(fixture.original),{entry:ENTRY,poll_ms:0});
		clientA=await SessionClient.connect({original_path:fixture.original,data_dir:dataDir});
		mcp=new Client({name:'lifecycle-test',version:'1.0.0'});
		await mcp.connect(new StdioClientTransport({command:process.execPath,args:[ADAPTER,'--document',fixture.original,'--data-dir',dataDir],stderr:'pipe'}));
		const before=await tool(mcp,'get_document');
		const committed=await tool(mcp,'apply_changes',{...expected(before),operations:[{op:'update',path:fixture.ids.text,props:{content:'Only document A'}}]});
		b=await openOwner(options(other),{entry:ENTRY,poll_ms:0});
		clientB=await SessionClient.connect({original_path:other,data_dir:dataDir});
		const bInfo=await clientB.call('get_document');
		assert.equal(bInfo.phase,'ready','opening B must not offer recovery of A');
		assert.equal(bInfo.dirty,false);
		assert.notEqual(bInfo.session_id,before.session_id);
		assert.equal((await clientB.call('get_nodes',{paths:[fixture.ids.text]})).nodes[0].node.content,fixture.ids.originalText);

		await clientA.call('get_frame_image',{frame_id:fixture.ids.component});
		await clientA.call('attach_view',{...tag(),scene_revision:committed.revision,frame_id:fixture.ids.component});
		const page=await clientA.call('list_frames',tag());
		assert.equal(page.activity.state,'ready');
		const published=page.page.nodes.find(node=>node.id===fixture.ids.component).image.path;
		const imageBytes=await readFile(published);
		assert.equal(imageBytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
		await clientA.call('detach_view',tag());
		assert.equal((await tool(mcp,'get_document')).revision,committed.revision);
		await assert.rejects(clientA.call('poll_view',tag()),error=>error.code==='VIEW_STALE');
		await clientA.call('attach_view',{...tag(2),scene_revision:committed.revision,frame_id:fixture.ids.component});
		assert.equal((await clientA.call('poll_view',tag(2))).view_generation,2);
		await a.close();
		await assert.rejects(clientA.call('get_document'),error=>error.code==='SESSION_UNAVAILABLE');
		assert.deepEqual(await readFile(published),imageBytes);
		assert.deepEqual(await readFile(fixture.original),original,'closing does not save implicitly');
		assert.equal((await clientB.call('get_document')).phase,'ready');
		assert.equal((await clientB.call('get_document')).dirty,false);

		reopened=await openOwner(options(fixture.original),{entry:ENTRY,poll_ms:0});
		assert.equal(reopened.document.info().phase,'recovering');
		await reopened.document.resolveRecovery('recover');
		assert.equal((await reopened.document.readNode(fixture.ids.text)).content,'Only document A');
		assert.notEqual(reopened.document.info().session_id,before.session_id);
		assert.deepEqual(await readFile(published),imageBytes,'a new owner cannot delete saved-board assets');
	} finally {
		await mcp?.close();
		await clientA?.close();
		await clientB?.close();
		await reopened?.close();
		await a?.close();
		await b?.close();
	}
	assert.deepEqual(await readdir(join(dataDir,'sessions')),[]);
	assert.deepEqual(await readdir(join(dataDir,'sources')),[]);
}));
