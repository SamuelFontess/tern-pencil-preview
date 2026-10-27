import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {SessionClient} from '../src/client.mjs';
import {MCP_METHODS} from '../src/protocol.mjs';
import {claimSource} from '../src/source.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {makeEngineFixture} from './fixtures.mjs';

const RUNTIME=fileURLToPath(new URL('../../runtime/',import.meta.url));
const EDITOR=join(RUNTIME,'editor.mjs');

function capture(command,args,options={}) {
	const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	child.stderr.setEncoding('utf8').on('data',chunk=>{ stderr+=chunk; });
	return new Promise((resolve,reject)=>{
		const timer=setTimeout(()=>{
			child.kill();
			reject(new Error('process timed out'));
		},180000);
		child.once('error',reject);
		child.once('close',code=>{
			clearTimeout(timer);
			resolve({code,stdout,stderr});
		});
	}).finally(()=>child.kill());
}

/** Processes anywhere on the machine whose command line mentions `needle` (the Pen engine takes the path as argv). */
async function processesMentioning(needle) {
	const {stdout}=await capture('powershell.exe',[
		'-NoProfile','-NonInteractive','-Command',
		'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:NEEDLE) } | ForEach-Object { $_.ProcessId }',
	],{env:{...process.env,NEEDLE:needle}});
	return stdout.split(/\s+/).filter(Boolean);
}

async function prepare(dir) {
	const base=join(dir,"A & B's ação");
	await mkdir(base,{recursive:true});
	const fixture=await makeEngineFixture(base);
	const dataDir=join(dir,'private');
	const manifest=join(dir,'launch.json');
	await writeFile(manifest,JSON.stringify({original_path:fixture.original,argv:fixture.argv,data_dir:dataDir}));
	return {fixture,dataDir,manifest,original:fixture.original};
}

async function assertReleased(original,dataDir) {
	const source=await claimSource({original_path:original,data_dir:dataDir,session_id:randomUUID()});
	await source.release();
}

test('the packaged owner reaches ready, serves the packaged MCP adapter, saves with the packaged helper and closes clean',
	{timeout:300000},async()=>{
		await withTemp(async dir=>{
			const {manifest,original,dataDir}=await prepare(dir);
			const before=await readFile(original);
			const bundle=await import(pathToFileURL(EDITOR).href);
			const started=performance.now();
			const owner=await bundle.startOwner(manifest,{entry:EDITOR,poll_ms:0});
			const readyMs=Math.round(performance.now()-started);
			let client;
			try {
				assert.ok(readyMs>0);
				console.log(`packaged owner ready in ${readyMs} ms`);
				assert.ok((await processesMentioning(basename(dir))).length>0,'the engine child is visible while the owner is open');
				const info=owner.document.info();
				assert.equal(info.revision,0);
				assert.equal(basename(info.original_path),'design.pen');
				assert.deepEqual(owner.mcp.args.slice(0,1),[join(RUNTIME,'mcp.mjs')]);

				client=new Client({name:'bundle-test',version:'1.0.0'});
				await client.connect(new StdioClientTransport({
					command:process.execPath,args:owner.mcp.args,stderr:'pipe',
				}));
				const listed=await client.listTools();
				assert.deepEqual(listed.tools.map(item=>item.name).sort(),[...MCP_METHODS].sort());
				assert.equal(listed.tools.length,10);
				const document=JSON.parse((await client.callTool({name:'get_document',arguments:{}})).content[0].text);
				assert.equal(document.session_id,info.session_id);
				assert.equal(document.original_path,info.original_path);
				assert.equal(document.revision,0);

				const {controller}=owner;
				await controller.selectNode('f85');
				const fill=controller.view().fields.find(field=>field.property==='fill');
				assert.equal(fill.editable,true);
				controller.edit('f85','fill',{from:0,to:fill.value.length,len:fill.value.length,text:'#123456',cursor:7});
				await controller.applyField('f85','fill');
				assert.equal(controller.view().notice,null);
				assert.equal(owner.document.info().revision,1);
				assert.equal((await owner.document.readNode('f85')).fill,'#123456');
				assert.deepEqual(await readFile(original),before,'editing never touches the original');

				await controller.save();
				assert.deepEqual(controller.view().notice,{kind:'info',message:'Saved revision 1'});
				const saved=JSON.parse(await readFile(original,'utf8'));
				const frame=saved.children.find(node=>node.id==='f85');
				assert.equal(frame.fill,'#123456');
				const backups=(await readdir(dirname(original))).filter(name=>name.endsWith('.bak'));
				assert.equal(backups.length,1,'the replaced original is kept as a backup');
				assert.ok((await stat(join(RUNTIME,'windows-replace.ps1'))).isFile());
			} finally {
				await client?.close().catch(()=>undefined);
				await owner.close();
			}
			await assertReleased(original,dataDir);
			assert.deepEqual(await processesMentioning(basename(dir)),[]);
		});
	});

test('the packaged owner runs as a plain process, answers its window and ends on close_editor: nothing on stdout or stderr, lock released, no child left',
	{timeout:300000},async()=>{
		await withTemp(async dir=>{
			const {manifest,original,dataDir}=await prepare(dir);
			// Tern's `tern.process.run`: no terminal, stdin closed at once, both outputs piped.
			const child=spawn(process.execPath,[EDITOR,'--launch',manifest],{windowsHide:true,stdio:['ignore','pipe','pipe']});
			let output='';
			child.stdout.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
			child.stderr.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
			const exited=new Promise(resolve=>child.once('close',code=>resolve(code)));
			let client;
			try {
				const deadline=Date.now()+120000;
				while (!client) {
					try {
						client=await SessionClient.connect({original_path:original,data_dir:dataDir});
					} catch (error) {
						if (Date.now()>deadline) throw error;
						await new Promise(resolve=>setTimeout(resolve,200));
					}
				}
				assert.equal(child.exitCode,null,'a closed stdin does not end it');
				assert.equal((await client.call('get_document')).revision,0);
				assert.deepEqual(await client.call('close_editor'),{closing:true});
				assert.equal(await exited,0);
				assert.equal(output,'');
			} finally {
				child.kill();
				await client?.close().catch(()=>undefined);
			}
			await assertReleased(original,dataDir);
			assert.deepEqual(await processesMentioning(basename(dir)),[]);
		});
	});
