import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,readdir,rename,rm,stat,unlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {openDocument} from '../src/document.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {expected,makeEngineFixture} from './fixtures.mjs';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function saveApi() {
	return import('../src/save.mjs');
}

async function publishWindows(options) {
	return (await saveApi()).publishWindows(options);
}

async function createRaceScript(dir) {
	const production=await readFile(new URL('../windows/replace.ps1',import.meta.url),'utf8');
	const hashLine="    $before = (Get-FileHash -LiteralPath $m.original -Algorithm SHA256).Hash.ToLowerInvariant()";
	const wait=[
		hashLine,
		"    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ready'), 'ready')",
		"    while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'proceed'))) { Start-Sleep -Milliseconds 10 }",
	].join('\n');
	assert.notEqual(production.replace(hashLine,wait),production);
	const script=join(dir,'replace-race.ps1');
	await writeFile(script,production.replace(hashLine,wait),{flag:'wx'});
	return {script,ready:join(dir,'ready'),proceed:join(dir,'proceed')};
}

async function createNoisyScript(dir) {
	const script=join(dir,'noisy.ps1');
	await writeFile(script,[
		"param([Parameter(Mandatory=$true)][string]$Manifest)",
		"[Console]::Out.Write(('x' * (4 * 1024 * 1024)))",
		"Start-Sleep -Seconds 30",
		"[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'survived'), 'not killed')",
	].join('\n'),{flag:'wx'});
	return {script,survived:join(dir,'survived')};
}

async function createManifestSwapScript(dir) {
	const script=join(dir,'swap-manifest.ps1');
	await writeFile(script,[
		"param([Parameter(Mandatory=$true)][string]$Manifest)",
		"Move-Item -LiteralPath $Manifest -Destination (Join-Path $PSScriptRoot 'owned-manifest')",
		"[System.IO.File]::WriteAllText($Manifest, 'replacement owned by another actor')",
		"[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'manifest-path'), $Manifest)",
		"[Console]::Out.WriteLine('{\"published\":false}')",
	].join('\n'),{flag:'wx'});
	return {script,manifestRecord:join(dir,'manifest-path')};
}

async function createUncertainDocumentModule(dir,initialMode) {
	const sourceDir=new URL('../src/',import.meta.url);
	const realSave=new URL('save.mjs',sourceDir).href;
	const adapterPath=join(dir,'uncertain-save-adapter.mjs');
	await writeFile(adapterPath,[
		`export * from ${JSON.stringify(realSave)};`,
		`import {publishWindows as publishReal} from ${JSON.stringify(realSave)};`,
		`let mode=${JSON.stringify(initialMode)};`,
		'export function setMode(value) { mode=value; }',
		'export async function publishWindows(options) {',
		"\tif (mode==='before') return {published:null,error:{code:'SAVE_UNCERTAIN'}};",
		'\tconst outcome=await publishReal(options);',
		"\tif (mode==='after') return {...outcome,published:null,error:{code:'SAVE_UNCERTAIN'}};",
		'\treturn outcome;',
		'}',
	].join('\n'),{flag:'wx'});
	let documentSource=await readFile(new URL('../src/document.mjs',import.meta.url),'utf8');
	for (const name of ['errors','engine','history','model','ops']) {
		documentSource=documentSource.replaceAll(
			`'./${name}.mjs'`,
			JSON.stringify(new URL(`${name}.mjs`,sourceDir).href),
		);
	}
	documentSource=documentSource.replaceAll("'./save.mjs'",JSON.stringify(pathToFileURL(adapterPath).href));
	const documentPath=join(dir,'uncertain-document.mjs');
	await writeFile(documentPath,documentSource,{flag:'wx'});
	const [documentModule,adapter]=await Promise.all([
		import(pathToFileURL(documentPath).href),
		import(pathToFileURL(adapterPath).href),
	]);
	return {openDocument:documentModule.openDocument,setMode:adapter.setMode};
}

async function runPowerShell(command,args=[]) {
	const child=spawn('powershell.exe',[
		'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
		'-Command',command,...args,
	],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
	let closed=false;
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data',chunk=>{ stdout+=chunk; });
	child.stderr.on('data',chunk=>{ stderr+=chunk; });
	try {
		const [code,signal]=await once(child,'close');
		closed=true;
		if (code!==0) throw Error(`PowerShell failed: code=${code} signal=${signal} stderr=${stderr}`);
		return stdout.trim();
	} finally {
		if (!closed) {
			child.kill();
			await once(child,'close').catch(()=>undefined);
		}
	}
}

async function setReadOnly(path,value) {
	await runPowerShell(
		'& { param([string]$Path,[string]$Value) (Get-Item -LiteralPath $Path).IsReadOnly = ($Value -eq "true") }',
		[path,String(value)],
	);
}

async function getSddl(path) {
	return runPowerShell(
		'& { param([string]$Path) (Get-Acl -LiteralPath $Path).Sddl }',
		[path],
	);
}

async function createDocument(dir,open=openDocument) {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const historyDir=join(dataDir,'history');
	const source=await claimSource({
		original_path:fixture.original,
		data_dir:dataDir,
		session_id:randomUUID(),
	});
	const store=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
	let doc;
	try {
		doc=await open({source,store,cli_argv:fixture.argv,recovery:'prompt'});
		return {fixture,dataDir,historyDir,source,store,doc};
	} catch (error) {
		await source.release();
		throw error;
	}
}

async function changeText(setup,content) {
	await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
		{op:'update',path:setup.fixture.ids.text,props:{content}},
	]});
}

async function closeSetup(setup) {
	if (setup.doc.info().phase!=='closed') await setup.doc.close();
}

async function waitForFile(path) {
	const deadline=Date.now()+10000;
	while (Date.now()<deadline) {
		try {
			await stat(path);
			return;
		} catch (error) {
			if (error?.code!=='ENOENT') throw error;
			await new Promise(resolve=>setTimeout(resolve,10));
		}
	}
	throw Error(`Timed out waiting for ${path}`);
}

test('publishWindows preserva bytes e caminhos especiais com argv seguro', {timeout:30000}, async () => withTemp(async dir=>{
	const special=join(dir,"A & B's ação");
	await mkdir(special);
	const original=join(special,"desenho d'água.pen");
	const candidate=join(special,"candidato & novo.pen");
	const backup=join(special,"backup d'ação.pen.bak");
	const oldBytes=Buffer.from('estado anterior ç');
	const newBytes=Buffer.from('estado novo ação');
	await writeFile(original,oldBytes);
	await writeFile(candidate,newBytes,{flag:'wx'});

	const result=await publishWindows({candidate,original,backup,expected_hash:sha256(oldBytes)});

	assert.equal(result.published,true);
	assert.equal(result.conflict,false);
	assert.equal(result.source_hash,sha256(newBytes));
	assert.equal(result.replaced_hash,sha256(oldBytes));
	assert.deepEqual(await readFile(original),newBytes);
	assert.deepEqual(await readFile(backup),oldBytes);
}));

test('Save recusa original alterado externamente e preserva os dois estados', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Local');
		const external=Buffer.concat([await readFile(setup.fixture.original),Buffer.from('\n')]);
		await writeFile(setup.fixture.original,external);

		await assert.rejects(
			setup.doc.saveOriginal(expected(setup.doc.info())),
			error=>error.code==='SOURCE_CHANGED',
		);
		assert.deepEqual(await readFile(setup.fixture.original),external);
		assert.equal((await setup.doc.readNode(setup.fixture.ids.text)).content,'Local');
		assert.equal(setup.doc.info().dirty,true);
	} finally {
		await closeSetup(setup);
	}
}));

test('Save recusa original removido sem perder o checkpoint local', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Local removido');
		await unlink(setup.fixture.original);
		await assert.rejects(
			setup.doc.saveOriginal(expected(setup.doc.info())),
			error=>error.code==='SOURCE_CHANGED',
		);
		assert.equal((await setup.doc.readNode(setup.fixture.ids.text)).content,'Local removido');
		assert.equal(setup.doc.info().dirty,true);
	} finally {
		await closeSetup(setup);
	}
}));

test('Save em original readonly falha sem alterar original ou estado confirmado', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	const before=await readFile(setup.fixture.original);
	try {
		await changeText(setup,'Não publicar readonly');
		await setReadOnly(setup.fixture.original,true);
		await assert.rejects(setup.doc.saveOriginal(expected(setup.doc.info())));
		assert.deepEqual(await readFile(setup.fixture.original),before);
		assert.equal((await setup.doc.readNode(setup.fixture.ids.text)).content,'Não publicar readonly');
		assert.equal(setup.doc.info().dirty,true);
	} finally {
		await setReadOnly(setup.fixture.original,false).catch(()=>undefined);
		await closeSetup(setup);
	}
}));

test('Save sem edição após normalização inicial não reescreve o original', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		const beforeBytes=await readFile(setup.fixture.original);
		const beforeStat=await stat(setup.fixture.original,{bigint:true});
		const result=await setup.doc.saveOriginal(expected(setup.doc.info()));
		const afterStat=await stat(setup.fixture.original,{bigint:true});
		assert.equal(result.saved,false);
		assert.deepEqual(await readFile(setup.fixture.original),beforeBytes);
		assert.equal(afterStat.mtimeNs,beforeStat.mtimeNs);
	} finally {
		await closeSetup(setup);
	}
}));

test('cópias de recuperação são exclusivas e não mudam origem nem estado salvo', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Cópia local');
		const originalBytes=await readFile(setup.fixture.original);
		const beforeIndex=await setup.store.load();
		const first=await setup.doc.saveRecoveryCopy(expected(setup.doc.info()));
		await writeFile(first.path,Buffer.from('destino existente'));
		const second=await setup.doc.saveRecoveryCopy(expected(setup.doc.info()));

		assert.notEqual(first.path,second.path);
		assert.deepEqual(await readFile(first.path),Buffer.from('destino existente'));
		assert.equal(sha256(await readFile(second.path)),setup.doc.info().checkpoint_id);
		assert.deepEqual(await readFile(setup.fixture.original),originalBytes);
		assert.equal(setup.doc.info().original_path,setup.source.original_path);
		assert.equal((await setup.store.load()).saved_id,beforeIndex.saved_id);
		assert.equal(setup.doc.info().dirty,true);
	} finally {
		await closeSetup(setup);
	}
}));

test('resolveRecovery copy preserva snapshot local e não toca a fonte externa', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Recuperação local');
		await setup.doc.close();
		const external=Buffer.concat([await readFile(setup.fixture.original),Buffer.from('\n')]);
		await writeFile(setup.fixture.original,external);
		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		const reopened=await openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'});
		try {
			const changedAfterReopen=Buffer.from('externo mudou novamente após reabrir');
			await writeFile(setup.fixture.original,changedAfterReopen);
			const result=await reopened.resolveRecovery('copy');
			assert.equal(reopened.info().phase,'ready');
			assert.equal((await reopened.readNode(setup.fixture.ids.text)).content,'Recuperação local');
			assert.deepEqual(await readFile(setup.fixture.original),changedAfterReopen);
			assert.equal(sha256(await readFile(result.recovery_copy)),reopened.info().checkpoint_id);
		} finally {
			await reopened.close();
		}
	} finally {
		await closeSetup(setup);
	}
}));

test('falha de índice depois do Replace é reconhecida por hash ao reabrir', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	let reopened;
	try {
		await changeText(setup,'Publicado sem resposta');
		const checkpoint=setup.doc.info().checkpoint_id;
		const realPublish=setup.store.publish.bind(setup.store);
		setup.store.publish=async()=>{
			setup.store.publish=realPublish;
			const error=Error('simulated lost index response');
			error.code='EIO';
			throw error;
		};
		await assert.rejects(
			setup.doc.saveOriginal(expected(setup.doc.info())),
			error=>error.code==='SAVE_UNCERTAIN',
		);
		assert.equal(sha256(await readFile(setup.fixture.original)),checkpoint);
		await setup.doc.close();

		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		reopened=await openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'});
		// The published bytes are recognised by hash: nothing is left to decide.
		assert.equal(reopened.info().phase,'ready');
		assert.equal(reopened.info().recovery,undefined);
		assert.equal(reopened.info().dirty,false);
		assert.equal((await store.load()).saved_id,checkpoint);
		assert.equal((await store.load()).source.fingerprint,sha256(await readFile(setup.fixture.original)));
	} finally {
		await reopened?.close();
		await closeSetup(setup);
	}
}));

test('conflito entre hash e Replace usa somente script temporário e preserva os bytes substituídos', {timeout:120000}, async () => withTemp(async dir=>{
	const special=join(dir,'race-source');
	await mkdir(special);
	const original=join(special,'design.pen');
	const candidate=join(special,'candidate.pen');
	const backup=join(special,'backup.bak');
	const expectedBytes=Buffer.from('base esperada');
	const candidateBytes=Buffer.from('candidato confirmado');
	await writeFile(original,expectedBytes,{flag:'wx'});
	await writeFile(candidate,candidateBytes,{flag:'wx'});
	const race=await createRaceScript(dir);
	const publishing=publishWindows({
		candidate,
		original,
		backup,
		expected_hash:sha256(expectedBytes),
		script:race.script,
	});
	await waitForFile(race.ready);
	const competing=Buffer.from('gravação externa entre hash e replace');
	await writeFile(original,competing);
	await writeFile(race.proceed,'go',{flag:'wx'});
	const outcome=await publishing;

	assert.equal(outcome.published,true);
	assert.equal(outcome.conflict,true);
	assert.deepEqual(await readFile(original),candidateBytes);
	assert.deepEqual(await readFile(backup),competing);
}));

test('Save preserva o SDDL do original', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'ACL preservada');
		const before=await getSddl(setup.fixture.original);
		const started=performance.now();
		const result=await setup.doc.saveOriginal(expected(setup.doc.info()));
		const saveLatency=performance.now()-started;
		const after=await getSddl(setup.fixture.original);
		assert.equal(result.saved,true);
		assert.equal(after,before);
		console.log(`NE-6 Windows Save latency: ${saveLatency.toFixed(1)}ms; SDDL preserved: true`);
		assert.equal((await setup.store.load()).saved_id,setup.doc.info().checkpoint_id);
		assert.equal(setup.source.source_fingerprint,sha256(await readFile(setup.fixture.original)));
	} finally {
		await closeSetup(setup);
	}
}));

test('applyChanges undo e redo nunca gravam o original sem Save explícito', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		const original=await readFile(setup.fixture.original);
		await changeText(setup,'Somente checkpoint');
		assert.deepEqual(await readFile(setup.fixture.original),original);
		await setup.doc.undo(expected(setup.doc.info()));
		assert.deepEqual(await readFile(setup.fixture.original),original);
		await setup.doc.redo(expected(setup.doc.info()));
		assert.deepEqual(await readFile(setup.fixture.original),original);
	} finally {
		await closeSetup(setup);
	}
}));

test('publicação deixa somente o backup seguro mais recente da própria sessão', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Primeiro Save');
		const first=await setup.doc.saveOriginal(expected(setup.doc.info()));
		await changeText(setup,'Segundo Save');
		const second=await setup.doc.saveOriginal(expected(setup.doc.info()));
		await assert.rejects(readFile(first.backup_path),error=>error.code==='ENOENT');
		assert.deepEqual(await readFile(second.backup_path),await setup.store.read(first.checkpoint_id));
		const ownBackups=(await readdir(dirname(setup.fixture.original)))
			.filter(name=>name.includes(setup.source.session_id)&&name.endsWith('.bak'));
		assert.equal(ownBackups.length,1);
	} finally {
		await closeSetup(setup);
	}
}));


async function openSaveConflict(dir) {
	const setup=await createDocument(dir);
	let reopened;
	try {
		await changeText(setup,'Publicação concorrente');
		const checkpointId=setup.doc.info().checkpoint_id;
		const checkpoint=await setup.store.read(checkpointId);
		const api=await saveApi();
		let intent=await api.prepareSave({
			bytes:checkpoint,
			original:setup.source.original_path,
			session_id:setup.source.session_id,
			expected_hash:setup.source.source_fingerprint,
			checkpoint_id:checkpointId,
		});
		await setup.source.assertDiskBase();
		await api.writeSaveIntent(setup.store.dir,intent);
		const race=await createRaceScript(dir);
		const publishing=publishWindows({
			candidate:intent.candidate_path,
			original:intent.original_path,
			backup:intent.backup_path,
			expected_hash:intent.expected_hash,
			script:race.script,
		});
		await waitForFile(race.ready);
		const competing=Buffer.from('gravação externa entre hash e replace');
		await writeFile(setup.fixture.original,competing);
		await writeFile(race.proceed,'go',{flag:'wx'});
		const outcome=await publishing;
		assert.equal(outcome.published,true);
		assert.equal(outcome.conflict,true);
		const preserved=await api.preserveCandidate({
			...intent,
			backup_identity:outcome.backup_identity,
		},checkpoint);
		intent={
			...preserved.intent,
			published:true,
			source_hash:outcome.source_hash,
			replaced_hash:outcome.replaced_hash,
			conflict:true,
		};
		await api.writeSaveIntent(setup.store.dir,intent,{replace:true});
		await setup.doc.close();

		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		reopened=await openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'});
		return {setup,reopened,competing,intent};
	} catch (error) {
		await reopened?.close();
		await closeSetup(setup);
		throw error;
	}
}

test('saveOriginal recusa campos de teste sem criar Save-intent', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Sem hook de produção');
		await assert.rejects(
			setup.doc.saveOriginal({...expected(setup.doc.info()),_test_after_hash:'forbidden'}),
			error=>error.code==='SAVE_REQUEST_INVALID',
		);
		await assert.rejects(
			readFile(join(setup.historyDir,'save-intent.json')),
			error=>error.code==='ENOENT',
		);
	} finally {
		await closeSetup(setup);
	}
}));

test('acceptPublished recusa hash que não corresponde ao disco e mantém a base anterior', async () => withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const source=await claimSource({
		original_path:fixture.original,
		data_dir:join(dir,'private'),
		session_id:randomUUID(),
	});
	try {
		const originalFingerprint=source.source_fingerprint;
		await writeFile(fixture.original,Buffer.from('alteração externa'));
		await assert.rejects(
			source.acceptPublished('a'.repeat(64)),
			error=>error.code==='SOURCE_CHANGED',
		);
		assert.equal(source.source_fingerprint,originalFingerprint);
		await assert.rejects(source.assertDiskBase(),error=>error.code==='SOURCE_CHANGED');
	} finally {
		await source.release();
	}
}));

test('limpeza não apaga candidato ou backup trocados por outro inode', async () => withTemp(async dir=>{
	const api=await saveApi();
	const sourceDir=join(dir,'source');
	await mkdir(sourceDir);
	const original=join(sourceDir,'design.pen');
	await writeFile(original,'original',{flag:'wx'});
	const sessionId=randomUUID();
	const bytes=Buffer.from('checkpoint');
	const checkpointId=sha256(bytes);
	const intent=await api.prepareSave({
		bytes,
		original,
		session_id:sessionId,
		expected_hash:sha256(Buffer.from('original')),
		checkpoint_id:checkpointId,
	});
	await rename(intent.candidate_path,`${intent.candidate_path}.owned`);
	await writeFile(intent.candidate_path,'replacement candidate',{flag:'wx'});
	const candidateCleanup=await api.removeCandidate(intent);
	assert.deepEqual(candidateCleanup.leftovers,[intent.candidate_path]);
	assert.equal(await readFile(intent.candidate_path,'utf8'),'replacement candidate');

	const backup=join(sourceDir,`.design.pen.tern-save-${sessionId}-${randomUUID()}.bak`);
	await writeFile(backup,'owned backup',{flag:'wx'});
	const backupIdentity=await api.captureArtifactIdentity(backup);
	await rename(backup,`${backup}.owned`);
	await writeFile(backup,'replacement backup',{flag:'wx'});
	const backupCleanup=await api.removePreviousBackup({
		save_backup:{path:backup,owner_session_id:sessionId,identity:backupIdentity},
	},sessionId,join(sourceDir,'current.bak'),original);
	assert.deepEqual(backupCleanup.leftovers,[backup]);
	assert.equal(await readFile(backup,'utf8'),'replacement backup');
}));

test('publishWindows não apaga manifesto trocado durante o helper', {timeout:30000}, async () => withTemp(async dir=>{
	const original=join(dir,'original.pen');
	const candidate=join(dir,'candidate.pen');
	const backup=join(dir,'backup.bak');
	const oldBytes=Buffer.from('old');
	await writeFile(original,oldBytes,{flag:'wx'});
	await writeFile(candidate,'new',{flag:'wx'});
	const fake=await createManifestSwapScript(dir);
	const result=await publishWindows({
		candidate,original,backup,expected_hash:sha256(oldBytes),script:fake.script,
	});
	const manifestPath=await readFile(fake.manifestRecord,'utf8');
	assert.equal(await readFile(manifestPath,'utf8'),'replacement owned by another actor');
	assert.deepEqual(result.leftovers,[manifestPath]);
}));

test('helper ruidoso tem saída limitada e é encerrado antes de continuar', {timeout:30000}, async () => withTemp(async dir=>{
	const original=join(dir,'original.pen');
	const candidate=join(dir,'candidate.pen');
	const backup=join(dir,'backup.bak');
	const oldBytes=Buffer.from('old');
	await writeFile(original,oldBytes,{flag:'wx'});
	await writeFile(candidate,'new',{flag:'wx'});
	const fake=await createNoisyScript(dir);
	const started=performance.now();
	await assert.rejects(
		publishWindows({candidate,original,backup,expected_hash:sha256(oldBytes),script:fake.script}),
		error=>error.code==='SAVE_PROTOCOL',
	);
	assert.ok(performance.now()-started<10000);
	await new Promise(resolve=>setTimeout(resolve,250));
	await assert.rejects(stat(fake.survived),error=>error.code==='ENOENT');
	assert.deepEqual(await readFile(original),oldBytes);
}));

test('resolveRecovery copy funciona se o original for removido depois da reabertura', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	try {
		await changeText(setup,'Snapshot após remoção');
		await setup.doc.close();
		await writeFile(setup.fixture.original,Buffer.from('externo antes de reabrir'));
		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		const reopened=await openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'});
		try {
			await unlink(setup.fixture.original);
			const result=await reopened.resolveRecovery('copy');
			assert.equal(sha256(await readFile(result.recovery_copy)),reopened.info().checkpoint_id);
			await assert.rejects(readFile(setup.fixture.original),error=>error.code==='ENOENT');
		} finally {
			await reopened.close();
		}
	} finally {
		await closeSetup(setup);
	}
}));

test('save_conflict aceita somente copy e devolve o backup externo preservado', {timeout:120000}, async () => withTemp(async dir=>{
	const state=await openSaveConflict(dir);
	try {
		for (const choice of ['recover','discard']) {
			await assert.rejects(
				state.reopened.resolveRecovery(choice),
				error=>error.code==='RECOVERY_CHOICE_INVALID'
					&&assert.deepEqual(error.details?.valid_choices,['copy'])===undefined,
			);
			assert.equal(state.reopened.info().phase,'recovering');
		}
		const result=await state.reopened.resolveRecovery('copy');
		assert.equal(state.reopened.info().phase,'ready');
		assert.equal(result.external_backup,state.intent.backup_path);
		assert.deepEqual(await readFile(result.external_backup),state.competing);
		assert.equal(sha256(await readFile(result.recovery_copy)),state.reopened.info().checkpoint_id);
		if (result.candidate) assert.equal(sha256(await readFile(result.candidate)),state.reopened.info().checkpoint_id);
	} finally {
		await state.reopened.close();
		await closeSetup(state.setup);
	}
}));

test('falha de limpeza pós-Save propaga o erro e restaura a fase ready', {timeout:120000}, async () => withTemp(async dir=>{
	const setup=await createDocument(dir);
	const intentPath=join(setup.historyDir,'save-intent.json');
	try {
		await changeText(setup,'Save confirmado antes da falha de limpeza');
		const realPublish=setup.store.publish.bind(setup.store);
		let interfere=true;
		setup.store.publish=async index=>{
			const published=await realPublish(index);
			if (interfere&&index.saved_id===setup.doc.info().checkpoint_id) {
				interfere=false;
				await unlink(intentPath);
				await mkdir(intentPath);
			}
			return published;
		};
		await assert.rejects(setup.doc.saveOriginal(expected(setup.doc.info())));
		assert.equal(setup.doc.info().phase,'ready');
		await setup.doc.applyChanges({...expected(setup.doc.info()),operations:[
			{op:'update',path:setup.fixture.ids.text,props:{content:'Sessão ainda utilizável'}},
		]});
		assert.equal((await setup.doc.readNode(setup.fixture.ids.text)).content,'Sessão ainda utilizável');
	} finally {
		await rm(intentPath,{recursive:true,force:true});
		await closeSetup(setup);
	}
}));

test('published null após Replace retorna sucesso reconhecido e adota o índice reconciliado', {timeout:120000}, async () => withTemp(async dir=>{
	const fault=await createUncertainDocumentModule(dir,'after');
	const setup=await createDocument(dir,fault.openDocument);
	let reopened;
	try {
		await changeText(setup,'Primeiro Save com resposta perdida');
		const firstCheckpoint=setup.doc.info().checkpoint_id;
		const firstResult=await setup.doc.saveOriginal(expected(setup.doc.info()));
		assert.equal(firstResult.saved,true);
		assert.equal(firstResult.recognized,true);
		assert.equal(firstResult.revision,setup.doc.info().revision);
		assert.equal(firstResult.checkpoint_id,firstCheckpoint);
		assert.equal(setup.doc.info().dirty,false);
		assert.equal((await setup.store.load()).saved_id,firstCheckpoint);
		assert.equal((await setup.store.load()).source.fingerprint,setup.source.source_fingerprint);

		fault.setMode('normal');
		await changeText(setup,'Segundo Save depois da reconciliação');
		const secondCheckpoint=setup.doc.info().checkpoint_id;
		const secondResult=await setup.doc.saveOriginal(expected(setup.doc.info()));
		assert.equal(secondResult.saved,true);
		assert.equal(secondResult.recognized,undefined);
		assert.equal(setup.doc.info().dirty,false);
		assert.equal((await setup.store.load()).saved_id,secondCheckpoint);
		assert.equal(sha256(await readFile(setup.fixture.original)),secondCheckpoint);

		const publishedBytes=await readFile(setup.fixture.original);
		await setup.doc.close();
		const beforeReopen=await stat(setup.fixture.original,{bigint:true});
		await assert.rejects(readFile(join(setup.historyDir,'save-intent.json')),error=>error.code==='ENOENT');
		const source=await claimSource({
			original_path:setup.fixture.original,
			data_dir:setup.dataDir,
			session_id:randomUUID(),
		});
		const store=await openStore({dir:setup.historyDir,max_steps:50,max_bytes:200*1024*1024});
		reopened=await openDocument({source,store,cli_argv:setup.fixture.argv,recovery:'prompt'});
		const afterReopen=await stat(setup.fixture.original,{bigint:true});
		assert.notEqual(reopened.info().recovery?.save_conflict,true);
		assert.equal(afterReopen.mtimeNs,beforeReopen.mtimeNs);
		assert.deepEqual(await readFile(setup.fixture.original),publishedBytes);
		assert.equal(reopened.info().phase,'ready');
		assert.equal(reopened.info().recovery,undefined);
		assert.equal(reopened.info().dirty,false);
	} finally {
		await reopened?.close();
		await closeSetup(setup);
	}
}));

test('published null antes do Replace mantém dirty ready e permite tentar Save novamente', {timeout:120000}, async () => withTemp(async dir=>{
	const fault=await createUncertainDocumentModule(dir,'before');
	const setup=await createDocument(dir,fault.openDocument);
	try {
		const original=await readFile(setup.fixture.original);
		await changeText(setup,'Save ainda não realizado');
		let uncertain;
		await assert.rejects(
			setup.doc.saveOriginal(expected(setup.doc.info())),
			error=>{
				uncertain=error;
				return error.code==='SAVE_UNCERTAIN';
			},
		);
		assert.match(uncertain.message,/not performed/i);
		assert.equal(uncertain.details?.published,false);
		assert.equal(uncertain.details?.retryable,true);
		assert.deepEqual(await readFile(setup.fixture.original),original);
		assert.equal(setup.doc.info().phase,'ready');
		assert.equal(setup.doc.info().dirty,true);

		fault.setMode('normal');
		const result=await setup.doc.saveOriginal(expected(setup.doc.info()));
		assert.equal(result.saved,true);
		assert.equal(setup.doc.info().dirty,false);
		assert.equal(sha256(await readFile(setup.fixture.original)),setup.doc.info().checkpoint_id);
	} finally {
		await closeSetup(setup);
	}
}));
