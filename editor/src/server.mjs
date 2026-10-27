import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {chmod,open,readFile,rename,rm,stat,unlink,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {geometryChanges} from './geometry.mjs';
import {readNode,readVariables} from './model.mjs';
import {
	MAX_METADATA_BYTES,MAX_REQUEST_BYTES,VIEW_METHODS,activityState,authorize,publicError,sessionRecordPath,
	validateCall,validateMetadataPage,
} from './protocol.mjs';
import {EditorError} from './errors.mjs';
import {recoveryChoices} from './panel-model.mjs';
import {systemTool} from './system.mjs';

const VIEW_TIMEOUT_MS=120000;
const CAPTURE_TIMEOUT_MS=20000;
const MAX_HOLD_MS=2000;
const HOLD_STEP_MS=50;
const MAX_VIEWS=16;
/**
 * One window drives a document at a time. A view that names its `holder` owns the lease while it keeps asking (every view
 * method renews it, when it arrives: a request still running for a window that is gone renews nothing); another holder's attach is refused until it has been silent this long. The window asks every
 * ~0.4 s and a held poll lasts at most MAX_HOLD_MS, so this is several times the longest silence of a live window, and a
 * reloaded window waits at most this long for the lease of the one it replaces.
 */
export const VIEW_LEASE_MS=10000;
const MAX_RESPONSE_BYTES=64*1024*1024;
const MAX_HEADER_BYTES=16*1024;
const MAX_CONNECTIONS=32;
const HEADERS_TIMEOUT_MS=10000;
const REQUEST_TIMEOUT_MS=30000;
const KEEP_ALIVE_TIMEOUT_MS=5000;
const DRAIN_TIMEOUT_MS=15000;
const SOCKET_CLOSE_TIMEOUT_MS=500;
const PROCESS_TIMEOUT_MS=10000;
const MAX_PROCESS_OUTPUT_BYTES=64*1024;

function serverError(code,message) {
	return new EditorError(code,message);
}

function dataDirOf(registry) {
	if (!registry||typeof registry!=='object'||Array.isArray(registry)||typeof registry.data_dir!=='string'||registry.data_dir.length===0) {
		throw serverError('SERVER_OPTIONS_INVALID','registry.data_dir is required');
	}
	return registry.data_dir;
}

/** Read and parse one JSON body incrementally without retaining bytes beyond the limit. */
export async function readJsonBody(stream) {
	const chunks=[];
	let bytes=0;
	for await (const chunk of stream) {
		const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
		bytes+=value.length;
		if (bytes>MAX_REQUEST_BYTES) throw serverError('LIMIT_EXCEEDED','Request exceeds 1 MiB');
		chunks.push(value);
	}
	let parsed;
	try {
		parsed=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
	} catch {
		throw serverError('INVALID_REQUEST','Request body is not valid JSON');
	}
	if (parsed===null||typeof parsed!=='object'||Array.isArray(parsed)) {
		throw serverError('INVALID_REQUEST','Envelope must be an object');
	}
	return parsed;
}

function statusFor(code) {
	if (code==='HOST_FORBIDDEN'||code==='ORIGIN_FORBIDDEN') return 403;
	if (code==='METHOD_NOT_ALLOWED') return 405;
	if (code==='UNAUTHORIZED') return 401;
	if (code==='LIMIT_EXCEEDED') return 413;
	if (code==='METHOD_NOT_FOUND') return 404;
	if (code==='SESSION_MISMATCH'||code==='REVISION_STALE'||code==='VIEW_TAKEN') return 409;
	if (code==='SESSION_UNAVAILABLE'||code==='SERVER_CLOSING') return 503;
	return 400;
}

function reply(response,status,value) {
	const bytes=Buffer.from(JSON.stringify(value));
	response.writeHead(status,{
		'Content-Type':'application/json; charset=utf-8',
		'Content-Length':bytes.length,
		'Cache-Control':'no-store',
	});
	return new Promise(resolve=>{
		let settled=false;
		function finish() {
			if (settled) return;
			settled=true;
			response.off('close',finish);
			resolve();
		}
		response.once('close',finish);
		response.end(bytes,finish);
	});
}

function runProcess(command,args) {
	return new Promise((resolve,reject)=>{
		const child=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
		let stdout='';
		let stderr='';
		let bytes=0;
		let settled=false;
		let forcedError;
		const timer=setTimeout(()=>{
			forcedError=serverError('REGISTRY_ACL_FAILED','Private registry ACL command timed out');
			child.kill();
		},PROCESS_TIMEOUT_MS);
		function finish(error,value) {
			if (settled) return;
			settled=true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(value);
		}
		function collect(chunk,target) {
			bytes+=chunk.length;
			if (bytes>MAX_PROCESS_OUTPUT_BYTES&&!forcedError) {
				forcedError=serverError('REGISTRY_ACL_FAILED','Private registry ACL command returned too much output');
				child.kill();
				return;
			}
			if (target==='stdout') stdout+=chunk;
			else stderr+=chunk;
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data',chunk=>collect(chunk,'stdout'));
		child.stderr.on('data',chunk=>collect(chunk,'stderr'));
		child.once('error',()=>finish(serverError('REGISTRY_ACL_FAILED','Private registry ACL command could not start')));
		child.once('close',code=>{
			if (forcedError) {
				finish(forcedError);
				return;
			}
			if (code!==0) {
				finish(serverError('REGISTRY_ACL_FAILED','Private registry ACL command failed'));
				return;
			}
			finish(null,{stdout,stderr});
		});
	});
}

function sidFromWhoami(output) {
	const fields=output.trim().match(/"(?:[^"]|"")*"/g);
	if (!fields||fields.length<2) throw serverError('REGISTRY_ACL_FAILED','Current Windows user SID is unavailable');
	const sid=fields[1].slice(1,-1).replaceAll('""','"');
	if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw serverError('REGISTRY_ACL_FAILED','Current Windows user SID is invalid');
	return sid;
}

async function windowsAcl(directory) {
	const script=[
		'& { param([string]$Path)',
		'$acl=Get-Acl -LiteralPath $Path;',
		'$sids=@($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });',
		'[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; sids=$sids } | ConvertTo-Json -Compress }',
	].join(' ');
	const {stdout}=await runProcess(systemTool('powershell'),[
		'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script,directory,
	]);
	let value;
	try {
		value=JSON.parse(stdout);
	} catch {
		throw serverError('REGISTRY_ACL_FAILED','Private registry ACL verification returned invalid data');
	}
	const sids=Array.isArray(value?.sids) ? value.sids : typeof value?.sids==='string' ? [value.sids] : [];
	if (typeof value?.protected!=='boolean'||sids.some(sid=>typeof sid!=='string')) {
		throw serverError('REGISTRY_ACL_FAILED','Private registry ACL verification is incomplete');
	}
	return {protected:value.protected,sids};
}

async function ensurePrivateRegistry(directory,aclVerifier=windowsAcl) {
	if (typeof aclVerifier!=='function') throw serverError('REGISTRY_ACL_FAILED','Private registry ACL verifier is invalid');
	if (process.platform!=='win32') {
		await mkdir(directory,{recursive:true,mode:0o700});
		await chmod(directory,0o700);
		return;
	}
	try {
		await mkdir(directory,{recursive:true,mode:0o700});
		const {stdout}=await runProcess(systemTool('whoami'),['/user','/fo','csv','/nh']);
		const sid=sidFromWhoami(stdout);
		await runProcess(systemTool('icacls'),[
			directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,
			'/grant:r','*S-1-5-18:(OI)(CI)F',
		]);
		const allowed=new Set([sid,'S-1-5-18']);
		let acl=await aclVerifier(directory);
		for (const extra of new Set(acl.sids.filter(value=>!allowed.has(value)))) {
			await runProcess(systemTool('icacls'),[directory,'/remove:g',`*${extra}`]);
			await runProcess(systemTool('icacls'),[directory,'/remove:d',`*${extra}`]);
		}
		acl=await aclVerifier(directory);
		const actual=new Set(acl.sids);
		if (!acl.protected||actual.size!==allowed.size
			||[...allowed].some(value=>!actual.has(value))) {
			throw serverError('REGISTRY_ACL_FAILED','Private session registry ACL is not restricted');
		}
	} catch {
		throw serverError('REGISTRY_ACL_FAILED','Private session registry ACL could not be established');
	}
}

async function atomicRecord(path,record) {
	const pending=`${path}.${randomUUID()}.pending`;
	const handle=await open(pending,'wx',0o600);
	try {
		await handle.writeFile(JSON.stringify(record));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(pending,path);
	} finally {
		await rm(pending,{force:true});
	}
}

async function removeOwnedRecord(path,record) {
	let current;
	let before;
	try {
		before=await stat(path,{bigint:true});
		current=JSON.parse(await readFile(path,'utf8'));
	} catch (error) {
		if (error?.code==='ENOENT') return;
		throw error;
	}
	if (current.session_id!==record.session_id||current.token!==record.token||current.pid!==record.pid) return;
	const after=await stat(path,{bigint:true});
	if (before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size) return;
	try {
		await unlink(path);
	} catch (error) {
		if (error?.code!=='ENOENT') throw error;
	}
}

function cleanupViews(views,now=Date.now()) {
	for (const [id,view] of views) {
		if (view.expires_at<=now) views.delete(id);
	}
}

function viewFor(views,args) {
	const view=views.get(args.view_id);
	if (!view||view.view_generation!==args.view_generation) {
		throw serverError('VIEW_STALE','View generation is no longer current');
	}
	view.touched=Date.now();
	return view;
}

/** The panel's focused frame and selected element, so the whiteboard can follow the panel. */
function focusOf(ui) {
	const focus=typeof ui?.focus==='function' ? ui.focus() : null;
	return {frame_id:focus?.frame_id??null,selected_node:focus?.selected_node??null};
}

function activeView(views) {
	let best=null;
	for (const view of views.values()) {
		if (!best||view.expires_at>best.expires_at) best=view;
	}
	return best;
}

/**
 * Geometry drafts of the whiteboard. A capture is read from the window's board and answered through submit_capture; the
 * panel asks for one (`request`), and the window that holds the lease may also start its own when a gesture on the
 * board ended (`claimDirect`). Nothing a poll saw earlier is ever applied, and the wait holds no document or engine
 * lock: the document only runs once the capture arrives.
 */
function createBoard(document,views) {
	let pending=null;
	let resets=0;
	let closed=false;
	// A claimed capture is being applied: the panel's request and the window's own wait for it, one capture at a time.
	let applying=false;
	return {
		get resets() { return resets; },
		get pendingId() { return pending?.capture_id??null; },
		get closed() { return closed; },
		/** The request the given view should answer now, if any. */
		forView(view) {
			const mine=pending&&pending.view_id===view.view_id&&pending.view_generation===view.view_generation;
			return mine ? {capture_id:pending.capture_id} : null;
		},
		/** Resolves with the outcome once the window's capture was handled; rejects when nothing was applied. */
		request() {
			cleanupViews(views);
			if (closed) return Promise.reject(serverError('SERVER_CLOSING','The editor is closing, so nothing was applied'));
			if (pending||applying) return Promise.reject(serverError('CAPTURE_BUSY','The board is already being read'));
			const view=activeView(views);
			if (!view) return Promise.reject(serverError('VIEW_NONE','No whiteboard is attached to this document'));
			const capture={
				capture_id:randomUUID(),view_id:view.view_id,view_generation:view.view_generation,
				base_revision:document.info().revision,expires_at:Date.now()+CAPTURE_TIMEOUT_MS,
			};
			return new Promise((resolve,reject)=>{
				capture.resolve=resolve;
				capture.reject=reject;
				capture.timer=setTimeout(()=>{
					if (pending===capture) pending=null;
					reject(serverError('GEOMETRY_CAPTURE_STALE','The board did not answer in time, so nothing was applied'));
				},CAPTURE_TIMEOUT_MS);
				capture.timer.unref();
				pending=capture;
			});
		},
		/** The server is closing: the panel's pending request ends now instead of waiting for its timeout. */
		detach(view) {
			const capture=pending;
			if (!capture||capture.view_id!==view.view_id||capture.view_generation!==view.view_generation) return;
			pending=null;
			clearTimeout(capture.timer);
			capture.reject(serverError('VIEW_STALE','The whiteboard closed before its edits were applied'));
		},
		close() {
			closed=true;
			const capture=pending;
			if (!capture) return;
			pending=null;
			clearTimeout(capture.timer);
			capture.reject(serverError('SERVER_CLOSING','The editor is closing, so nothing was applied'));
		},
		/** Makes every view rebuild its click targets from the document (the panel's Cancel). */
		reset() { resets+=1; },
		/** A view that attaches again is a rebuilt board: a request made for its old generation can no longer be answered. */
		viewReplaced(view) {
			const capture=pending;
			if (!capture||capture.view_id!==view.view_id||capture.view_generation===view.view_generation) return;
			pending=null;
			clearTimeout(capture.timer);
			capture.reject(serverError('GEOMETRY_CAPTURE_STALE','The board was rebuilt while it was read, so nothing was applied'));
		},
		/** Takes the pending request once, for exactly the capture id and view it was made for. */
		claim(view,args) {
			const capture=pending;
			if (!capture||capture.capture_id!==args.capture_id||capture.view_id!==view.view_id
				||capture.view_generation!==view.view_generation||Date.now()>capture.expires_at) {
				throw serverError('GEOMETRY_CAPTURE_STALE','Geometry capture is stale or expired');
			}
			pending=null;
			applying=true;
			clearTimeout(capture.timer);
			return capture;
		},
		/**
		 * The capture of a gesture the window found ended on its own board: no request of the panel is needed, but only the
		 * view that holds the lease may make one, and never while another capture is pending or being applied.
		 */
		claimDirect(view,args) {
			if (closed) throw serverError('SERVER_CLOSING','The editor is closing, so nothing was applied');
			if (view.holder===undefined||pending||applying) {
				throw serverError('GEOMETRY_CAPTURE_STALE','The board cannot be captured now');
			}
			applying=true;
			return {capture_id:args.capture_id,view_id:view.view_id,view_generation:view.view_generation,base_revision:document.info().revision,resolve() {},reject() {}};
		},
		/** The claimed capture was answered. */
		settled() { applying=false; },
	};
}

function boundedEnvelope(envelope) {
	while (Buffer.byteLength(JSON.stringify(envelope),'utf8')>MAX_METADATA_BYTES) {
		if (envelope.page.nodes.length<=1) throw serverError('LIMIT_EXCEEDED','One metadata node exceeds 32 KiB');
		envelope.page.nodes.pop();
		envelope.page.next_cursor=envelope.page.cursor+envelope.page.nodes.length;
	}
	validateMetadataPage(envelope.page);
	return envelope;
}

/**
 * The view-method dispatcher and the board it serves; exported for tests that drive it without HTTP. `onClose` is what the
 * window's `close_editor` asks for: the owner ends. `window` says how long ago the window last asked for anything: the view
 * methods are the window's, the document's own are an agent's too, so an agent never keeps an editor nobody sees alive.
 */
export function createDispatcher(document,renderer,ui,mcp,onClose) {
	let windowAsked=Date.now();
	let closeAsked=false;
	const window={idle_ms:()=>Date.now()-windowAsked,renew:()=>{ windowAsked=Date.now(); }};
	const views=new Map();
	const detached=new Map();
	function checkViewSlot(id) {
		cleanupViews(views);
		cleanupViews(detached);
		if (!views.has(id)&&!detached.has(id)&&new Set([...views.keys(),...detached.keys()]).size>=MAX_VIEWS) {
			throw serverError('LIMIT_EXCEEDED','Too many active views');
		}
	}
	const board=createBoard(document,views);
	const activity=shownRevision=>{
		const info=document.info();
		const render=renderer.status();
		if (shownRevision!==undefined) render.rendered_revision=shownRevision;
		const state=activityState(info,render);
		let affected=state==='ready'?(render.exported_frame_ids??[])
			:state==='working'&&info.phase==='ready'&&render.refreshing_revision===info.revision
				?(render.affected_frame_ids??null):null;
		if (affected&&(affected.length>64||Buffer.byteLength(JSON.stringify(affected),'utf8')>4096)) affected=null;
		return {
			state,phase:info.phase,revision:info.revision,rendered_revision:render.rendered_revision,dirty:info.dirty,
			affected_frame_ids:affected,
		};
	};
	const viewState=(view,shownRevision)=>({capture:board.forView(view),reset:board.resets,activity:activity(shownRevision)});
	let attemptedRevision=null;
	function requestRefresh() {
		const info=document.info();
		if (info.phase!=='ready'||attemptedRevision===info.revision) return;
		attemptedRevision=info.revision;
		void renderer.refresh(info.revision).catch(()=>undefined);
	}
	// What the window follows: a number that grows whenever the document revision, the panel's focus or selection, a
	// capture request, a reset or the closing changes. An idle window waits on it instead of polling.
	let changes=0;
	let lastSignature='';
	function changeSeq() {
		const info=document.info();
		const render=renderer.status();
		const signature=JSON.stringify([info.revision,info.phase,info.dirty,info.status_seq,render.rendered_revision,
			render.refreshing_revision,render.affected_frame_ids,render.error?.code,focusOf(ui),board.resets,board.pendingId,board.closed]);
		if (signature!==lastSignature) {
			lastSignature=signature;
			changes+=1;
		}
		return changes;
	}
	/** Returns when something changed since `since` or after `waitMs`, whichever is first. */
	async function holdForChange(since,waitMs) {
		const deadline=Date.now()+Math.min(waitMs,MAX_HOLD_MS);
		while (!board.closed&&changeSeq()<=since&&Date.now()<deadline) {
			await new Promise(resolve=>setTimeout(resolve,HOLD_STEP_MS));
		}
	}
	/** Applies one claimed capture; the revision is compared again after every wait. */
	async function applyCapture(view,capture,args) {
		const base=capture.base_revision;
		const current=()=>!board.closed&&views.get(view.view_id)===view&&document.info().revision===base
			&&args.scene_revision===base&&view.scene_revision===base;
		const conflict=()=>serverError('REVISION_STALE','The document changed after the board was read, so nothing was applied');
		if (!current()) throw conflict();
		const model=await document.readModel();
		if (!current()) throw conflict();
		const operations=geometryChanges({
			model,
			view:{view_id:view.view_id,view_generation:view.view_generation,scene_revision:view.scene_revision},
			capture:args,
		});
		// The window found shapes of its own missing and rebuilds the board; the panel says so next to the outcome.
		const reconcile=args.needs_reconcile===true;
		if (operations.length===0) return {applied:false,changes:0,revision:base,reconcile};
		const result=await document.applyChanges({session_id:document.info().session_id,base_revision:base,operations},current);
		return {applied:result.revision!==base,changes:operations.length,revision:result.revision,reconcile};
	}
	async function dispatch(method,args) {
		if (board.closed) throw serverError('SERVER_CLOSING','The editor is closing');
		if (VIEW_METHODS.includes(method)) window.renew();
		const info=document.info();
		switch (method) {
			// The window's own read of the same answer: a view method, so it keeps the owner (an agent's get_document does not).
			case 'poll_document':
			case 'get_document': {
				const render=renderer.status();
				return {
					...info,frames:render.frame_ids,recovery_choices:recoveryChoices(info),
					activity:activity(),
					render:{rendered_revision:render.rendered_revision,refreshing_revision:render.refreshing_revision,
						error:render.error?{code:'RENDER_FAILED',message:'Official frame rendering failed'}:null},
					limits:{operations:100,request_bytes:MAX_REQUEST_BYTES,metadata_nodes:64,metadata_bytes:MAX_METADATA_BYTES},
					capabilities:{structured_operations:true,explicit_save:true,document_history:true},
				};
			}
			case 'get_nodes': {
				const nodes=await document.withEngine(info.revision,async engine=>{
					const values=[];
					for (const path of args.paths) {
						const value=await readNode(engine,path);
						if (value===null) {
							values.push({path,node:null,bounds:null});
						} else {
							const {bounds,...node}=value;
							values.push({path,node,bounds:bounds??null});
						}
					}
					return values;
				});
				const page={nodes};
				validateMetadataPage(page);
				return page;
			}
			case 'get_variables':
				return document.withEngine(info.revision,readVariables);
			case 'get_schema':
				return {
					schema:await document.withEngine(info.revision,engine=>engine.schema()),
					operations:['insert','copy','update','replace','move','delete','set_variables'],
				};
			case 'apply_changes':
				return document.applyChanges(args);
			case 'get_frame_image': {
				await renderer.refresh(info.revision);
				const image=await renderer.frameImage({
					frame_id:args.frame_id,revision:info.revision,max_side:args.max_side??4096,
				});
				const bytes=await readFile(image.path);
				if (document.info().revision!==image.revision) throw serverError('RENDER_NOT_CURRENT','Image revision is no longer current');
				const {path,...metadata}=image;
				return {kind:'image',metadata,base64:bytes.toString('base64')};
			}
			case 'undo_document':
				return document.undo(args);
			case 'redo_document':
				return document.redo(args);
			case 'save_document':
				return document.saveOriginal(args);
			case 'get_mcp_config':
				if (!mcp) throw serverError('METHOD_NOT_FOUND','Method is not supported');
				return {mcp};
			case 'close_editor':
				if (typeof onClose!=='function') throw serverError('METHOD_NOT_FOUND','Method is not supported');
				// After the answer is on its way: the owner's close waits for the handlers, but the window must hear it first.
				if (!closeAsked) {
					closeAsked=true;
					setImmediate(onClose);
				}
				return {closing:true};
			case 'discard_unsaved':
				return document.discardUnsaved(args);
			case 'resolve_recovery':
				return document.resolveRecovery(args.choice);
			case 'save_recovery_copy':
				return document.saveRecoveryCopy(args);
			case 'attach_view': {
				checkViewSlot(args.view_id);
				const now=Date.now();
				if (args.holder!==undefined) {
					for (const other of [...views.values()]) {
						if (other.holder===undefined||other.holder===args.holder) continue;
						if (now-other.touched<VIEW_LEASE_MS) throw serverError('VIEW_TAKEN','Another window is showing this document');
						// Its window stopped asking: its view is gone, and so is whatever it had detached.
						board.detach(other);
						views.delete(other.view_id);
						detached.delete(other.view_id);
					}
					if (detached.get(args.view_id)?.holder!==args.holder) detached.delete(args.view_id);
				}
				const previous=views.get(args.view_id);
				if ((previous&&previous.view_generation>args.view_generation)
					||(detached.get(args.view_id)?.view_generation??-1)>=args.view_generation) {
					throw serverError('VIEW_STALE','View generation is no longer current');
				}
				const frameId=args.frame_id??renderer.status().frame_ids[0]??'';
				const view={
					view_id:args.view_id,view_generation:args.view_generation,
					scene_revision:args.scene_revision,frame_id:frameId,selected_node:null,
					expires_at:now+VIEW_TIMEOUT_MS,holder:args.holder,touched:now,
				};
				views.set(args.view_id,view);
				board.viewReplaced(view);
				return {...view,request_id:args.request_id,status_seq:info.status_seq,focus:focusOf(ui),...viewState(view)};
			}
			case 'detach_view': {
				checkViewSlot(args.view_id);
				const view=views.get(args.view_id);
				if (view&&view.view_generation>args.view_generation) throw serverError('VIEW_STALE','View generation is no longer current');
				detached.set(args.view_id,{
					holder:view?.holder??detached.get(args.view_id)?.holder,
					view_generation:Math.max(args.view_generation,detached.get(args.view_id)?.view_generation??-1),
					expires_at:Date.now()+VIEW_TIMEOUT_MS+REQUEST_TIMEOUT_MS,
				});
				if (view?.view_generation===args.view_generation) {
					views.delete(args.view_id);
					board.detach(view);
				}
				return {request_id:args.request_id,view_generation:args.view_generation,detached:true};
			}
			case 'poll_view': {
				cleanupViews(views);
				const view=viewFor(views,args);
				const frameId=args.frame_id??view.frame_id;
				const requestId=args.request_id;
				const generation=view.view_generation;
				const expiresAt=Date.now()+VIEW_TIMEOUT_MS;
				const revision=document.info().revision;
				await renderer.refresh(revision);
				if (views.get(args.view_id)!==view||view.view_generation!==generation) {
					throw serverError('VIEW_STALE','View generation changed during polling');
				}
				const page=renderer.projection({frame_id:frameId,cursor:args.cursor??null});
				view.frame_id=frameId;
				view.expires_at=expiresAt;
				view.scene_revision=page.revision;
				return boundedEnvelope({
					request_id:requestId,status_seq:document.info().status_seq,
					view_generation:generation,page,focus:focusOf(ui),...viewState(view,page.revision),
				});
			}
			case 'list_frames': {
				cleanupViews(views);
				const view=viewFor(views,args);
				const generation=view.view_generation;
				if (args.wait_ms>0) await holdForChange(args.since??0,args.wait_ms);
				const seq=changeSeq();
				requestRefresh();
				if (views.get(args.view_id)!==view||view.view_generation!==generation) {
					throw serverError('VIEW_STALE','View generation changed during listing');
				}
				const rendered=renderer.status();
				const page=rendered.rendered_revision===null
					?{frame_id:view.frame_id,revision:0,nodes:[],cursor:0,next_cursor:null}
					:await renderer.frameList({frame_id:view.frame_id,cursor:args.cursor??null});
				if (board.closed||views.get(args.view_id)!==view) throw serverError('VIEW_STALE','View changed during publication');
				view.expires_at=Date.now()+VIEW_TIMEOUT_MS;
				return boundedEnvelope({
					request_id:args.request_id,status_seq:document.info().status_seq,
					view_generation:generation,page,focus:focusOf(ui),...viewState(view,rendered.rendered_revision===null?null:page.revision),change_seq:seq,
				});
			}
			case 'select_node': {
				const view=viewFor(views,args);
				if (view.scene_revision!==args.scene_revision) throw serverError('VIEW_STALE','View revision is no longer current');
				view.selected_node=args.path;
				if (typeof ui?.selectNode==='function') await ui.selectNode({...view,path:args.path});
				return {request_id:args.request_id,path:args.path,view_generation:view.view_generation};
			}
			case 'submit_capture': {
				const view=viewFor(views,args);
				const capture=args.direct===true ? board.claimDirect(view,args) : board.claim(view,args);
				const answer={request_id:args.request_id,capture_id:capture.capture_id,view_generation:view.view_generation};
				try {
					const outcome=await applyCapture(view,capture,args);
					capture.resolve(outcome);
					return {...answer,outcome:outcome.applied ? 'applied' : 'unchanged',revision:outcome.revision,reconcile:outcome.reconcile};
				} catch (error) {
					capture.reject(error);
					// A refusal or conflict is an answer for the window (it keeps or rebuilds its shapes); the rest is a fault.
					const {code}=publicError(error);
					if (code==='REVISION_STALE') return {...answer,outcome:'conflict',code};
					if (code.startsWith('GEOMETRY_')) {
						// A refusal by the layout names it, so the toast can say which layout decides.
						const layout=code==='GEOMETRY_CONTROLLED_BY_LAYOUT' ? error.details?.layout : undefined;
						// A text conflict names what the node has now, so the window can offer to keep the user's text over it.
						const current=code==='GEOMETRY_TEXT_CONFLICT' ? error.details?.current : undefined;
						return {...answer,outcome:'refused',code,...(typeof layout==='string' ? {layout} : {}),...(typeof current==='string' ? {current} : {})};
					}
					throw error;
				} finally {
					board.settled();
				}
			}
		}
		throw serverError('METHOD_NOT_FOUND','Method is not supported');
	}
	return {dispatch,board,window};
}

/** Start the one authenticated loopback server and publish its private discovery record. */
export async function startServer({document,renderer,registry,ui,mcp,onClose,aclVerifier}) {
	if (!document||typeof document.info!=='function'||!renderer||typeof renderer.status!=='function') {
		throw serverError('SERVER_OPTIONS_INVALID','document and renderer are required');
	}
	const dataDir=dataDirOf(registry);
	const session=document.info();
	const recordPath=sessionRecordPath(dataDir,session.original_path);
	await ensurePrivateRegistry(dirname(recordPath),aclVerifier);
	const token=randomBytes(32).toString('base64url');
	let closing=false;
	let expectedHost;
	const sockets=new Set();
	const handlers=new Set();
	const headerTimers=new Map();
	const {dispatch,board,window}=createDispatcher(document,renderer,ui,mcp,onClose);
	function headerValues(request,name) {
		const values=[];
		for (let index=0;index<request.rawHeaders.length;index+=2) {
			if (request.rawHeaders[index].toLowerCase()===name) values.push(request.rawHeaders[index+1]);
		}
		return values;
	}
	function clearHeaderTimer(socket) {
		const timer=headerTimers.get(socket);
		if (timer) clearTimeout(timer);
		headerTimers.delete(socket);
	}
	async function handleRequest(request,response) {
		clearHeaderTimer(request.socket);
		try {
			const hosts=headerValues(request,'host');
			if (hosts.length!==1||hosts[0]!==expectedHost) throw serverError('HOST_FORBIDDEN','Host is forbidden');
			if (headerValues(request,'origin').length!==0) throw serverError('ORIGIN_FORBIDDEN','Origin is forbidden');
			if (closing) throw serverError('SERVER_CLOSING','Server is closing');
			if (request.method!=='POST'||request.url!=='/') throw serverError('METHOD_NOT_ALLOWED','HTTP method is not allowed');
			authorize(request.headers.authorization,token,true);
			const declared=Number(request.headers['content-length']);
			if (Number.isFinite(declared)&&declared>MAX_REQUEST_BYTES) throw serverError('LIMIT_EXCEEDED','Request exceeds 1 MiB');
			const envelope=await readJsonBody(request);
			const keys=Object.keys(envelope);
			if (keys.some(key=>!['method','args','session_id'].includes(key))||typeof envelope.method!=='string') {
				throw serverError('INVALID_REQUEST','Envelope contains unsupported fields');
			}
			validateCall(envelope.method,envelope.args,Buffer.byteLength(JSON.stringify(envelope),'utf8'));
			if (envelope.session_id!==session.session_id||document.info().session_id!==session.session_id) {
				throw serverError('SESSION_MISMATCH','Request belongs to another document session');
			}
			const result=await dispatch(envelope.method,envelope.args);
			if (Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_RESPONSE_BYTES) throw serverError('LIMIT_EXCEEDED','Response exceeds its limit');
			await reply(response,200,{result});
		} catch (error) {
			const value=error?.code==='SERVER_CLOSING'
				?{code:'SERVER_CLOSING',message:'Server is closing'}
				:publicError(error,token);
			await reply(response,statusFor(value.code),{error:value});
		}
	}
	const listener=createServer({
		maxHeaderSize:MAX_HEADER_BYTES,joinDuplicateHeaders:true,requireHostHeader:false,
	},(request,response)=>{
		const handler=handleRequest(request,response);
		handlers.add(handler);
		void handler.then(
			()=>handlers.delete(handler),
			()=>handlers.delete(handler),
		);
	});
	listener.headersTimeout=HEADERS_TIMEOUT_MS;
	listener.requestTimeout=REQUEST_TIMEOUT_MS;
	listener.keepAliveTimeout=KEEP_ALIVE_TIMEOUT_MS;
	listener.maxConnections=MAX_CONNECTIONS;
	listener.on('connection',socket=>{
		sockets.add(socket);
		const timer=setTimeout(()=>socket.destroy(),HEADERS_TIMEOUT_MS);
		headerTimers.set(socket,timer);
		socket.once('close',()=>{
			clearHeaderTimer(socket);
			sockets.delete(socket);
		});
	});
	listener.on('clientError',(_error,socket)=>socket.destroy());
	async function drainHandlers() {
		let timer;
		const timeout=new Promise(resolve=>{
			timer=setTimeout(()=>resolve(false),DRAIN_TIMEOUT_MS);
		});
		try {
			while (handlers.size>0) {
				const drained=await Promise.race([
					Promise.allSettled([...handlers]).then(()=>true),
					timeout,
				]);
				if (!drained) return false;
			}
			return true;
		} finally {
			clearTimeout(timer);
		}
	}
	async function stopListener() {
		closing=true;
		let closed=Promise.resolve();
		if (listener.listening) closed=new Promise(resolve=>listener.close(()=>resolve()));
		// Idle connections were closed when close() began; the rest are closed once the handlers have drained.
		const drained=await drainHandlers();
		const aborted=drained?0:handlers.size;
		listener.closeIdleConnections();
		listener.closeAllConnections();
		for (const socket of sockets) socket.destroy();
		let timer;
		try {
			await Promise.race([
				closed,
				new Promise(resolve=>{ timer=setTimeout(resolve,SOCKET_CLOSE_TIMEOUT_MS); }),
			]);
		} finally {
			clearTimeout(timer);
		}
		return {drained,aborted};
	}
	try {
		await new Promise((resolve,reject)=>{
			listener.once('error',reject);
			listener.listen(0,'127.0.0.1',()=>{
				listener.off('error',reject);
				resolve();
			});
		});
	} catch (error) {
		await stopListener();
		throw error;
	}
	const address=listener.address();
	expectedHost=`127.0.0.1:${address.port}`;
	const endpoint=`http://${expectedHost}`;
	const record={
		version:1,original_path:session.original_path,endpoint,token,
		session_id:session.session_id,pid:process.pid,
	};
	// The plugin cannot hash a canonical path, so it finds this record by the nonce its manifest carried.
	if (typeof registry.launch_id==='string'&&/^[0-9a-f]{32}$/.test(registry.launch_id)) record.launch_id=registry.launch_id;
	try {
		await atomicRecord(recordPath,record);
	} catch (error) {
		await stopListener();
		throw error;
	}
	let closePromise;
	return {
		endpoint,token,board,window,
		close() {
			if (closePromise) return closePromise;
			board.close();
			// New requests are refused from here, and idle connections go, while the listener stays up until the record is gone.
			closing=true;
			listener.closeIdleConnections();
			closePromise=(async()=>{
				// Unpublish first: a record that outlives its listener makes the lock's owner look dead while it drains.
				let removal;
				try {
					await removeOwnedRecord(recordPath,record);
				} catch (error) {
					removal={error};
				}
				const result=await stopListener();
				if (removal) throw removal.error;
				return result;
			})();
			return closePromise;
		},
	};
}
