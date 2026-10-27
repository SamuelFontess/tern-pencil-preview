import {readFile} from 'node:fs/promises';
import {EditorError} from './errors.mjs';
import {startEngine} from './engine.mjs';
import {appendHistory,seekHistory} from './history.mjs';
import {readModel as readEngineModel,readNode as readEngineNode} from './model.mjs';
import {compileOperations} from './ops.mjs';
import {
	createRecoveryCopy,
	prepareSave,
	preserveCandidate,
	publishWindows,
	reconcileSaveIntent,
	removeCandidate,
	removePreviousBackup,
	removeSaveIntent,
	writeSaveIntent,
} from './save.mjs';

const MAX_DOCUMENT_BYTES=64*1024*1024;

function documentError(code,message,details) {
	return new EditorError(code,message,details);
}

/** The engine's first error message (no warnings, no stack), safe to show the agent. */
export function refusalReason(error) {
	const stderr=String(error.details?.stderr??'').replaceAll('\r','');
	const block=/^\[error\][^\n]*(?:\n(?!\[|\s+at ).*)*/im.exec(stderr)?.[0]??'';
	const reason=block.split('[Error]: ').pop().replace(/^\[ERROR\]\s*/i,'').trim();
	return Array.from(reason).slice(0,300).join('')||'The engine refused the operations';
}

function assertSource(source) {
	if (!source
		||typeof source.original_path!=='string'
		||typeof source.session_id!=='string'
		||typeof source.working_path!=='string'
		||typeof source.source_fingerprint!=='string'
		||typeof source.assertDiskBase!=='function'
		||typeof source.acceptPublished!=='function'
		||typeof source.restore!=='function'
		||typeof source.discardWorking!=='function'
		||typeof source.release!=='function') {
		throw documentError('DOCUMENT_OPTIONS_INVALID','Source is incomplete');
	}
}

function assertStore(store) {
	if (!store
		||typeof store.dir!=='string'
		||typeof store.load!=='function'
		||typeof store.put!=='function'
		||typeof store.read!=='function'
		||typeof store.publish!=='function') {
		throw documentError('DOCUMENT_OPTIONS_INVALID','Store is incomplete');
	}
}

function assertCliArgv(argv) {
	if (!Array.isArray(argv)||argv.length===0||argv.some(value=>typeof value!=='string')) {
		throw documentError('DOCUMENT_OPTIONS_INVALID','cli_argv must be a nonempty string array');
	}
}

function assertDocumentSize(bytes) {
	if (!Buffer.isBuffer(bytes)||bytes.length>MAX_DOCUMENT_BYTES) {
		throw documentError('DOCUMENT_LIMIT','Document exceeds 64 MiB');
	}
}

function currentCheckpoint(index) {
	return index.snapshots[index.cursor];
}

function assertSaveRequest(request) {
	if (!request||typeof request!=='object'||Array.isArray(request)
		||Object.keys(request).some(key=>key!=='session_id'&&key!=='base_revision')) {
		throw documentError('SAVE_REQUEST_INVALID','Save request contains unsupported fields');
	}
}

function expiredFacadeError() {
	return documentError('ENGINE_FACADE_EXPIRED','Engine facade is no longer active');
}

function createEngineFacade(engine) {
	let active=true;
	let execCalled=false;
	const pending=new Set();
	function invoke(operation) {
		if (!active) return Promise.reject(expiredFacadeError());
		let promise;
		try {
			promise=Promise.resolve(operation());
		} catch (error) {
			promise=Promise.reject(error);
		}
		pending.add(promise);
		void promise.then(
			()=>pending.delete(promise),
			()=>pending.delete(promise),
		);
		return promise;
	}
	const facade=Object.create(null);
	Object.defineProperties(facade,{
		exec:{
			enumerable:true,
			value(body,options) {
				if (!active) return Promise.reject(expiredFacadeError());
				execCalled=true;
				return invoke(()=>engine.exec(body,options));
			},
		},
		schema:{
			enumerable:true,
			value() {
				return invoke(()=>engine.schema());
			},
		},
	});
	return {
		facade:Object.freeze(facade),
		didExec:()=>execCalled,
		async expire() {
			active=false;
			await Promise.allSettled([...pending]);
		},
	};
}

function initialIndex(source,checkpoint) {
	return {
		version:1,
		source:{fingerprint:source.source_fingerprint},
		snapshots:[checkpoint.id],
		cursor:0,
		saved_id:checkpoint.id,
		revision:0,
		sizes:{[checkpoint.id]:checkpoint.bytes},
	};
}

export class DocumentSession {
	constructor({source,store,cliArgv,engine,index,phase,recovery,recoverySourceBytes,recoverySaveIntent,model}) {
		this.source=source;
		this.store=store;
		this.cliArgv=cliArgv;
		this.engine=engine;
		this.index=index;
		this.phase=phase;
		this.recovery=recovery;
		this.recoverySourceBytes=recoverySourceBytes;
		this.recoverySaveIntent=recoverySaveIntent;
		this.model=model;
		this.engineGeneration=0;
		this.statusSeq=0;
		this.renderedRevision=null;
		this.tail=Promise.resolve();
		this.engineSuspect=false;
		this.listeners=new Set();
		this.statusListeners=new Set();
		this.closePromise=null;
	}

	setPhase(phase) {
		if (this.phase===phase) return;
		this.phase=phase;
		this.statusSeq+=1;
		for (const listener of this.statusListeners) {
			try {
				listener(this.info());
			} catch {
				// A view cannot interrupt a document transition.
			}
		}
	}

	/** @returns {{session_id:string,original_path:string,revision:number,checkpoint_id:string,
	 * dirty:boolean,phase:string,status_seq:number,rendered_revision:number|null,recovery?:object}} */
	info() {
		const info={
			session_id:this.source.session_id,
			original_path:this.source.original_path,
			revision:this.index.revision,
			checkpoint_id:currentCheckpoint(this.index),
			dirty:currentCheckpoint(this.index)!==this.index.saved_id,
			phase:this.phase,
			status_seq:this.statusSeq,
			rendered_revision:this.renderedRevision,
		};
		if (this.recovery) info.recovery={...this.recovery};
		return info;
	}

	/** @template T @param {()=>Promise<T>} fn @returns {Promise<T>} */
	runExclusive(fn) {
		const operation=this.tail.then(fn);
		this.tail=operation.then(()=>undefined,()=>undefined);
		return operation;
	}

	assertExpected(sessionId,baseRevision) {
		if (sessionId!==this.source.session_id) {
			throw documentError('SESSION_MISMATCH','Request belongs to another document session');
		}
		if (!Number.isSafeInteger(baseRevision)||baseRevision!==this.index.revision) {
			throw documentError('REVISION_CONFLICT','Request revision is no longer current',{
				expected:this.index.revision,
				received:baseRevision,
			});
		}
	}

	assertReadable() {
		if (this.phase==='blocked') throw documentError('DOCUMENT_BLOCKED','Document cannot be restored');
		if (this.phase==='closing'||this.phase==='closed') {
			throw documentError('DOCUMENT_CLOSED','Document session is closed');
		}
	}

	assertQueryable() {
		this.assertReadable();
		if (this.phase==='recovering') {
			throw documentError('RECOVERY_REQUIRED','Recovery must be resolved before reading document state');
		}
	}

	assertMutable() {
		this.assertQueryable();
		if (this.phase!=='ready') throw documentError('DOCUMENT_BUSY','Document is not ready for editing');
	}

	async notifyCommit() {
		const info=this.info();
		for (const listener of this.listeners) {
			try {
				listener(info);
			} catch {
				// A notification observer cannot roll back or reject a durable commit.
			}
		}
	}

	async replaceEngineFromWorking() {
		this.engineGeneration+=1;
		const previous=this.engine;
		await previous?.close();
		let replacement;
		try {
			replacement=await startEngine({
				argv:this.cliArgv,
				input:this.source.working_path,
				output:this.source.working_path,
				timeout_ms:120000,
			});
			const model=await readEngineModel(replacement);
			this.engine=replacement;
			this.model=model;
			this.engineSuspect=false;
		} catch (error) {
			await replacement?.close();
			throw error;
		}
	}

	async restoreConfirmed(bytes) {
		this.setPhase('restoring');
		try {
			await this.source.restore(bytes);
			await this.replaceEngineFromWorking();
			this.setPhase('ready');
		} catch (error) {
			this.setPhase('blocked');
			throw error;
		}
	}

	/**
	 * Apply one structured atomic batch against an expected confirmed revision.
	 * @param {{session_id:string,base_revision:number,operations:unknown}} request
	 * @param {(()=>boolean)|undefined} [isCurrent] Internal view-lifetime fence, checked inside the document queue.
	 * @returns {Promise<{revision:number,checkpoint_id:string,created:object[],warnings:string[]}>}
	 */
	applyChanges(request,isCurrent) {
		if (!request||typeof request!=='object') {
			return Promise.reject(documentError('OPERATIONS_INVALID','Request must be an object'));
		}
		let body;
		try {
			body=compileOperations(request.operations);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.runExclusive(async()=>{
			this.assertMutable();
			this.assertExpected(request.session_id,request.base_revision);
			if (isCurrent&&!isCurrent()) throw documentError('VIEW_STALE','The view closed before its edits were applied');
			const previousBytes=await this.store.read(currentCheckpoint(this.index));
			if (this.engineSuspect) {
				try {
					await this.restoreConfirmed(previousBytes);
				} catch (restoreError) {
					throw documentError('DOCUMENT_BLOCKED','The confirmed checkpoint could not be restored before editing',{
						restore:restoreError,
					});
				}
			}
			if (isCurrent&&!isCurrent()) throw documentError('VIEW_STALE','The view closed before its edits were applied');
			this.setPhase('applying');
			try {
				const reply=await this.engine.exec(body);
				if (!reply.value||!Array.isArray(reply.value.created)) {
					throw documentError('ENGINE_PROTOCOL','Engine returned invalid operation results');
				}
				this.setPhase('checkpointing');
				await this.engine.save();
				const bytes=await readFile(this.source.working_path);
				assertDocumentSize(bytes);
				const checkpoint=await this.store.put(bytes);
				if (checkpoint.id===currentCheckpoint(this.index)) {
					this.setPhase('ready');
					return {
						revision:this.index.revision,
						checkpoint_id:checkpoint.id,
						created:reply.value.created,
						warnings:reply.warnings,
					};
				}
				const next=appendHistory(this.index,checkpoint);
				this.index=await this.store.publish(next);
				this.setPhase('ready');
				const result={
					revision:this.index.revision,
					checkpoint_id:currentCheckpoint(this.index),
					created:reply.value.created,
					warnings:reply.warnings,
				};
				await this.notifyCommit();
				return result;
			} catch (error) {
				try {
					await this.restoreConfirmed(previousBytes);
				} catch (restoreError) {
					throw documentError('DOCUMENT_BLOCKED','The last confirmed checkpoint could not be restored',{
						cause:error,
						restore:restoreError,
					});
				}
				if (error?.code==='ENGINE_REJECTED') throw documentError('OPERATIONS_REJECTED',refusalReason(error));
				throw error;
			}
		});
	}

	/** @param {'undo'|'redo'} direction @param {{session_id:string,base_revision:number}} request */
	moveHistory(direction,request) {
		return this.runExclusive(async()=>{
			this.assertMutable();
			this.assertExpected(request?.session_id,request?.base_revision);
			const target=seekHistory(this.index,direction);
			if (target.cursor===this.index.cursor) {
				throw documentError('HISTORY_UNAVAILABLE',`No ${direction} checkpoint is available`);
			}
			const previousBytes=await this.store.read(currentCheckpoint(this.index));
			const targetBytes=await this.store.read(currentCheckpoint(target));
			this.setPhase('restoring');
			try {
				await this.source.restore(targetBytes);
				await this.replaceEngineFromWorking();
				const next={...target,revision:this.index.revision+1};
				this.index=await this.store.publish(next);
				this.setPhase('ready');
				await this.notifyCommit();
				return {revision:this.index.revision,checkpoint_id:currentCheckpoint(this.index)};
			} catch (error) {
				try {
					await this.restoreConfirmed(previousBytes);
				} catch (restoreError) {
					throw documentError('DOCUMENT_BLOCKED','The last confirmed checkpoint could not be restored',{
						cause:error,
						restore:restoreError,
					});
				}
				throw error;
			}
		});
	}

	/** @param {{session_id:string,base_revision:number}} request */
	undo(request) {
		return this.moveHistory('undo',request);
	}

	/** @param {{session_id:string,base_revision:number}} request */
	redo(request) {
		return this.moveHistory('redo',request);
	}

	/**
	 * Drops every change made since the last save, so that closing leaves no recovery behind. The history keeps only the
	 * saved checkpoint; the engine is rebuilt from it before the next edit.
	 * @param {{session_id:string,base_revision:number}} request
	 * @returns {Promise<{discarded:boolean,revision:number}>}
	 */
	discardUnsaved(request) {
		return this.runExclusive(async()=>{
			this.assertMutable();
			this.assertExpected(request?.session_id,request?.base_revision);
			const saved=this.index.saved_id;
			if (currentCheckpoint(this.index)===saved) return {discarded:false,revision:this.index.revision};
			this.index=await this.store.publish({
				...this.index,snapshots:[saved],cursor:0,revision:this.index.revision+1,sizes:{[saved]:this.index.sizes[saved]},
			});
			this.engineSuspect=true;
			await this.notifyCommit();
			return {discarded:true,revision:this.index.revision};
		});
	}

	/** @param {'recover'|'discard'|'copy'} choice */
	resolveRecovery(choice) {
		return this.runExclusive(async()=>{
			if (choice!=='recover'&&choice!=='discard'&&choice!=='copy') {
				throw documentError('RECOVERY_CHOICE_INVALID','Recovery choice is not supported');
			}
			this.assertReadable();
			if (this.phase!=='recovering'||!this.recovery) {
				throw documentError('RECOVERY_NOT_REQUIRED','This document has no pending recovery');
			}
			if (this.recovery.save_conflict&&choice!=='copy') {
				throw documentError('RECOVERY_CHOICE_INVALID','Save conflict requires a recovery copy',{
					valid_choices:['copy'],
				});
			}
			if (choice==='copy'&&this.recovery.source_matches!==false&&!this.recovery.save_conflict) {
				throw documentError('RECOVERY_CHOICE_INVALID','A recovery copy is only available for an external conflict');
			}
			const confirmedBytes=await this.store.read(currentCheckpoint(this.index));
			if (choice!=='copy') await this.source.assertDiskBase();
			let recoveryCopy;
			if (choice==='copy') {
				recoveryCopy=await createRecoveryCopy({
					bytes:confirmedBytes,
					original:this.source.original_path,
					checkpoint_id:currentCheckpoint(this.index),
				});
			}
			if (choice==='recover'||choice==='copy') {
				try {
					this.setPhase('restoring');
					await this.source.restore(confirmedBytes);
					await this.replaceEngineFromWorking();
					let candidate;
					let leftovers=[];
					const externalBackup=choice==='copy'&&this.recoverySaveIntent
						?this.recoverySaveIntent.backup_path
						:undefined;
					if (this.recoverySaveIntent&&choice==='copy') {
						await removeSaveIntent(this.store.dir);
						const cleanup=await removeCandidate(this.recoverySaveIntent);
						leftovers=cleanup.leftovers;
						if (leftovers.includes(this.recoverySaveIntent.candidate_path)) {
							candidate=this.recoverySaveIntent.candidate_path;
						}
						this.recoverySaveIntent=undefined;
					}
					this.recovery=undefined;
					this.recoverySourceBytes=undefined;
					this.setPhase('ready');
					return {
						...this.info(),
						...(recoveryCopy?{recovery_copy:recoveryCopy.path}:{}),
						...(externalBackup?{external_backup:externalBackup}:{}),
						...(candidate?{candidate}:{}),
						...(leftovers.length?{leftovers}:{}),
					};
				} catch (error) {
					this.setPhase('blocked');
					throw error;
				}
			}

			const sourceBytes=this.recoverySourceBytes;
			assertDocumentSize(sourceBytes);
			const checkpoint=await this.store.put(sourceBytes);
			const next={
				...this.index,
				source:{fingerprint:this.source.source_fingerprint},
				snapshots:[checkpoint.id],
				cursor:0,
				revision:this.index.revision+1,
				sizes:{...this.index.sizes,[checkpoint.id]:checkpoint.bytes},
			};
			try {
				this.setPhase('restoring');
				await this.source.restore(sourceBytes);
				await this.replaceEngineFromWorking();
				this.index=await this.store.publish(next);
				this.recovery=undefined;
				this.recoverySourceBytes=undefined;
				this.setPhase('ready');
				await this.notifyCommit();
				return this.info();
			} catch (error) {
				try {
					await this.source.restore(confirmedBytes);
					await this.replaceEngineFromWorking();
					this.setPhase('recovering');
				} catch (restoreError) {
					this.setPhase('blocked');
					throw documentError('DOCUMENT_BLOCKED','The recovered checkpoint could not be restored',{
						cause:error,
						restore:restoreError,
					});
				}
				throw error;
			}
		});
	}

	/**
	 * Serialize query/export access against one confirmed revision. The callback receives a
	 * temporary facade. Verification compares the final serialized engine state to the current checkpoint.
	 * Exec mutations reverted to identical bytes are equivalent; nonserialized engine state is outside the document contract.
	 * @template T
	 * @param {number} expectedRevision
	 * @param {(engine:Readonly<{exec:(body:string,options?:{kind:'mutate'|'read'|'measure'})=>Promise<{value:any,warnings:string[]}>,
	 * schema:()=>Promise<string>}>)=>Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	withEngine(expectedRevision,fn) {
		if (typeof fn!=='function') {
			return Promise.reject(documentError('DOCUMENT_CALLBACK_INVALID','Engine callback must be a function'));
		}
		return this.runExclusive(async()=>{
			this.assertQueryable();
			if (!Number.isSafeInteger(expectedRevision)||expectedRevision!==this.index.revision) {
				throw documentError('REVISION_CONFLICT','Requested engine revision is no longer current');
			}
			const access=createEngineFacade(this.engine);
			try {
				return await fn(access.facade);
			} finally {
				await access.expire();
				if (access.didExec()) {
					try {
						await this.engine.save();
						const [workingBytes,checkpointBytes]=await Promise.all([
							readFile(this.source.working_path),
							this.store.read(currentCheckpoint(this.index)),
						]);
						this.engineSuspect=!workingBytes.equals(checkpointBytes);
					} catch {
						this.engineSuspect=true;
					}
				}
			}
		});
	}

	/** @param {string} path @returns {Promise<any|null>} */
	readNode(path) {
		return this.runExclusive(async()=>{
			this.assertQueryable();
			return readEngineNode(this.engine,path);
		});
	}

	/** @returns {Promise<{roots:any[],rows:any[],variables:object}>} */
	readModel() {
		return this.runExclusive(async()=>{
			this.assertQueryable();
			return readEngineModel(this.engine);
		});
	}

	/** @param {(info:ReturnType<DocumentSession['info']>)=>void} fn @returns {()=>void} */
	onCommit(fn) {
		if (typeof fn!=='function') throw documentError('DOCUMENT_CALLBACK_INVALID','Commit listener must be a function');
		this.listeners.add(fn);
		return ()=>this.listeners.delete(fn);
	}

	/** Observe accepted work without waiting for an engine read or a durable commit. */
	onStatus(fn) {
		if (typeof fn!=='function') throw documentError('DOCUMENT_CALLBACK_INVALID','Status listener must be a function');
		this.statusListeners.add(fn);
		return ()=>this.statusListeners.delete(fn);
	}

	/** @returns {Promise<void>} */
	close() {
		if (this.closePromise) return this.closePromise;
		this.closePromise=this.runExclusive(async()=>{
			if (this.phase==='closed') return;
			this.setPhase('closing');
			try {
				await this.engine?.close();
				// Only after the engine exited cleanly: the confirmed checkpoints are the recovery material, not this file.
				await this.source.discardWorking();
			} finally {
				await this.source.release();
				this.setPhase('closed');
			}
		});
		return this.closePromise;
	}

	/**
	 * Publish only the current confirmed checkpoint to the original file.
	 * @param {{session_id:string,base_revision:number}} request
	 */
	saveOriginal(request) {
		return this.runExclusive(async()=>{
			this.assertMutable();
			assertSaveRequest(request);
			this.assertExpected(request.session_id,request.base_revision);
			const checkpointId=currentCheckpoint(this.index);
			if (checkpointId===this.index.saved_id) {
				return {saved:false,checkpoint_id:checkpointId};
			}
			const checkpoint=await this.store.read(checkpointId);
			assertDocumentSize(checkpoint);
			let intent;
			try {
				intent=await prepareSave({
					bytes:checkpoint,
					original:this.source.original_path,
					session_id:this.source.session_id,
					expected_hash:this.source.source_fingerprint,
					checkpoint_id:checkpointId,
				});
				await this.source.assertDiskBase();
				await writeSaveIntent(this.store.dir,intent);
			} catch (error) {
				if (intent) {
					try {
						const cleanup=await removeCandidate(intent);
						if (cleanup.leftovers.length) {
							error.details={...(error.details??{}),leftovers:cleanup.leftovers};
						}
					} catch (cleanupError) {
						error.details={...(error.details??{}),cleanup_error:cleanupError};
					}
				}
				throw error;
			}

			this.setPhase('saving');
			let finalPhase='ready';
			try {
				let outcome;
				try {
					outcome=await publishWindows({
						candidate:intent.candidate_path,
						original:intent.original_path,
						backup:intent.backup_path,
						expected_hash:intent.expected_hash,
					});
				} catch (error) {
					finalPhase='blocked';
					let preservationError;
					try {
						const preserved=await preserveCandidate(intent,checkpoint);
						intent=preserved.intent;
						await writeSaveIntent(this.store.dir,{...intent,uncertain:true},{replace:true});
					} catch (failure) {
						preservationError=failure;
					}
					throw documentError('SAVE_UNCERTAIN','Save helper failed without a confirmed outcome',{
						cause:error,
						...(preservationError?{preservation_error:preservationError}:{}),
					});
				}

				if (outcome.published===false) {
					const cleanup=await Promise.allSettled([
						removeSaveIntent(this.store.dir),
						removeCandidate(intent),
					]);
					const candidateCleanup=cleanup[1].status==='fulfilled'
						?cleanup[1].value
						:{leftovers:[]};
					const code=typeof outcome.error?.code==='string'?outcome.error.code:'SAVE_FAILED';
					throw documentError(code,'The original was not published',{
						outcome,
						leftovers:[...(outcome.leftovers??[]),...candidateCleanup.leftovers],
						cleanup_errors:cleanup.filter(result=>result.status==='rejected').map(result=>result.reason),
					});
				}

				if (outcome.published===null) {
					finalPhase='blocked';
					const indexBefore=this.index;
					let reconciliation;
					let reconciliationError;
					try {
						try {
							await this.source.acceptPublished(intent.candidate_hash);
						} catch (candidateError) {
							try {
								await this.source.assertDiskBase();
							} catch (baseError) {
								throw documentError('SAVE_UNCERTAIN','Neither the candidate nor the previous source hash matches',{
									candidate_error:candidateError,
									base_error:baseError,
								});
							}
						}
						reconciliation=await reconcileSaveIntent({
							source:this.source,
							store:this.store,
							index:indexBefore,
						});
					} catch (error) {
						reconciliationError=error;
					}
					if (reconciliation&&!reconciliation.recovery) {
						this.index=reconciliation.index;
						finalPhase='ready';
						const leftovers=[
							...(outcome.leftovers??[]),
							...(reconciliation.leftovers??[]),
						];
						if (this.index.saved_id!==indexBefore.saved_id) {
							return {
								saved:true,
								revision:this.index.revision,
								checkpoint_id:this.index.saved_id,
								backup_path:this.index.save_backup?.path,
								recognized:true,
								...(leftovers.length?{leftovers:[...new Set(leftovers)]}:{}),
							};
						}
						throw documentError('SAVE_UNCERTAIN','The Save was not performed; the original is intact and may be retried',{
							outcome,
							published:false,
							original_intact:true,
							retryable:true,
							leftovers:[...new Set(leftovers)],
						});
					}
					if (reconciliation?.recovery) {
						throw documentError('SAVE_UNCERTAIN','The publication result requires explicit recovery',{
							outcome,
							recovery:reconciliation.recovery,
						});
					}
					let preservationError;
					try {
						const preserved=await preserveCandidate(intent,checkpoint);
						intent=preserved.intent;
						await writeSaveIntent(this.store.dir,{...intent,uncertain:true},{replace:true});
					} catch (error) {
						preservationError=error;
					}
					throw documentError('SAVE_UNCERTAIN','The publication result is uncertain',{
						outcome,
						...(reconciliationError?{reconciliation_error:reconciliationError}:{}),
						...(preservationError?{preservation_error:preservationError}:{}),
					});
				}

				let preserveResult;
				try {
					preserveResult=await preserveCandidate({
						...intent,
						backup_identity:outcome.backup_identity,
					},checkpoint);
					intent={
						...preserveResult.intent,
						published:true,
						source_hash:outcome.source_hash,
						replaced_hash:outcome.replaced_hash,
						conflict:outcome.conflict===true,
					};
					await writeSaveIntent(this.store.dir,intent,{replace:true});
				} catch (error) {
					finalPhase='blocked';
					throw documentError('SAVE_UNCERTAIN','Published bytes could not be recorded safely',{cause:error});
				}
				if (intent.conflict
					||outcome.source_hash!==checkpointId
					||outcome.replaced_hash!==intent.expected_hash) {
					finalPhase='blocked';
					throw documentError('SAVE_CONFLICT','Another writer changed the original during publication',{outcome});
				}

				const previousIndex=this.index;
				let publishedIndex;
				try {
					publishedIndex=await this.store.publish({
						...this.index,
						saved_id:checkpointId,
						source:{fingerprint:outcome.source_hash},
						save_backup:{
							path:intent.backup_path,
							owner_session_id:this.source.session_id,
							identity:intent.backup_identity,
						},
					});
				} catch (error) {
					finalPhase='blocked';
					throw documentError('SAVE_UNCERTAIN','The original was published but the Save index was not confirmed',{
						cause:error,
						source_hash:outcome.source_hash,
					});
				}
				try {
					await this.source.acceptPublished(outcome.source_hash);
				} catch (error) {
					finalPhase='blocked';
					throw documentError('SAVE_UNCERTAIN','The published original changed before confirmation',{cause:error});
				}
				this.index=publishedIndex;

				const cleanup=await Promise.allSettled([
					removeSaveIntent(this.store.dir),
					removeCandidate(intent),
					removePreviousBackup(
						previousIndex,
						this.source.session_id,
						intent.backup_path,
						this.source.original_path,
					),
				]);
				const cleanupError=cleanup.find(result=>result.status==='rejected');
				if (cleanupError?.status==='rejected') throw cleanupError.reason;
				const leftovers=[
					...(outcome.leftovers??[]),
					...preserveResult.leftovers,
					...cleanup[1].value.leftovers,
					...cleanup[2].value.leftovers,
				];
				return {
					saved:true,
					revision:this.index.revision,
					checkpoint_id:checkpointId,
					backup_path:intent.backup_path,
					...(leftovers.length?{leftovers:[...new Set(leftovers)]}:{}),
				};
			} finally {
				this.setPhase(finalPhase);
			}
		});
	}

	/** @param {{session_id:string,base_revision:number}} request */
	saveRecoveryCopy(request) {
		return this.runExclusive(async()=>{
			this.assertReadable();
			this.assertExpected(request?.session_id,request?.base_revision);
			if (this.phase!=='ready'&&this.phase!=='recovering') {
				throw documentError('DOCUMENT_BUSY','Document is not ready to create a recovery copy');
			}
			const checkpointId=currentCheckpoint(this.index);
			const bytes=await this.store.read(checkpointId);
			assertDocumentSize(bytes);
			return createRecoveryCopy({
				bytes,
				original:this.source.original_path,
				checkpoint_id:checkpointId,
			});
		});
	}
}

/**
 * Open one document engine over its exclusive working source.
 * @param {{source:any,store:any,cli_argv:string[],recovery:'prompt'}} options
 * @returns {Promise<DocumentSession>}
 */
export async function openDocument({source,store,cli_argv:cliArgv,recovery}) {
	assertSource(source);
	assertStore(store);
	assertCliArgv(cliArgv);
	if (recovery!=='prompt') {
		throw documentError('DOCUMENT_OPTIONS_INVALID','Only prompt recovery is available');
	}
	let engine;
	try {
		const sourceBytes=await readFile(source.working_path);
		assertDocumentSize(sourceBytes);
		let index=await store.load();
		let phase='ready';
		let recoveryInfo;
		let recoverySaveIntent;
		let model=null;
		if (index) {
			const reconciliation=await reconcileSaveIntent({source,store,index});
			index=reconciliation.index;
			recoverySaveIntent=reconciliation.intent;
			const checkpointBytes=await store.read(currentCheckpoint(index));
			assertDocumentSize(checkpointBytes);
			await source.restore(checkpointBytes);
			engine=await startEngine({
				argv:cliArgv,
				input:source.working_path,
				output:source.working_path,
				timeout_ms:120000,
			});
			model=await readEngineModel(engine);
			// Nothing unsaved and the original is still the saved bytes: there is nothing to decide. The history is kept
			// (spec: private history is restored for the next session, the 50-step/200 MiB policy still prunes it).
			const nothingToRecover=!reconciliation.recovery&&!reconciliation.intent
				&&currentCheckpoint(index)===index.saved_id&&index.source.fingerprint===source.source_fingerprint;
			if (!nothingToRecover) {
				index=await store.publish({...index,revision:index.revision+1});
				phase='recovering';
				recoveryInfo={
					source_matches:index.source.fingerprint===source.source_fingerprint,
					// Only an adopted orphan lock means the previous owner never closed.
					previous_owner_lost:source.adopted_orphan===true,
					...(reconciliation.recovery??{}),
				};
			}
		} else {
			engine=await startEngine({
				argv:cliArgv,
				input:source.working_path,
				output:source.working_path,
				timeout_ms:120000,
			});
			await engine.save();
			const normalized=await readFile(source.working_path);
			assertDocumentSize(normalized);
			const checkpoint=await store.put(normalized);
			index=await store.publish(initialIndex(source,checkpoint));
		}
		return new DocumentSession({
			source,
			store,
			cliArgv,
			engine,
			index,
			phase,
			recovery:recoveryInfo,
			recoverySourceBytes:recoveryInfo?sourceBytes:undefined,
			recoverySaveIntent,
			model,
		});
	} catch (error) {
		// The working copy is ours alone; drop it only once the engine that may hold it has exited. Cleanup is
		// best-effort: its failure (EBUSY/EPERM) must never replace the error that stopped the open.
		const cleanup=[];
		try {
			await engine?.close();
			await source.discardWorking();
		} catch (cleanupError) {
			cleanup.push(cleanupError);
		}
		try {
			await source.release();
		} catch (cleanupError) {
			cleanup.push(cleanupError);
		}
		if (cleanup.length>0&&error&&typeof error==='object'&&Object.isExtensible(error)) {
			Object.defineProperty(error,'cleanup_failures',{value:cleanup,configurable:true});
		}
		throw error;
	}
}
