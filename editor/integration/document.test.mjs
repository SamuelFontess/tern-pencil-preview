import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {openDocument} from '../src/document.mjs';
import {readVariables} from '../src/model.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {expected,makeEngineFixture,withDocument} from './fixtures.mjs';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function withPublishFailure(options,fn) {
	return withTemp(async dir=>{
		const fixture=await makeEngineFixture(dir);
		const source=await claimSource({
			original_path:fixture.original,
			data_dir:join(dir,'private'),
			session_id:randomUUID(),
		});
		const store=await openStore({
			dir:join(dir,'private','history'),
			max_steps:50,
			max_bytes:200*1024*1024,
		});
		let doc;
		try {
			doc=await openDocument({source,store,cli_argv:fixture.argv,recovery:'prompt'});
			const publish=store.publish.bind(store);
			let fail=true;
			store.publish=async index=>{
				if (!fail) return publish(index);
				fail=false;
				const error=Error('disk full');
				error.code='ENOSPC';
				throw error;
			};
			if (options.restoreFails) {
				source.restore=async()=>{ throw Error('restore failed'); };
			}
			return await fn({doc,fixture});
		} finally {
			if (doc) await doc.close();
			else await source.release();
		}
	});
}

test('session and revision guards reject requests before changing confirmed state', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	await assert.rejects(
		doc.applyChanges({session_id:'other',base_revision:before.revision,operations:[]}),
		error=>error.code==='SESSION_MISMATCH',
	);
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'confirmed'}},
	]});
	await assert.rejects(
		doc.applyChanges({...expected(before),operations:[]}),
		error=>error.code==='REVISION_CONFLICT',
	);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'confirmed');
}));

test('two writes from the same base do not both commit', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const outcomes=await Promise.allSettled([
		doc.applyChanges({...expected(before),operations:[
			{op:'update',path:doc.fixture.text,props:{content:'A'}},
		]}),
		doc.applyChanges({...expected(before),operations:[
			{op:'update',path:doc.fixture.text,props:{content:'B'}},
		]}),
	]);
	assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
	assert.equal(doc.info().revision,before.revision+1);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'A');
}));

test('an error in the middle rolls back the entire batch and leaves the queue usable', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const original=(await doc.readNode(doc.fixture.text)).content;
	await assert.rejects(doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'must roll back'}},
		{op:'set_variables',variables:{invalid:'#fff'}},
	]}));
	assert.equal(doc.info().revision,before.revision);
	assert.equal((await doc.readNode(doc.fixture.text)).content,original);
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'after failure'}},
	]});
	assert.equal((await doc.readNode(doc.fixture.text)).content,'after failure');
}));

test('a no-op creates no revision or commit notification', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const content=(await doc.readNode(doc.fixture.text)).content;
	const commits=[];
	const unsubscribe=doc.onCommit(info=>commits.push(info));
	const result=await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{content}},
	]});
	assert.equal(result.revision,before.revision);
	assert.equal(doc.info().checkpoint_id,before.checkpoint_id);
	assert.deepEqual(commits,[]);
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'changed'}},
	]});
	assert.equal(commits.length,1);
	unsubscribe();
}));

test('publish failure restores the last checkpoint before another write', {timeout:120000}, async () => withPublishFailure({},async ({doc,fixture})=>{
	const before=doc.info();
	const original=(await doc.readNode(fixture.ids.text)).content;
	await assert.rejects(
		doc.applyChanges({...expected(before),operations:[
			{op:'update',path:fixture.ids.text,props:{content:'unpublished'}},
		]}),
		error=>error.code==='ENOSPC',
	);
	assert.equal(doc.info().revision,before.revision);
	assert.equal((await doc.readNode(fixture.ids.text)).content,original);
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:fixture.ids.text,props:{content:'published'}},
	]});
	assert.equal((await doc.readNode(fixture.ids.text)).content,'published');
}));

test('failed restoration blocks every later mutation', {timeout:120000}, async () => withPublishFailure({restoreFails:true},async ({doc,fixture})=>{
	const before=doc.info();
	await assert.rejects(doc.applyChanges({...expected(before),operations:[
		{op:'update',path:fixture.ids.text,props:{content:'unpublished'}},
	]}));
	assert.equal(doc.info().phase,'blocked');
	await assert.rejects(
		doc.applyChanges({...expected(doc.info()),operations:[]}),
		error=>error.code==='DOCUMENT_BLOCKED',
	);
}));

test('real engine applies all seven operations and never writes the original', {timeout:120000}, async () => withDocument(async doc=>{
	const originalHash=sha256(await readFile(doc.fixture.original));
	const before=doc.info();
	const result=await doc.applyChanges({...expected(before),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Inserted',x:500,y:0,width:40,height:40}},
		{op:'copy',path:doc.fixture.component,parent:null,data:{name:'Copied',x:550,y:0}},
		{op:'update',path:doc.fixture.text,props:{content:'Updated'}},
		{op:'replace',path:doc.fixture.path,node:{type:'text',name:'Replacement',content:'Replaced',fontFamily:'Arial',fontSize:16}},
		{op:'move',path:doc.fixture.instance,parent:null,index:0},
		{op:'delete',path:doc.fixture.imageFrame},
		{op:'set_variables',variables:{shared:{type:'number',value:12}}},
	]});
	assert.equal(result.created.length,3);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'Updated');
	assert.equal((await doc.readModel()).roots.some(root=>root.id===doc.fixture.imageFrame),false);
	assert.equal((await doc.withEngine(result.revision,readVariables)).variables.shared.value,12);
	assert.equal(sha256(await readFile(doc.fixture.original)),originalHash);
	await assert.rejects(
		doc.withEngine(before.revision,async()=>null),
		error=>error.code==='REVISION_CONFLICT',
	);
}));

test('an existing index with unsaved confirmed edits opens in recovering and refuses mutation', {timeout:120000}, async () => withTemp(async dir=>{
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const historyDir=join(dataDir,'history');
	const firstSource=await claimSource({
		original_path:fixture.original,
		data_dir:dataDir,
		session_id:randomUUID(),
	});
	const firstStore=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
	const first=await openDocument({source:firstSource,store:firstStore,cli_argv:fixture.argv,recovery:'prompt'});
	await first.applyChanges({...expected(first.info()),operations:[
		{op:'update',path:fixture.ids.text,props:{content:'pending edit'}},
	]});
	await first.close();

	const secondSource=await claimSource({
		original_path:fixture.original,
		data_dir:dataDir,
		session_id:randomUUID(),
	});
	let second;
	try {
		const secondStore=await openStore({dir:historyDir,max_steps:50,max_bytes:200*1024*1024});
		second=await openDocument({source:secondSource,store:secondStore,cli_argv:fixture.argv,recovery:'prompt'});
		assert.equal(second.info().phase,'recovering');
		assert.equal(second.info().original_path,secondSource.original_path);
		assert.equal(second.info().session_id,secondSource.session_id);
		await assert.rejects(
			second.applyChanges({...expected(second.info()),operations:[]}),
			error=>error.code==='RECOVERY_REQUIRED',
		);
	} finally {
		if (second) await second.close();
		else await secondSource.release();
	}
}));

test('withEngine exposes a frozen facade that expires after the serialized callback', {timeout:120000}, async () => withDocument(async doc=>{
	let facade;
	await doc.withEngine(doc.info().revision,async query=>{
		facade=query;
		assert.equal(Object.isFrozen(query),true);
		assert.equal(Object.getPrototypeOf(query),null);
		assert.deepEqual(Object.keys(query),['exec','schema']);
	});
	await assert.rejects(
		facade.exec('return true;'),
		error=>error.code==='ENGINE_FACADE_EXPIRED',
	);
	await assert.rejects(
		facade.schema(),
		error=>error.code==='ENGINE_FACADE_EXPIRED',
	);
}));

function firstByteDifference(left,right) {
	const length=Math.min(left.length,right.length);
	for (let index=0;index<length;index+=1) {
		if (left[index]!==right[index]) return index;
	}
	return left.length===right.length ? -1 : length;
}

test('the real engine saves an unchanged document byte-for-byte as its checkpoint', {timeout:120000}, async () => withDocument(async doc=>{
	const checkpoint=await doc.store.read(doc.info().checkpoint_id);
	await doc.engine.save();
	const saved=await readFile(doc.source.working_path);
	const difference=firstByteDifference(checkpoint,saved);
	console.log(`NE-4b deterministic save: checkpoint=${checkpoint.length} saved=${saved.length} first_difference=${difference}`);
	assert.equal(difference,-1,`unchanged save differs at byte ${difference}; checkpoint=${checkpoint.length}, saved=${saved.length}`);
}));

test('a query through withEngine does not restart the engine before the next change', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	const idleStarted=performance.now();
	await doc.withEngine(before.revision,async()=>undefined);
	const idleMs=performance.now()-idleStarted;
	const execStarted=performance.now();
	await doc.withEngine(before.revision,engine=>engine.exec(
		`return Get(${JSON.stringify(doc.fixture.text)}).content;`,
	));
	const execMs=performance.now()-execStarted;
	console.log(`NE-4b withEngine ms: no_exec=${idleMs.toFixed(1)} exec_save_read_compare=${execMs.toFixed(1)} extra=${(execMs-idleMs).toFixed(1)}`);
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation);
}));

test('exec mutation through withEngine cannot contaminate the next commit', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	const original=await doc.readNode(doc.fixture.text);
	await doc.withEngine(before.revision,facade=>facade.exec(
		`Update(${JSON.stringify(doc.fixture.text)},{content:'untracked'});return true;`,
	));
	const result=await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	const confirmed=await doc.readNode(doc.fixture.text);
	assert.equal(doc.engineGeneration,generation+1);
	assert.equal(result.revision,before.revision+1);
	assert.equal(confirmed.content,original.content);
	assert.equal(confirmed.fontSize,18);
}));

test('a save failure after withEngine exec makes the engine suspect', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	const save=doc.engine.save.bind(doc.engine);
	doc.engine.save=async()=>{ throw Error('forced save failure'); };
	try {
		await doc.withEngine(before.revision,engine=>engine.exec(
			`return Get(${JSON.stringify(doc.fixture.text)}).content;`,
		));
	} finally {
		doc.engine.save=save;
	}
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation+1);
}));

test('a renderer refresh does not make the following change restart the engine', {timeout:120000}, async () => {
	let baseline;
	await withDocument(async doc=>{
		const started=performance.now();
		await doc.applyChanges({...expected(doc.info()),operations:[
			{op:'update',path:doc.fixture.text,props:{fontSize:18}},
		]});
		baseline=performance.now()-started;
	});
	let afterRefresh;
	await withDocument(async doc=>{
		const {createRenderer}=await import('../src/render.mjs');
		const renderer=createRenderer({document:doc,dir:join(doc.source.working_path,'..','renders')});
		try {
			await renderer.refresh(doc.info().revision);
		} finally {
			await renderer.close();
		}
		const generation=doc.engineGeneration;
		const started=performance.now();
		await doc.applyChanges({...expected(doc.info()),operations:[
			{op:'update',path:doc.fixture.text,props:{fontSize:18}},
		]});
		afterRefresh=performance.now()-started;
		assert.equal(doc.engineGeneration,generation);
	});
	console.log(`NE-4b apply ms: baseline=${baseline.toFixed(1)} after_refresh=${afterRefresh.toFixed(1)}`);
	assert.equal(Number.isFinite(baseline)&&Number.isFinite(afterRefresh),true);
});

test('an unawaited withEngine exec is verified before the next commit', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	await doc.withEngine(before.revision,engine=>{
		void engine.exec(`Update(${JSON.stringify(doc.fixture.text)},{content:'unawaited'});return true;`);
	});
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation+1);
	assert.equal((await doc.readNode(doc.fixture.text)).content,doc.fixture.originalText);
}));

test('a rejected callback verifies its exec mutation and leaves the queue usable', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	await assert.rejects(
		doc.withEngine(before.revision,async engine=>{
			await engine.exec(`Update(${JSON.stringify(doc.fixture.text)},{content:'rejected'});return true;`);
			throw Error('callback rejected');
		}),
		/callback rejected/,
	);
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation+1);
	assert.equal((await doc.readNode(doc.fixture.text)).content,doc.fixture.originalText);
}));

test('a withEngine mutation reverted to checkpoint bytes does not restart the engine', {timeout:120000}, async () => withDocument(async doc=>{
	const before=doc.info();
	const generation=doc.engineGeneration;
	await doc.withEngine(before.revision,engine=>engine.exec(
		`Update(${JSON.stringify(doc.fixture.text)},{content:'transient'});`+
		`Update(${JSON.stringify(doc.fixture.text)},{content:${JSON.stringify(doc.fixture.originalText)}});return true;`,
	));
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation);
	assert.equal((await doc.readNode(doc.fixture.text)).content,doc.fixture.originalText);
}));

test('withEngine compares a query against the checkpoint selected by undo', {timeout:120000}, async () => withDocument(async doc=>{
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'edited'}},
	]});
	await doc.undo(expected(doc.info()));
	const current=doc.info();
	const generation=doc.engineGeneration;
	await doc.withEngine(current.revision,engine=>engine.exec(
		`return Get(${JSON.stringify(doc.fixture.text)}).content;`,
	));
	await doc.applyChanges({...expected(current),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation);
	assert.equal((await doc.readNode(doc.fixture.text)).content,doc.fixture.originalText);
}));

test('withEngine compares a query against the checkpoint selected by redo', {timeout:120000}, async () => withDocument(async doc=>{
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'edited'}},
	]});
	await doc.undo(expected(doc.info()));
	await doc.redo(expected(doc.info()));
	const current=doc.info();
	const generation=doc.engineGeneration;
	await doc.withEngine(current.revision,engine=>engine.exec(
		`return Get(${JSON.stringify(doc.fixture.text)}).content;`,
	));
	await doc.applyChanges({...expected(current),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	assert.equal(doc.engineGeneration,generation);
	assert.equal((await doc.readNode(doc.fixture.text)).content,'edited');
}));

test('withEngine without exec does not save the engine', {timeout:120000}, async () => withDocument(async doc=>{
	const save=doc.engine.save.bind(doc.engine);
	let saves=0;
	doc.engine.save=async()=>{
		saves+=1;
		return save();
	};
	try {
		await doc.withEngine(doc.info().revision,async()=>undefined);
	} finally {
		doc.engine.save=save;
	}
	assert.equal(saves,0);
}));

test('withEngine rejects a revision made stale by a confirmed edit', {timeout:120000}, async () => withDocument(async doc=>{
	const stale=doc.info();
	await doc.applyChanges({...expected(stale),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:18}},
	]});
	await assert.rejects(
		doc.withEngine(stale.revision,async()=>undefined),
		error=>error.code==='REVISION_CONFLICT',
	);
}));

test('closing a dirty session removes its working copy and keeps the confirmed edit recoverable', {timeout:120000}, async () => withDocument(async doc=>{
	const working=doc.source.working_path;
	const before=doc.info();
	await doc.applyChanges({...expected(before),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'kept after close'}},
	]});
	const confirmed=doc.info().checkpoint_id;
	await doc.close();
	await assert.rejects(readFile(working),error=>error.code==='ENOENT');
	assert.equal((await readFile(doc.fixture.original)).includes('kept after close'),false);
	assert.equal((await doc.store.read(confirmed)).includes('kept after close'),true);
}));
