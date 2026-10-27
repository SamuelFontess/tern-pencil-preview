import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {builtinModules} from 'node:module';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildBundles,checkBuild} from '../build.mjs';
import {withTemp} from './helpers.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const RUNTIME=join(ROOT,'runtime');
const ARTIFACTS=['editor.mjs','mcp.mjs','THIRD_PARTY_NOTICES.txt','windows-replace.ps1'];

const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
async function digests(dir) {
	return Object.fromEntries(await Promise.all(ARTIFACTS.map(async name=>[name,await digest(join(dir,name))])));
}

test('two builds of the same sources are byte-identical', async()=>{
	await withTemp(async dir=>{
		await buildBundles(join(dir,'a'));
		await buildBundles(join(dir,'b'));
		assert.deepEqual((await readdir(join(dir,'a'))).sort(),[...ARTIFACTS].sort());
		assert.deepEqual(await digests(join(dir,'a')),await digests(join(dir,'b')));
	});
});

test('check:build compares every artifact byte for byte and never rewrites what it checks', async()=>{
	await withTemp(async dir=>{
		await buildBundles(dir);
		assert.deepEqual(await checkBuild(dir),[]);

		const bundle=join(dir,'editor.mjs');
		await writeFile(bundle,`${await readFile(bundle,'utf8')}\n// tampered`);
		await writeFile(join(dir,'THIRD_PARTY_NOTICES.txt'),'edited');
		await rm(join(dir,'windows-replace.ps1'));
		await writeFile(join(dir,'stray.mjs'),'');
		const before={};
		for (const name of await readdir(dir)) before[name]=await digest(join(dir,name));
		const differences=await checkBuild(dir);
		assert.deepEqual(differences.sort(),[
			'THIRD_PARTY_NOTICES.txt: differs from a fresh build',
			'editor.mjs: differs from a fresh build',
			'stray.mjs: not produced by the build',
			'windows-replace.ps1: missing from runtime/',
		].sort());
		const after={};
		for (const name of await readdir(dir)) after[name]=await digest(join(dir,name));
		assert.deepEqual(after,before);
	});
});

test('notices list each bundled package once, sorted, without paths or timestamps', async()=>{
	await withTemp(async dir=>{
		const {metafile}=await buildBundles(dir);
		const notices=await readFile(join(dir,'THIRD_PARTY_NOTICES.txt'),'utf8');
		const headers=[...notices.matchAll(/^={78}\n(\S+) (\S+) \(([^)]+)\)\n={78}$/gm)].map(match=>`${match[1]}@${match[2]}`);
		assert.ok(headers.length>=3);
		const names=headers.map(header=>header.slice(0,header.lastIndexOf('@')));
		assert.deepEqual(names,[...names].sort((a,b)=>a.localeCompare(b,'en')));
		assert.equal(new Set(headers).size,headers.length);
		const bundled=new Set(Object.keys(metafile.inputs).map(input=>{
			const match=/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
			return match?.[1];
		}).filter(Boolean));
		assert.deepEqual(new Set(headers.map(header=>header.slice(0,header.lastIndexOf('@')))),bundled);
		assert.equal(headers.some(header=>header.startsWith('@stencil-hq/tern@')),false,'the Tern panel SDK is gone with the panel');
		assert.ok(headers.some(header=>header.startsWith('@modelcontextprotocol/sdk@')));
		assert.doesNotMatch(notices,/\b[A-Za-z]:[\\/]|\/Users\/|\/home\//);
		assert.equal(notices.includes(ROOT.replaceAll('\\','/')),false);
		assert.equal(notices.includes('\r'),false);
	});
});

test('bundles resolve only from the project: no outside path, no Margin or Bun install, only node builtins external', async()=>{
	await withTemp(async dir=>{
		const {metafile}=await buildBundles(dir);
		for (const input of Object.keys(metafile.inputs)) {
			assert.match(input,/^(?:editor\/src|node_modules)\//,input);
			assert.doesNotMatch(input,/margin|\.bun|bun-/i);
		}
		const builtins=new Set([...builtinModules,...builtinModules.map(name=>`node:${name}`)]);
		for (const output of Object.values(metafile.outputs)) {
			for (const imported of output.imports.filter(item=>item.external||item.kind==='import-statement')) {
				assert.ok(builtins.has(imported.path),`${imported.path} must be a Node builtin`);
			}
		}
		for (const name of ['editor.mjs','mcp.mjs']) {
			const text=await readFile(join(dir,name),'utf8');
			assert.doesNotMatch(text,/[A-Za-z]:[\\/](?:Users|wt-|Program)/);
			assert.equal(text.includes(ROOT.replaceAll('\\','/')),false);
		}
	});
});

test('the Save helper ships beside the bundles unchanged', async()=>{
	await withTemp(async dir=>{
		await buildBundles(dir);
		assert.equal(await digest(join(dir,'windows-replace.ps1')),await digest(join(ROOT,'editor/windows/replace.ps1')));
	});
});

function run(args) {
	const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
	let stdout='';
	let stderr='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	child.stderr.setEncoding('utf8').on('data',chunk=>{ stderr+=chunk; });
	return new Promise((resolve,reject)=>{
		const timer=setTimeout(()=>{
			child.kill();
			reject(new Error('process timed out'));
		},60000);
		child.once('error',reject);
		child.once('close',code=>{
			clearTimeout(timer);
			resolve({code,stdout,stderr});
		});
	}).finally(()=>child.kill());
}

test('the distributed editor bundle runs from a path with a space and refuses what is not a launch', async()=>{
	await withTemp(async dir=>{
		await mkdir(join(dir,'plugin runtime'));
		const entry=join(dir,'plugin runtime','editor.mjs');
		await copyFile(join(RUNTIME,'editor.mjs'),entry);
		const usage=await run([entry]);
		assert.equal(usage.code,2);
		assert.equal(JSON.parse(usage.stdout).error.code,'USAGE');
		assert.equal(usage.stderr,'');
		const missing=await run([entry,'--launch',join(dir,'absent.json')]);
		assert.equal(missing.code,1);
		assert.equal(missing.stdout,'');
		assert.match(missing.stderr,/^Pencil editor failed to start: MANIFEST_INVALID\r?\n$/);
	});
});

test('the distributed MCP bundle refuses to start without an explicit document and keeps stdout clean', async()=>{
	const result=await run([join(RUNTIME,'mcp.mjs')]);
	assert.equal(result.code,1);
	assert.equal(result.stdout,'');
	assert.match(result.stderr,/MCP adapter failed/);
});
