import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openOwner} from '../src/owner.mjs';
import {SessionClient} from '../src/client.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {makeEngineFixture} from './fixtures.mjs';

const ENTRY=fileURLToPath(new URL('../src/main.mjs',import.meta.url));

test('the configuration the window asks the owner for starts an MCP client bound to that very document',{timeout:180000},async()=>withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	let owner;
	let view;
	let agent;
	try {
		owner=await openOwner({original_path:fixture.original,argv:fixture.argv,data_dir:dataDir},{entry:ENTRY,poll_ms:0});
		view=await SessionClient.connect({original_path:fixture.original,data_dir:dataDir});
		const {mcp}=await view.call('get_mcp_config');
		assert.deepEqual(mcp,owner.mcp);
		// What the window pastes is this command, with the arguments the owner gave it.
		const server={command:mcp.command,args:mcp.args};
		agent=new Client({name:'copy-mcp-test',version:'1.0.0'});
		await agent.connect(new StdioClientTransport({command:process.execPath,args:server.args,stderr:'pipe'}));
		const document=JSON.parse((await agent.callTool({name:'get_document',arguments:{}})).content[0].text);
		assert.equal(document.session_id,(await view.call('get_document')).session_id);
	} finally {
		await agent?.close().catch(()=>undefined);
		await view?.close().catch(()=>undefined);
		await owner?.close().catch(()=>undefined);
	}
}));
