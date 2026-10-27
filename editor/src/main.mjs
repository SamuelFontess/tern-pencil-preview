import {mkdir,rm,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isEntry} from './entry.mjs';
import {EditorError} from './errors.mjs';
import {watchOrphan} from './orphan.mjs';

const USAGE='Usage: editor.mjs --launch <manifest.json>';
/**
 * How long an owner lives without a window asking for anything. A plugin reload or a window that waits for another one's
 * lease takes seconds, a Tern that is closed and opened again under a minute, so this is longer than all of them; a
 * document with unsaved changes loses nothing by it (its history is the recovery, offered when it is next opened), and
 * opening the file again within it reconnects to this owner. The price is a file kept locked this long after Tern closed.
 */
export const ORPHAN_MS=120000;
const ORPHAN_CHECK_MS=5000;

/**
 * @param {string[]} argv process.argv
 * @returns {{mode:'owner',manifest:string}}
 */
export function parseArguments(argv) {
	const [mode,manifest,...extra]=argv.slice(2);
	if (mode!=='--launch'||extra.length>0||typeof manifest!=='string'||manifest.length===0) throw new EditorError('USAGE',USAGE);
	return {mode:'owner',manifest};
}

function fail(error) {
	const code=typeof error?.code==='string'?error.code:'EDITOR_FAILED';
	return {code,message:error instanceof EditorError?error.message:'Editor failed'};
}

/**
 * The window learns why an owner stopped before it published its session from this file in the data folder: the
 * manifest's name with `.failed` for `.json`, so the sweep of stale launch files clears it too. The process's exit
 * status alone says nothing. Best effort; the code only, the window words it.
 */
async function recordFailure(manifest,{data_dir:dataDir,launch_id:launchId},error) {
	if (launchId===undefined) return;
	try {
		await mkdir(dataDir,{recursive:true,mode:0o700});
		await writeFile(join(dataDir,basename(manifest).replace(/\.json$/,'.failed')),JSON.stringify({code:fail(error).code}),{mode:0o600});
	} catch {
		// The exit status is all the window gets then.
	}
}

/**
 * Open the session owner for a launch manifest: document, renderer, local server. The distributed bundle exports this so
 * its engine, Save and transport can be exercised without Tern.
 * @param {string} manifest path of the private launch manifest; it holds the document path, so it is deleted as soon as
 * it has been read (the owner is its only consumer)
 * @param {{entry?:string,poll_ms?:number,on_close?:()=>void}} [options] `on_close`: what the window's `close_editor` asks for
 */
export async function startOwner(manifest,{entry=fileURLToPath(import.meta.url),poll_ms,on_close}={}) {
	const {openOwner,readManifest}=await import('./owner.mjs');
	const path=resolve(manifest);
	const options=await readManifest(path);
	await rm(path,{force:true}).catch(()=>undefined);
	try {
		return await openOwner(options,{entry,poll_ms,on_close});
	} catch (error) {
		await recordFailure(path,options,error);
		throw error;
	}
}

let stdioGuarded=false;
/**
 * Tern reads the owner's output only while a window runs it. Once that window is gone (Tern quit, a plugin reload that
 * dropped the callback) a write to stdout or stderr fails with EPIPE, and unhandled that kills the owner on its way to
 * close: the working copy, lock and session record stay behind. Nothing the owner prints matters that much.
 */
function ignoreBrokenStdio() {
	if (stdioGuarded) return;
	stdioGuarded=true;
	for (const stream of [process.stdout,process.stderr]) stream.on('error',()=>undefined);
}

/**
 * Run the session owner. Tern starts it with `tern.process.run`: no terminal, stdin closed at once, and nobody to hang up
 * on it, so it ends only three ways, each followed by the same close (engine, lock, working copy, record): a signal, the
 * window's `close_editor`, or no window asking for `orphan_ms`. The path is armed before startup, which may take as long
 * as the engine timeout: a signal then waits for the owner to exist and closes it.
 * @param {string} manifest
 * @param {string} entry
 * @param {{events?:NodeJS.Process,exit?:(code:number)=>void,orphan_ms?:number,check_ms?:number}} [runtime] replaceable in tests
 */
export async function ownerMode(manifest,entry,{events=process,exit=code=>process.exit(code),orphan_ms=ORPHAN_MS,check_ms=ORPHAN_CHECK_MS}={}) {
	ignoreBrokenStdio();
	const stop=new AbortController();
	// `on`, not `once`: a repeated signal during startup or close must not fall back to Node's default and kill the process.
	for (const signal of ['SIGINT','SIGTERM','SIGHUP']) events.on(signal,()=>stop.abort());
	const owner=await startOwner(manifest,{entry,on_close:()=>stop.abort()});
	const unwatch=watchOrphan({
		idle_ms:owner.window.idle_ms,renew:owner.window.renew,limit_ms:orphan_ms,check_ms,
		on_expired:()=>{
			process.stderr.write(`Pencil editor ended: no window asked for it in ${Math.round(orphan_ms/1000)} s\n`);
			stop.abort();
		},
	});
	if (!stop.signal.aborted) await new Promise(done=>stop.signal.addEventListener('abort',done,{once:true}));
	unwatch();
	const closed=await owner.close().then(()=>0,()=>1);
	exit(closed);
}

async function main() {
	const entry=fileURLToPath(import.meta.url);
	let parsed;
	try {
		parsed=parseArguments(process.argv);
	} catch (error) {
		process.stdout.write(JSON.stringify({error:fail(error)}));
		process.exitCode=2;
		return;
	}
	try {
		await ownerMode(parsed.manifest,entry);
	} catch (error) {
		process.stderr.write(`Pencil editor failed to start: ${fail(error).code}\n`);
		process.exit(1);
	}
}

if (isEntry(import.meta.url)) await main();
