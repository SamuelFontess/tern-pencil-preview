import assert from 'node:assert/strict';
import {test} from 'node:test';
import {expected,withDocument} from './fixtures.mjs';

// An agent's invalid operation: the engine refuses it, and the session must stay intact.
const refused=[
	['update of a prop the node type does not have',doc=>({op:'update',path:doc.fixture.component,props:{content:'x'}}),/content/],
	['update with an unknown prop on a text',doc=>({op:'update',path:doc.fixture.text,props:{nonsense:1}}),/nonsense/],
	['update with a wrong prop type',doc=>({op:'update',path:doc.fixture.text,props:{fontSize:'big'}}),/fontSize/],
	['update of a missing node',()=>({op:'update',path:'nope',props:{content:'x'}}),/nope/],
	['move of a missing node',()=>({op:'move',path:'nope',parent:null}),/nope/],
	['insert under a missing parent',()=>({op:'insert',parent:'nope',node:{type:'rectangle'}}),/nope/],
];

for (const [name,make,reason] of refused) {
	test(`${name} is refused with a public error and the session keeps working`,{timeout:120000},async()=>withDocument(async doc=>{
		const before=doc.info();
		const text=await doc.readNode(doc.fixture.text);
		await assert.rejects(
			doc.applyChanges({...expected(before),operations:[make(doc)]}),
			error=>{
				assert.equal(error.code,'OPERATIONS_REJECTED');
				assert.match(error.message,reason);
				assert.doesNotMatch(error.message,/\n\s+at /);
				return true;
			},
		);
		const after=doc.info();
		assert.equal(after.revision,before.revision);
		assert.equal(after.phase,'ready');
		assert.deepEqual(await doc.readNode(doc.fixture.text),text);
		const ok=await doc.applyChanges({...expected(after),operations:[{op:'update',path:doc.fixture.text,props:{content:'Depois'}}]});
		assert.equal(ok.revision,before.revision+1);
		assert.equal((await doc.readNode(doc.fixture.text)).content,'Depois');
		await doc.undo(expected(doc.info()));
		assert.equal((await doc.readNode(doc.fixture.text)).content,text.content,'history is intact');
	}));
}

test('delete of a missing node is a silent no-op: no error, no new revision',{timeout:120000},async()=>withDocument(async doc=>{
	const before=doc.info();
	const result=await doc.applyChanges({...expected(before),operations:[{op:'delete',path:'nope'}]});
	assert.equal(result.revision,before.revision);
	assert.equal(doc.info().revision,before.revision);
	assert.equal(doc.info().phase,'ready');
}));
