import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {EditorError} from './errors.mjs';

const ANSI_PATTERN=/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DEFAULT_TIMEOUT_MS=120000;
const CLOSE_TIMEOUT_MS=2000;
const EXEC_KINDS=new Set(['mutate','read','measure']);

function stripAnsi(value) {
	return value.replace(ANSI_PATTERN,'');
}

function hasTerminalPrompt(value) {
	return /(?:^|\n)pen > $/.test(stripAnsi(value).replaceAll('\r',''));
}

function details(stdout,stderr) {
	return {stdout:stripAnsi(stdout),stderr:stripAnsi(stderr)};
}

function warningsFrom(stderr) {
	return stripAnsi(stderr)
		.split(/\r?\n/)
		.map(line=>line.trim())
		.filter(Boolean);
}

/**
 * The engine measures text with a stand-in font until the real one has loaded, and the loads start lazily at the
 * first measurement. Only a render waits for them, so a measuring body is preceded by a minimal export of one
 * top-level node: that render resolves every pending font, and the body then reads the settled layout.
 * @param {string} dir
 */
function fontBarrier(dir) {
	return `{const roots=Get((n,c)=>{if(c.depth===0){c.skipChildren();const b=c.bounds;`+
		`if(b.width>0&&b.height>0)return {id:n.id,scale:Math.min(1,8/Math.min(b.width,b.height))};}});`+
		`if(roots.length)Export([roots[0].id],'png',${JSON.stringify(dir)},{scale:roots[0].scale});}\n`;
}

/**
 * Decode one completed execute reply and require its current nonce.
 * @param {{stdout:string,stderr:string,nonce:string}} reply
 * @returns {{value:any,warnings:string[]}}
 */
export function decodeReply({stdout,stderr,nonce}) {
	const clean=stripAnsi(stdout).replaceAll('\r','');
	const markers=[];
	let malformedCurrent=false;
	for (const rawLine of clean.split('\n')) {
		const line=rawLine.trim();
		if (!line.startsWith('{')) continue;
		try {
			const value=JSON.parse(line);
			if (value&&typeof value==='object'&&typeof value.bridge==='string') {
				markers.push(value);
			}
		} catch {
			if (line.includes(`"bridge":"${nonce}"`)) malformedCurrent=true;
		}
	}
	if (malformedCurrent||markers.some(marker=>marker.bridge!==nonce)) {
		throw new EditorError('ENGINE_PROTOCOL','Ambiguous engine reply',details(stdout,stderr));
	}
	const marker=markers.find(value=>value.bridge===nonce);
	if (!marker) {
		const rejected=stderr.trim()||/\b(?:error|failed|rejected)\b/i.test(clean);
		throw new EditorError(
			rejected ? 'ENGINE_REJECTED' : 'ENGINE_PROTOCOL',
			rejected ? 'Engine rejected execute' : 'Engine reply has no current marker',
			details(stdout,stderr),
		);
	}
	return {value:marker.value,warnings:warningsFrom(stderr)};
}

function closedError() {
	return new EditorError('ENGINE_CLOSED','Engine is closed');
}

class Engine {
	#child;
	#timeoutMs;
	#stdoutDecoder=new StringDecoder('utf8');
	#stderrDecoder=new StringDecoder('utf8');
	#startup={stdout:'',stderr:''};
	#pending=null;
	#alive=true;
	#accepting=true;
	#active=false;
	#queued=0;
	#queue=Promise.resolve();
	#exitPromise;
	#resolveExit;
	#terminatePromise=null;
	#closePromise=null;
	#fontsStale=true;

	constructor(child,timeoutMs) {
		this.#child=child;
		this.#timeoutMs=timeoutMs;
		this.#exitPromise=new Promise(resolve=>{
			this.#resolveExit=resolve;
		});
		child.stdout.on('data',chunk=>this.#onStdout(this.#stdoutDecoder.write(chunk)));
		child.stderr.on('data',chunk=>this.#onStderr(this.#stderrDecoder.write(chunk)));
		child.once('error',error=>this.#onFailure(new EditorError('ENGINE_START','Engine process failed',{cause:error.message})));
		child.once('exit',(code,signal)=>this.#onExit(code,signal));
	}

	/** @returns {number|undefined} */
	get pid() {
		return this.#child.pid;
	}

	async ready() {
		if (hasTerminalPrompt(this.#startup.stdout)) return;
		await this.#waitForPrompt(null);
	}

	#onStdout(text) {
		if (this.#pending) {
			this.#pending.stdout+=text;
			if (hasTerminalPrompt(this.#pending.stdout)) this.#settlePending();
			return;
		}
		this.#startup.stdout+=text;
	}

	#onStderr(text) {
		if (this.#pending) {
			this.#pending.stderr+=text;
			return;
		}
		this.#startup.stderr+=text;
	}

	#onFailure(error) {
		this.#alive=false;
		this.#accepting=false;
		this.#rejectPending(error);
		this.#resolveExit();
	}

	#onExit(code,signal) {
		const stdoutTail=this.#stdoutDecoder.end();
		const stderrTail=this.#stderrDecoder.end();
		if (stdoutTail) this.#onStdout(stdoutTail);
		if (stderrTail) this.#onStderr(stderrTail);
		this.#alive=false;
		this.#accepting=false;
		this.#rejectPending(new EditorError('ENGINE_EOF','Engine exited before completing the reply',{
			code,
			signal,
			...details(this.#pending?.stdout??this.#startup.stdout,this.#pending?.stderr??this.#startup.stderr),
		}));
		this.#resolveExit();
	}

	#settlePending() {
		const pending=this.#pending;
		if (!pending) return;
		this.#pending=null;
		clearTimeout(pending.timer);
		pending.resolve({stdout:pending.stdout,stderr:pending.stderr});
	}

	#rejectPending(error) {
		const pending=this.#pending;
		if (!pending) return;
		this.#pending=null;
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	#waitForPrompt(line) {
		if (!this.#alive) return Promise.reject(closedError());
		if (this.#pending) {
			return Promise.reject(new EditorError('ENGINE_PROTOCOL','Engine already has a pending command'));
		}
		return new Promise((resolve,reject)=>{
			const pending={stdout:'',stderr:'',resolve,reject,timer:null};
			if (line===null) {
				pending.stdout=this.#startup.stdout;
				pending.stderr=this.#startup.stderr;
				this.#startup={stdout:'',stderr:''};
			}
			pending.timer=setTimeout(()=>{
				if (this.#pending!==pending) return;
				this.#pending=null;
				reject(new EditorError('ENGINE_TIMEOUT','Engine command timed out',details(pending.stdout,pending.stderr)));
				void this.#terminate();
			},this.#timeoutMs);
			this.#pending=pending;
			if (hasTerminalPrompt(pending.stdout)) {
				this.#settlePending();
				return;
			}
			if (line!==null) {
				this.#child.stdin.write(`${line}\n`,error=>{
					if (error&&this.#pending===pending) {
						this.#rejectPending(new EditorError('ENGINE_EOF','Could not write to engine',{cause:error.message}));
					}
				});
			}
		});
	}

	#enqueue(operation) {
		if (!this.#accepting) return Promise.reject(closedError());
		this.#queued+=1;
		const result=this.#queue.then(async()=>{
			this.#queued-=1;
			if (!this.#accepting) throw closedError();
			this.#active=true;
			try {
				return await operation();
			} finally {
				this.#active=false;
			}
		});
		this.#queue=result.catch(()=>{});
		return result;
	}

	#terminate() {
		if (this.#terminatePromise) return this.#terminatePromise;
		this.#accepting=false;
		this.#terminatePromise=(async()=>{
			if (!this.#alive) {
				await this.#exitPromise;
				return;
			}
			try {
				this.#child.kill();
			} catch {
				// The exit event remains authoritative when the process ended between checks.
			}
			let timer;
			await Promise.race([
				this.#exitPromise,
				new Promise(resolve=>{
					timer=setTimeout(resolve,CLOSE_TIMEOUT_MS);
				}),
			]);
			clearTimeout(timer);
			if (!this.#alive) return;
			try {
				this.#child.kill('SIGKILL');
			} catch {
				// Wait for the process event even if it exited just before the forced kill.
			}
			await this.#exitPromise;
		})();
		return this.#terminatePromise;
	}

	async #execute(body,kind) {
		const nonce=randomUUID();
		// The first read of a session and the first read after a possible edit wait for fonts; reads in between do not.
		if (kind==='mutate') this.#fontsStale=true;
		const barrier=kind==='measure'&&this.#fontsStale;
		let dir;
		if (barrier) {
			try {
				dir=await mkdtemp(join(tmpdir(),'pen-fonts-'));
			} catch (cause) {
				// Nothing reached the engine yet, so it stays usable; only this read has no settled bounds to offer.
				throw new EditorError('ENGINE_FONTS','Could not prepare the font wait',{cause:cause.message});
			}
		}
		try {
			const input=`const value = (() => {${barrier ? fontBarrier(dir) : ''}${body}\n})();`+
				`Print({bridge:${JSON.stringify(nonce)},value});`;
			const reply=await this.#waitForPrompt(`execute(${JSON.stringify({input})})`);
			const decoded=decodeReply({...reply,nonce});
			if (barrier) this.#fontsStale=false;
			return decoded;
		} catch (error) {
			await this.#terminate();
			throw error;
		} finally {
			// Best effort: the scratch directory is empty of anything the caller needs.
			if (dir) await rm(dir,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
		}
	}

	/**
	 * Run one body in the engine.
	 * `kind` says what the body may do to the document: `mutate` (default) may change it, including text, so the
	 * next measuring read waits for fonts again; `read` leaves it untouched; `measure` is a read of node bounds and
	 * only runs once every font the document needs has loaded, so no bound comes from a stand-in font.
	 * @param {string} body
	 * @param {{kind?:'mutate'|'read'|'measure'}} [options]
	 * @returns {Promise<{value:any,warnings:string[]}>}
	 */
	exec(body,{kind='mutate'}={}) {
		if (typeof body!=='string') {
			return Promise.reject(new EditorError('ENGINE_INPUT','Execute body must be a string'));
		}
		if (!EXEC_KINDS.has(kind)) {
			return Promise.reject(new EditorError('ENGINE_INPUT','Execute kind must be mutate, read or measure'));
		}
		return this.#enqueue(()=>this.#execute(body,kind));
	}

	async #command(line) {
		try {
			const reply=await this.#waitForPrompt(line);
			const clean=stripAnsi(reply.stdout);
			if (reply.stderr.trim()||/^\[ERROR\]/mi.test(clean)) {
				throw new EditorError('ENGINE_REJECTED','Engine rejected command',details(reply.stdout,reply.stderr));
			}
			return stripAnsi(reply.stdout).replace(/(?:^|\n)pen > $/,'').trim();
		} catch (error) {
			await this.#terminate();
			throw error;
		}
	}

	/** @returns {Promise<void>} */
	async save() {
		await this.#enqueue(()=>this.#command('save()'));
	}

	/** @returns {Promise<string>} */
	schema() {
		return this.#enqueue(()=>this.#command(`read_skill(${JSON.stringify({path:'pen-schema.md'})})`));
	}

	async #closeEngine() {
		const interrupted=this.#pending!==null||this.#active||this.#queued>0||this.#terminatePromise!==null;
		if (interrupted) {
			this.#rejectPending(closedError());
			await this.#terminate();
			await this.#queue;
			return;
		}
		if (!this.#alive) return;
		try {
			this.#child.stdin.write('exit()\n',()=>{});
		} catch {
			await this.#terminate();
			return;
		}
		let timer;
		await Promise.race([
			this.#exitPromise,
			new Promise(resolve=>{
				timer=setTimeout(resolve,CLOSE_TIMEOUT_MS);
			}),
		]);
		clearTimeout(timer);
		if (this.#alive) await this.#terminate();
	}

	/** @returns {Promise<void>} */
	close() {
		if (this.#closePromise) return this.#closePromise;
		this.#accepting=false;
		this.#closePromise=this.#closeEngine();
		return this.#closePromise;
	}
}

/**
 * Start one persistent Pen process bound to an explicit input/output pair.
 * @param {{argv:string[],input:string,output:string,timeout_ms?:number}} options
 * @returns {Promise<Engine>}
 */
export async function startEngine({argv,input,output,timeout_ms=DEFAULT_TIMEOUT_MS}) {
	if (!Array.isArray(argv)||argv.length===0||argv.some(value=>typeof value!=='string')) {
		throw new EditorError('ENGINE_INPUT','argv must be a nonempty string array');
	}
	if (typeof input!=='string'||typeof output!=='string') {
		throw new EditorError('ENGINE_INPUT','input and output must be strings');
	}
	const child=spawn(argv[0],[...argv.slice(1),'interactive','-i',input,'-o',output],{
		shell:false,
		stdio:['pipe','pipe','pipe'],
		windowsHide:true,
	});
	const engine=new Engine(child,timeout_ms);
	try {
		await engine.ready();
		return engine;
	} catch (error) {
		await engine.close();
		throw error;
	}
}
