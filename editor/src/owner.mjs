import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {openDocument} from './document.mjs';
import {EditorError} from './errors.mjs';
import {PanelController} from './panel-model.mjs';
import {createRenderer} from './render.mjs';
import {startServer} from './server.mjs';
import {claimSource} from './source.mjs';
import {openStore} from './store.mjs';

const MAX_MANIFEST_BYTES=1024*1024;

/**
 * Read the private launch manifest: JSON data written by the plugin, never code. It carries no token. `launch_id` is
 * an optional random nonce (32 hex digits) the plugin uses to find this launch's discovery record.
 * @param {string} manifestPath
 * @returns {Promise<{original_path:string,argv:string[],data_dir:string,launch_id?:string}>}
 */
export async function readManifest(manifestPath) {
	let value;
	try {
		const bytes=await readFile(manifestPath);
		if (bytes.length>MAX_MANIFEST_BYTES) throw new Error('too large');
		value=JSON.parse(bytes.toString('utf8'));
	} catch {
		throw new EditorError('MANIFEST_INVALID','Launch manifest cannot be read as JSON');
	}
	const absolute=text=>typeof text==='string'&&text.length>0&&!text.includes('\0')&&isAbsolute(text);
	if (!value||typeof value!=='object'||Array.isArray(value)
		||!absolute(value.original_path)||!absolute(value.data_dir)
		||!Array.isArray(value.argv)||value.argv.length===0||value.argv.some(item=>typeof item!=='string')) {
		throw new EditorError('MANIFEST_INVALID','Launch manifest needs an absolute original_path and data_dir, and argv');
	}
	if (value.launch_id!==undefined&&!(typeof value.launch_id==='string'&&/^[0-9a-f]{32}$/.test(value.launch_id))) {
		throw new EditorError('MANIFEST_INVALID','Launch manifest launch_id must be 32 lowercase hex digits');
	}
	const manifest={original_path:value.original_path,argv:value.argv,data_dir:value.data_dir};
	if (value.launch_id!==undefined) manifest.launch_id=value.launch_id;
	return manifest;
}

/**
 * Open the document session and everything it owns. close() releases all of it, whatever failed.
 * @param {{original_path:string,argv:string[],data_dir:string,launch_id?:string}} options
 * @param {{entry:string,poll_ms?:number,on_close?:()=>void}} runtime `on_close`: the window asked the owner to end
 */
export async function openOwner({original_path:originalPath,argv,data_dir:dataDir,launch_id:launchId},{entry,poll_ms:pollMs,on_close:onClose}) {
	const sessionId=randomUUID();
	const claim={original_path:originalPath,data_dir:dataDir,session_id:sessionId};
	// A lock whose owner process is gone (crash, killed, reboot) is adopted: its unsaved edits come back as a recovery.
	const source=await claimSource(claim).catch(error=>{
		const lost=error?.code==='RECOVERY_REQUIRED'?error.details?.recovery?.session_id:undefined;
		if (typeof lost!=='string') throw error;
		return claimSource({...claim,adopt_orphan:lost});
	});
	let document;
	let renderer;
	let controller;
	let server;
	let mcp;
	let closing;
	function close() {
		closing??=(async()=>{
			let firstError;
			for (const step of [
				()=>controller?.close(),
				()=>server?.close(),
				()=>renderer?.close(),
				()=>document?document.close():source.release(),
			]) {
				try {
					await step();
				} catch (error) {
					firstError??=error;
				}
			}
			if (firstError) throw firstError;
		})();
		return closing;
	}
	try {
		const renderDir=join(dataDir,'renders',sessionId);
		await mkdir(renderDir,{recursive:true,mode:0o700});
		const documentKey=createHash('sha256').update(source.original_path).digest('hex');
		const store=await openStore({dir:join(dataDir,'history',documentKey),max_steps:50,max_bytes:200*1024*1024});
		document=await openDocument({source,store,cli_argv:argv,recovery:'prompt'});
		renderer=createRenderer({document,dir:renderDir});
		controller=new PanelController({document,renderer,poll_ms:pollMs});
		mcp={command:'node',args:[join(dirname(entry),'mcp.mjs'),'--document',document.info().original_path,'--data-dir',dataDir]};
		server=await startServer({
			document,renderer,registry:{data_dir:dataDir,launch_id:launchId},mcp,onClose,
			ui:{
				selectNode:view=>controller.selectNode(view.path),
				focus:()=>({frame_id:controller.frameId,selected_node:controller.selectedPath}),
			},
		});
		controller.useBoard(server.board);
		await controller.start();
		// The first render runs behind the panel; its failure is reported through renderer.status().
		void renderer.refresh(document.info().revision).catch(()=>undefined);
	} catch (error) {
		await close().catch(()=>undefined);
		throw error;
	}
	return {controller,document,close,mcp,window:server.window};
}
