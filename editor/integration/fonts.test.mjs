import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {startEngine} from '../src/engine.mjs';
import {readModel} from '../src/model.mjs';
import {createRenderer} from '../src/render.mjs';
import {sampleFile,withTemp} from '../tests/helpers.mjs';
import {expected,testCliArgv,withDocument} from './fixtures.mjs';

// These tests need the real engine to load its web fonts (network): offline it measures with stand-in fonts throughout.
// f07 "Install" hugs a JetBrains Mono line; f88 "Badge" is a top-level frame without a fixed size.
const INSTALL='f07';
const BADGE='f88';
const HEADLINE='t04';

function size(rows,path) {
	const row=rows.find(item=>item.path===path);
	assert.ok(row,`${path} is in the model`);
	return {width:row.width,height:row.height};
}

function pngSize(bytes) {
	return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

async function settle(doc,dir) {
	await doc.withEngine(doc.info().revision,engine=>engine.exec(
		`Export([${JSON.stringify(BADGE)}],'png',${JSON.stringify(dir)},{scale:1});return true;`,
	));
}

test('the first model read of a fresh engine already has the settled text bounds', {timeout:120000}, async () => withTemp(async dir=>{
	const input=await sampleFile(dir);
	const engine=await startEngine({
		argv:testCliArgv(),input,output:join(dirname(input),'out.pen'),timeout_ms:120000,
	});
	try {
		const first=await readModel(engine);
		await engine.exec(`Export([${JSON.stringify(BADGE)}],'png',${JSON.stringify(join(dir,'settle'))},{scale:1});`);
		const settled=await readModel(engine);
		assert.deepEqual(first.rows,settled.rows);
		assert.ok(size(first.rows,INSTALL).width>500,'Install is measured with its real font');
	} finally {
		await engine.close();
	}
}));

test('the frame bounds read right after open match the rendered PNG', {timeout:120000}, async () => withDocument(async doc=>withTemp(async dir=>{
	const renderer=createRenderer({document:doc,dir:join(dir,'renders')});
	try {
		const first=await doc.readModel();
		const revision=doc.info().revision;
		await renderer.refresh(revision);
		const image=await renderer.frameImage({frame_id:BADGE,revision,max_side:4096});
		assert.equal(image.scale,1);
		assert.deepEqual(pngSize(await readFile(image.path)),size(first.rows,BADGE));
		const projected=renderer.projection({frame_id:BADGE,cursor:null}).nodes.find(node=>node.path===BADGE);
		assert.deepEqual(
			{width:projected.geometry.width,height:projected.geometry.height},
			size(first.rows,BADGE),
		);
	} finally {
		await renderer.close();
	}
})));

test('a font introduced by an edit is measured before the next read', {timeout:120000}, async () => withDocument(async doc=>withTemp(async dir=>{
	await settle(doc,join(dir,'settle-before'));
	const before=await doc.readModel();
	const result=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:HEADLINE,props:{fontFamily:'Playfair Display'}},
	]});
	const first=await doc.readModel();
	assert.equal(result.revision,doc.info().revision);
	assert.notDeepEqual(size(first.rows,HEADLINE),size(before.rows,HEADLINE),'the new font changes the text size');
	await settle(doc,join(dir,'settle'));
	const settled=await doc.readModel();
	assert.deepEqual(first.rows,settled.rows);
})));
