import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {open,lstat,readFile,rename,stat,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {EditorError} from './errors.mjs';
import {systemTool} from './system.mjs';

const HASH=/^[a-f0-9]{64}$/;
const INTENT_NAME='save-intent.json';
const MAX_OUTPUT_BYTES=1024*1024;
// Source keeps the helper in editor/windows; a bundle ships it beside itself as windows-replace.ps1.
const REPLACE_SCRIPT=fileURLToPath(new URL(
	import.meta.url.endsWith('/save.mjs')?'../windows/replace.ps1':'./windows-replace.ps1',
	import.meta.url,
));

function saveError(code,message,details) {
	return new EditorError(code,message,details);
}

/** @param {Buffer} bytes */
export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function artifactIdentity(details) {
	return {
		dev:String(details.dev),
		ino:String(details.ino),
		size:String(details.size),
	};
}

function isArtifactIdentity(identity) {
	return identity!==null&&typeof identity==='object'
		&&/^\d+$/.test(identity.dev)
		&&/^\d+$/.test(identity.ino)
		&&/^\d+$/.test(identity.size);
}

function sameIdentity(details,identity) {
	return isArtifactIdentity(identity)
		&&String(details.dev)===identity.dev
		&&String(details.ino)===identity.ino
		&&String(details.size)===identity.size;
}

async function writeExclusiveDurable(path,data) {
	const handle=await open(path,'wx',0o600);
	try {
		await handle.writeFile(data);
		await handle.sync();
		return artifactIdentity(await handle.stat({bigint:true}));
	} finally {
		await handle.close();
	}
}

async function unlinkIfExists(path) {
	try {
		await unlink(path);
	} catch (error) {
		if (error?.code!=='ENOENT') throw error;
	}
}

/** @param {string} path */
export async function captureArtifactIdentity(path) {
	const [followed,direct]=await Promise.all([
		stat(path,{bigint:true}),
		lstat(path,{bigint:true}),
	]);
	if (direct.isSymbolicLink()||!direct.isFile()||!followed.isFile()
		||String(direct.dev)!==String(followed.dev)||String(direct.ino)!==String(followed.ino)) {
		throw saveError('SAVE_ARTIFACT_INVALID','Save artifact is not a regular file');
	}
	return artifactIdentity(followed);
}

async function removeOwnedArtifact(path,identity) {
	let details;
	try {
		details=await lstat(path,{bigint:true});
	} catch (error) {
		if (error?.code==='ENOENT') return {leftovers:[]};
		throw error;
	}
	if (details.isSymbolicLink()||!details.isFile()||!sameIdentity(details,identity)) {
		return {leftovers:[path]};
	}
	// Identity validation narrows accidental deletion, but pathname unlink has no portable CAS.
	// Another actor can still replace the path between this lstat and unlink; that TOCTOU remains.
	try {
		await unlink(path);
	} catch (error) {
		if (error?.code!=='ENOENT') throw error;
	}
	return {leftovers:[]};
}

async function regularFile(path,code) {
	let details;
	try {
		details=await lstat(path);
	} catch (error) {
		throw saveError(code,'Save input is unavailable',{cause:error});
	}
	if (details.isSymbolicLink()||!details.isFile()) {
		throw saveError(code,'Save input must be a regular file');
	}
	return details;
}

async function assertAbsent(path,code) {
	try {
		await lstat(path);
	} catch (error) {
		if (error?.code==='ENOENT') return;
		throw saveError(code,'Save destination cannot be inspected',{cause:error});
	}
	throw saveError(code,'Save destination already exists');
}

function assertAbsolutePath(path,name) {
	if (typeof path!=='string'||!isAbsolute(path)||path.includes('\0')) {
		throw saveError('SAVE_MANIFEST_INVALID',`${name} must be an absolute path`);
	}
	return resolve(path);
}

async function validatePublishOptions(options) {
	const allowed=new Set(['candidate','original','backup','expected_hash','script']);
	if (!options||typeof options!=='object'
		||Object.keys(options).some(key=>!allowed.has(key))
		||!HASH.test(options.expected_hash)) {
		throw saveError('SAVE_MANIFEST_INVALID','Save manifest is invalid');
	}
	const candidate=assertAbsolutePath(options.candidate,'candidate');
	const original=assertAbsolutePath(options.original,'original');
	const backup=assertAbsolutePath(options.backup,'backup');
	const script=options.script===undefined
		?REPLACE_SCRIPT
		:assertAbsolutePath(options.script,'script');
	if (new Set([candidate.toLowerCase(),original.toLowerCase(),backup.toLowerCase()]).size!==3
		||dirname(candidate).toLowerCase()!==dirname(original).toLowerCase()
		||dirname(backup).toLowerCase()!==dirname(original).toLowerCase()) {
		throw saveError('SAVE_MANIFEST_INVALID','Save paths must be distinct and share one directory');
	}
	const candidateDetails=await regularFile(candidate,'SAVE_CANDIDATE_INVALID');
	await regularFile(original,'SOURCE_CHANGED');
	await regularFile(script,'SAVE_MANIFEST_INVALID');
	await assertAbsent(backup,'SAVE_BACKUP_EXISTS');
	if (candidateDetails.size<1) throw saveError('SAVE_CANDIDATE_INVALID','Save candidate is incomplete');
	const candidateHash=sha256(await readFile(candidate));
	return {
		script,
		manifest:{
			candidate,
			original,
			backup,
			expected_hash:options.expected_hash,
			candidate_hash:candidateHash,
		},
	};
}

function parseResult(stdout) {
	const lines=stdout.split(/\r?\n/).filter(Boolean);
	let result;
	try {
		result=JSON.parse(lines.at(-1));
	} catch (error) {
		throw saveError('SAVE_PROTOCOL','Save helper returned invalid JSON',{cause:error,stdout});
	}
	if (!result||typeof result!=='object'||![true,false,null].includes(result.published)) {
		throw saveError('SAVE_PROTOCOL','Save helper returned an invalid outcome');
	}
	if (result.source_hash!==undefined&&!HASH.test(result.source_hash)
		||result.replaced_hash!==undefined&&!HASH.test(result.replaced_hash)
		||result.conflict!==undefined&&typeof result.conflict!=='boolean') {
		throw saveError('SAVE_PROTOCOL','Save helper returned invalid hashes');
	}
	return result;
}

async function terminateChildTree(child) {
	let killer;
	if (process.platform==='win32'&&Number.isInteger(child.pid)) {
		try {
			killer=spawn(systemTool('taskkill'),['/PID',String(child.pid),'/T','/F'],{
				shell:false,
				windowsHide:true,
				stdio:'ignore',
			});
		} catch {
			killer=undefined;
		}
	}
	child.kill();
	if (killer) await once(killer,'close').catch(()=>undefined);
}

async function runReplace(manifestPath,script) {
	const child=spawn(systemTool('powershell'),[
		'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
		'-File',script,'-Manifest',manifestPath,
	],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
	let stdout='';
	let stderr='';
	let outputBytes=0;
	let closed=false;
	let overflow=false;
	let termination;
	function stopChild() {
		if (!termination) termination=terminateChildTree(child);
		return termination;
	}
	function collect(chunk,target) {
		if (overflow) return;
		const bytes=Buffer.byteLength(chunk);
		if (outputBytes+bytes>MAX_OUTPUT_BYTES) {
			overflow=true;
			void stopChild();
			return;
		}
		outputBytes+=bytes;
		if (target==='stdout') stdout+=chunk;
		else stderr+=chunk;
	}
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data',chunk=>collect(chunk,'stdout'));
	child.stderr.on('data',chunk=>collect(chunk,'stderr'));
	const timeout=setTimeout(()=>{ void stopChild(); },120000);
	try {
		const [code,signal]=await once(child,'close');
		closed=true;
		await termination;
		if (overflow) {
			throw saveError('SAVE_PROTOCOL','Save helper output exceeded its limit',{
				captured_bytes:outputBytes,
				max_bytes:MAX_OUTPUT_BYTES,
			});
		}
		if (!stdout.trim()) {
			throw saveError('SAVE_HELPER_FAILED','Save helper returned no result',{code,signal,stderr});
		}
		return parseResult(stdout);
	} catch (error) {
		if (error?.code==='ENOENT') throw saveError('SAVE_HELPER_MISSING','PowerShell is unavailable',{cause:error});
		throw error;
	} finally {
		clearTimeout(timeout);
		if (!closed) {
			await stopChild();
			await once(child,'close').catch(()=>undefined);
		}
	}
}

/**
 * Atomically replaces a Windows destination with a complete candidate and preserves a backup.
 * The script option is internal test instrumentation and is never forwarded into the manifest.
 * @param {{candidate:string,original:string,backup:string,expected_hash:string,script?:string}} options
 * @returns {Promise<{published:boolean|null,source_hash?:string,replaced_hash?:string,
 * conflict?:boolean,error?:object,backup_identity?:object,leftovers?:string[]}>}
 */
export async function publishWindows(options) {
	const {manifest,script}=await validatePublishOptions(options);
	const manifestPath=join(dirname(manifest.candidate),`.tern-save-${randomUUID()}.json`);
	let manifestIdentity;
	let result;
	let operationError;
	try {
		manifestIdentity=await writeExclusiveDurable(manifestPath,JSON.stringify(manifest));
		try {
			result=await runReplace(manifestPath,script);
			if (result.published===true) {
				result={...result,backup_identity:await captureArtifactIdentity(manifest.backup)};
			}
		} catch (error) {
			operationError=error;
		}
	} catch (error) {
		operationError=error;
	}

	let cleanup={leftovers:[]};
	let cleanupError;
	if (manifestIdentity) {
		try {
			cleanup=await removeOwnedArtifact(manifestPath,manifestIdentity);
		} catch (error) {
			cleanupError=error;
		}
	}
	if (operationError) {
		operationError.details={
			...(operationError.details??{}),
			leftovers:cleanup.leftovers,
			...(cleanupError?{cleanup_error:cleanupError}:{}),
		};
		throw operationError;
	}
	if (cleanupError) throw cleanupError;
	return {...result,leftovers:cleanup.leftovers};
}

function candidatePath(original,sessionId) {
	return join(dirname(original),`.${basename(original)}.tern-save-${sessionId}-${randomUUID()}.candidate`);
}

function backupPath(original,sessionId) {
	return join(dirname(original),`.${basename(original)}.tern-save-${sessionId}-${randomUUID()}.bak`);
}

function intentPath(storeDir) {
	return join(storeDir,INTENT_NAME);
}

function validateIntent(intent,original) {
	if (!intent||typeof intent!=='object'||intent.version!==1
		||intent.original_path!==original
		||typeof intent.session_id!=='string'
		||!HASH.test(intent.expected_hash)
		||!HASH.test(intent.candidate_hash)
		||!HASH.test(intent.checkpoint_id)
		||typeof intent.candidate_path!=='string'
		||!isArtifactIdentity(intent.candidate_identity)
		||typeof intent.backup_path!=='string'
		||intent.backup_identity!==undefined&&!isArtifactIdentity(intent.backup_identity)) {
		throw saveError('SAVE_INTENT_INVALID','Pending Save intent is invalid');
	}
	const directory=dirname(original).toLowerCase();
	if (dirname(intent.candidate_path).toLowerCase()!==directory
		||dirname(intent.backup_path).toLowerCase()!==directory
		||!basename(intent.candidate_path).includes(`tern-save-${intent.session_id}-`)
		||!basename(intent.candidate_path).endsWith('.candidate')
		||!basename(intent.backup_path).includes(`tern-save-${intent.session_id}-`)
		||!basename(intent.backup_path).endsWith('.bak')) {
		throw saveError('SAVE_INTENT_INVALID','Pending Save paths are not owned by the session');
	}
	return intent;
}

export async function prepareSave({bytes,original,session_id:sessionId,expected_hash:expectedHash,checkpoint_id:checkpointId}) {
	if (!Buffer.isBuffer(bytes)||bytes.length<1||sha256(bytes)!==checkpointId||!HASH.test(expectedHash)) {
		throw saveError('SAVE_CANDIDATE_INVALID','Confirmed checkpoint cannot form a Save candidate');
	}
	const candidate=candidatePath(original,sessionId);
	const backup=backupPath(original,sessionId);
	await assertAbsent(backup,'SAVE_BACKUP_EXISTS');
	const candidateIdentity=await writeExclusiveDurable(candidate,bytes);
	return {
		version:1,
		session_id:sessionId,
		original_path:original,
		expected_hash:expectedHash,
		candidate_hash:checkpointId,
		checkpoint_id:checkpointId,
		candidate_path:candidate,
		candidate_identity:candidateIdentity,
		backup_path:backup,
	};
}

export async function writeSaveIntent(storeDir,intent,{replace=false}={}) {
	const path=intentPath(storeDir);
	validateIntent(intent,intent.original_path);
	if (!replace) {
		try {
			await writeExclusiveDurable(path,JSON.stringify(intent));
			return;
		} catch (error) {
			if (error?.code==='EEXIST') throw saveError('SAVE_INTENT_PENDING','A previous Save needs recovery');
			throw error;
		}
	}
	const pending=join(storeDir,`${randomUUID()}.save-intent-pending`);
	try {
		await writeExclusiveDurable(pending,JSON.stringify(intent));
		await rename(pending,path);
	} finally {
		await unlinkIfExists(pending);
	}
}

export async function removeSaveIntent(storeDir) {
	await unlinkIfExists(intentPath(storeDir));
}

export async function loadSaveIntent(storeDir,original) {
	let text;
	try {
		text=await readFile(intentPath(storeDir),'utf8');
	} catch (error) {
		if (error?.code==='ENOENT') return null;
		throw error;
	}
	let intent;
	try {
		intent=JSON.parse(text);
	} catch (error) {
		throw saveError('SAVE_INTENT_INVALID','Pending Save intent is unreadable',{cause:error});
	}
	return validateIntent(intent,original);
}

export async function preserveCandidate(intent,bytes) {
	let existingIdentity;
	try {
		existingIdentity=await captureArtifactIdentity(intent.candidate_path);
	} catch (error) {
		if (error?.code!=='ENOENT') throw error;
		const candidateIdentity=await writeExclusiveDurable(intent.candidate_path,bytes);
		return {intent:{...intent,candidate_identity:candidateIdentity},leftovers:[]};
	}
	if (!sameIdentity({
		dev:BigInt(existingIdentity.dev),
		ino:BigInt(existingIdentity.ino),
		size:BigInt(existingIdentity.size),
	},intent.candidate_identity)) {
		return {intent,leftovers:[intent.candidate_path]};
	}
	const existing=await readFile(intent.candidate_path);
	const verifiedIdentity=await captureArtifactIdentity(intent.candidate_path);
	if (JSON.stringify(verifiedIdentity)!==JSON.stringify(existingIdentity)) {
		return {intent,leftovers:[intent.candidate_path]};
	}
	if (sha256(existing)!==intent.candidate_hash) {
		throw saveError('SAVE_CANDIDATE_INVALID','Preserved Save candidate changed');
	}
	return {intent,leftovers:[]};
}

export async function removeCandidate(intent) {
	return removeOwnedArtifact(intent.candidate_path,intent.candidate_identity);
}

async function fileHash(path) {
	try {
		return sha256(await readFile(path));
	} catch (error) {
		if (error?.code==='ENOENT') return null;
		throw error;
	}
}

export async function reconcileSaveIntent({source,store,index}) {
	let intent=await loadSaveIntent(store.dir,source.original_path);
	if (!intent) return {index,recovery:null};
	const checkpoint=await store.read(intent.checkpoint_id);
	if (sha256(checkpoint)!==intent.candidate_hash) {
		throw saveError('SAVE_INTENT_INVALID','Save intent checkpoint does not match its candidate');
	}
	const diskHash=source.source_fingerprint;
	const backupHash=await fileHash(intent.backup_path);
	if (backupHash!==null&&!intent.backup_identity) {
		intent={...intent,backup_identity:await captureArtifactIdentity(intent.backup_path)};
	}
	if (intent.conflict===true
		||diskHash===intent.candidate_hash&&backupHash!==intent.expected_hash) {
		const preserved=await preserveCandidate({
			...intent,
			conflict:true,
			replaced_hash:backupHash,
		},checkpoint);
		await writeSaveIntent(store.dir,preserved.intent,{replace:true});
		return {
			index,
			recovery:{save_conflict:true,leftovers:preserved.leftovers},
			intent:preserved.intent,
		};
	}
	if (diskHash===intent.candidate_hash) {
		const next=await store.publish({
			...index,
			saved_id:intent.checkpoint_id,
			source:{fingerprint:diskHash},
			save_backup:{
				path:intent.backup_path,
				owner_session_id:intent.session_id,
				identity:intent.backup_identity,
			},
		});
		await source.acceptPublished(diskHash);
		await removeSaveIntent(store.dir);
		const cleanup=await removeCandidate(intent);
		return {index:next,recovery:null,leftovers:cleanup.leftovers};
	}
	const candidateHash=await fileHash(intent.candidate_path);
	if (diskHash===intent.expected_hash&&candidateHash===intent.candidate_hash&&backupHash===null) {
		await removeSaveIntent(store.dir);
		const cleanup=await removeCandidate(intent);
		return {index,recovery:null,leftovers:cleanup.leftovers};
	}
	const preserved=await preserveCandidate({
		...intent,
		conflict:true,
		replaced_hash:backupHash,
	},checkpoint);
	await writeSaveIntent(store.dir,preserved.intent,{replace:true});
	return {
		index,
		recovery:{save_conflict:true,leftovers:preserved.leftovers},
		intent:preserved.intent,
	};
}

export async function createRecoveryCopy({bytes,original,checkpoint_id:checkpointId}) {
	if (!Buffer.isBuffer(bytes)||bytes.length<1||sha256(bytes)!==checkpointId) {
		throw saveError('RECOVERY_COPY_INVALID','Recovery checkpoint is invalid');
	}
	for (let attempt=0;attempt<16;attempt+=1) {
		const path=join(dirname(original),`${basename(original,'.pen')}.tern-recovery-${randomUUID()}.pen`);
		try {
			await writeExclusiveDurable(path,bytes);
			return {path,checkpoint_id:checkpointId};
		} catch (error) {
			if (error?.code!=='EEXIST') throw saveError('RECOVERY_COPY_FAILED','Recovery copy could not be written',{cause:error});
		}
	}
	throw saveError('RECOVERY_COPY_FAILED','A unique recovery copy name could not be reserved');
}

export async function removePreviousBackup(index,sessionId,currentBackup,original) {
	const previous=index.save_backup;
	if (!previous||previous.owner_session_id!==sessionId||previous.path===currentBackup) {
		return {leftovers:[]};
	}
	if (dirname(previous.path).toLowerCase()!==dirname(original).toLowerCase()
		||!basename(previous.path).includes(`tern-save-${sessionId}-`)
		||!basename(previous.path).endsWith('.bak')) {
		return {leftovers:[]};
	}
	return removeOwnedArtifact(previous.path,previous.identity);
}
