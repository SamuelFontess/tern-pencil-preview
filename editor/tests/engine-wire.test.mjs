import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeReply,startEngine} from '../src/engine.mjs';
import {EditorError} from '../src/errors.mjs';

const fakeCli = String.raw`
const mode=process.argv[1];
const prompt='\u001b[36mpen\u001b[39m \u001b[2m>\u001b[22m ';
let calls=0;
function writeChunked(text) {
	const bytes=Buffer.from(text);
	const split=bytes.indexOf(0xc3)+1;
	if (split>0) {
		process.stdout.write(bytes.subarray(0,split));
		setTimeout(()=>process.stdout.write(bytes.subarray(split)),5);
	} else {
		process.stdout.write(bytes.subarray(0,2));
		setTimeout(()=>process.stdout.write(bytes.subarray(2)),5);
	}
}
process.stdout.write(prompt.slice(0,-1));
setTimeout(()=>process.stdout.write(prompt.slice(-1)),5);
let pending='';
process.stdin.on('data',chunk=>{
	pending+=chunk;
	for (;;) {
		const newline=pending.indexOf('\n');
		if (newline<0) break;
		const line=pending.slice(0,newline);
		pending=pending.slice(newline+1);
		if (line==='exit()') process.exit(0);
		if (line==='save()') {
			writeChunked('Saved output.pen\n'+prompt);
			continue;
		}
		if (line.startsWith('read_skill(')) {
			writeChunked('Schema documents Error values.\n'+prompt);
			continue;
		}
		if (!line.startsWith('execute(')) continue;
		calls+=1;
		if (mode==='timeout') continue;
		if (mode==='eof') process.exit(0);
		const payload=JSON.parse(line.slice(8,-1));
		const nonce=/bridge:"([^"]+)"/.exec(payload.input)?.[1];
		if (mode==='second-reject'&&calls===2) {
			writeChunked('failed to execute\n'+prompt);
			continue;
		}
		if (mode==='fonts-reject'&&payload.input.includes("'png'")) {
			writeChunked('failed to execute\n'+prompt);
			continue;
		}
		if (mode==='fonts') {
			const dir=/Export\(\[.*?\],'png',("(?:[^"\\]|\\.)*")/.exec(payload.input);
			const path=dir&&JSON.parse(dir[1]);
			const value={path,existedDuringRun:path!==null&&require('node:fs').existsSync(path)};
			writeChunked('OK\n'+JSON.stringify({bridge:nonce,value})+'\n\n'+prompt);
			continue;
		}
		writeChunked('OK\n{"bridge":"'+nonce+'","value":"olá pen > aqui"}\n\n'+prompt);
	}
});
`;

function fakeArgv(mode) {
	return [process.execPath,'-e',fakeCli,mode];
}

function options(mode, timeout_ms=1000) {
	return {argv:fakeArgv(mode),input:'input.pen',output:'output.pen',timeout_ms};
}

test('does not confuse prompt text inside reply content with termination', () => {
	const stdout = 'OK\n{"bridge":"n1","value":"texto pen > aqui"}\n\npen > ';
	assert.deepEqual(decodeReply({stdout,stderr:'',nonce:'n1'}), {
		value:'texto pen > aqui',
		warnings:[],
	});
});

test('rejects a reply carrying a different marker', () => {
	assert.throws(
		() => decodeReply({stdout:'{"bridge":"old","value":1}\npen > ',stderr:'',nonce:'new'}),
		error => error.code==='ENGINE_PROTOCOL',
	);
});

test('rejects execute errors without a marker', () => {
	assert.throws(
		() => decodeReply({stdout:'pen > ',stderr:'failed to execute',nonce:'n2'}),
		error => error.code==='ENGINE_REJECTED',
	);
});

test('streams fragmented UTF-8 and waits for the complete prompt', async () => {
	const engine=await startEngine(options('success'));
	try {
		assert.deepEqual(await engine.exec('return "ignored";'), {
			value:'olá pen > aqui',
			warnings:[],
		});
	} finally {
		await engine.close();
	}
});

test('a measuring read waits for fonts once per possible edit and cleans up its scratch directory', async () => {
	const engine=await startEngine(options('fonts'));
	try {
		const measure=()=>engine.exec('return 1;',{kind:'measure'});
		const first=(await measure()).value;
		assert.equal(typeof first.path,'string');
		assert.equal(first.existedDuringRun,true);
		assert.equal(existsSync(first.path),false);
		assert.equal((await measure()).value.path,null);
		assert.equal((await engine.exec('return 1;',{kind:'read'})).value.path,null);
		assert.equal((await measure()).value.path,null);
		assert.equal((await engine.exec('return 1;')).value.path,null);
		assert.equal(typeof (await measure()).value.path,'string');
		assert.equal((await measure()).value.path,null);
	} finally {
		await engine.close();
	}
});

test('a font barrier the engine rejects fails the read without returning bounds', async () => {
	const engine=await startEngine(options('fonts-reject'));
	try {
		await assert.rejects(
			engine.exec('return 1;',{kind:'measure'}),
			error=>error instanceof EditorError&&error.code==='ENGINE_REJECTED',
		);
	} finally {
		await engine.close();
	}
});

test('a scratch directory that cannot be created fails the read and leaves the engine usable', async () => {
	const engine=await startEngine(options('fonts'));
	const names=['TMPDIR','TMP','TEMP'];
	const saved=names.map(name=>process.env[name]);
	const missing=join(tmpdir(),`missing-${randomUUID()}`);
	for (const name of names) process.env[name]=missing;
	try {
		await assert.rejects(
			engine.exec('return 1;',{kind:'measure'}),
			error=>error instanceof EditorError&&error.code==='ENGINE_FONTS',
		);
	} finally {
		names.forEach((name,index)=>{
			if (saved[index]===undefined) delete process.env[name];
			else process.env[name]=saved[index];
		});
	}
	try {
		assert.equal((await engine.exec('return 1;',{kind:'read'})).value.path,null);
		assert.equal(typeof (await engine.exec('return 1;',{kind:'measure'})).value.path,'string');
	} finally {
		await engine.close();
	}
});

test('rejects an unknown execute kind', async () => {
	const engine=await startEngine(options('success'));
	try {
		await assert.rejects(engine.exec('return 1;',{kind:'bounds'}),error=>error.code==='ENGINE_INPUT');
	} finally {
		await engine.close();
	}
});

test('an execute error cannot return the preceding result', async () => {
	const engine=await startEngine(options('second-reject'));
	try {
		assert.equal((await engine.exec('return 1;')).value,'olá pen > aqui');
		await assert.rejects(
			engine.exec('return 2;'),
			error => error.code==='ENGINE_REJECTED',
		);
	} finally {
		await engine.close();
	}
});

test('times out a command that never reaches a reply prompt', async () => {
	const engine=await startEngine(options('timeout',500));
	try {
		await assert.rejects(
			engine.exec('return 1;'),
			error => error.code==='ENGINE_TIMEOUT',
		);
	} finally {
		await engine.close();
	}
});

test('rejects EOF before a command reply', async () => {
	const engine=await startEngine(options('eof'));
	try {
		await assert.rejects(
			engine.exec('return 1;'),
			error => error.code==='ENGINE_EOF',
		);
	} finally {
		await engine.close();
	}
});


test('save and schema use marker-free shell commands', async () => {
	const engine=await startEngine(options('success'));
	try {
		await engine.save();
		assert.match(await engine.schema(),/Schema documents Error values/);
	} finally {
		await engine.close();
	}
});

function processIsAlive(pid) {
	try {
		process.kill(pid,0);
		return true;
	} catch (error) {
		if (error.code==='ESRCH') return false;
		throw error;
	}
}

test('close aborts a pending execute and queued work without waiting for command timeout', {timeout:5000}, async () => {
	const engine=await startEngine(options('timeout',1200));
	const pid=engine.pid;
	try {
		const active=engine.exec('return "active";');
		const queued=engine.exec('return "queued";');
		const activeRejected=assert.rejects(active,error=>error.code==='ENGINE_CLOSED');
		const queuedRejected=assert.rejects(queued,error=>error.code==='ENGINE_CLOSED');
		await new Promise(resolve=>setImmediate(resolve));
		const started=performance.now();
		const firstClose=engine.close();
		const secondClose=engine.close();
		assert.strictEqual(firstClose,secondClose);
		await Promise.all([firstClose,secondClose,activeRejected,queuedRejected]);
		assert.ok(performance.now()-started<800,'close waited for the command timeout');
		assert.equal(processIsAlive(pid),false);
	} finally {
		await engine.close();
	}
});
