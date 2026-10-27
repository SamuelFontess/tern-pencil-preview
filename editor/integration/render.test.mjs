import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat,truncate,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {inflateSync} from 'node:zlib';
import {createRenderer} from '../src/render.mjs';
import {expected,withDocument} from './fixtures.mjs';

function decodePng(bytes) {
	assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
	let width;
	let height;
	let bitDepth;
	let colorType;
	const data=[];
	for (let offset=8;offset<bytes.length;) {
		const length=bytes.readUInt32BE(offset);
		const type=bytes.subarray(offset+4,offset+8).toString('ascii');
		const chunk=bytes.subarray(offset+8,offset+8+length);
		if (type==='IHDR') {
			width=chunk.readUInt32BE(0);
			height=chunk.readUInt32BE(4);
			bitDepth=chunk[8];
			colorType=chunk[9];
			assert.equal(chunk[12],0,'interlaced PNG is outside the test decoder');
		} else if (type==='IDAT') {
			data.push(chunk);
		} else if (type==='IEND') {
			break;
		}
		offset+=length+12;
	}
	assert.equal(bitDepth,8);
	const channels={0:1,2:3,4:2,6:4}[colorType];
	assert.ok(channels,'unsupported PNG color type');
	const raw=inflateSync(Buffer.concat(data));
	const stride=width*channels;
	const rows=[];
	let offset=0;
	let previous=Buffer.alloc(stride);
	for (let y=0;y<height;y+=1) {
		const filter=raw[offset];
		offset+=1;
		const source=raw.subarray(offset,offset+stride);
		offset+=stride;
		const row=Buffer.alloc(stride);
		for (let x=0;x<stride;x+=1) {
			const left=x>=channels ? row[x-channels] : 0;
			const up=previous[x];
			const upperLeft=x>=channels ? previous[x-channels] : 0;
			let prediction=0;
			if (filter===1) prediction=left;
			else if (filter===2) prediction=up;
			else if (filter===3) prediction=Math.floor((left+up)/2);
			else if (filter===4) {
				const p=left+up-upperLeft;
				const pa=Math.abs(p-left);
				const pb=Math.abs(p-up);
				const pc=Math.abs(p-upperLeft);
				prediction=pa<=pb&&pa<=pc ? left : pb<=pc ? up : upperLeft;
			} else assert.equal(filter,0,'unsupported PNG filter');
			row[x]=(source[x]+prediction)&255;
		}
		rows.push(row);
		previous=row;
	}
	const pixels=[];
	for (const row of rows) {
		for (let x=0;x<width;x+=1) {
			const at=x*channels;
			if (colorType===0) pixels.push([row[at],row[at],row[at],255]);
			else if (colorType===2) pixels.push([row[at],row[at+1],row[at+2],255]);
			else if (colorType===4) pixels.push([row[at],row[at],row[at],row[at+1]]);
			else pixels.push([row[at],row[at+1],row[at+2],row[at+3]]);
		}
	}
	return {width,height,pixels};
}

async function withRenderer(doc,fn) {
	const renderer=createRenderer({document:doc,dir:join(doc.source.working_path,'..','published-renders')});
	try {
		return await fn(renderer);
	} finally {
		await renderer.close();
	}
}


async function imageSnapshots(renderer,revision) {
	const snapshots=new Map();
	for (const frameId of renderer.status().frame_ids) {
		const image=await renderer.frameImage({frame_id:frameId,revision,max_side:4096});
		const bytes=await readFile(image.path);
		const metadata=await stat(image.path);
		snapshots.set(frameId,{
			path:image.path,
			hash:createHash('sha256').update(bytes).digest('hex'),
			mtimeMs:metadata.mtimeMs,
			size:metadata.size,
		});
	}
	return snapshots;
}

test('a local text change rewrites only its top-level frame PNG', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const beforeRevision=doc.info().revision;
	await renderer.refresh(beforeRevision);
	const before=await imageSnapshots(renderer,beforeRevision);
	const result=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Only this frame changed'}},
	]});
	await renderer.refresh(result.revision);
	const after=await imageSnapshots(renderer,result.revision);
	assert.deepEqual(renderer.status().exported_frame_ids,[doc.fixture.component]);
	assert.notEqual(after.get(doc.fixture.component).path,before.get(doc.fixture.component).path);
	assert.notEqual(after.get(doc.fixture.component).hash,before.get(doc.fixture.component).hash);
	for (const frameId of before.keys()) {
		if (frameId===doc.fixture.component) continue;
		assert.deepEqual(after.get(frameId),before.get(frameId));
	}
	assert.equal(renderer.status().rendered_revision,result.revision);
})));

test('missing and truncated current PNGs are rejected then selectively reexported', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const revision=doc.info().revision;
	await renderer.refresh(revision);
	const beforeMissing=await imageSnapshots(renderer,revision);

	const missingBefore=await renderer.frameImage({
		frame_id:doc.fixture.imageFrame,revision,max_side:4096,
	});
	const missingBytes=await readFile(missingBefore.path);
	await unlink(missingBefore.path);
	await assert.rejects(
		renderer.frameImage({frame_id:doc.fixture.imageFrame,revision,max_side:4096}),
		error=>error.code==='RENDER_MISSING',
	);
	await renderer.refresh(revision);
	assert.deepEqual(renderer.status().exported_frame_ids,[doc.fixture.imageFrame]);
	const afterMissing=await imageSnapshots(renderer,revision);
	assert.equal(afterMissing.get(doc.fixture.imageFrame).hash,beforeMissing.get(doc.fixture.imageFrame).hash);
	assert.equal(afterMissing.get(doc.fixture.imageFrame).size,beforeMissing.get(doc.fixture.imageFrame).size);
	assert.deepEqual(decodePng(await readFile(missingBefore.path)).pixels,decodePng(missingBytes).pixels);
	for (const frameId of beforeMissing.keys()) {
		if (frameId===doc.fixture.imageFrame) continue;
		assert.deepEqual(afterMissing.get(frameId),beforeMissing.get(frameId));
	}

	const beforeTruncated=afterMissing;
	const truncatedBefore=await renderer.frameImage({
		frame_id:doc.fixture.component,revision,max_side:4096,
	});
	const truncatedBytes=await readFile(truncatedBefore.path);
	await truncate(truncatedBefore.path,8);
	await assert.rejects(
		renderer.frameImage({frame_id:doc.fixture.component,revision,max_side:4096}),
		error=>error.code==='RENDER_MISSING',
	);
	await renderer.refresh(revision);
	assert.deepEqual(renderer.status().exported_frame_ids,[doc.fixture.component]);
	const afterTruncated=await imageSnapshots(renderer,revision);
	assert.equal(afterTruncated.get(doc.fixture.component).hash,beforeTruncated.get(doc.fixture.component).hash);
	assert.equal(afterTruncated.get(doc.fixture.component).size,beforeTruncated.get(doc.fixture.component).size);
	assert.deepEqual(decodePng(await readFile(truncatedBefore.path)).pixels,decodePng(truncatedBytes).pixels);
	for (const frameId of beforeTruncated.keys()) {
		if (frameId===doc.fixture.component) continue;
		assert.deepEqual(afterTruncated.get(frameId),beforeTruncated.get(frameId));
	}
})));

test('removing an invalid frame clears its forced-refresh state', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const initialRevision=doc.info().revision;
	await renderer.refresh(initialRevision);
	const removed=await renderer.frameImage({
		frame_id:doc.fixture.imageFrame,revision:initialRevision,max_side:4096,
	});
	await unlink(removed.path);
	await assert.rejects(
		renderer.frameImage({frame_id:doc.fixture.imageFrame,revision:initialRevision,max_side:4096}),
		error=>error.code==='RENDER_MISSING',
	);

	const deletion=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'delete',path:doc.fixture.imageFrame},
	]});
	await renderer.refresh(deletion.revision);
	assert.ok(!renderer.status().frame_ids.includes(doc.fixture.imageFrame));
	assert.deepEqual(renderer.status().exported_frame_ids,[]);
	const beforeRepeat=await imageSnapshots(renderer,deletion.revision);
	const readModel=doc.readModel.bind(doc);
	try {
		doc.readModel=async()=>{ throw Error('same revision refresh must return early'); };
		await renderer.refresh(deletion.revision);
	} finally {
		doc.readModel=readModel;
	}
	assert.deepEqual(await imageSnapshots(renderer,deletion.revision),beforeRepeat);
})));

test('a max_side that quantizes to zero is rejected before Export', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const revision=doc.info().revision;
	await renderer.refresh(revision);
	await assert.rejects(
		renderer.frameImage({frame_id:doc.fixture.imageFrame,revision,max_side:1e-9}),
		error=>error.code==='RENDER_SCALE_INVALID',
	);
})));

test('shared variables and components invalidate only dependent frames', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const seeded=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Variable user',x:700,y:0,width:20,height:20,fill:'$accent'}},

		{op:'insert',parent:null,node:{type:'frame',name:'Component user',x:730,y:0,width:100,height:80,
			children:[{type:'ref',ref:doc.fixture.component}]}},
	]});
	const variableFrame=seeded.created[0].path;
	const componentFrame=seeded.created[1].path;
	await renderer.refresh(seeded.revision);

	const variableChange=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'set_variables',variables:{accent:{type:'color',value:'#22AA44'}}},
	]});
	await renderer.refresh(variableChange.revision);
	assert.ok(renderer.status().exported_frame_ids.includes(variableFrame));
	assert.ok(!renderer.status().exported_frame_ids.includes(doc.fixture.imageFrame));

	const componentChange=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{content:'Shared component changed'}},
	]});
	await renderer.refresh(componentChange.revision);
	assert.deepEqual(new Set(renderer.status().exported_frame_ids),new Set([
		doc.fixture.component,componentFrame,
	]));
})));

test('official PNG keeps relative assets and a solid-color pixel golden', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const inserted=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Golden',x:900,y:0,width:4,height:3,fill:'#336699'}},
	]});
	const goldenFrame=inserted.created[0].path;
	await renderer.refresh(inserted.revision);

	const golden=decodePng(await readFile((await renderer.frameImage({
		frame_id:goldenFrame,revision:inserted.revision,max_side:4096,
	})).path));
	assert.equal(golden.width,4);
	assert.equal(golden.height,3);
	assert.ok(golden.pixels.every(pixel=>assert.deepEqual(pixel,[0x33,0x66,0x99,0xff])===undefined));

	const source=decodePng(await readFile(join(doc.source.working_path,'..','fixture.png')));
	assert.ok(source.pixels.every(pixel=>assert.deepEqual(pixel,source.pixels[0])===undefined));
	const rendered=decodePng(await readFile((await renderer.frameImage({
		frame_id:doc.fixture.imageFrame,revision:inserted.revision,max_side:4096,
	})).path));
	assert.ok(rendered.pixels.every(pixel=>assert.deepEqual(pixel,source.pixels[0])===undefined));
})));

test('projection pages never exceed 64 nodes or 32 KiB', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	const children=Array.from({length:70},(_,index)=>({
		type:'frame',name:`Node ${index}`,x:index,y:0,width:1,height:1,fill:'#000000',
	}));
	const inserted=await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'insert',parent:null,node:{type:'frame',name:'Paged',x:1000,y:0,width:100,height:10,children}},
	]});
	const frameId=inserted.created[0].path;
	await renderer.refresh(inserted.revision);
	let cursor=null;
	let count=0;
	do {
		const page=renderer.projection({frame_id:frameId,cursor});
		assert.ok(page.nodes.length<=64);
		assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=32*1024);
		count+=page.nodes.length;
		cursor=page.next_cursor;
	} while (cursor!==null);
	assert.equal(count,71);
})));

test('frame list pages give every frame its page box and a published PNG, and stay within the page limits', {timeout:120000}, async () => withDocument(doc=>withRenderer(doc,async renderer=>{
	await renderer.refresh(doc.info().revision);
	const ids=renderer.status().frame_ids;
	const page=await renderer.frameList({frame_id:ids[0],cursor:null});
	assert.equal(page.frame_id,ids[0]);
	assert.equal(page.revision,doc.info().revision);
	assert.deepEqual(page.nodes.map(node=>node.id),ids);
	assert.equal(page.next_cursor,null);
	for (const node of page.nodes) {
		assert.ok(node.w>0&&node.h>0&&Number.isFinite(node.x)&&Number.isFinite(node.y));
		assert.equal(typeof node.fill,'boolean');
		assert.equal(typeof node.key,'string');
		const bytes=await readFile(node.image.path);
		assert.equal(decodePng(bytes).width,node.image.width);
	}
	await assert.rejects(renderer.frameList({frame_id:ids[0],cursor:ids.length+1}),error=>error.code==='RENDER_CURSOR_INVALID');
	const many=Array.from({length:70},(_,index)=>({
		type:'frame',name:`F ${index}`,x:index*10,y:5000,width:5,height:5,fill:'#000000',
	}));
	const inserted=await doc.applyChanges({...expected(doc.info()),operations:many.map(node=>({op:'insert',parent:null,node}))});
	await renderer.refresh(inserted.revision);
	let cursor=null;
	let count=0;
	do {
		const next=await renderer.frameList({frame_id:ids[0],cursor});
		assert.ok(next.nodes.length<=64);
		assert.ok(Buffer.byteLength(JSON.stringify(next),'utf8')<=32*1024);
		count+=next.nodes.length;
		cursor=next.next_cursor;
	} while (cursor!==null);
	assert.equal(count,ids.length+70);
})));

test('a render result for a revision that changed does not become current', async () => {
	let revision=1;
	let releaseMetadata;
	const metadataReady=new Promise(resolve=>{ releaseMetadata=resolve; });
	const document={
		info:()=>({revision}),
		readModel:async()=>({
			roots:[{id:'frame',type:'frame',width:10,height:10,children:[]}],
			rows:[{path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:10,height:10}],
			variables:{},
		}),
		withEngine:async(expectedRevision,fn)=>fn({
			exec:async()=>{
				await metadataReady;
				return {value:{rows:[{
					path:'frame',parent_path:null,type:'frame',layout:'none',x:0,y:0,width:10,height:10,
					schema:{id:'frame',type:'frame',width:10,height:10},
				}]},warnings:[]};
			},
		}),
		onCommit:()=>()=>{},
	};
	const renderer=createRenderer({document,dir:'unused'});
	try {
		const refreshing=renderer.refresh(1);
		revision=2;
		releaseMetadata();
		await refreshing;
		assert.equal(renderer.status().rendered_revision,null);
	} finally {
		await renderer.close();
	}
});

test('measures applyChanges immediately after render against an edit without render', {timeout:120000}, async t=>withDocument(async doc=>{
	let started=performance.now();
	await doc.applyChanges({...expected(doc.info()),operations:[
		{op:'update',path:doc.fixture.text,props:{fontSize:17}},
	]});
	const withoutRenderMs=performance.now()-started;

	await withRenderer(doc,async renderer=>{
		await renderer.refresh(doc.info().revision);
		started=performance.now();
		await doc.applyChanges({...expected(doc.info()),operations:[
			{op:'update',path:doc.fixture.text,props:{fontSize:18}},
		]});
		const afterRenderMs=performance.now()-started;
		t.diagnostic(`render restart timing: without_render_ms=${withoutRenderMs.toFixed(1)} after_render_ms=${afterRenderMs.toFixed(1)}`);
		assert.ok(withoutRenderMs>0);
		assert.ok(afterRenderMs>0);
	});
}));
