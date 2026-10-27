import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileOperations} from '../src/ops.mjs';

function executeCompiled(operations) {
	const calls=[];
	let nextId=0;
	const create=(name,args)=>{
		calls.push([name,...args]);
		nextId+=1;
		return `created-${nextId}`;
	};
	const functions={
		Insert(...args) { return create('insert',args); },
		Copy(...args) { return create('copy',args); },
		Update(...args) { calls.push(['update',...args]); },
		Replace(...args) { return create('replace',args); },
		Move(...args) { calls.push(['move',...args]); },
		Delete(...args) { calls.push(['delete',...args]); },
		SetVariables(...args) { calls.push(['set_variables',...args]); },
	};
	const run=Function(
		'Insert','Copy','Update','Replace','Move','Delete','SetVariables','document',
		compileOperations(operations),
	);
	const result=run(
		functions.Insert,functions.Copy,functions.Update,functions.Replace,
		functions.Move,functions.Delete,functions.SetVariables,'document-root',
	);
	return {calls,result};
}

test('compiled batch invokes all seven official operations and reports created IDs', () => {
	const operations=[
		{op:'insert',parent:null,node:{type:'frame',name:'New'}},
		{op:'copy',path:'source',parent:'target',data:{name:'Copy'}},
		{op:'update',path:'text',props:{content:'Changed'}},
		{op:'replace',path:'old',node:{type:'text',content:'Replacement'}},
		{op:'move',path:'moved',parent:null,index:2},
		{op:'delete',path:'removed'},
		{op:'set_variables',variables:{accent:{type:'color',value:'#fff'}},replace:true},
	];
	const {calls,result}=executeCompiled(operations);
	assert.deepEqual(calls,[
		['insert','document-root',operations[0].node],
		['copy','source','target',operations[1].data],
		['update','text',operations[2].props],
		['replace','old',operations[3].node],
		['move','moved','document-root',2],
		['delete','removed'],
		['set_variables',operations[6].variables,true],
	]);
	assert.deepEqual(result,{created:[
		{index:0,path:'created-1'},
		{index:1,path:'created-2'},
		{index:3,path:'created-3'},
	]});
});

test('copy defaults data and move preserves an omitted parent', () => {
	const {calls}=executeCompiled([
		{op:'copy',path:'source',parent:null},
		{op:'move',path:'same-parent',index:0},
		{op:'set_variables',variables:{}},
	]);
	assert.deepEqual(calls,[
		['copy','source','document-root',{}],
		['move','same-parent',undefined,0],
		['set_variables',{},false],
	]);
});

test('operation strings remain inert JSON data', () => {
	delete globalThis.__pencilOpsInjected;
	const dangerous='quote"\n;globalThis.__pencilOpsInjected=true;//';
	const {calls}=executeCompiled([
		{op:'insert',parent:null,node:{type:'text',name:dangerous,content:dangerous}},
		{op:'update',path:dangerous,props:{content:dangerous}},
	]);
	assert.equal(globalThis.__pencilOpsInjected,undefined);
	assert.equal(calls[0][2].content,dangerous);
	assert.equal(calls[1][1],dangerous);
});

test('compiler rejects malformed operations and unknown keys', () => {
	const invalid=[
		null,
		{},
		{op:'insert',parent:null,node:[]},
		{op:'copy',path:'',parent:null},
		{op:'update',path:'node',props:null},
		{op:'replace',path:'node',node:{},extra:true},
		{op:'move',path:'node',index:-1},
		{op:'delete',path:'node',parent:null},
		{op:'set_variables',variables:{},replace:'yes'},
		{op:'script',code:'Delete(document)'},
	];
	for (const operation of invalid) {
		assert.throws(
			()=>compileOperations([operation]),
			error=>error.code==='OPERATIONS_INVALID',
		);
	}
});

test('compiler enforces count and serialized byte limits', () => {
	assert.throws(
		()=>compileOperations(Array.from({length:101},()=>({op:'delete',path:'node'}))),
		error=>error.code==='OPERATIONS_LIMIT',
	);
	assert.throws(
		()=>compileOperations([{op:'update',path:'node',props:{content:'x'.repeat(1024*1024)}}]),
		error=>error.code==='OPERATIONS_LIMIT',
	);
});
