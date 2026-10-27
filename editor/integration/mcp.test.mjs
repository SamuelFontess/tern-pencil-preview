import assert from 'node:assert/strict';
import childProcess,{fork,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {connect as connectSocket} from 'node:net';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {SessionClient} from '../src/client.mjs';
import {startServer} from '../src/server.mjs';
import {makeEngineFixture} from './fixtures.mjs';
import {withTemp} from '../tests/helpers.mjs';

const OWNER=new URL('../smoke/owner-fixture.mjs',import.meta.url);
const ADAPTER=new URL('../src/mcp.mjs',import.meta.url);

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function message(child,type,timeout=120000) {
	return new Promise((resolve,reject)=>{
		const timer=setTimeout(()=>reject(Error(`Timed out waiting for ${type}`)),timeout);
		function receive(value) {
			if (value?.type==='error') {
				cleanup();
				reject(Object.assign(Error(value.message),{code:value.code}));
			} else if (value?.type===type) {
				cleanup();
				resolve(value);
			}
		}
		function exited(code,signal) {
			cleanup();
			reject(Error(`Owner exited before ${type}: code=${code} signal=${signal}`));
		}
		function cleanup() {
			clearTimeout(timer);
			child.off('message',receive);
			child.off('exit',exited);
		}
		child.on('message',receive);
		child.once('exit',exited);
	});
}

async function startOwner({original,dataDir,argv}) {
	const child=fork(OWNER,[
		'--document',original,'--data-dir',dataDir,'--cli-argv',JSON.stringify(argv),
	],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data',chunk=>{ stdout+=chunk; });
	child.stderr.on('data',chunk=>{ stderr+=chunk; });
	try {
		const ready=await message(child,'ready');
		return {child,ready,stdout:()=>stdout,stderr:()=>stderr};
	} catch (error) {
		child.kill();
		await once(child,'exit').catch(()=>undefined);
		throw error;
	}
}

async function stopOwner(owner) {
	if (owner.child.exitCode!==null) return;
	owner.child.send({type:'shutdown'});
	let timer;
	try {
		await Promise.race([
			once(owner.child,'exit'),
			new Promise((_,reject)=>{ timer=setTimeout(()=>reject(Error('Owner shutdown timed out')),120000); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function connectMcp(original,dataDir) {
	const transport=new StdioClientTransport({
		command:process.execPath,
		args:[ADAPTER.pathname.slice(1),'--document',original,'--data-dir',dataDir],
		stderr:'pipe',
	});
	const client=new Client({name:'tern-pencil-editor-test',version:'1.0.0'});
	await client.connect(transport);
	let raw='';
	transport._process.stdout.on('data',chunk=>{ raw+=chunk.toString('utf8'); });
	return {client,transport,raw:()=>raw};
}

async function tool(client,name,args={}) {
	const result=await client.callTool({name,arguments:args});
	return {
		isError:result.isError===true,
		value:JSON.parse(result.content[0].text),
		content:result.content,
	};
}

async function withMcpDocument(fn) {
	return withTemp(async dir=>{
		const fixture=await makeEngineFixture(dir);
		const dataDir=join(dir,'private');
		const owner=await startOwner({original:fixture.original,dataDir,argv:fixture.argv});
		let connection;
		try {
			const canonicalAlias=join(dirname(fixture.original),'.','design.pen');
			connection=await connectMcp(canonicalAlias,dataDir);
			return await fn({
				client:connection.client,transport:connection.transport,raw:connection.raw,
				fixture:{...fixture.ids,original:fixture.original},owner,dataDir,
			});
		} finally {
			await connection?.client.close().catch(()=>undefined);
			await stopOwner(owner).catch(()=>undefined);
		}
	});
}

test('MCP real rejects stale and partial edits, keeps stdout JSON-RPC, and saves only explicitly',{timeout:600000},async t=>{
	await withMcpDocument(async({client,raw,fixture,owner})=>{
		const original=await readFile(fixture.original);
		const initial=await tool(client,'get_document');
		assert.equal(initial.isError,false);
		const hidden=await tool(client,'attach_view',{
			request_id:'hidden',view_id:'hidden',view_generation:1,
			scene_revision:initial.value.revision,frame_id:fixture.component,
		});
		assert.equal(hidden.isError,true);
		assert.equal(hidden.value.code,'METHOD_NOT_FOUND');
		async function sessionCall(method,args) {
			const response=await fetch(owner.ready.endpoint,{
				method:'POST',
				headers:{Authorization:`Bearer ${owner.ready.token}`,'Content-Type':'application/json'},
				body:JSON.stringify({method,args,session_id:owner.ready.session_id}),
			});
			assert.equal(response.status,200);
			return (await response.json()).result;
		}
		await sessionCall('attach_view',{
			request_id:'attach-1',view_id:'view-1',view_generation:1,
			scene_revision:initial.value.revision,frame_id:fixture.component,
		});
		const poll=await sessionCall('poll_view',{
			request_id:'poll-1',view_id:'view-1',view_generation:1,cursor:null,
		});
		assert.equal(poll.request_id,'poll-1');
		assert.equal(typeof poll.status_seq,'number');
		assert.equal(poll.view_generation,1);
		assert.equal(poll.page.frame_id,fixture.component);
		assert.equal(poll.page.revision,initial.value.revision);
		assert.ok(Array.isArray(poll.page.nodes));
		assert.ok(Object.hasOwn(poll.page,'cursor'));
		assert.ok(Object.hasOwn(poll.page,'next_cursor'));
		const root=poll.page.nodes.find(node=>node.path===fixture.component);
		const asked=message(owner.child,'capture');
		owner.child.send({type:'request_capture'});
		let requested;
		for (let attempt=0;attempt<50&&!requested?.capture;attempt+=1) {
			if (attempt>0) await new Promise(resolve=>setTimeout(resolve,20));
			requested=await sessionCall('list_frames',{request_id:`list-${attempt}`,view_id:'view-1',view_generation:1});
		}
		assert.equal(typeof requested.capture.capture_id,'string');
		const capture=await sessionCall('submit_capture',{
			request_id:'poll-1',capture_id:requested.capture.capture_id,view_id:'view-1',view_generation:1,
			scene_revision:poll.page.revision,
			changes:[{path:root.path,x:root.geometry.x,y:root.geometry.y,w:root.geometry.width,h:root.geometry.height}],
		});
		assert.equal(capture.outcome,'unchanged');
		assert.equal(capture.revision,initial.value.revision);
		assert.equal((await asked).outcome.applied,false);
		const base={session_id:initial.value.session_id,base_revision:initial.value.revision};

		const applyStarted=performance.now();
		const accepted=await tool(client,'apply_changes',{...base,operations:[
			{op:'insert',parent:null,node:{type:'frame',name:'MCP inserted',x:500,y:0,width:40,height:40}},
			{op:'copy',path:fixture.component,parent:null,data:{name:'MCP copy',x:550,y:0}},
			{op:'update',path:fixture.text,props:{content:'Via MCP'}},
			{op:'replace',path:fixture.path,node:{type:'text',name:'Replacement',content:'Replaced',fontFamily:'Arial',fontSize:16}},
			{op:'move',path:fixture.instance,parent:null,index:0},
			{op:'delete',path:fixture.imageFrame},
			{op:'set_variables',variables:{shared:{type:'number',value:12}}},
		]});
		const applyMs=performance.now()-applyStarted;
		assert.equal(accepted.isError,false);
		assert.deepEqual(await readFile(fixture.original),original);

		const stale=await tool(client,'apply_changes',{...base,operations:[{op:'delete',path:fixture.text}]});
		assert.equal(stale.isError,true);
		assert.equal(stale.value.code,'REVISION_STALE');
		const read=await tool(client,'get_nodes',{paths:[fixture.text]});
		assert.equal(read.value.nodes[0].node.content,'Via MCP');

		const beforeFailure=await tool(client,'get_document');
		const failed=await tool(client,'apply_changes',{
			session_id:beforeFailure.value.session_id,base_revision:beforeFailure.value.revision,
			operations:[
				{op:'update',path:fixture.text,props:{content:'must roll back'}},
				{op:'set_variables',variables:{invalid:'#fff'}},
			],
		});
		assert.equal(failed.isError,true);
		assert.equal(failed.value.code,'OPERATIONS_REJECTED');
		assert.equal((await tool(client,'get_nodes',{paths:[fixture.text]})).value.nodes[0].node.content,'Via MCP');
		const wrongProp=await tool(client,'apply_changes',{
			session_id:beforeFailure.value.session_id,base_revision:beforeFailure.value.revision,
			operations:[{op:'update',path:fixture.component,props:{content:'a frame has no text'}}],
		});
		assert.equal(wrongProp.isError,true);
		assert.equal(wrongProp.value.code,'OPERATIONS_REJECTED');
		assert.match(wrongProp.value.message,/content/);
		assert.equal((await tool(client,'get_document')).value.revision,beforeFailure.value.revision);

		const variables=await tool(client,'get_variables');
		const schema=await tool(client,'get_schema');
		assert.equal(variables.value.variables.shared.value,12);
		assert.equal(typeof schema.value.schema,'string');
		const afterQueries=await tool(client,'get_document');
		assert.equal(afterQueries.value.revision,beforeFailure.value.revision);
		const recovery=await tool(client,'save_recovery_copy',{
			session_id:afterQueries.value.session_id,base_revision:afterQueries.value.revision,
		});
		assert.equal(recovery.isError,false);
		assert.deepEqual(await readFile(fixture.original),original);
		assert.equal((await tool(client,'get_document')).value.revision,afterQueries.value.revision);

		const frameId=afterQueries.value.frames.find(id=>id===fixture.component)??afterQueries.value.frames[0];
		const imageStarted=performance.now();
		const image=await tool(client,'get_frame_image',{frame_id:frameId,max_side:4096});
		const imageMs=performance.now()-imageStarted;
		assert.equal(image.isError,false);
		assert.equal(image.value.revision,afterQueries.value.revision);
		assert.equal(image.content[1].type,'image');
		assert.ok(Buffer.from(image.content[1].data,'base64').length>8);

		const undoStarted=performance.now();
		const undone=await tool(client,'undo_document',{
			session_id:afterQueries.value.session_id,base_revision:afterQueries.value.revision,
		});
		const undoMs=performance.now()-undoStarted;
		assert.equal(undone.isError,false);
		assert.deepEqual(await readFile(fixture.original),original);
		const redone=await tool(client,'redo_document',{
			session_id:afterQueries.value.session_id,base_revision:undone.value.revision,
		});
		assert.equal(redone.isError,false);
		assert.deepEqual(await readFile(fixture.original),original);

		const saveStarted=performance.now();
		const saved=await tool(client,'save_document',{
			session_id:afterQueries.value.session_id,base_revision:redone.value.revision,
		});
		const saveMs=performance.now()-saveStarted;
		assert.equal(saved.isError,false);
		assert.notEqual(sha256(await readFile(fixture.original)),sha256(original));
		assert.equal((await tool(client,'get_document')).value.revision,redone.value.revision);

		const oldSession=await fetch(owner.ready.endpoint,{
			method:'POST',headers:{Authorization:`Bearer ${owner.ready.token}`,'Content-Type':'application/json'},
			body:JSON.stringify({method:'get_document',args:{},session_id:'closed-session-id'}),
		});
		assert.equal(oldSession.status,409);
		assert.equal((await oldSession.json()).error.code,'SESSION_MISMATCH');
		const unauthorized=await fetch(owner.ready.endpoint,{
			method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},
			body:JSON.stringify({method:'get_document',args:{},session_id:owner.ready.session_id}),
		});
		assert.equal(unauthorized.status,401);
		assert.equal(owner.stdout(),'');
		await new Promise(resolve=>setTimeout(resolve,20));
		for (const line of raw().trim().split(/\r?\n/).filter(Boolean)) {
			const parsed=JSON.parse(line);
			assert.equal(parsed.jsonrpc,'2.0');
		}
		t.diagnostic(`NE-8 MCP latency ms: open=${owner.ready.startup_ms.toFixed(1)} apply=${applyMs.toFixed(1)} image=${imageMs.toFixed(1)} undo=${undoMs.toFixed(1)} save=${saveMs.toFixed(1)}`);
	});
});

test('closed document is unavailable and never falls back to another file with equal ids',{timeout:600000},async()=>{
	await withTemp(async dir=>{
		const fixtureA=await makeEngineFixture(join(dir,'A'));
		const fixtureB=await makeEngineFixture(join(dir,'B'));
		const dataA=join(dir,'private-A');
		const dataB=join(dir,'private-B');
		const ownerA=await startOwner({original:fixtureA.original,dataDir:dataA,argv:fixtureA.argv});
		const ownerB=await startOwner({original:fixtureB.original,dataDir:dataB,argv:fixtureB.argv});
		let a;
		let b;
		try {
			a=await connectMcp(fixtureA.original,dataA);
			b=await connectMcp(fixtureB.original,dataB);
			const infoA=(await tool(a.client,'get_document')).value;
			const infoB=(await tool(b.client,'get_document')).value;
			assert.notEqual(infoA.session_id,infoB.session_id);
			const beforeB=(await tool(b.client,'get_nodes',{paths:[fixtureB.ids.text]})).value.nodes[0].node.content;
			await stopOwner(ownerA);
			const unavailable=await tool(a.client,'get_nodes',{paths:[fixtureA.ids.text]});
			assert.equal(unavailable.isError,true);
			assert.equal(unavailable.value.code,'SESSION_UNAVAILABLE');
			assert.equal((await tool(b.client,'get_nodes',{paths:[fixtureB.ids.text]})).value.nodes[0].node.content,beforeB);
		} finally {
			await a?.client.close().catch(()=>undefined);
			await b?.client.close().catch(()=>undefined);
			await stopOwner(ownerA).catch(()=>undefined);
			await stopOwner(ownerB).catch(()=>undefined);
		}
	});
});


function delay(ms) {
	return new Promise(resolve=>setTimeout(resolve,ms));
}

async function waitFor(predicate,timeout=2000) {
	const deadline=Date.now()+timeout;
	while (Date.now()<deadline) {
		if (predicate()) return;
		await delay(10);
	}
	throw Error('Condition timed out');
}

async function withLocalServer(dir,overrides,fn) {
	const original=join(dir,`transport-${randomUUID()}.pen`);
	await writeFile(original,'{}',{flag:'wx'});
	const canonical=await realpath(original);
	const info={
		session_id:randomUUID(),original_path:canonical,revision:0,checkpoint_id:'a'.repeat(64),
		dirty:false,phase:'ready',status_seq:0,rendered_revision:0,
	};
	let infoCalls=0;
	const document={
		info:()=>{
			infoCalls+=1;
			return {...info};
		},
		withEngine:overrides.withEngine??(async(_revision,callback)=>callback({
			exec:async()=>({value:{variables:{}},warnings:[]}),schema:async()=>'',
		})),
		readModel:overrides.readModel??(async()=>({roots:[],rows:[],variables:{}})),
		applyChanges:async()=>({revision:0,checkpoint_id:info.checkpoint_id,created:[],warnings:[]}),
		undo:async()=>({revision:1,checkpoint_id:info.checkpoint_id}),
		redo:async()=>({revision:1,checkpoint_id:info.checkpoint_id}),
		saveOriginal:async()=>({saved:false,checkpoint_id:info.checkpoint_id}),
		saveRecoveryCopy:async()=>({path:join(dir,'copy.pen'),checkpoint_id:info.checkpoint_id}),
	};
	const renderer={
		status:()=>({frame_ids:['frame-a','frame-b'],rendered_revision:0}),
		refresh:overrides.refresh??(async()=>({rendered_revision:0})),
		projection:overrides.projection??(({frame_id:frameId,cursor})=>({
			frame_id:frameId,revision:0,nodes:[],cursor:cursor??0,next_cursor:null,
		})),
		frameList:overrides.frameList??(({frame_id:frameId,cursor})=>({
			frame_id:frameId,revision:0,cursor:cursor??0,next_cursor:null,
			nodes:[{id:'frame-a',x:0,y:0,w:10,h:10,key:'k',fill:true,image:null}],
		})),
		frameImage:async()=>{ throw Error('not used'); },
	};
	const dataDir=overrides.dataDir??join(dir,`private-${randomUUID()}`);
	const server=await startServer({
		document,renderer,registry:{data_dir:dataDir,launch_id:overrides.launch_id},ui:overrides.ui??null,aclVerifier:overrides.aclVerifier,
	});
	try {
		return await fn({server,document,renderer,dataDir,original,info,infoCalls:()=>infoCalls});
	} finally {
		await server.close();
	}
}

function endpointParts(endpoint) {
	const url=new URL(endpoint);
	return {host:`127.0.0.1:${url.port}`,port:Number(url.port)};
}

async function rawExchange(endpoint,text,{timeout=3000}={}) {
	const {port}=endpointParts(endpoint);
	const socket=connectSocket({host:'127.0.0.1',port});
	let response='';
	socket.setEncoding('utf8');
	socket.on('data',chunk=>{ response+=chunk; });
	await once(socket,'connect');
	socket.write(text);
	let timer;
	try {
		await Promise.race([
			once(socket,'close'),
			new Promise((_,reject)=>{ timer=setTimeout(()=>reject(Error('Raw request timed out')),timeout); }),
		]);
		return response;
	} finally {
		clearTimeout(timer);
		socket.destroy();
	}
}

function parsedRaw(response) {
	const [head,body='']=response.split('\r\n\r\n');
	return {
		status:Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1]),
		headers:head.toLowerCase(),
		body:body?JSON.parse(body):null,
	};
}

async function runCommand(command,args) {
	const child=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
	let stderr='';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data',chunk=>{ stderr+=chunk; });
	const [code]=await once(child,'close');
	if (code!==0) throw Error(`${command} failed: ${stderr}`);
}

async function powershellJson(script,args=[]) {
	const child=spawn('powershell.exe',[
		'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script,...args,
	],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data',chunk=>{ stdout+=chunk; });
	child.stderr.on('data',chunk=>{ stderr+=chunk; });
	const [code]=await once(child,'close');
	if (code!==0) throw Error(`PowerShell failed: ${stderr}`);
	return JSON.parse(stdout);
}

test('HTTP rejects untrusted Host and every Origin before auth without CORS',{timeout:30000},async()=>withTemp(async dir=>{
	await withLocalServer(dir,{},async({server,info,infoCalls})=>{
		const initialInfoCalls=infoCalls();
		const {host}=endpointParts(server.endpoint);
		const body=JSON.stringify({method:'get_document',args:{},session_id:info.session_id});
		const requests=[
			`POST / HTTP/1.1\r\nHost: attacker.test\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
			`POST / HTTP/1.1\r\nHost: attacker.test\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
			`POST / HTTP/1.1\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
			`POST / HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
		];
		for (const [index,request] of requests.entries()) {
			const response=parsedRaw(await rawExchange(server.endpoint,request));
			assert.equal(response.status,403,`Host request ${index}`);
			assert.equal(response.body.error.code,'HOST_FORBIDDEN');
			assert.equal(response.headers.includes('access-control-'),false);
		}
		for (const authorization of ['',`Authorization: Bearer ${server.token}\r\n`]) {
			const response=parsedRaw(await rawExchange(server.endpoint,
				`POST / HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://attacker.test\r\n${authorization}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
			assert.equal(response.status,403);
			assert.equal(response.body.error.code,'ORIGIN_FORBIDDEN');
			assert.equal(response.headers.includes('access-control-'),false);
		}
		const options=parsedRaw(await rawExchange(server.endpoint,
			`OPTIONS / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${server.token}\r\nConnection: close\r\n\r\n`));
		assert.equal(options.status,405);
		assert.equal(options.headers.includes('access-control-'),false);
		assert.equal(infoCalls(),initialInfoCalls);
	});
}));

test('Windows session registry rebuild removes an explicit Everyone ACE',{timeout:30000},async()=>withTemp(async dir=>{
	if (process.platform!=='win32') return;
	const dataDir=join(dir,'private-with-extra-ace');
	const sessions=join(dataDir,'sessions');
	await mkdir(sessions,{recursive:true});
	await runCommand('icacls.exe',[sessions,'/grant','*S-1-1-0:(R)']);
	await withLocalServer(dir,{dataDir},async()=>{
		const acl=await powershellJson([
			'& { param([string]$Path)',
			'$acl=Get-Acl -LiteralPath $Path;',
			'$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
			'$rules=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });',
			'[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; user=$sid; rules=$rules } | ConvertTo-Json -Compress }',
		].join(' '),[join(dataDir,'sessions')]);
		assert.equal(acl.protected,true);
		assert.ok(acl.rules.length>=1);
		assert.ok(acl.rules.every(sid=>sid===acl.user||sid==='S-1-5-18'));
	});
}));

test('registry ACL verification failure is fail-closed before writing a session record',{timeout:30000},async()=>withTemp(async dir=>{
	if (process.platform!=='win32') return;
	const dataDir=join(dir,'private-acl-failure');
	const realSpawn=childProcess.spawn;
	childProcess.spawn=(command,args,options)=>/powershell\.exe$/i.test(command)
		?realSpawn(process.execPath,['--eval','process.exit(7)'],options)
		:realSpawn(command,args,options);
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			withLocalServer(dir,{dataDir},async()=>{}),
			error=>error.code==='REGISTRY_ACL_FAILED',
		);
	} finally {
		childProcess.spawn=realSpawn;
		syncBuiltinESMExports();
	}
	assert.deepEqual(await readdir(join(dataDir,'sessions')),[]);
}));

test('slow incomplete headers are disconnected by the server header deadline',{timeout:20000},async()=>withTemp(async dir=>{
	await withLocalServer(dir,{},async({server})=>{
		const {host,port}=endpointParts(server.endpoint);
		const socket=connectSocket({host:'127.0.0.1',port});
		await once(socket,'connect');
		socket.write(`POST / HTTP/1.1\r\nHost: ${host}\r\nX-Slow: `);
		const started=performance.now();
		const ticker=setInterval(()=>{ if (!socket.destroyed) socket.write('x'); },250);
		let timer;
		try {
			await Promise.race([
				once(socket,'close'),
				new Promise((_,reject)=>{ timer=setTimeout(()=>reject(Error('Slow headers were not disconnected')),12000); }),
			]);
			assert.ok(performance.now()-started<12000);
		} finally {
			clearInterval(ticker);
			clearTimeout(timer);
			socket.destroy();
		}
	});
}));

test('server caps concurrent sockets and close terminates active and idle connections',{timeout:30000},async()=>withTemp(async dir=>{
	await withLocalServer(dir,{},async({server,info})=>{
		const {host,port}=endpointParts(server.endpoint);
		const sockets=[];
		try {
			for (let index=0;index<32;index+=1) {
				const socket=connectSocket({host:'127.0.0.1',port});
				sockets.push(socket);
				await once(socket,'connect');
			}
			const overflow=connectSocket({host:'127.0.0.1',port});
			sockets.push(overflow);
			await once(overflow,'connect');
			let closed=false;
			overflow.once('close',()=>{ closed=true; });
			await waitFor(()=>closed,1500);
			for (const socket of sockets.slice(1,31)) socket.destroy();
			const active=sockets[0];
			const idle=sockets[31];
			active.write(`POST / HTTP/1.1\r\nHost: ${host}\r\n`);
			const body=JSON.stringify({method:'get_document',args:{},session_id:info.session_id});
			idle.write(`POST / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
			await once(idle,'data');
			const started=performance.now();
			await server.close();
			assert.ok(performance.now()-started<1500);
			await delay(50);
			const owned=process._getActiveHandles().filter(handle=>
				handle?.constructor?.name==='Socket'&&(handle.remotePort===port||handle.localPort===port));
			assert.equal(owned.length,0);
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});
}));

test('closing SessionClient aborts an in-flight response promptly',{timeout:30000},async()=>withTemp(async dir=>{
	let release;
	const blocked=new Promise(resolve=>{ release=resolve; });
	await withLocalServer(dir,{withEngine:async()=>blocked},async({server,original,dataDir})=>{
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		const pending=client.call('get_nodes',{paths:['node']});
		await delay(30);
		const started=performance.now();
		await client.close();
		await assert.rejects(pending,error=>error.code==='CLIENT_CLOSED'||error.code==='SESSION_UNAVAILABLE');
		assert.ok(performance.now()-started<500);
		release([]);
		await server.close();
	});
}));

test('server close drains an active handler and rejects a new request on its existing socket',{timeout:30000},async()=>withTemp(async dir=>{
	let entered;
	let release;
	const started=new Promise(resolve=>{ entered=resolve; });
	const blocked=new Promise(resolve=>{ release=resolve; });
	await withLocalServer(dir,{withEngine:async()=>{ entered(); return blocked; }},async({server,info})=>{
		const {host,port}=endpointParts(server.endpoint);
		const socket=connectSocket({host:'127.0.0.1',port});
		let response='';
		socket.setEncoding('utf8');
		socket.on('data',chunk=>{ response+=chunk; });
		await once(socket,'connect');
		const first=JSON.stringify({method:'get_nodes',args:{paths:['node']},session_id:info.session_id});
		const second=JSON.stringify({method:'get_document',args:{},session_id:info.session_id});
		const headers=body=>`POST / HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
		socket.write(headers(first));
		await started;
		const closing=server.close();
		socket.write(headers(second));
		await delay(20);
		release([]);
		const result=await closing;
		assert.deepEqual(result,{drained:true,aborted:0});
		// What the server wrote reaches the client before its socket closes, not necessarily before close() settles.
		if (socket.readyState!=='closed') await once(socket,'close');
		assert.match(response,/SERVER_CLOSING/);
		socket.destroy();
	});
}));

test('server close reports and aborts a handler that exceeds the drain deadline',{timeout:25000},async()=>withTemp(async dir=>{
	let entered;
	const started=new Promise(resolve=>{ entered=resolve; });
	await withLocalServer(dir,{withEngine:async()=>{ entered(); return new Promise(()=>{}); }},async({server,original,dataDir})=>{
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		const pending=client.call('get_nodes',{paths:['node']});
		const rejected=assert.rejects(pending,error=>error.code==='SESSION_UNAVAILABLE');
		await started;
		const closeStarted=performance.now();
		const result=await server.close();
		const closeMs=performance.now()-closeStarted;
		assert.deepEqual(result,{drained:false,aborted:1});
		assert.ok(closeMs>=14000&&closeMs<18000,`close_ms=${closeMs}`);
		await rejected;
		await client.close();
	});
}));

test('simultaneous polls keep request and frame values local across refresh awaits',{timeout:30000},async()=>withTemp(async dir=>{
	const releases=[];
	await withLocalServer(dir,{
		refresh:()=>new Promise(resolve=>{ releases.push(resolve); }),
		projection:({frame_id:frameId,cursor})=>({frame_id:frameId,revision:0,nodes:[],cursor:cursor??0,next_cursor:null}),
	},async({original,dataDir,info})=>{
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		try {
			await client.call('attach_view',{
				request_id:'attach',view_id:'view',view_generation:1,scene_revision:0,frame_id:'frame-a',
			});
			const first=client.call('poll_view',{
				request_id:'first',view_id:'view',view_generation:1,frame_id:'frame-a',cursor:null,
			});
			await waitFor(()=>releases.length===1);
			const second=client.call('poll_view',{
				request_id:'second',view_id:'view',view_generation:1,frame_id:'frame-b',cursor:null,
			});
			await waitFor(()=>releases.length===2);
			releases[1]();
			const secondPage=await second;
			releases[0]();
			const firstPage=await first;
			assert.equal(firstPage.request_id,'first');
			assert.equal(firstPage.page.frame_id,'frame-a');
			assert.equal(secondPage.request_id,'second');
			assert.equal(secondPage.page.frame_id,'frame-b');
			assert.equal(info.revision,0);
		} finally {
			await client.close();
		}
	});
}));

test('view registry rejects a seventeenth live view',{timeout:30000},async()=>withTemp(async dir=>{
	await withLocalServer(dir,{},async({original,dataDir})=>{
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		try {
			for (let index=0;index<16;index+=1) {
				await client.call('attach_view',{
					request_id:`attach-${index}`,view_id:`view-${index}`,view_generation:1,
					scene_revision:0,frame_id:'frame-a',
				});
			}
			await assert.rejects(client.call('attach_view',{
				request_id:'overflow',view_id:'overflow',view_generation:1,scene_revision:0,frame_id:'frame-a',
			}),error=>error.code==='LIMIT_EXCEEDED');
		} finally {
			await client.close();
		}
	});
}));

test('list_frames and poll_view carry the panel focus; the record carries only a well-formed launch_id',{timeout:30000},async()=>withTemp(async dir=>{
	const launchId='0123456789abcdef0123456789abcdef';
	const ui={focus:()=>({frame_id:'frame-b',selected_node:'frame-b/child'})};
	await withLocalServer(dir,{ui,launch_id:launchId},async({server,original,dataDir})=>{
		const records=await readdir(join(dataDir,'sessions'));
		assert.equal(records.length,1);
		const record=JSON.parse(await readFile(join(dataDir,'sessions',records[0]),'utf8'));
		assert.equal(record.launch_id,launchId);
		assert.equal(record.endpoint,server.endpoint);
		const client=await SessionClient.connect({original_path:original,data_dir:dataDir});
		try {
			const tag={view_id:'view',view_generation:1};
			const attached=await client.call('attach_view',{request_id:'a',...tag,scene_revision:0,frame_id:'frame-a'});
			assert.deepEqual(attached.focus,{frame_id:'frame-b',selected_node:'frame-b/child'});
			const listed=await client.call('list_frames',{request_id:'l',...tag,cursor:null});
			assert.equal(listed.request_id,'l');
			assert.equal(listed.view_generation,1);
			assert.equal(listed.page.frame_id,'frame-a');
			assert.equal(listed.page.nodes[0].id,'frame-a');
			assert.deepEqual(listed.focus,{frame_id:'frame-b',selected_node:'frame-b/child'});
			const polled=await client.call('poll_view',{request_id:'p',...tag,frame_id:'frame-b',cursor:null});
			assert.deepEqual(polled.focus,listed.focus);
			await assert.rejects(
				client.call('list_frames',{request_id:'old',view_id:'view',view_generation:0,cursor:null}),
				error=>error.code==='VIEW_STALE',
			);
		} finally {
			await client.close();
		}
	});
	await withLocalServer(dir,{launch_id:'not-a-nonce'},async({dataDir})=>{
		const [name]=await readdir(join(dataDir,'sessions'));
		assert.equal('launch_id' in JSON.parse(await readFile(join(dataDir,'sessions',name),'utf8')),false);
	});
}));


test('owner close drains a real undo and preserves its acknowledged revision',{timeout:600000},async t=>{
	await withMcpDocument(async({client,fixture,owner})=>{
		const initial=(await tool(client,'get_document')).value;
		const changed=await tool(client,'apply_changes',{
			session_id:initial.session_id,base_revision:initial.revision,
			operations:[{op:'update',path:fixture.text,props:{content:'Drain before close'}}],
		});
		assert.equal(changed.isError,false);
		const undoPromise=tool(client,'undo_document',{
			session_id:initial.session_id,base_revision:changed.value.revision,
		});
		await delay(100);
		const started=performance.now();
		const stopping=stopOwner(owner);
		const undone=await undoPromise;
		await stopping;
		const closeMs=performance.now()-started;
		assert.equal(undone.isError,false);
		assert.equal(undone.value.revision,changed.value.revision+1);
		t.diagnostic(`NE-8 close drained real undo in ${closeMs.toFixed(1)}ms`);
	});
});


test('registry ACL verifier requires both owner and SYSTEM SIDs',{timeout:30000},async()=>withTemp(async dir=>{
	if (process.platform!=='win32') return;
	async function actualAcl(path) {
		const acl=await powershellJson([
			'& { param([string]$Path)',
			'$acl=Get-Acl -LiteralPath $Path;',
			'$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
			'$rules=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });',
			'[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; user=$sid; rules=$rules } | ConvertTo-Json -Compress }',
		].join(' '),[path]);
		return {protected:acl.protected,sids:acl.rules,user:acl.user};
	}
	for (const missing of ['owner','system']) {
		await assert.rejects(
			withLocalServer(dir,{aclVerifier:async path=>{
				const acl=await actualAcl(path);
				return {
					protected:acl.protected,
					sids:acl.sids.filter(sid=>sid!==(missing==='owner'?acl.user:'S-1-5-18')),
				};
			}},async()=>{}),
			error=>error.code==='REGISTRY_ACL_FAILED',
			`missing ${missing}`,
		);
	}
	await withLocalServer(dir,{aclVerifier:async path=>{
		const acl=await actualAcl(path);
		return {protected:acl.protected,sids:acl.sids};
	}},async()=>{});
}));
