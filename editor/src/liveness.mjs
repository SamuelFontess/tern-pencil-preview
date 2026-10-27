import {readFile,stat} from 'node:fs/promises';
import {connect} from 'node:net';
import {sessionRecordPath} from './protocol.mjs';

const MAX_RECORD_BYTES=64*1024;
const PROBE_TIMEOUT_MS=1000;

/**
 * Whether a process holds `pid`. A pid says nothing about who holds it: the OS hands a dead owner's pid to the next
 * program, so `active` only rules out `missing`.
 * @param {unknown} pid
 * @returns {'active'|'missing'|'unknown'}
 */
export function pidStatus(pid) {
	if (!Number.isInteger(pid)||pid<=0) return 'unknown';
	try {
		process.kill(pid,0);
		return 'active';
	} catch (error) {
		return error?.code==='ESRCH'?'missing':'unknown';
	}
}

/**
 * Whether nothing listens on a session's loopback endpoint. Only a refused connection says so: a connection that is
 * accepted, or that does not answer in time, is a live owner as far as this can tell. A listener whose backlog is full
 * is refused on Windows (not left to time out), so a busy owner could read as dead; it does not happen in practice: the
 * kernel completes the handshake of a connection the owner has not accepted yet, the backlog (511) holds a handful of
 * clients (the window, MCP), and the owner takes connections as soon as its event loop turns. Timeouts and every other
 * error count as alive.
 * @param {string} endpoint `http://127.0.0.1:<port>`
 * @returns {Promise<boolean>}
 */
export function endpointRefuses(endpoint) {
	let port;
	try {
		port=Number(new URL(endpoint).port);
	} catch {
		return Promise.resolve(false);
	}
	return new Promise(resolve=>{
		const socket=connect({host:'127.0.0.1',port});
		const done=refused=>{
			socket.destroy();
			resolve(refused);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS,()=>done(false));
		socket.once('connect',()=>done(false));
		socket.once('error',error=>done(error?.code==='ECONNREFUSED'));
	});
}

/** The endpoint session `sessionId` published for `originalPath`, if its record is still there. */
async function publishedEndpoint(dataDir,originalPath,sessionId) {
	try {
		const path=sessionRecordPath(dataDir,originalPath);
		if ((await stat(path)).size>MAX_RECORD_BYTES) return undefined;
		const record=JSON.parse(await readFile(path,'utf8'));
		return record?.session_id===sessionId&&typeof record.endpoint==='string'?record.endpoint:undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the owner a source lock names is still there. A pid that is gone is gone. A pid that is held may belong to
 * another program (Windows reuses pids within hours), so an owner that has published its session must also still
 * answer on the endpoint it published. An owner that has not published yet (its engine is starting) is judged by its
 * pid alone: shortcut: a crash in that window, followed by pid reuse, still reads as open, until the pid is free.
 * @param {{pid:unknown,session_id:string,original_path:string}} lock
 * @param {string} dataDir
 * @param {{probe?:(endpoint:string)=>Promise<boolean>}} [options] replaceable in tests
 * @returns {Promise<'active'|'missing'|'unknown'>}
 */
export async function lockOwnerStatus(lock,dataDir,{probe=endpointRefuses}={}) {
	const status=pidStatus(lock.pid);
	if (status==='missing') return status;
	const endpoint=await publishedEndpoint(dataDir,lock.original_path,lock.session_id);
	if (endpoint===undefined||!await probe(endpoint)) return status;
	// A closing owner takes its record down before its listener goes: a refusal only counts if the record it was read
	// from is still there, with the same endpoint. One that vanished meanwhile leaves the pid to decide.
	return await publishedEndpoint(dataDir,lock.original_path,lock.session_id)===endpoint?'missing':status;
}
