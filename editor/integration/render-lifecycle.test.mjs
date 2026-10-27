import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createRenderer} from '../src/render.mjs';
import {expected,withDocument} from './fixtures.mjs';

test('saved board PNG bytes survive owner closure and renderer restart after a newer revision', {timeout:120000},async()=>withDocument(async document=>{
	const dir=join(document.source.working_path,'..','lifecycle-renders');
	const renderer=createRenderer({document,dir});
	let restarted;
	try {
		await renderer.refresh(document.info().revision);
		const savedBoard=JSON.parse(JSON.stringify(await renderer.frameList({
			frame_id:document.fixture.component,cursor:null,
		})));
		const snapshots=await Promise.all(savedBoard.nodes.map(async node=>({
			path:node.image.path,bytes:await readFile(node.image.path),
		})));
		assert.ok(snapshots.length>1);
		for (const snapshot of snapshots) {
			assert.equal(snapshot.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
		}
		const edit=await document.applyChanges({...expected(document.info()),operations:[
			{op:'update',path:document.fixture.text,props:{content:'An unreferenced newer render'}},
		]});
		await renderer.refresh(edit.revision);
		await renderer.close();
		for (const snapshot of snapshots) assert.deepEqual(await readFile(snapshot.path),snapshot.bytes);

		restarted=createRenderer({document,dir});
		await restarted.refresh(document.info().revision);
		await restarted.close();
		for (const snapshot of snapshots) assert.deepEqual(await readFile(snapshot.path),snapshot.bytes);
	} finally {
		await renderer.close();
		if (restarted) await restarted.close();
	}
}));

test('close removes an unreserved real scale export while retaining published PNGs and unrelated files', {timeout:120000},async()=>withDocument(async document=>{
	const dir=join(document.source.working_path,'..','lifecycle-renders');
	const renderer=createRenderer({document,dir});
	try {
		const revision=document.info().revision;
		await renderer.refresh(revision);
		const page=await renderer.frameList({frame_id:document.fixture.component,cursor:null});
		const published=page.nodes.find(node=>node.id===document.fixture.component).image;
		const publishedBytes=await readFile(published.path);
		const thumbnail=await renderer.frameImage({frame_id:document.fixture.component,revision,max_side:16});
		assert.notEqual(thumbnail.path,published.path);
		const unrelated=join(dir,'user-annotation.png');
		await writeFile(unrelated,'annotation owned by the user');
		await renderer.close();
		await assert.rejects(readFile(thumbnail.path),error=>error.code==='ENOENT');
		assert.deepEqual(await readFile(published.path),publishedBytes);
		assert.equal(await readFile(unrelated,'utf8'),'annotation owned by the user');
	} finally {
		await renderer.close();
	}
}));
