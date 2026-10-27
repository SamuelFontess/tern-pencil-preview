import {Agent,request as httpRequest} from 'node:http';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {EditorError} from './errors.mjs';
import {endpointRefuses,pidStatus} from './liveness.mjs';
import {MAX_REQUEST_BYTES,publicError,sessionRecordPath,validateCall} from './protocol.mjs';

const MAX_RECORD_BYTES=64*1024;
const MAX_RESPONSE_BYTES=64*1024*1024;

function clientError(code,message) {
	return new EditorError(code,message);
}

/** The record's owner is there: its pid is held and its endpoint takes connections (a held pid may be another program's). */
async function ownerActive(record) {
	return Number.isSafeInteger(record.pid)&&record.pid>0&&pidStatus(record.pid)!=='missing'&&!await endpointRefuses(record.endpoint);
}

function validEndpoint(value) {
	return typeof value==='string'&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)
		&&Number(new URL(value).port)>=1&&Number(new URL(value).port)<=65535;
}

async function readRecord(path,canonical) {
	try {
		const details=await lstat(path);
		if (details.isSymbolicLink()||!details.isFile()||details.size>MAX_RECORD_BYTES) throw clientError('SESSION_UNAVAILABLE','Session record is invalid');
		// On Windows, startServer writes a record only after protecting the parent ACL by SID.
		// The client consumes that exact owned record and never weakens or recreates its ACL.
		if (process.platform!=='win32'&&(details.mode&0o077)!==0) throw clientError('SESSION_UNAVAILABLE','Session record is not private');
		const record=JSON.parse(await readFile(path,'utf8'));
		if (!record||record.version!==1||record.original_path!==canonical
			||!validEndpoint(record.endpoint)||typeof record.token!=='string'||record.token.length<32
			||typeof record.session_id!=='string'||!await ownerActive(record)) {
			throw clientError('SESSION_UNAVAILABLE','Document session is unavailable');
		}
		return record;
	} catch (error) {
		if (error?.code==='SESSION_UNAVAILABLE') throw error;
		throw clientError('SESSION_UNAVAILABLE','Document session is unavailable');
	}
}

function transportError(error,closed) {
	if (closed||error?.code==='CLIENT_CLOSED') return clientError('CLIENT_CLOSED','Session client is closed');
	const value=publicError(error);
	if (value.code==='INTERNAL_ERROR') return clientError('SESSION_UNAVAILABLE','Document session is unavailable');
	return clientError(value.code,value.message);
}

function send(owner,record,body) {
	let request;
	let response;
	let settled=false;
	let resolveOperation;
	let rejectOperation;
	const operation=new Promise((resolve,reject)=>{
		resolveOperation=resolve;
		rejectOperation=reject;
	});
	function cleanup() {
		request?.setTimeout(0);
		owner.requests.delete(request);
		owner.pending.delete(operation);
	}
	function settle(error,value) {
		if (settled) return;
		settled=true;
		cleanup();
		if (error) rejectOperation(transportError(error,owner.closed));
		else resolveOperation(value);
	}
	const url=new URL(record.endpoint);
	request=httpRequest({
		hostname:'127.0.0.1',port:Number(url.port),path:'/',method:'POST',agent:owner.agent,
		headers:{
			Authorization:`Bearer ${record.token}`,
			'Content-Type':'application/json',
			'Content-Length':body.length,
		},
	},incoming=>{
		response=incoming;
		const chunks=[];
		let bytes=0;
		incoming.on('data',chunk=>{
			bytes+=chunk.length;
			if (bytes>MAX_RESPONSE_BYTES) {
				incoming.destroy(clientError('LIMIT_EXCEEDED','Response exceeds its limit'));
				return;
			}
			chunks.push(chunk);
		});
		incoming.once('aborted',()=>settle(clientError('SESSION_UNAVAILABLE','Session response was aborted')));
		incoming.once('error',error=>settle(error));
		incoming.once('close',()=>{
			if (!incoming.complete) settle(clientError('SESSION_UNAVAILABLE','Session response ended prematurely'));
		});
		incoming.once('end',()=>{
			let value;
			try {
				value=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
			} catch {
				settle(clientError('SESSION_UNAVAILABLE','Session returned an invalid response'));
				return;
			}
			if (incoming.statusCode!==200||value.error) {
				const error=value.error??{code:'SESSION_UNAVAILABLE',message:'Document session is unavailable'};
				settle(clientError(error.code,error.message));
				return;
			}
			settle(null,value.result);
		});
	});
	owner.requests.add(request);
	owner.pending.add(operation);
	request.setTimeout(120000,()=>request.destroy(clientError('SESSION_UNAVAILABLE','Document session did not respond')));
	request.once('error',error=>settle(error));
	request.end(body);
	return operation;
}

export class SessionClient {
	constructor(record) {
		this.record=Object.freeze({...record});
		this.closed=false;
		this.agent=new Agent({keepAlive:false,maxSockets:8});
		this.requests=new Set();
		this.pending=new Set();
		this.closePromise=null;
	}

	/** Discover only the private session record for the explicitly supplied canonical original. */
	static async connect({original_path:originalPath,data_dir:dataDir}) {
		if (typeof originalPath!=='string'||typeof dataDir!=='string') throw clientError('SESSION_UNAVAILABLE','Document session is unavailable');
		let canonical;
		try {
			canonical=await realpath(originalPath);
		} catch {
			throw clientError('SESSION_UNAVAILABLE','Document session is unavailable');
		}
		const record=await readRecord(sessionRecordPath(dataDir,canonical),canonical);
		return new SessionClient(record);
	}

	/** Call one method on the already-bound session without rediscovery or fallback. */
	async call(method,args={}) {
		if (this.closed) throw clientError('CLIENT_CLOSED','Session client is closed');
		validateCall(method,args);
		const body=Buffer.from(JSON.stringify({method,args,session_id:this.record.session_id}));
		if (body.length>MAX_REQUEST_BYTES) throw clientError('LIMIT_EXCEEDED','Request exceeds 1 MiB');
		return send(this,this.record,body);
	}

	/** Abort every owned HTTP operation and release this client's Agent. */
	close() {
		if (this.closePromise) return this.closePromise;
		this.closed=true;
		this.closePromise=(async()=>{
			const pending=[...this.pending];
			for (const request of this.requests) request.destroy(clientError('CLIENT_CLOSED','Session client is closed'));
			this.agent.destroy();
			await Promise.allSettled(pending);
		})();
		return this.closePromise;
	}
}
