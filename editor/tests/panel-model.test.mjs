import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorError} from '../src/errors.mjs';
import {
	PanelController,coerceValue,describeFields,recoveryChoices,
} from '../src/panel-model.mjs';
import {edit,fakeDocument,fakeRenderer} from './panel-fixtures.mjs';

async function open(options) {
	const document=fakeDocument(options);
	const renderer=fakeRenderer(document);
	const controller=new PanelController({document,renderer,poll_ms:0});
	await controller.start();
	return {document,renderer,controller,calls:()=>document.state.calls.filter(call=>call.method==='applyChanges')};
}

const field=(fields,property)=>fields.find(item=>item.property===property);

test('fields controlled by the model are read-only with their reason and never become fixed values', async t=>{
	const {controller}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T1');
	let fields=controller.view().fields;
	assert.equal(field(fields,'content').editable,true);
	assert.equal(field(fields,'x').editable,false);
	assert.match(field(fields,'x').reason,/auto-layout/);
	assert.equal(field(fields,'width').editable,false);
	assert.match(field(fields,'width').reason,/Automatic size/);

	await controller.selectNode('T4');
	fields=controller.view().fields;
	assert.match(field(fields,'fill').reason,/\$accent/);
	assert.equal(field(fields,'x').editable,true);

	await controller.selectNode('R3');
	fields=controller.view().fields;
	assert.match(field(fields,'x').reason,/\$gap/);
	assert.match(field(fields,'width').reason,/\$gap/);
	assert.equal(field(fields,'height').editable,true);

	await controller.selectNode('R1');
	fields=controller.view().fields;
	assert.match(field(fields,'height').reason,/fill_container/);
	assert.equal(field(fields,'fill').value,'#112233');

	await controller.selectNode('R2');
	assert.match(field(controller.view().fields,'fill').reason,/gradient/);
});

test('a text that merely starts with a dollar sign is not mistaken for a variable binding', async t=>{
	const {controller}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T2');
	const content=field(controller.view().fields,'content');
	assert.equal(content.editable,true);
	assert.equal(content.value,'$100');
});

test('instances expose only what is overridden or owned by the instance itself', async t=>{
	const {controller}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('I1');
	let fields=controller.view().fields;
	assert.equal(field(fields,'x').editable,true);
	assert.match(field(fields,'width').reason,/Inherited/);

	await controller.selectNode('I1/A1');
	fields=controller.view().fields;
	assert.equal(field(fields,'content').editable,true);
	assert.equal(field(fields,'content').value,'Over');

	await controller.selectNode('I1/A2');
	fields=controller.view().fields;
	assert.equal(field(fields,'content').editable,false);
	assert.match(field(fields,'content').reason,/Inherited/);
});

test('unknown node data yields only read-only fields', () => {
	const fields=describeFields({path:'X',schema:null,row:null,parentRow:null},{roots:[],variables:{variables:{}}});
	assert.equal(fields.length,6);
	assert.ok(fields.every(item=>!item.editable&&item.reason));
});

test('typed values are validated before they can become an update', () => {
	assert.deepEqual(coerceValue('x','12.5'),{ok:true,value:12.5});
	assert.deepEqual(coerceValue('width',' 40 '),{ok:true,value:40});
	for (const bad of ['','abc','1e3','0x10','NaN','--1']) assert.equal(coerceValue('y',bad).ok,false,bad);
	assert.equal(coerceValue('height','-1').ok,false);
	assert.deepEqual(coerceValue('fill','#FFAA0033'),{ok:true,value:'#FFAA0033'});
	for (const bad of ['red','#12','#GGGGGG','ffffff']) assert.equal(coerceValue('fill',bad).ok,false,bad);
	assert.deepEqual(coerceValue('content','  keep \n spaces '),{ok:true,value:'  keep \n spaces '});
});

test('a text edit replaces a UTF-16 pair whole and commits one update for the confirmed revision', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T1');
	controller.edit('T1','content',edit(1,3,4,'ã'));
	assert.equal(controller.view().fields[0].draft.text,'Aãe');
	await controller.applyField('T1','content');
	assert.deepEqual(calls()[0].request,{
		session_id:'session-1',base_revision:3,
		operations:[{op:'update',path:'T1',props:{content:'Aãe'}}],
	});
	assert.equal(controller.view().pending.length,0);
	assert.equal(controller.view().info.revision,4);
});

test('a broken UTF-16 range is rejected instead of splitting the emoji', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T1');
	controller.edit('T1','content',edit(2,2,4,'x'));
	await controller.applyField('T1','content');
	assert.equal(calls().length,0);
	assert.equal(controller.view().fields[0].draft.status,'diverged');
});

test('numeric and color fields apply typed values and keep an invalid draft', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('R1');
	controller.edit('R1','x',edit(0,2,2,'abc'));
	await controller.applyField('R1','x');
	assert.equal(calls().length,0);
	assert.match(field(controller.view().fields,'x').draft.error,/number/);
	controller.undoField('R1','x');
	controller.edit('R1','x',edit(0,2,2,'42'));
	await controller.applyField('R1','x');
	assert.deepEqual(calls()[0].request.operations,[{op:'update',path:'R1',props:{x:42}}]);
	controller.edit('R1','fill',edit(0,7,7,'#abcdef'));
	await controller.applyField('R1','fill');
	assert.deepEqual(calls()[1].request.operations,[{op:'update',path:'R1',props:{fill:'#abcdef'}}]);
});

test('multi-line text is applied only through the explicit apply, and Escape-style cancel drops it', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	controller.setMultiline('T3','content',true);
	controller.edit('T3','content',edit(5,5,5,'\nline two'));
	assert.equal(controller.view().fields[0].multiline,true);
	assert.equal(calls().length,0);
	controller.cancelField('T3','content');
	assert.equal(controller.view().fields[0].draft,null);
	assert.equal(controller.view().fields[0].value,'third');
	assert.equal(calls().length,0);
});

test('a new selection never receives another target\'s pending draft', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T1');
	controller.edit('T1','content',edit(0,4,4,'Changed'));
	await controller.selectNode('T3');
	const view=controller.view();
	assert.equal(field(view.fields,'content').draft,null);
	assert.equal(field(view.fields,'content').value,'third');
	assert.deepEqual(view.pending.map(item=>[item.path,item.property,item.status]),[['T1','content','changed']]);
	await controller.applyField('T3','content');
	assert.equal(calls().length,0);
	await controller.selectNode('T1');
	assert.equal(controller.view().fields[0].draft.text,'Changed');
});

test('an MCP change to the same property is a visible conflict that is never overwritten silently', async t=>{
	const {controller,document,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('R1');
	controller.edit('R1','x',edit(0,2,2,'77'));
	document.external(roots=>{ roots[1].children[0].x=99; });
	await controller.refresh();
	const draft=field(controller.view().fields,'x').draft;
	assert.equal(draft.status,'stale');
	assert.equal(draft.current,'99');
	await controller.applyField('R1','x');
	assert.equal(calls().length,0);
	assert.equal(controller.view().notice.code,'DRAFT_STALE');
	assert.equal(document.state.roots[1].children[0].x,99);

	controller.keepDraft('R1','x');
	await controller.applyField('R1','x');
	assert.deepEqual(calls()[0].request,{
		session_id:'session-1',base_revision:4,operations:[{op:'update',path:'R1',props:{x:77}}],
	});
});

test('an MCP change elsewhere does not disturb a draft whose property is unchanged', async t=>{
	const {controller,document,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('R1');
	controller.edit('R1','x',edit(0,2,2,'77'));
	document.external(roots=>{ roots[1].children[1].content='other'; });
	await controller.refresh();
	assert.equal(field(controller.view().fields,'x').draft.status,'changed');
	await controller.applyField('R1','x');
	assert.equal(calls()[0].request.base_revision,4);
});

test('a draft whose target disappears is flagged removed and cannot be applied', async t=>{
	const {controller,document}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	controller.edit('T3','content',edit(0,5,5,'gone'));
	await controller.selectNode('T1');
	document.external(roots=>{ roots[0].children.splice(2,1); });
	await controller.refresh();
	assert.deepEqual(controller.view().pending.map(item=>item.status),['removed']);
});

test('deleting requires an explicit confirmation against the same revision', async t=>{
	const {controller,document,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	controller.requestDelete('T3');
	controller.cancelDelete();
	await controller.confirmDeletion();
	assert.equal(calls().length,0);

	controller.requestDelete('T3');
	document.external(roots=>{ roots[1].children[1].content='moved on'; });
	await controller.refresh();
	await controller.confirmDeletion();
	assert.equal(calls().length,0);
	assert.equal(controller.view().notice.code,'REVISION_STALE');

	controller.requestDelete('T3');
	assert.equal(controller.view().confirmDelete.path,'T3');
	await controller.confirmDeletion();
	assert.deepEqual(calls()[0].request.operations,[{op:'delete',path:'T3'}]);
	assert.equal(controller.view().selected,null);
	assert.match(controller.deleteReason('I1/A1'),/instance/);
});

test('children of an auto-layout parent reorder by index and free children do not', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	assert.deepEqual(controller.view().reorder,{index:2,count:3});
	await controller.moveNode('T3',1);
	assert.equal(calls().length,0);
	await controller.moveNode('T3',-1);
	assert.deepEqual(calls()[0].request.operations,[{op:'move',path:'T3',index:1}]);
	await controller.selectNode('R1');
	assert.equal(controller.view().reorder,null);
});

test('an absolute child of an auto-layout parent keeps its position fields and is not reordered', async t=>{
	const roots=[{type:'frame',id:'F1',name:'Stack',x:0,y:0,width:400,height:300,layout:'vertical',children:[
		{type:'text',id:'T1',name:'Title',content:'a'},
		{type:'rectangle',id:'B1',name:'Badge',x:5,y:6,width:10,height:10,layoutPosition:'absolute'},
		{type:'text',id:'T3',name:'Third',content:'c'},
	]}];
	const {controller,calls}=await open({roots});
	t.after(()=>controller.close());
	await controller.selectNode('B1');
	assert.equal(field(controller.view().fields,'x').editable,true);
	assert.equal(controller.view().reorder,null);
	await controller.moveNode('B1',1);
	assert.equal(calls().length,0);
	await controller.selectNode('T3');
	assert.equal(field(controller.view().fields,'x').editable,false);
	assert.deepEqual(controller.view().reorder,{index:2,count:3},'the absolute sibling still counts in the index');
});

test('document undo, redo and save act on the document and keep field drafts', async t=>{
	const {controller,document}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	controller.edit('T3','content',edit(0,5,5,'draft'));
	await controller.docUndo();
	await controller.docRedo();
	assert.equal(controller.view().pending.length,1);
	assert.deepEqual(document.state.calls.map(call=>call.method),['undo','redo']);
	await controller.save();
	assert.equal(document.state.calls.length,2,'Save is refused while a draft is pending');
	assert.equal(controller.view().notice.code,'DRAFTS_PENDING');
	controller.cancelField('T3','content');
	await controller.save();
	assert.equal(document.state.calls.at(-1).method,'saveOriginal');
	assert.deepEqual(document.state.calls.at(-1).request,{session_id:'session-1',base_revision:5});
	await controller.saveCopy();
	assert.equal(document.state.calls.at(-1).method,'saveRecoveryCopy');
	assert.match(controller.view().notice.message,/tern-recovery/);
});

test('failed operations say which stage failed and keep the draft', async t=>{
	const {controller,document}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('T3');
	controller.edit('T3','content',edit(0,5,5,'x'));
	document.state.failNext=new EditorError('ENGINE_REJECTED','bad value');
	await controller.applyField('T3','content');
	assert.equal(controller.view().notice.stage,'not_applied');
	document.state.failNext=new EditorError('CHECKPOINT_WRITE_FAILED','disk full');
	await controller.applyField('T3','content');
	assert.equal(controller.view().notice.stage,'checkpoint');
	document.state.failNext=new EditorError('DOCUMENT_BLOCKED','cannot restore');
	await controller.applyField('T3','content');
	assert.equal(controller.view().notice.stage,'blocked');
	assert.equal(controller.view().pending.length,1);
	assert.equal(document.state.revision,3);
});

test('an applied document with a failed render reports the render failure separately', async t=>{
	const {controller,renderer}=await open();
	t.after(()=>controller.close());
	renderer.error={code:'RENDER_MISSING',message:'no png'};
	await controller.refresh({force:true});
	const view=controller.view();
	assert.equal(view.render.error.code,'RENDER_MISSING');
	assert.equal(view.render.pending,false);
	assert.equal(view.notice,null);
});

test('recovery and save conflict expose exactly the choices the document accepts', async t=>{
	assert.deepEqual(recoveryChoices({phase:'ready'}),[]);
	assert.deepEqual(
		recoveryChoices({phase:'recovering',recovery:{save_conflict:true}}).map(item=>item.choice),['copy'],
	);
	assert.deepEqual(
		recoveryChoices({phase:'recovering',recovery:{source_matches:true}}).map(item=>item.choice),['recover','discard'],
	);
	assert.deepEqual(
		recoveryChoices({phase:'recovering',recovery:{source_matches:false}}).map(item=>item.choice),['recover','discard','copy'],
	);
	const {controller,document,calls}=await open();
	t.after(()=>controller.close());
	document.state.phase='recovering';
	document.state.recovery={source_matches:true};
	await controller.refresh({force:true});
	const view=controller.view();
	assert.equal(view.editable,false);
	assert.deepEqual(view.recovery.map(item=>item.choice),['recover','discard']);
	await controller.resolveRecovery('recover');
	assert.equal(document.state.calls.at(-1).method,'resolveRecovery');
	assert.equal(document.state.calls.at(-1).request,'recover');
	assert.equal(controller.view().editable,true);
	assert.equal(calls().length,0);
});

test('whiteboard selection moves the focus frame and an unknown target is reported', async t=>{
	const {controller}=await open();
	t.after(()=>controller.close());
	await controller.selectNode('R1');
	assert.equal(controller.view().frameId,'F2');
	assert.deepEqual(controller.view().layers.map(layer=>layer.path),['F2','R1','T4','R2','R3']);
	await controller.selectNode('missing');
	assert.equal(controller.view().selected,null);
	assert.equal(controller.view().notice.code,'TARGET_MISSING');
});

test('applying board edits reports the outcome, a failed capture changes nothing, and cancel only resets the board', async t=>{
	const {controller,calls}=await open();
	t.after(()=>controller.close());
	assert.equal(controller.view().board,false);
	const board={requests:0,resets:0,next:null,request(){ this.requests+=1; return this.next(); },reset(){ this.resets+=1; }};
	controller.useBoard(board);
	assert.equal(controller.view().board,true);

	board.next=async()=>({applied:true,changes:2,revision:5});
	await controller.applyBoard();
	assert.match(controller.view().notice.message,/Applied 2 board changes/);

	board.next=async()=>({applied:false,changes:0,revision:5});
	await controller.applyBoard();
	assert.equal(controller.view().notice.kind,'info');

	board.next=async()=>{ throw new EditorError('REVISION_STALE','The document changed after the board was read, so nothing was applied'); };
	await controller.applyBoard();
	assert.equal(controller.view().notice.code,'REVISION_STALE');
	assert.equal(controller.view().busy,null);

	controller.cancelBoard();
	assert.equal(board.resets,1);
	assert.equal(board.requests,3);
	assert.deepEqual(calls(),[],'the panel never writes the document for the board itself');
});

test('a board that had to be rebuilt says nothing was applied instead of reporting no changes', async t=>{
	const {controller}=await open();
	t.after(()=>controller.close());
	const board={request:async()=>({applied:false,changes:0,revision:5,reconcile:true}),reset(){}};
	controller.useBoard(board);
	await controller.applyBoard();
	assert.match(controller.view().notice.message,/rebuilt and nothing was applied/);
	board.request=async()=>({applied:true,changes:1,revision:6,reconcile:true});
	await controller.applyBoard();
	assert.match(controller.view().notice.message,/Applied 1 board change.*restored/);
});
