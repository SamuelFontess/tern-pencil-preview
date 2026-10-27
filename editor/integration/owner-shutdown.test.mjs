import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {readdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ownerMode} from '../src/main.mjs';
import {systemTool} from '../src/system.mjs';
import {withTemp} from '../tests/helpers.mjs';
import {makeEngineFixture,testCliArgv} from './fixtures.mjs';

const MAIN=fileURLToPath(new URL('../src/main.mjs',import.meta.url));

async function processesMentioning(needle) {
	const child=spawn(systemTool('powershell'),[
		'-NoProfile','-NonInteractive','-Command',
		'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:NEEDLE) } | ForEach-Object { $_.ProcessId }',
	],{env:{...process.env,NEEDLE:needle},windowsHide:true,stdio:['ignore','pipe','ignore']});
	let stdout='';
	child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
	await new Promise(resolve=>child.once('close',resolve));
	return stdout.split(/\s+/).filter(Boolean);
}

async function startupSignal(dir,fire) {
	const fixture=await makeEngineFixture(dir);
	const dataDir=join(dir,'private');
	const manifest=join(dir,'launch.json');
	await writeFile(manifest,JSON.stringify({original_path:fixture.original,argv:testCliArgv(),data_dir:dataDir}));
	const events=new EventEmitter();
	let exitCode;
	const exits=[];
	const finished=ownerMode(manifest,MAIN,{events,exit:code=>{ exits.push(code); }});
	// Armed synchronously, before the owner exists: this is the startup window.
	fire(events);
	await finished;
	return {fixture,dataDir,exitCode:exits[0],exits,events};
}

async function assertNothingLeft({fixture,dataDir,dir}) {
	assert.deepEqual(await readdir(join(dataDir,'sources')),[]);
	assert.deepEqual(await readdir(join(dataDir,'sessions')),[]);
	assert.deepEqual((await readdir(dirname(fixture.original))).filter(name=>name.includes('.tern-pencil-')),[]);
	if (process.platform==='win32') assert.deepEqual(await processesMentioning(dir),[]);
}

test('a signal during owner startup closes the owner afterwards: no lock, working copy or engine child', {timeout:120000}, async () => withTemp(async dir => {
	const result=await startupSignal(dir,events=>events.emit('SIGTERM'));
	assert.equal(result.exitCode,0);
	await assertNothingLeft({...result,dir});
}));

test('the same signal twice during startup keeps the shutdown path armed and exits once, cleanly', {timeout:120000}, async () => withTemp(async dir => {
	let armedAfterFirst;
	const result=await startupSignal(dir,events=>{
		events.emit('SIGINT');
		armedAfterFirst=events.listenerCount('SIGINT');
		events.emit('SIGINT');
		events.emit('SIGHUP');
	});
	assert.equal(armedAfterFirst,1,'the listener must survive the first signal');
	assert.deepEqual(result.exits,[0]);
	await assertNothingLeft({...result,dir});
}));
