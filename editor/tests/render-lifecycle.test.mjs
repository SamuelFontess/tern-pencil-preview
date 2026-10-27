import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createRenderer} from '../src/render.mjs';
import {withTemp} from './helpers.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMCFziBMAAIPRAgYEvCRHAAAAAElFTkSuQmCC','base64');

function deferred() {
	let resolve;
	const promise=new Promise(done=>{ resolve=done; });
	return {promise,resolve};
}

function documentFixture() {
	let revision=0;
	const fixture={
		beforeMetadata:async()=>{},
		beforeExport:async()=>{},
		setRevision(value) { revision=value; },
		info:()=>({revision}),
		readModel:async()=>({
			roots:[{id:'frame',type:'frame',width:10,height:10,children:[]}],
			rows:[{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:10,height:10}],
			variables:{},
		}),
		withEngine:async(expectedRevision,fn)=>fn({
			exec:async body=>{
				if (!body.startsWith('Export(')) {
					await fixture.beforeMetadata();
					return {value:{rows:[{
						path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:10,height:10,
						schema:{id:'frame',type:'frame',width:10,height:10,name:`revision ${revision}`},
					}]},warnings:[]};
				}
				const match=/^Export\((\[[^\]]*\]),'png',("(?:[^"\\]|\\.)*"),\{scale:([\d.]+)\}\);/.exec(body);
				assert.ok(match,'renderer must use the official Export command');
				const ids=JSON.parse(match[1]);
				const dir=JSON.parse(match[2]);
				await fixture.beforeExport();
				for (const id of ids) await writeFile(join(dir,`${id}.png`),PNG);
				return {value:{ids},warnings:[]};
			},
		}),
		onCommit:()=>()=>{},
	};
	return fixture;
}

test('close deletes its unreserved outputs but not unrelated files or batch directories',async()=>withTemp(async dir=>{
	const foreign=join(dir,'unrelated.png');
	const foreignBatch=join(dir,'.batch-someone-else','annotation.txt');
	await writeFile(foreign,'user image');
	await mkdir(join(dir,'.batch-someone-else'));
	await writeFile(foreignBatch,'user annotation');
	const renderer=createRenderer({document:documentFixture(),dir});
	try {
		await renderer.refresh(0);
		const image=await renderer.frameImage({frame_id:'frame',revision:0,max_side:4096});
		await renderer.close();
		await assert.rejects(readFile(image.path),error=>error.code==='ENOENT');
		assert.equal(await readFile(foreign,'utf8'),'user image');
		assert.equal(await readFile(foreignBatch,'utf8'),'user annotation');
	} finally {
		await renderer.close();
	}
}));

test('publication by another renderer durably protects the creating renderer output across restart',async()=>withTemp(async dir=>{
	const document=documentFixture();
	const creator=createRenderer({document,dir});
	const publisher=createRenderer({document,dir});
	let restarted;
	try {
		await creator.refresh(0);
		await publisher.refresh(0);
		const page=await publisher.frameList({frame_id:'frame',cursor:null});
		const savedBoard=JSON.parse(JSON.stringify(page));
		const intermediate=await creator.frameImage({frame_id:'frame',revision:0,max_side:5});
		const path=savedBoard.nodes[0].image.path;
		assert.deepEqual(await readFile(path),PNG);
		await publisher.close();
		await creator.close();
		assert.deepEqual(await readFile(path),PNG,'publication must survive both owners closing');
		restarted=createRenderer({document,dir});
		await restarted.refresh(0);
		await restarted.close();
		assert.deepEqual(await readFile(savedBoard.nodes[0].image.path),PNG,'saved boards read disk bytes after restart');
		await assert.rejects(readFile(intermediate.path),error=>error.code==='ENOENT');
	} finally {
		await publisher.close();
		await creator.close();
		if (restarted) await restarted.close();
	}
}));

test('a failed refresh completing after close cannot publish a late error or frame state',async()=>withTemp(async dir=>{
	const document=documentFixture();
	const renderer=createRenderer({document,dir});
	const entered=deferred();
	const release=deferred();
	try {
		await renderer.refresh(0);
		const previous=renderer.status();
		document.setRevision(1);
		document.beforeMetadata=async()=>{
			entered.resolve();
			await release.promise;
			throw Object.assign(Error('late engine failure'),{code:'EXPORT_FAILED'});
		};
		const refreshing=renderer.refresh(1);
		const rejected=assert.rejects(refreshing,error=>error.code==='EXPORT_FAILED'||error.code==='RENDER_CLOSED');
		await entered.promise;
		const closing=renderer.close();
		release.resolve();
		await rejected;
		await closing;
		assert.deepEqual(renderer.status(),{...previous,affected_frame_ids:null});
	} finally {
		release.resolve();
		await renderer.close();
	}
}));

test('an image export that finishes after close is rejected and leaves no intermediate PNG',async()=>withTemp(async dir=>{
	const document=documentFixture();
	const renderer=createRenderer({document,dir});
	const entered=deferred();
	const release=deferred();
	try {
		await renderer.refresh(0);
		const page=await renderer.frameList({frame_id:'frame',cursor:null});
		const previous=renderer.status();
		const files=(await readdir(dir)).sort();
		document.beforeExport=async()=>{ entered.resolve(); await release.promise; };
		const image=renderer.frameImage({frame_id:'frame',revision:0,max_side:5});
		const rejected=assert.rejects(image,error=>error.code==='RENDER_CLOSED');
		await entered.promise;
		const closing=renderer.close();
		release.resolve();
		await rejected;
		await closing;
		assert.deepEqual(renderer.status(),previous);
		assert.deepEqual(await readFile(page.nodes[0].image.path),PNG);
		assert.deepEqual((await readdir(dir)).sort(),files,'late exports must leave neither PNGs nor batch directories');
	} finally {
		release.resolve();
		await renderer.close();
	}
}));

test('frameList returns the last published revision without waiting for a pending refresh', {timeout:10000},async()=>withTemp(async dir=>{
	const document=documentFixture();
	const renderer=createRenderer({document,dir});
	const entered=deferred();
	const release=deferred();
	let timer;
	try {
		await renderer.refresh(0);
		const before=await renderer.frameList({frame_id:'frame',cursor:null});
		document.setRevision(1);
		document.beforeMetadata=async()=>{ entered.resolve(); await release.promise; };
		const refreshing=renderer.refresh(1);
		await entered.promise;
		const page=await Promise.race([
			renderer.frameList({frame_id:'frame',cursor:null}),
			new Promise((_,reject)=>{ timer=setTimeout(()=>reject(Error('frameList waited for rendering')),2000); }),
		]);
		assert.deepEqual(page,before);
		release.resolve();
		await refreshing;
	} finally {
		clearTimeout(timer);
		release.resolve();
		await renderer.close();
	}
}));

test('close preserves a user replacement of an output it previously created',async()=>withTemp(async dir=>{
	const renderer=createRenderer({document:documentFixture(),dir});
	try {
		await renderer.refresh(0);
		const image=await renderer.frameImage({frame_id:'frame',revision:0,max_side:4096});
		await unlink(image.path);
		await writeFile(image.path,'a replacement owned by the user');
		await renderer.close();
		assert.equal(await readFile(image.path,'utf8'),'a replacement owned by the user');
	} finally {
		await renderer.close();
	}
}));

test('frameList cannot expose an asset whose durable reservation fails',async()=>withTemp(async dir=>{
	const renderer=createRenderer({document:documentFixture(),dir});
	try {
		await renderer.refresh(0);
		const image=await renderer.frameImage({frame_id:'frame',revision:0,max_side:4096});
		await unlink(image.path);
		await assert.rejects(renderer.frameList({frame_id:'frame',cursor:null}),error=>error.code==='ENOENT');
	} finally {
		await renderer.close();
	}
}));

test('refresh exposes document-wide activity until the dirty frame diff is available',async()=>withTemp(async dir=>{
	const document=documentFixture();
	const renderer=createRenderer({document,dir});
	const metadataEntered=deferred();
	const metadataRelease=deferred();
	const exportEntered=deferred();
	const exportRelease=deferred();
	try {
		assert.equal(renderer.status().affected_frame_ids,null);
		document.beforeMetadata=async()=>{ metadataEntered.resolve(); await metadataRelease.promise; };
		document.beforeExport=async()=>{ exportEntered.resolve(); await exportRelease.promise; };
		const refreshing=renderer.refresh(0);
		await metadataEntered.promise;
		assert.equal(renderer.status().refreshing_revision,0);
		assert.equal(renderer.status().affected_frame_ids,null);
		metadataRelease.resolve();
		await exportEntered.promise;
		const status=renderer.status();
		assert.equal(status.refreshing_revision,0);
		assert.equal(status.rendered_revision,null);
		assert.deepEqual(status.affected_frame_ids,['frame']);
		status.affected_frame_ids.push('not-a-frame');
		assert.deepEqual(renderer.status().affected_frame_ids,['frame'],'callers cannot mutate pending affected IDs');
		exportRelease.resolve();
		await refreshing;
		assert.deepEqual(renderer.status().affected_frame_ids,['frame']);
	} finally {
		metadataRelease.resolve();
		exportRelease.resolve();
		await renderer.close();
	}
}));

test('closed or stale metadata cannot publish affected frame IDs',async t=>{
	for (const mode of ['closed','stale']) {
		await t.test(mode,async()=>withTemp(async dir=>{
			const document=documentFixture();
			const renderer=createRenderer({document,dir});
			const entered=deferred();
			const release=deferred();
			try {
				document.beforeMetadata=async()=>{ entered.resolve(); await release.promise; };
				const refreshing=renderer.refresh(0);
				await entered.promise;
				const closing=mode==='closed' ? renderer.close() : null;
				if (mode==='stale') document.setRevision(1);
				release.resolve();
				await refreshing;
				if (closing) await closing;
				assert.equal(renderer.status().affected_frame_ids,null);
				assert.equal(renderer.status().rendered_revision,null);
			} finally {
				release.resolve();
				await renderer.close();
			}
		}));
	}
});

test('a text bound to a variable is not offered to the board as text, a plain one is', async()=>withTemp(async dir=>{
	const document=documentFixture();
	const row=(path,parent,type,schema)=>({path,parent_path:parent,type,layout:'none',x:0,y:0,width:10,height:10,schema});
	document.readModel=async()=>({
		roots:[{id:'frame',type:'frame',width:10,height:10,children:[
			{id:'bound',type:'text',content:'$title'},
			{id:'plain',type:'text',content:'$5 only'},
		]}],
		rows:[{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:10,height:10}],
		variables:{title:{type:'string',value:'Resolved'}},
	});
	const engine=document.withEngine;
	document.withEngine=(revision,fn)=>engine(revision,inner=>fn({exec:async(body,options)=>{
		if (body.startsWith('Export(')) return inner.exec(body,options);
		return {value:{rows:[
			row('frame',null,'frame',{id:'frame',type:'frame',width:10,height:10}),
			// Metadata is read with variables resolved: the bound one carries the variable's value.
			row('bound','frame','text',{id:'bound',type:'text',content:'Resolved'}),
			row('plain','frame','text',{id:'plain',type:'text',content:'$5 only'}),
		]},warnings:[]};
	}}));
	const renderer=createRenderer({document,dir});
	try {
		await renderer.refresh(0);
		const page=renderer.projection({frame_id:'frame',cursor:null});
		const texts=Object.fromEntries(page.nodes.map(node=>[node.path,node.text]));
		assert.equal(texts.bound,undefined,'a bound text is left to the panel fields');
		assert.equal(texts.plain,'$5 only');
	} finally {
		await renderer.close();
	}
}));
