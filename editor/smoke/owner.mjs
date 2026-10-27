// Smoke harness for the packaged editor: runtime/editor.mjs started the way Tern starts it (`tern.process.run`: no
// terminal, stdin closed at once, both outputs piped, no window), with a document in a folder whose name has a space, an
// ampersand, a quote and an accent. It follows one document through open, edit, undo, Save, a clean close, a close with
// unsaved changes and its recovery, and checks that every close leaves no process, lock, record or working copy.
// Run: TERN_PENCIL_CLI=<pen cli index.mjs> node editor/smoke/owner.mjs [--keep]
// Needs runtime/ built (npm run build). It never touches Tern, its config or the user's data. The JSON report is printed
// and kept in editor/.build/smoke-<id>/report.json (with --keep or on failure); exit code 1 when a step fails.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionClient} from '../src/client.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const EDITOR=join(ROOT,'runtime','editor.mjs');
const MENTIONS='Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:NEEDLE) } | ForEach-Object { $_.ProcessId }';
const steps=[];
let failed=false;

function capture(command,args,options={}) {
	const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
	let stdout='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	return new Promise((resolve,reject)=>{
		child.once('error',reject);
		child.once('close',code=>resolve({code,stdout}));
	});
}

async function until(label,probe,timeoutMs) {
	const deadline=Date.now()+timeoutMs;
	let last;
	for (;;) {
		try {
			const value=await probe();
			if (value) return value;
		} catch (error) {
			last=error;
		}
		if (Date.now()>deadline) throw new Error(`${label} not reached in ${timeoutMs} ms${last?`: ${last.message}`:''}`);
		await new Promise(resolve=>setTimeout(resolve,300));
	}
}

async function step(name,fn) {
	const started=performance.now();
	try {
		const detail=await fn();
		steps.push({name,ok:true,ms:Math.round(performance.now()-started),detail});
	} catch (error) {
		steps.push({name,ok:false,ms:Math.round(performance.now()-started),error:String(error?.message??error)});
		failed=true;
	}
}

async function processesMentioning(needle) {
	const {stdout}=await capture('powershell.exe',['-NoProfile','-NonInteractive','-Command',MENTIONS],{env:{...process.env,NEEDLE:needle}});
	return stdout.split(/\s+/).filter(Boolean);
}


async function main() {
	const cli=process.env.TERN_PENCIL_CLI;
	if (!cli||/\.cmd$/i.test(cli)) throw new Error('Set TERN_PENCIL_CLI to the Pen CLI index.mjs');
	const id=randomUUID().slice(0,8);
	const root=join(ROOT,'editor','.build',`smoke-${id}`);
	const design=join(root,"A & B's ação");
	const dataDir=join(root,'private');
	const original=join(design,'design.pen');
	await mkdir(design,{recursive:true});
	await copyFile(join(ROOT,'tests','fixtures','sample.pen'),original);
	const originalBytes=await readFile(original);
	let launches=0;
	let owner;
	let client;
	const sessionOf=()=>SessionClient.connect({original_path:original,data_dir:dataDir});
	const nodeContent=async path=>(await client.call('get_nodes',{paths:[path]})).nodes[0].node.content;
	const change=async content=>{
		const document=await client.call('get_document',{});
		return client.call('apply_changes',{
			session_id:document.session_id,base_revision:document.revision,
			operations:[{op:'update',path:'t02',props:{content}}],
		});
	};

	// The plugin writes one manifest per launch, and the owner deletes it once read.
	async function open(shows='ready') {
		launches+=1;
		const manifest=join(root,`launch-${launches}.json`);
		await writeFile(manifest,JSON.stringify({original_path:original,argv:[process.execPath,cli],data_dir:dataDir,launch_id:randomUUID().replaceAll('-','')}));
		const child=spawn(process.execPath,[EDITOR,'--launch',manifest],{cwd:design,windowsHide:true,stdio:['ignore','pipe','pipe']});
		let output='';
		child.stdout.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
		child.stderr.setEncoding('utf8').on('data',chunk=>{ output+=chunk; });
		owner={child,output:()=>output,exited:new Promise(resolve=>child.once('close',code=>resolve(code)))};
		client=await until('session record',sessionOf,60000);
		await until(`document ${shows}`,async()=>{
			const document=await client.call('get_document',{});
			return (shows==='ready'?document.activity.state==='ready'&&document.activity.rendered_revision===document.revision:document.phase===shows)?document:null;
		},90000);
	}

	// What the window's Discard, Save and close and recovery all end with.
	async function closeEditor() {
		const reply=await client.call('close_editor',{});
		if (!reply.closing) throw new Error(JSON.stringify(reply));
		const code=await Promise.race([owner.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),30000))]);
		await client.close().catch(()=>undefined);
		client=undefined;
		if (code!==0) throw new Error(`the owner exited with ${code}: ${owner.output()}`);
		if (owner.output()!=='') throw new Error(`a clean close wrote output: ${owner.output()}`);
		await until('no process mentions the fixture',async()=>(await processesMentioning(`smoke-${id}`)).length===0,30000);
		await sessionOf().then(
			()=>{ throw new Error('a closed session must not answer'); },
			()=>undefined,
		);
		const left={
			lock_or_session:[...await readdir(join(dataDir,'sources')),...await readdir(join(dataDir,'sessions'))],
			working_copy:(await readdir(design)).filter(name=>name.includes('.tern-pencil-')),
		};
		if (left.lock_or_session.length>0||left.working_copy.length>0) throw new Error(`left behind: ${JSON.stringify(left)}`);
		return {left_behind:0};
	}

	let first;
	try {
		await step('the packaged owner starts with its stdin closed and keeps running',async()=>{
			await open();
			await new Promise(resolve=>setTimeout(resolve,1500));
			if (owner.child.exitCode!==null) throw new Error(`it exited with ${owner.child.exitCode}: ${owner.output()}`);
			return {pid:owner.child.pid};
		});
		await step('the session in the special-character directory has the fixture identity',async()=>{
			const document=await client.call('get_document',{});
			if (!document.original_path.endsWith('design.pen')||document.revision!==0||document.dirty) throw new Error(JSON.stringify(document));
			first={session_id:document.session_id};
			return {session_id:document.session_id};
		});
		await step('an agent change is a revision and an undo steps the history back',async()=>{
			const changed=await change('Agent wins');
			if (changed.revision!==1||await nodeContent('t02')!=='Agent wins') throw new Error(JSON.stringify(changed));
			const document=await client.call('get_document',{});
			const undone=await client.call('undo_document',{session_id:document.session_id,base_revision:document.revision});
			const content=await nodeContent('t02');
			if (content==='Agent wins') throw new Error('undo changed nothing');
			await change('MCP wins');
			return {revision_after_undo:undone.revision,content};
		});
		await step('Save publishes the confirmed state: the original bytes change and the document is clean',async()=>{
			const document=await client.call('get_document',{});
			await client.call('save_document',{session_id:document.session_id,base_revision:document.revision});
			const saved=await readFile(original);
			if (saved.equals(originalBytes)||!saved.includes('MCP wins')) throw new Error('the saved original lacks the value');
			const state=await client.call('get_document',{});
			if (state.dirty) throw new Error('still dirty after Save');
			return {bytes:saved.length};
		});
		await step('close_editor ends the owner and its engine and leaves no lock, record or working copy',closeEditor);
		await step('reopening shows the saved value and no recovery',async()=>{
			await open();
			const document=await client.call('get_document',{});
			if (document.dirty||document.phase!=='ready'||document.session_id===first.session_id) throw new Error(JSON.stringify(document));
			const content=await nodeContent('t02');
			if (content!=='MCP wins') throw new Error(JSON.stringify(content));
			return {content};
		});
		await step('closing with an unsaved change is just as clean, and keeps the original untouched',async()=>{
			await change('unsaved');
			const before=await readFile(original);
			const closed=await closeEditor();
			if (!(await readFile(original)).equals(before)) throw new Error('closing changed the original');
			return closed;
		});
		await step('a close that left unsaved changes reopens in recovery, and recovering brings them back',async()=>{
			await open('recovering');
			const document=await client.call('get_document',{});
			if (!document.recovery_choices.some(item=>item.choice==='recover')) throw new Error(JSON.stringify(document.recovery_choices));
			await client.call('resolve_recovery',{choice:'recover'});
			const state=await client.call('get_document',{});
			if (!state.dirty||state.phase!=='ready') throw new Error(JSON.stringify(state));
			const content=await nodeContent('t02');
			if (content!=='unsaved') throw new Error(JSON.stringify(content));
			return {content,dirty:state.dirty};
		});
		await step('Discard, then close_editor, leaves the file as saved and nothing to recover',async()=>{
			const document=await client.call('get_document',{});
			await client.call('discard_unsaved',{session_id:document.session_id,base_revision:document.revision});
			await closeEditor();
			await open();
			const state=await client.call('get_document',{});
			if (state.dirty||await nodeContent('t02')!=='MCP wins') throw new Error(JSON.stringify(state));
			return {content:'MCP wins'};
		});
		await step('the last close is clean again',closeEditor);
	} catch (error) {
		steps.push({name:'harness',ok:false,error:String(error?.message??error)});
		failed=true;
	} finally {
		await client?.close().catch(()=>undefined);
		owner?.child.kill();
		await owner?.exited;
		const leftover=(await processesMentioning(`smoke-${id}`)).length;
		if (leftover>0) {
			steps.push({name:'no process mentions the smoke directory at the end',ok:false,error:`${leftover} left`});
			failed=true;
		}
		const report=JSON.stringify({id,failed,steps},null,2);
		await mkdir(root,{recursive:true});
		await writeFile(join(root,'report.json'),report);
		console.log(report);
		const bad=steps.filter(step=>!step.ok).map(step=>step.name);
		console.log(failed?`owner smoke: FAILED (${bad.length} of ${steps.length} steps: ${bad.join('; ')})`:`owner smoke: OK (${steps.length} steps)`);
		if (!process.argv.includes('--keep')&&!failed) await rm(root,{recursive:true,force:true});
	}
}

await main();
process.exitCode=failed?1:0;
