import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainedIds} from '../src/history.mjs';
import {openStore} from '../src/store.mjs';
import {withTemp} from './helpers.mjs';

function index(snapshots, cursor, saved_id, sizes) {
	return {
		version: 1,
		source: {fingerprint: 'source-fingerprint'},
		snapshots,
		cursor,
		saved_id,
		revision: 1,
		sizes,
	};
}

test('read rejects a corrupted immutable checkpoint', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const checkpoint = await store.put(Buffer.from('confirmed'));
	await writeFile(join(dir, `${checkpoint.id}.checkpoint`), 'corrupted');
	await assert.rejects(store.read(checkpoint.id), error => error.code === 'CHECKPOINT_CORRUPT');
}));

test('concurrent puts publish only complete checkpoints and leave no temporary files', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const repeated = Buffer.alloc(16 * 1024 * 1024, 0x61);
	const distinct = Array.from({length: 16}, (_, position) => Buffer.from(`distinct-${position}`));
	const refs = await Promise.all([
		...Array.from({length: 24}, () => store.put(repeated)),
		...distinct.map(bytes => store.put(bytes)),
	]);

	assert.equal(new Set(refs.slice(0, 24).map(ref => ref.id)).size, 1);
	assert.deepEqual(await store.read(refs[0].id), repeated);
	for (let position = 0; position < distinct.length; position += 1) {
		assert.deepEqual(await store.read(refs[24 + position].id), distinct[position]);
	}
	assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.ckpt-pending')), []);
}));

test('a failure after opening a put leaves no final checkpoint or temporary file', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const bytes = Buffer.allocUnsafeSlow(1024 * 1024);
	bytes.fill(0x5a);
	const id = createHash('sha256').update(bytes).digest('hex');
	const writing = store.put(bytes);
	structuredClone(bytes.buffer, {transfer: [bytes.buffer]});

	await assert.rejects(writing);
	await assert.rejects(readFile(join(dir, `${id}.checkpoint`)), error => error.code === 'ENOENT');
	assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.ckpt-pending')), []);
}));


test('reopening after interruption ignores unreferenced checkpoints and pending indexes', async () => withTemp(async dir => {
	const first = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const confirmed = await first.put(Buffer.from('confirmed'));
	const confirmedIndex = index([confirmed.id], 0, confirmed.id, {[confirmed.id]: confirmed.bytes});
	await first.publish(confirmedIndex);
	await first.put(Buffer.from('interrupted before publication'));
	await writeFile(join(dir, `${randomUUID()}.ckpt-pending`), 'partial checkpoint bytes');
	await writeFile(join(dir, `${randomUUID()}.pending`), '{"snapshots":');

	const reopened = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	assert.deepEqual(await reopened.load(), confirmedIndex);
}));

test('rejects an incomplete published index instead of loading partial state', async () => withTemp(async dir => {
	await writeFile(join(dir, 'index.json'), '{"snapshots":');
	await assert.rejects(
		openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024}),
		error => error.code === 'INDEX_INVALID',
	);
}));

test('requires versioned source metadata for published indexes', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const checkpoint = await store.put(Buffer.from('confirmed'));
	const valid = index([checkpoint.id], 0, checkpoint.id, {[checkpoint.id]: checkpoint.bytes});
	await assert.rejects(
		store.publish({...valid, version: 2}),
		error => error.code === 'INDEX_INVALID',
	);
	await assert.rejects(
		store.publish({...valid, source: {fingerprint: ''}}),
		error => error.code === 'INDEX_INVALID',
	);
}));

test('publish rejects missing or size-divergent checkpoints without replacing the prior index', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const confirmed = await store.put(Buffer.from('confirmed'));
	const baseline = index([confirmed.id], 0, confirmed.id, {[confirmed.id]: confirmed.bytes});
	await store.publish(baseline);
	const missing = 'f'.repeat(64);
	await assert.rejects(
		store.publish(index([confirmed.id, missing], 1, confirmed.id, {
			[confirmed.id]: confirmed.bytes,
			[missing]: 1,
		})),
		error => ['INDEX_INVALID', 'CHECKPOINT_MISSING'].includes(error.code),
	);
	await assert.rejects(
		store.publish(index([confirmed.id], 0, confirmed.id, {[confirmed.id]: confirmed.bytes + 1})),
		error => error.code === 'INDEX_INVALID',
	);
	assert.deepEqual(await store.load(), baseline);
}));

test('opening rejects indexes with missing or size-divergent checkpoints', async () => withTemp(async dir => {
	const writer = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const checkpoint = await writer.put(Buffer.from('confirmed'));
	const missing = 'e'.repeat(64);
	await writeFile(join(dir, 'index.json'), JSON.stringify(index([missing], 0, missing, {[missing]: 1})));
	await assert.rejects(
		openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024}),
		error => ['INDEX_INVALID', 'CHECKPOINT_MISSING'].includes(error.code),
	);
	await writeFile(join(dir, 'index.json'), JSON.stringify(index(
		[checkpoint.id],
		0,
		checkpoint.id,
		{[checkpoint.id]: checkpoint.bytes + 1},
	)));
	await assert.rejects(
		openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024}),
		error => error.code === 'INDEX_INVALID',
	);
}));


test('publish and prune serialize so the final index never references removed checkpoints', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 100, max_bytes: 200 * 1024 * 1024});
	const removed = await store.put(Buffer.from('removed then restored'));
	const fillers = await Promise.all(Array.from(
		{length: 48},
		(_, position) => store.put(Buffer.from(`filler-${position}`)),
	));
	const current = await store.put(Buffer.from('current'));
	const fullRefs = [removed, ...fillers, current];
	const full = index(
		fullRefs.map(ref => ref.id),
		fullRefs.length - 1,
		current.id,
		Object.fromEntries(fullRefs.map(ref => [ref.id, ref.bytes])),
	);
	await store.publish(full);
	const dropped = index([current.id], 0, current.id, {[current.id]: current.bytes});
	await store.publish(dropped);

	await Promise.all([
		store.publish(full),
		store.prune(retainedIds(dropped)),
	]);

	const loaded = await store.load();
	assert.deepEqual(loaded, full);
	for (const id of retainedIds(loaded)) await store.read(id);
}));

test('a failed mutation does not block the next serialized store operation', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const checkpoint = await store.put(Buffer.from('confirmed'));
	const valid = index([checkpoint.id], 0, checkpoint.id, {[checkpoint.id]: checkpoint.bytes});
	const missing = 'd'.repeat(64);
	await assert.rejects(store.publish(index([missing], 0, missing, {[missing]: 1})));
	assert.deepEqual(await store.publish(valid), valid);
}));

test('retention protects saved files without retaining saved history positions', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 10, max_bytes: 10});
	const a = await store.put(Buffer.from('aaaaaa'));
	const b = await store.put(Buffer.from('bbbbbb'));
	const c = await store.put(Buffer.from('cccccc'));
	const published = await store.publish(index(
		[a.id, b.id, c.id],
		2,
		a.id,
		{[a.id]: a.bytes, [b.id]: b.bytes, [c.id]: c.bytes},
	));
	assert.deepEqual(published.snapshots, [c.id]);
	assert.equal(published.cursor, 0);
	assert.deepEqual([...retainedIds(published)].sort(), [a.id, c.id].sort());
}));

test('retention counts saved files outside the branch and keeps the cursor valid', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 10, max_bytes: 12});
	const optional = await store.put(Buffer.from('optional'));
	const current = await store.put(Buffer.from('current'));
	const saved = await store.put(Buffer.from('saved!'));
	const published = await store.publish(index(
		[optional.id, current.id],
		1,
		saved.id,
		{[optional.id]: optional.bytes, [current.id]: current.bytes, [saved.id]: saved.bytes},
	));
	assert.deepEqual(published.snapshots, [current.id]);
	assert.equal(published.cursor, 0);
	assert.deepEqual([...retainedIds(published)].sort(), [current.id, saved.id].sort());
}));

test('retention limits ordinary history to the configured step count', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 2, max_bytes: 100});
	const a = await store.put(Buffer.from('a'));
	const b = await store.put(Buffer.from('b'));
	const c = await store.put(Buffer.from('c'));
	const published = await store.publish(index(
		[a.id, b.id, c.id],
		2,
		c.id,
		{[a.id]: a.bytes, [b.id]: b.bytes, [c.id]: c.bytes},
	));
	assert.deepEqual(published.snapshots, [b.id, c.id]);
	assert.equal(published.cursor, 1);
}));

test('retention counts repeated snapshots as positions and keeps the cursor', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 2, max_bytes: 200 * 1024 * 1024});
	const a = await store.put(Buffer.from('a'));
	const b = await store.put(Buffer.from('b'));
	const published = await store.publish(index(
		[a.id, b.id, a.id],
		2,
		b.id,
		{[a.id]: a.bytes, [b.id]: b.bytes},
	));
	assert.deepEqual(published.snapshots, [b.id, a.id]);
	assert.equal(published.cursor, 1);
}));

test('retention charges duplicate snapshots only once against the byte limit', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 4, max_bytes: 3});
	const b = await store.put(Buffer.from('b'));
	const a = await store.put(Buffer.from('a'));
	const c = await store.put(Buffer.from('c'));
	const published = await store.publish(index(
		[b.id, a.id, a.id, c.id],
		3,
		c.id,
		{[a.id]: a.bytes, [b.id]: b.bytes, [c.id]: c.bytes},
	));
	assert.deepEqual(published.snapshots, [b.id, a.id, a.id, c.id]);
	assert.equal(published.cursor, 3);
}));

test('prune keeps a checkpoint still referenced by a retained repeated position', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 2, max_bytes: 200 * 1024 * 1024});
	const a = await store.put(Buffer.from('a'));
	const b = await store.put(Buffer.from('b'));
	const repeated = index(
		[a.id, b.id, a.id],
		2,
		b.id,
		{[a.id]: a.bytes, [b.id]: b.bytes},
	);
	const published = await store.publish(repeated);
	assert.deepEqual(published.snapshots, [b.id, a.id]);
	await store.publish(index([b.id], 0, b.id, {[b.id]: b.bytes}));
	const restored = await store.publish(repeated);
	await store.prune(retainedIds(restored));
	assert.deepEqual(await store.read(a.id), Buffer.from('a'));
}));

test('prune removes only formerly indexed checkpoints after publishing the replacement index', async () => withTemp(async dir => {
	const store = await openStore({dir, max_steps: 50, max_bytes: 200 * 1024 * 1024});
	const a = await store.put(Buffer.from('a'));
	const b = await store.put(Buffer.from('b'));
	const c = await store.put(Buffer.from('c'));
	const first = index(
		[a.id, b.id, c.id],
		2,
		a.id,
		{[a.id]: a.bytes, [b.id]: b.bytes, [c.id]: c.bytes},
	);
	await store.publish(first);
	const replacement = index(
		[a.id, c.id],
		1,
		a.id,
		{[a.id]: a.bytes, [c.id]: c.bytes},
	);
	const published = await store.publish(replacement);
	const unknown = join(dir, 'unrelated.checkpoint');
	await writeFile(unknown, 'do not remove');
	await store.prune(retainedIds(published));

	assert.deepEqual(await store.read(a.id), Buffer.from('a'));
	assert.deepEqual(await store.read(c.id), Buffer.from('c'));
	await assert.rejects(store.read(b.id), error => error.code === 'CHECKPOINT_NOT_FOUND');
	assert.equal(await readFile(unknown, 'utf8'), 'do not remove');
}));
