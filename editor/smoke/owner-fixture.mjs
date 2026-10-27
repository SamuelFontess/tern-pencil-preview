import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {openDocument} from '../src/document.mjs';
import {createRenderer} from '../src/render.mjs';
import {startServer} from '../src/server.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';

function options(argv) {
	const parsed={};
	for (let index=2;index<argv.length;index+=2) {
		const key=argv[index];
		const value=argv[index+1];
		if (!key?.startsWith('--')||value===undefined) throw Error('Invalid owner arguments');
		parsed[key.slice(2)]=value;
	}
	if (!parsed.document||!parsed['data-dir']||!parsed['cli-argv']) throw Error('Missing owner arguments');
	const cliArgv=JSON.parse(parsed['cli-argv']);
	if (!Array.isArray(cliArgv)||cliArgv.length===0||cliArgv.some(value=>typeof value!=='string')) {
		throw Error('Invalid CLI argv');
	}
	return {original:parsed.document,dataDir:parsed['data-dir'],cliArgv};
}

async function main() {
	if (typeof process.send!=='function') throw Error('owner-fixture requires IPC');
	const started=performance.now();
	const {original,dataDir,cliArgv}=options(process.argv);
	const sessionId=randomUUID();
	const source=await claimSource({original_path:original,data_dir:dataDir,session_id:sessionId});
	let document;
	let renderer;
	let server;
	let closing;
	async function close() {
		if (closing) return closing;
		closing=(async()=>{
			let firstError;
			async function attempt(operation) {
				try {
					await operation();
				} catch (error) {
					firstError??=error;
				}
			}
			await attempt(()=>server?.close());
			await attempt(()=>renderer?.close());
			await attempt(()=>document?document.close():source.release());
			if (firstError) throw firstError;
		})();
		return closing;
	}
	try {
		const historyDir=join(dataDir,'history');
		const renderDir=join(dataDir,'renders',sessionId);
		await mkdir(renderDir,{recursive:true,mode:0o700});
		const store=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
		document=await openDocument({source,store,cli_argv:cliArgv,recovery:'prompt'});
		renderer=createRenderer({document,dir:renderDir});
		await renderer.refresh(document.info().revision);
		server=await startServer({document,renderer,registry:{data_dir:dataDir},ui:null});
		function shutdown() {
			void close().then(
				()=>process.exit(0),
				error=>{
					const message={type:'error',code:error?.code??'OWNER_CLOSE_FAILED',message:error?.message??'Owner close failed'};
					if (process.connected) process.send(message,()=>process.exit(1));
					else process.exit(1);
				},
			);
		}
		process.on('message',message=>{
			if (message?.type==='shutdown') shutdown();
			if (message?.type==='request_capture') {
				server.board.request().then(
					outcome=>process.send({type:'capture',outcome}),
					error=>process.send({type:'capture',error:{code:error?.code??'INTERNAL_ERROR'}}),
				);
			}
		});
		process.once('disconnect',shutdown);
		process.send({
			type:'ready',endpoint:server.endpoint,token:server.token,
			session_id:document.info().session_id,startup_ms:performance.now()-started,
		});
	} catch (error) {
		await close().catch(()=>undefined);
		throw error;
	}
}

main().catch(error=>{
	if (typeof process.send==='function') process.send({type:'error',code:error?.code??'OWNER_FAILED',message:error?.message??'Owner failed'});
	process.exitCode=1;
});
