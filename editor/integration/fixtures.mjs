import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {openDocument} from '../src/document.mjs';
import {startEngine} from '../src/engine.mjs';
import {claimSource} from '../src/source.mjs';
import {openStore} from '../src/store.mjs';
import {sampleFile,withTemp} from '../tests/helpers.mjs';

/** @returns {string[]} */
export function testCliArgv() {
	const json=process.env.TERN_PENCIL_ARGV;
	if (json) {
		const argv=JSON.parse(json);
		if (!Array.isArray(argv)||!argv.length||argv.some(value=>typeof value!=='string')) {
			throw Error('TERN_PENCIL_ARGV must be a nonempty string array');
		}
		return argv;
	}
	const cli=process.env.TERN_PENCIL_CLI;
	if (!cli||/\.cmd$/i.test(cli)) {
		throw Error('Configure TERN_PENCIL_CLI with index.mjs or an executable');
	}
	return /\.[cm]?js$/i.test(cli) ? [process.execPath,cli] : [cli];
}

export async function withEngine(options,fn) {
	const engine=await startEngine(options);
	try {
		return await fn(engine);
	} finally {
		await engine.close();
	}
}

export async function makeEngineFixture(dir,argv=testCliArgv()) {
	const original=await sampleFile(dir);
	const png='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMCFziBMAAIPRAgYEvCRHAAAAAElFTkSuQmCC';
	await writeFile(join(dirname(original),'fixture.png'),Buffer.from(png,'base64'));
	return withEngine({argv,input:original,output:original,timeout_ms:120000},async engine=>{
		let reply;
		try {
			reply=await engine.exec(`
const component=Insert(document,{type:'frame',reusable:true,width:100,height:80,
 children:[{type:'text',content:'Original',fontFamily:'Arial',fontSize:16}]});
const child=Get(component,{depth:1}).children[0].id;
const instance=Insert(document,{type:'ref',ref:component,x:150,y:0});
Update(instance+'/'+child,{content:'Instância'});
const imageFrame=Insert(document,{type:'frame',x:300,y:0,width:64,height:64,
 fill:{type:'image',url:'./fixture.png',mode:'cover'}});
SetVariables({accent:{type:'color',value:'#8844FF'}});
return {component,child,instance,path:instance+'/'+child,text:child,
 originalText:Get(child).content,imageFrame};`);
		} catch (error) {
			if (error&&typeof error==='object'&&error.details) {
				error.message+=` ${JSON.stringify(error.details)}`;
			}
			throw error;
		}
		const {value:ids}=reply;
		await engine.save();
		return {original,argv,ids};
	});
}

export function expected(info) {
	return {session_id:info.session_id,base_revision:info.revision};
}

export async function withDocument(fn) {
	return withTemp(async dir=>{
		const fixture=await makeEngineFixture(dir);
		const source=await claimSource({
			original_path:fixture.original,
			data_dir:join(dir,'private'),
			session_id:randomUUID(),
		});
		let doc;
		try {
			const store=await openStore({
				dir:join(dir,'private','history'),
				max_steps:50,
				max_bytes:200*1024*1024,
			});
			doc=await openDocument({source,store,cli_argv:fixture.argv,recovery:'prompt'});
			Object.defineProperty(doc,'fixture',{value:{...fixture.ids,original:fixture.original}});
			return await fn(doc);
		} finally {
			if (doc) await doc.close();
			else await source.release();
		}
	});
}
