import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readVariables} from '../src/model.mjs';
import {expected,withDocument} from './fixtures.mjs';

test('undo e redo restauram ids, overrides, variáveis e imagem relativa', {timeout:120000}, async () => withDocument(async doc => {
	const initial=doc.info();
	const imageBefore=await doc.readNode(doc.fixture.imageFrame);
	const relativeImage=imageBefore.fill.url;
	assert.equal(relativeImage,'fixture.png');

	await doc.applyChanges({...expected(initial),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Alterado'}},
		{op:'update',path:doc.fixture.path,props:{content:'Override alterado'}},
		{op:'set_variables',variables:{accent:{type:'color',value:'#22AA44'}}},
	]});
	const changed=doc.info();

	const undoStarted=performance.now();
	await doc.undo(expected(changed));
	const undoLatency=performance.now()-undoStarted;
	const undone=doc.info();
	assert.equal(undone.revision,changed.revision+1);
	assert.equal((await doc.readNode(doc.fixture.component)).id,doc.fixture.component);
	assert.equal((await doc.readNode(doc.fixture.instance)).id,doc.fixture.instance);
	assert.equal((await doc.readNode(doc.fixture.text)).content,doc.fixture.originalText);
	assert.equal((await doc.readNode(doc.fixture.path)).content,'Instância');
	assert.equal((await doc.readNode(doc.fixture.imageFrame)).fill.url,relativeImage);
	assert.equal((await doc.withEngine(undone.revision,readVariables)).variables.accent.value,'#8844FF');

	const redoStarted=performance.now();
	await doc.redo(expected(undone));
	const redoLatency=performance.now()-redoStarted;
	console.log(`NE-5 history latency: undo=${undoLatency.toFixed(1)}ms redo=${redoLatency.toFixed(1)}ms`);
	const redone=doc.info();
	assert.equal(redone.revision,undone.revision+1);
	assert.equal((await doc.readNode(doc.fixture.component)).id,doc.fixture.component);
	assert.equal((await doc.readNode(doc.fixture.instance)).id,doc.fixture.instance);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'Alterado');
	assert.equal((await doc.readNode(doc.fixture.path)).content,'Override alterado');
	assert.equal((await doc.readNode(doc.fixture.imageFrame)).fill.url,relativeImage);
	assert.equal((await doc.withEngine(redone.revision,readVariables)).variables.accent.value,'#22AA44');
}));

test('uma edição depois de undo corta redo somente após confirmar o novo checkpoint', {timeout:120000}, async () => withDocument(async doc => {
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Primeira'}},
	]});
	const edited=doc.info();
	await doc.undo(expected(edited));
	const undone=doc.info();

	await doc.applyChanges({...expected(undone),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Segundo'}},
	]});
	const replacement=doc.info();
	await assert.rejects(
		doc.redo(expected(replacement)),
		error=>error.code==='HISTORY_UNAVAILABLE',
	);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'Segundo');
}));

test('undo avança a revisão e recusa a revisão exposta antes da restauração', {timeout:120000}, async () => withDocument(async doc => {
	const before=doc.info();
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Confirmado'}},
	]});
	const changed=doc.info();
	await doc.undo(expected(changed));

	await assert.rejects(
		doc.applyChanges({...expected(before),operations:[
			{op:'delete',path:doc.fixture.text},
		]}),
		error=>error.code==='REVISION_CONFLICT',
	);
	assert.equal(doc.info().revision,changed.revision+1);
}));

test('undo e redo sem checkpoint disponível não avançam a revisão', {timeout:120000}, async () => withDocument(async doc => {
	const initial=doc.info();
	await assert.rejects(doc.undo(expected(initial)),error=>error.code==='HISTORY_UNAVAILABLE');
	assert.equal(doc.info().revision,initial.revision);
	await doc.applyChanges({...expected(initial),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Confirmado'}},
	]});
	const changed=doc.info();
	await assert.rejects(doc.redo(expected(changed)),error=>error.code==='HISTORY_UNAVAILABLE');
	assert.equal(doc.info().revision,changed.revision);
}));
