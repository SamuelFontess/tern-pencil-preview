import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readdir,realpath,writeFile} from 'node:fs/promises';
import {delimiter,join} from 'node:path';
import test from 'node:test';
import {publishWindows} from '../src/save.mjs';
import {startServer} from '../src/server.mjs';
import {systemTool} from '../src/system.mjs';
import {withTemp} from './helpers.mjs';

const windows={skip:process.platform!=='win32'};

test('system tools resolve under SystemRoot\\System32, with the Windows default only when it is unset', ()=>{
	assert.equal(systemTool('whoami',{SystemRoot:'D:\\Win'}),'D:\\Win\\System32\\whoami.exe');
	assert.equal(systemTool('powershell',{SystemRoot:'D:\\Win'}),'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
	assert.equal(systemTool('icacls',{}),'C:\\Windows\\System32\\icacls.exe');
	assert.equal(systemTool('taskkill',{SystemRoot:''}),'C:\\Windows\\System32\\taskkill.exe');
	assert.throws(()=>systemTool('cmd'));
});

/** Fake system tools first in PATH: node.exe copies that, when started, drop a marker through NODE_OPTIONS. */
async function hostilePath(dir,fn) {
	const bin=join(dir,'bin');
	const marks=join(dir,'marks');
	await mkdir(bin);
	await mkdir(marks);
	const hook=join(dir,'mark.cjs');
	await writeFile(hook,`require('node:fs').writeFileSync(${JSON.stringify(marks)}+'\\\\'+process.pid,process.argv.join(' '));`);
	for (const name of ['whoami.exe','icacls.exe','powershell.exe','taskkill.exe']) await copyFile(process.execPath,join(bin,name));
	const saved={PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS};
	process.env.PATH=`${bin}${delimiter}${saved.PATH}`;
	process.env.NODE_OPTIONS=`--require ${JSON.stringify(hook)}`;
	try {
		return await fn(()=>readdir(marks));
	} finally {
		process.env.PATH=saved.PATH;
		if (saved.NODE_OPTIONS===undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS=saved.NODE_OPTIONS;
	}
}

test('a hostile PATH with fake whoami, icacls and powershell never decides the private registry ACL',windows,async()=>{
	await withTemp(async dir=>{
		const original=join(dir,'doc.pen');
		await writeFile(original,'{}');
		const info={
			session_id:randomUUID(),original_path:await realpath(original),revision:0,checkpoint_id:'a'.repeat(64),
			dirty:false,phase:'ready',status_seq:0,rendered_revision:0,
		};
		await hostilePath(dir,async marked=>{
			const server=await startServer({
				document:{info:()=>({...info})},renderer:{status:()=>({frame_ids:[],rendered_revision:0})},
				registry:{data_dir:join(dir,'private')},ui:null,
			});
			await server.close();
			assert.deepEqual(await marked(),[]);
		});
	});
});

test('a hostile PATH with a fake powershell never runs the Save helper',windows,async()=>{
	await withTemp(async dir=>{
		const original=join(dir,'original.pen');
		const candidate=join(dir,'candidate.pen');
		await writeFile(original,'old');
		await writeFile(candidate,'new');
		const script=join(dir,'helper.ps1');
		await writeFile(script,"[Console]::Out.WriteLine('{\"published\":false}')");
		await hostilePath(dir,async marked=>{
			const result=await publishWindows({
				candidate,original,backup:join(dir,'backup.bak'),
				expected_hash:createHash('sha256').update('old').digest('hex'),script,
			});
			assert.equal(result.published,false);
			assert.deepEqual(await marked(),[]);
		});
	});
});
