import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {startEngine} from '../src/engine.mjs';
import {readModel,readNode,readVariables} from '../src/model.mjs';
import {sampleFile,withTemp} from '../tests/helpers.mjs';
import {makeEngineFixture,testCliArgv} from './fixtures.mjs';

const argv=testCliArgv();

function engineOptions(input,output) {
	return {argv,input,output,timeout_ms:120000};
}

async function exportFrame(engine,frameId,dir) {
	await mkdir(dir,{recursive:true});
	await engine.exec(`Export([${JSON.stringify(frameId)}],'png',${JSON.stringify(dir)},{scale:1});`);
	return readFile(join(dir,`${frameId}.png`));
}

test('dedicated processes isolate documents with identical node IDs', {timeout:120000}, async () => {
	await withTemp(async dir=>{
		const inputA=await sampleFile(join(dir,'a'));
		const inputB=await sampleFile(join(dir,'b'));
		const engineA=await startEngine(engineOptions(inputA,join(dirname(inputA),'out.pen')));
		let engineB;
		try {
			engineB=await startEngine(engineOptions(inputB,join(dirname(inputB),'out.pen')));
			const beforeA=await readNode(engineA,'t04');
			const beforeB=await readNode(engineB,'t04');
			assert.equal(beforeA.content,beforeB.content);
			await engineA.exec('Update("t04",{content:"Only A"});');
			assert.equal((await readNode(engineA,'t04')).content,'Only A');
			assert.equal((await readNode(engineB,'t04')).content,beforeB.content);
			await engineA.close();
			await assert.rejects(engineA.exec('return Get("t04").content;'), error=>error.code==='ENGINE_CLOSED');
			assert.equal((await readNode(engineB,'t04')).content,beforeB.content);
		} finally {
			await engineA.close();
			if (engineB) await engineB.close();
		}
	});
});

test('Save and reopen preserve IDs, variables, overrides and relative assets', {timeout:120000}, async () => {
	await withTemp(async dir=>{
		const {original,ids}=await makeEngineFixture(dir,argv);
		const beforeDir=join(dir,'before');
		const afterDir=join(dir,'after');
		let beforeAsset;
		const engine=await startEngine(engineOptions(original,original));
		try {
			beforeAsset=await exportFrame(engine,ids.imageFrame,beforeDir);
			await engine.exec(`Update(${JSON.stringify(ids.text)},{content:'Saved text'});`);
			await engine.save();
		} finally {
			await engine.close();
		}
		const reopened=await startEngine(engineOptions(original,original));
		try {
			for (const id of [ids.component,ids.child,ids.instance,ids.imageFrame]) {
				assert.equal((await readNode(reopened,id)).id,id);
			}
			assert.equal((await readNode(reopened,ids.text)).content,'Saved text');
			assert.equal((await readNode(reopened,ids.path)).content,'Instância');
			assert.equal((await readVariables(reopened)).variables.accent.value,'#8844FF');
			assert.deepEqual(await exportFrame(reopened,ids.imageFrame,afterDir),beforeAsset);
		} finally {
			await reopened.close();
		}
	});
});

test('readModel returns canonical instance paths, resolved bounds and schema roots', {timeout:120000}, async () => {
	await withTemp(async dir=>{
		const {original,ids}=await makeEngineFixture(dir,argv);
		const engine=await startEngine(engineOptions(original,original));
		try {
			const model=await readModel(engine);
			const instanceChild=model.rows.find(row=>row.path===ids.path);
			assert.ok(instanceChild,'resolved instance child path must come from the engine');
			assert.equal(instanceChild.parent_path,ids.instance);
			for (const field of ['x','y','width','height']) {
				assert.equal(typeof instanceChild[field],'number');
			}
			assert.equal(instanceChild.type,'text');
			assert.equal(instanceChild.layout,'none');
			assert.ok(model.roots.some(root=>root.id===ids.component));
			assert.equal(model.variables.variables.accent.value,'#8844FF');
			const flexibleRoot=model.roots.find(root=>root.id==='f54')
				.children.find(child=>child.id==='f37');
			assert.equal(flexibleRoot.width,'fill_container');
			assert.ok(model.rows.every(row=>!Object.hasOwn(row,'children')));
		} finally {
			await engine.close();
		}
	});
});

test('close terminates the real Pen process during a long execute', {timeout:15000}, async () => {
	await withTemp(async dir=>{
		const input=await sampleFile(dir);
		const engine=await startEngine({...engineOptions(input,join(dirname(input),'out.pen')),timeout_ms:10000});
		const pid=engine.pid;
		try {
			const executing=engine.exec('const until=Date.now()+30000;while(Date.now()<until){};return true;');
			const rejected=assert.rejects(executing,error=>error.code==='ENGINE_CLOSED');
			await new Promise(resolve=>setImmediate(resolve));
			const started=performance.now();
			await engine.close();
			await rejected;
			assert.ok(performance.now()-started<1500,'close waited for the engine timeout');
			assert.throws(
				()=>process.kill(pid,0),
				error=>error.code==='ESRCH',
			);
		} finally {
			await engine.close();
		}
	});
});
