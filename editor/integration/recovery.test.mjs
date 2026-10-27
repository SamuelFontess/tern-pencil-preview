import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {openDocument} from '../src/document.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';
import {withEngine,expected,makeEngineFixture,testCliArgv} from './fixtures.mjs';
import {withTemp} from '../tests/helpers.mjs';

async function openRecovered({fixture,dataDir,historyDir,adoptOrphan}) {
	const source=await claimSource({
		original_path:fixture.original,
		data_dir:dataDir,
		session_id:randomUUID(),
		adopt_orphan:adoptOrphan,
	});
	const store=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
	try {
		return {source,store,doc:await openDocument({source,store,cli_argv:fixture.argv,recovery:'prompt'})};
	} catch (error) {
		await source.release();
		throw error;
	}
}

async function adoptRecovered(options) {
	let recovery;
	await assert.rejects(
		claimSource({
			original_path:options.fixture.original,
			data_dir:options.dataDir,
			session_id:randomUUID(),
		}),
		error=>{
			recovery=error.details?.recovery;
			return error.code==='RECOVERY_REQUIRED'&&typeof recovery?.session_id==='string';
		},
	);
	return openRecovered({...options,adoptOrphan:recovery.session_id});
}

async function createRecoveryFixture(dir) {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const historyDir=join(dataDir,'history');
	const source=await claimSource({
		original_path:fixture.original,
		data_dir:dataDir,
		session_id:randomUUID(),
	});
	const store=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
	const doc=await openDocument({source,store,cli_argv:fixture.argv,recovery:'prompt'});
	return {fixture,dataDir,historyDir,source,store,doc};
}

test('recuperação recusa consultas até recover e preserva o original externo', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
			{op:'update',path:setup.fixture.ids.text,props:{content:'Local recuperado'}},
		]});
		await setup.doc.close();

		await withEngine({argv:setup.fixture.argv,input:setup.fixture.original,output:setup.fixture.original,timeout_ms:120000},async engine => {
			await engine.exec(`Update(${JSON.stringify(setup.fixture.ids.text)},{content:'Externo'});return true;`);
			await engine.save();
		});
		const externalBytes=await readFile(setup.fixture.original);
		const reopeningStarted=performance.now();
		const reopened=await openRecovered(setup);
		const reopeningLatency=performance.now()-reopeningStarted;
		console.log(`NE-5 recovery reopen latency: ${reopeningLatency.toFixed(1)}ms`);
		try {
			assert.equal(reopened.doc.info().phase,'recovering');
			assert.equal(reopened.doc.info().recovery.source_matches,false);
			await assert.rejects(reopened.doc.readNode(setup.fixture.ids.text),error=>error.code==='RECOVERY_REQUIRED');
			await assert.rejects(reopened.doc.readModel(),error=>error.code==='RECOVERY_REQUIRED');
			await assert.rejects(reopened.doc.withEngine(reopened.doc.info().revision,async()=>null),error=>error.code==='RECOVERY_REQUIRED');
			await assert.rejects(reopened.doc.undo(expected(reopened.doc.info())),error=>error.code==='RECOVERY_REQUIRED');

			await reopened.doc.resolveRecovery('recover');
			assert.equal(reopened.doc.info().phase,'ready');
			assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Local recuperado');
			assert.deepEqual(await readFile(setup.fixture.original),externalBytes);
		} finally {
			await reopened.doc.close();
		}
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

test('discard usa o original atual como nova base e preserva saved_id', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		const savedId=setup.doc.info().checkpoint_id;
		await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
			{op:'update',path:setup.fixture.ids.text,props:{content:'Local'}},
		]});
		await setup.doc.close();

		await withEngine({argv:setup.fixture.argv,input:setup.fixture.original,output:setup.fixture.original,timeout_ms:120000},async engine => {
			await engine.exec(`Update(${JSON.stringify(setup.fixture.ids.text)},{content:'Externo'});return true;`);
			await engine.save();
		});
		const reopened=await openRecovered(setup);
		try {
			const reopeningRevision=reopened.doc.info().revision;
			await reopened.doc.resolveRecovery('discard');
			assert.equal(reopened.doc.info().phase,'ready');
			assert.ok(reopened.doc.info().revision>reopeningRevision);
			assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Externo');
			assert.equal((await reopened.store.load()).saved_id,savedId);
		} finally {
			await reopened.doc.close();
		}
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

test('checkpoint corrompido não é restaurado como estado confirmado', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		const checkpoint=setup.doc.info().checkpoint_id;
		await setup.doc.close();
		const original=await readFile(setup.fixture.original);
		const checkpointPath=join(setup.historyDir,`${checkpoint}.checkpoint`);
		const checkpointBytes=await readFile(checkpointPath);
		await writeFile(checkpointPath,Buffer.alloc(checkpointBytes.length,0));

		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		try {
			await assert.rejects(
				openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'}),
				error=>error.code==='CHECKPOINT_CORRUPT',
			);
			// The failed open discards its own working copy; the original and the history stay as they were.
			await assert.rejects(readFile(source.working_path),error=>error.code==='ENOENT');
			assert.deepEqual(await readFile(setup.fixture.original),original);
		} finally {
			await source.release();
		}
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

async function waitForLine(child,line) {
	return new Promise((resolve,reject)=>{
		let output='';
		let errors='';
		function cleanup() {
			child.stdout.off('data',onOutput);
			child.stderr.off('data',onError);
			child.off('close',onClose);
			child.off('error',onChildError);
		}
		function onOutput(chunk) {
			output+=chunk;
			if (output.includes(`${line}\n`)) {
				cleanup();
				resolve();
			}
		}
		function onError(chunk) {
			errors+=chunk;
		}
		function onClose(code,signal) {
			cleanup();
			reject(Error(`Child exited before ${line}: code=${code} signal=${signal} stdout=${output} stderr=${errors}`));
		}
		function onChildError(error) {
			cleanup();
			reject(error);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data',onOutput);
		child.stderr.on('data',onError);
		child.once('close',onClose);
		child.once('error',onChildError);
	});
}

async function runInterruptedOwner({fixture,dataDir,historyDir,mode}) {
	const documentUrl=new URL('../src/document.mjs',import.meta.url).href;
	const sourceUrl=new URL('../src/source.mjs',import.meta.url).href;
	const storeUrl=new URL('../src/store.mjs',import.meta.url).href;
	const childSource=`
		import {randomUUID} from 'node:crypto';
		import {openDocument} from ${JSON.stringify(documentUrl)};
		import {claimSource} from ${JSON.stringify(sourceUrl)};
		import {openStore} from ${JSON.stringify(storeUrl)};
		const config=JSON.parse(process.env.NE5_CHILD_CONFIG);
		const source=await claimSource({original_path:config.original,data_dir:config.dataDir,session_id:randomUUID()});
		const store=await openStore({dir:config.historyDir,max_steps:50,max_bytes:200*1024*1024});
		const doc=await openDocument({source,store,cli_argv:config.argv,recovery:'prompt'});
		if (doc.info().phase==='recovering') await doc.resolveRecovery('recover');
		process.stdout.write('ready\\n');
		process.stdout.write('applying\\n');
		await doc.applyChanges({session_id:doc.info().session_id,base_revision:doc.info().revision,operations:[{op:'update',path:config.path,props:{content:'Child confirmed'}}]});
		process.stdout.write('checkpoint\\n');
		await new Promise(()=>{});
	`;
	const child=spawn(process.execPath,['--input-type=module','--eval',childSource],{
		env:{...process.env,NE5_CHILD_CONFIG:JSON.stringify({
			original:fixture.original,dataDir,historyDir,argv:testCliArgv(),path:fixture.ids.text,
		})},
		stdio:['ignore','pipe','pipe'],
	});
	try {
		await waitForLine(child,mode==='unrecognized'?'applying':'checkpoint');
		const closed=once(child,'close');
		child.kill('SIGKILL');
		await closed;
	} finally {
		if (!child.killed) child.kill('SIGKILL');
	}
}

test('índice corrompido falha sem apagar o checkpoint recuperável', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		const checkpoint=setup.doc.info().checkpoint_id;
		const checkpointPath=join(setup.historyDir,`${checkpoint}.checkpoint`);
		const material=await readFile(checkpointPath);
		await setup.doc.close();
		await writeFile(join(setup.historyDir,'index.json'),'{incompleto');

		await assert.rejects(
			openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024}),
			error=>error.code==='INDEX_INVALID',
		);
		assert.deepEqual(await readFile(checkpointPath),material);
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

test('processo interrompido recupera somente o último checkpoint confirmado', {timeout:120000}, async () => withTemp(async dir => {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const historyDir=join(dataDir,'history');

	await runInterruptedOwner({fixture,dataDir,historyDir,mode:'unrecognized'});
	let reopened=await adoptRecovered({fixture,dataDir,historyDir});
	try {
		// Nothing was confirmed before the interruption, so there is nothing to recover.
		assert.equal(reopened.doc.info().phase,'ready');
		assert.equal((await reopened.doc.readNode(fixture.ids.text)).content,fixture.ids.originalText);
	} finally {
		await reopened.doc.close();
	}

	await runInterruptedOwner({fixture,dataDir,historyDir,mode:'recognized'});
	reopened=await adoptRecovered({fixture,dataDir,historyDir});
	try {
		await reopened.doc.resolveRecovery('recover');
		assert.equal((await reopened.doc.readNode(fixture.ids.text)).content,'Child confirmed');
	} finally {
		await reopened.doc.close();
	}
}));



test('falha ao iniciar engine de recuperação não publica revisão nem mantém a fonte bloqueada', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		await setup.doc.close();
		const before=await setup.store.load();
		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		try {
			await assert.rejects(openDocument({
				source,
				store,
				cli_argv:['definitely-not-a-pen-cli'],
				recovery:'prompt',
			}));
			assert.equal((await store.load()).revision,before.revision);
			const next=await claimSource({
				original_path:setup.fixture.original,
				data_dir:setup.dataDir,
				session_id:randomUUID(),
			});
			await next.release();
		} finally {
			await source.release();
		}
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

test('uma restauração posterior funciona depois de falha transitória ao recriar engine', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	try {
		const checkpoint=await setup.store.read(setup.doc.info().checkpoint_id);
		const argv=setup.doc.cliArgv;
		setup.doc.cliArgv=['definitely-not-a-pen-cli'];
		await assert.rejects(setup.doc.restoreConfirmed(checkpoint));
		setup.doc.cliArgv=argv;
		await setup.doc.restoreConfirmed(checkpoint);
		assert.equal(setup.doc.info().phase,'ready');
		assert.equal((await setup.doc.readNode(setup.fixture.ids.text)).content,setup.fixture.ids.originalText);
	} finally {
		if (setup.doc.info().phase!=='closed') await setup.doc.close();
	}
}));

test('reabrir após salvar e fechar limpo abre pronto, sem recuperação, e mantém o histórico', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
		{op:'update',path:setup.fixture.ids.text,props:{content:'Salvo'}},
	]});
	await setup.doc.saveOriginal(expected(setup.doc.info()));
	await setup.doc.close();
	const savedBytes=await readFile(setup.fixture.original);
	const reopened=await openRecovered(setup);
	try {
		const info=reopened.doc.info();
		assert.equal(info.phase,'ready');
		assert.equal(info.recovery,undefined);
		assert.equal(info.dirty,false);
		assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Salvo');
		await reopened.doc.undo(expected(info));
		assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,setup.fixture.ids.originalText);
		assert.deepEqual(await readFile(setup.fixture.original),savedBytes);
	} finally {
		await reopened.doc.close();
	}
}));

test('reabrir um documento aberto e fechado sem edição também abre pronto', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	await setup.doc.close();
	const reopened=await openRecovered(setup);
	try {
		assert.equal(reopened.doc.info().phase,'ready');
		assert.equal(reopened.doc.info().recovery,undefined);
	} finally {
		await reopened.doc.close();
	}
}));

test('fechar limpo com edição não salva oferece recover/discard como mudanças não salvas, não como queda', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
		{op:'update',path:setup.fixture.ids.text,props:{content:'Não salvo'}},
	]});
	await setup.doc.close();
	const reopened=await openRecovered(setup);
	try {
		const info=reopened.doc.info();
		assert.equal(info.phase,'recovering');
		assert.equal(info.recovery.source_matches,true);
		assert.equal(info.recovery.previous_owner_lost,false);
		await reopened.doc.resolveRecovery('recover');
		assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Não salvo');
		assert.equal(reopened.doc.info().dirty,true);
	} finally {
		await reopened.doc.close();
	}
}));

test('um dono perdido adotado continua descrito como queda quando há edição não salva', {timeout:120000}, async () => withTemp(async dir => {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const historyDir=join(dataDir,'history');
	await runInterruptedOwner({fixture,dataDir,historyDir,mode:'recognized'});
	const reopened=await adoptRecovered({fixture,dataDir,historyDir});
	try {
		assert.equal(reopened.doc.info().phase,'recovering');
		assert.equal(reopened.doc.info().recovery.previous_owner_lost,true);
	} finally {
		await reopened.doc.close();
	}
}));

async function rewriteExternally(setup,content) {
	await withEngine({argv:setup.fixture.argv,input:setup.fixture.original,output:setup.fixture.original,timeout_ms:120000},async engine => {
		await engine.exec(`Update(${JSON.stringify(setup.fixture.ids.text)},{content:${JSON.stringify(content)}});return true;`);
		await engine.save();
	});
}

test('um original reescrito por fora depois de fechar sem edição não abre pronto: recovering e discard mostra o externo', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	await setup.doc.close();
	await rewriteExternally(setup,'Externo sem edição');
	const reopened=await openRecovered(setup);
	try {
		assert.equal(reopened.doc.info().phase,'recovering');
		assert.equal(reopened.doc.info().recovery.source_matches,false);
		await reopened.doc.resolveRecovery('discard');
		assert.equal(reopened.doc.info().phase,'ready');
		assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Externo sem edição');
	} finally {
		await reopened.doc.close();
	}
}));

test('um original reescrito por fora depois de salvar e fechar também exige decisão', {timeout:120000}, async () => withTemp(async dir => {
	const setup=await createRecoveryFixture(dir);
	await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
		{op:'update',path:setup.fixture.ids.text,props:{content:'Salvo'}},
	]});
	await setup.doc.saveOriginal(expected(setup.doc.info()));
	await setup.doc.close();
	await rewriteExternally(setup,'Externo depois do Save');
	const reopened=await openRecovered(setup);
	try {
		assert.equal(reopened.doc.info().phase,'recovering');
		assert.equal(reopened.doc.info().recovery.source_matches,false);
		await reopened.doc.resolveRecovery('discard');
		assert.equal((await reopened.doc.readNode(setup.fixture.ids.text)).content,'Externo depois do Save');
	} finally {
		await reopened.doc.close();
	}
}));
