import {build} from 'esbuild';
import {copyFile,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isEntry} from './src/entry.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const ARTIFACTS=['editor.mjs','mcp.mjs','THIRD_PARTY_NOTICES.txt','windows-replace.ps1'];
const LICENSE_FILE=/^(?:licen[cs]e|copying)(?:[-.].*)?$/i;

/** Package directory and name of a `node_modules/...` input path; the innermost install wins. */
function packageOf(input) {
	const marker='node_modules/';
	const at=input.lastIndexOf(marker);
	if (at<0) return null;
	const parts=input.slice(at+marker.length).split('/');
	const name=parts[0].startsWith('@')?`${parts[0]}/${parts[1]}`:parts[0];
	return {name,dir:input.slice(0,at+marker.length)+name};
}

async function noticeFor(dir,name) {
	const absolute=join(ROOT,dir);
	const manifest=JSON.parse(await readFile(join(absolute,'package.json'),'utf8'));
	const files=(await readdir(absolute)).filter(file=>LICENSE_FILE.test(file)).sort();
	const license=typeof manifest.license==='string'?manifest.license:null;
	if (files.length===0) {
		// Some packages publish only the SPDX id in package.json; the notice then records exactly that.
		if (!license) throw new Error(`Bundled package ${name} declares no license`);
		const source=typeof manifest.repository?.url==='string'?`\nSource: ${manifest.repository.url.replace(/^git\+/,'')}`:'';
		return {name,version:manifest.version,license,text:`License ${license}, declared in package.json; the package ships no license file.${source}`};
	}
	const text=(await readFile(join(absolute,files[0]),'utf8')).replaceAll('\r\n','\n').trim();
	return {name,version:manifest.version,license:license??'see text',text};
}

/** Licenses of the packages actually present in the metafile, sorted, without paths or dates. */
async function thirdPartyNotices(metafile) {
	const dirs=new Map();
	for (const input of Object.keys(metafile.inputs)) {
		const owner=packageOf(input);
		if (owner) dirs.set(owner.dir,owner.name);
	}
	const notices=await Promise.all([...dirs].map(([dir,name])=>noticeFor(dir,name)));
	notices.sort((a,b)=>a.name.localeCompare(b.name,'en')||a.version.localeCompare(b.version,'en'));
	const rule='='.repeat(78);
	return [
		'THIRD-PARTY NOTICES',
		'',
		'The runtime bundles editor.mjs and mcp.mjs include the following packages.',
		'',
		...notices.flatMap(item=>[rule,`${item.name} ${item.version} (${item.license})`,rule,item.text,'']),
	].join('\n');
}

/**
 * Build both runtime bundles, the Windows replace helper and the license notices into `outdir`.
 * @param {string} outdir
 */
export async function buildBundles(outdir) {
	await mkdir(outdir,{recursive:true});
	const result=await build({
		absWorkingDir:ROOT,
		entryPoints:{editor:'editor/src/main.mjs',mcp:'editor/src/mcp.mjs'},
		outdir,outExtension:{'.js':'.mjs'},platform:'node',format:'esm',target:'node22',
		bundle:true,metafile:true,sourcemap:false,legalComments:'eof',logLevel:'silent',
		banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},
	});
	await copyFile(join(ROOT,'editor/windows/replace.ps1'),join(outdir,'windows-replace.ps1'));
	await writeFile(join(outdir,'THIRD_PARTY_NOTICES.txt'),`${await thirdPartyNotices(result.metafile)}\n`);
	return result;
}

/**
 * Rebuild into a temporary directory and compare every artifact with the distributed runtime/ byte for byte.
 * The distributed directory is only read.
 * @param {string} [runtimeDir]
 * @returns {Promise<string[]>} differences; empty when the bundles are current
 */
export async function checkBuild(runtimeDir=join(ROOT,'runtime')) {
	const scratch=join(ROOT,'editor','.build',`check-${process.pid}`);
	await rm(scratch,{recursive:true,force:true});
	try {
		await buildBundles(scratch);
		const differences=[];
		for (const name of ARTIFACTS) {
			let distributed;
			try {
				distributed=await readFile(join(runtimeDir,name));
			} catch {
				differences.push(`${name}: missing from runtime/`);
				continue;
			}
			if (!distributed.equals(await readFile(join(scratch,name)))) differences.push(`${name}: differs from a fresh build`);
		}
		const present=await readdir(runtimeDir).catch(()=>[]);
		for (const name of present) {
			if (!ARTIFACTS.includes(name)) differences.push(`${name}: not produced by the build`);
		}
		return differences;
	} finally {
		await rm(scratch,{recursive:true,force:true});
	}
}

if (isEntry(import.meta.url)) {
	const [command]=process.argv.slice(2);
	if (command==='check') {
		const differences=await checkBuild();
		if (differences.length>0) {
			process.stderr.write(`runtime/ is out of date:\n${differences.map(item=>`  ${item}`).join('\n')}\nRun npm run build.\n`);
			process.exitCode=1;
		}
	} else if (command===undefined) {
		await buildBundles(join(ROOT,'runtime'));
	} else {
		process.stderr.write('Usage: node editor/build.mjs [check]\n');
		process.exitCode=2;
	}
}
