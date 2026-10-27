import {EditorError} from '../src/errors.mjs';
import {layoutOf,normalizeRow} from '../src/layout.mjs';

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function project(nodes,parentPath,rows,parentLayout) {
	for (const node of nodes) {
		const width=typeof node.width==='number'?node.width:40;
		const height=typeof node.height==='number'?node.height:20;
		const placed=parentLayout&&parentLayout!=='none'&&node.layoutPosition!=='absolute';
		rows.push(normalizeRow({
			path:node.id,parent_path:parentPath,type:node.type,layout:node.layout??null,
			x:placed?0:node.x??0,y:node.y??0,width,height,
			...(node.layoutPosition?{layout_position:node.layoutPosition}:{}),
		}));
		if (node.children) project(node.children,node.id,rows,layoutOf(node));
		for (const [child,props] of Object.entries(node.inherited??{})) {
			rows.push(normalizeRow({path:`${node.id}/${child}`,parent_path:node.id,type:props.type,layout:null,x:0,y:0,width:60,height:20}));
		}
	}
}

function find(nodes,id) {
	for (const node of nodes) {
		if (node.id===id) return node;
		const inner=find(node.children??[],id);
		if (inner) return inner;
	}
	return null;
}

function parentOf(nodes,id,parent=null) {
	for (const node of nodes) {
		if (node.id===id) return parent?parent.children:nodes;
		const inner=parentOf(node.children??[],id,node);
		if (inner) return inner;
	}
	return null;
}

/** The scenario every panel test edits: auto-layout frame, free frame, instance with one override. */
export function sampleRoots() {
	return [
		{type:'frame',id:'F1',name:'Stack',x:0,y:0,width:400,height:300,layout:'vertical',children:[
			{type:'text',id:'T1',name:'Title',content:'A\u{1F600}e'},
			{type:'text',id:'T2',name:'Price',content:'$100'},
			{type:'text',id:'T3',name:'Third',content:'third'},
		]},
		{type:'frame',id:'F2',name:'Free',x:500,y:0,width:200,height:100,layout:'none',children:[
			{type:'rectangle',id:'R1',name:'Box',x:10,y:20,width:50,height:'fill_container',fill:'#112233'},
			{type:'text',id:'T4',name:'Tinted',x:5,y:6,content:'tinted',fill:'$accent'},
			{type:'rectangle',id:'R2',name:'Glow',x:1,y:2,width:30,height:30,fill:{type:'gradient',colors:[]}},
			{type:'rectangle',id:'R3',name:'Gap',x:'$gap',y:0,width:'$gap',height:5,fill:'#ffffff'},
		]},
		{type:'ref',id:'I1',ref:'C1',x:150,y:0,descendants:{A1:{content:'Over'}},
			inherited:{A1:{type:'text',content:'Over'},A2:{type:'text',content:'Base'}}},
	];
}

/**
 * In-memory DocumentSession double: same method contract, scriptable external (MCP) changes and failures.
 * It records every mutating call so tests can read the operations the panel generated.
 */
export function fakeDocument({roots=sampleRoots(),variables={accent:{type:'color',value:'#8844FF'}}}={}) {
	const state={
		roots:clone(roots),revision:3,phase:'ready',dirty:false,recovery:undefined,
		calls:[],listeners:new Set(),statusListeners:new Set(),failNext:null,statusSeq:1,
	};
	function rows() {
		const out=[];
		project(state.roots,null,out,'none');
		return out;
	}
	function instanceChildren(path) {
		const [owner,child]=path.split('/');
		const instance=find(state.roots,owner);
		const inherited=instance?.inherited?.[child];
		if (!inherited) return null;
		return {...inherited,id:path,path,...(instance.descendants?.[child]??{})};
	}
	const document={
		state,
		info() {
			return {
				session_id:'session-1',original_path:'C:/work/design.pen',revision:state.revision,
				checkpoint_id:`cp-${state.revision}`,dirty:state.dirty,phase:state.phase,status_seq:state.statusSeq,
				rendered_revision:null,...(state.recovery?{recovery:{...state.recovery}}:{}),
			};
		},
		async readModel() {
			return {roots:clone(state.roots),rows:rows(),variables:{variables:clone(variables)}};
		},
		async readNode(path) {
			return path.includes('/')?instanceChildren(path):clone(find(state.roots,path));
		},
		onCommit(fn) {
			state.listeners.add(fn);
			return ()=>state.listeners.delete(fn);
		},
		onStatus(fn) {
			state.statusListeners.add(fn);
			return ()=>state.statusListeners.delete(fn);
		},
		async applyChanges(request) {
			state.calls.push({method:'applyChanges',request:clone(request)});
			if (state.failNext) {
				const error=state.failNext;
				state.failNext=null;
				throw error;
			}
			if (request.base_revision!==state.revision) {
				throw new EditorError('REVISION_CONFLICT','Request revision is no longer current');
			}
			for (const operation of request.operations) {
				if (operation.op==='update') Object.assign(find(state.roots,operation.path),operation.props);
				if (operation.op==='delete') {
					const siblings=parentOf(state.roots,operation.path);
					siblings.splice(siblings.findIndex(node=>node.id===operation.path),1);
				}
				if (operation.op==='move') {
					const siblings=parentOf(state.roots,operation.path);
					const [node]=siblings.splice(siblings.findIndex(item=>item.id===operation.path),1);
					siblings.splice(operation.index,0,node);
				}
			}
			state.revision+=1;
			state.dirty=true;
			document.notify();
			return {revision:state.revision,checkpoint_id:`cp-${state.revision}`,created:[],warnings:[]};
		},
		notify() {
			for (const fn of state.statusListeners) fn(document.info());
			for (const fn of state.listeners) fn(document.info());
		},
		/** A change from another writer (the MCP adapter) at a new revision. */
		external(mutate) {
			mutate(state.roots,find);
			state.revision+=1;
			state.dirty=true;
			document.notify();
		},
	};
	for (const method of ['undo','redo','saveOriginal','saveRecoveryCopy','resolveRecovery']) {
		document[method]=async argument=>{
			state.calls.push({method,request:clone(argument)});
			if (state.failNext) {
				const error=state.failNext;
				state.failNext=null;
				throw error;
			}
			if (method==='saveOriginal') return {saved:true,revision:state.revision};
			if (method==='saveRecoveryCopy') return {path:'C:/work/design.tern-recovery-x.pen'};
			if (method==='resolveRecovery') {
				state.recovery=undefined;
				state.phase='ready';
				return {};
			}
			state.revision+=1;
			document.notify();
			return {revision:state.revision};
		};
	}
	return document;
}

export function fakeRenderer(document) {
	const renderer={
		error:null,renderedRevision:null,
		status() {
			return {
				rendered_revision:renderer.renderedRevision,refreshing_revision:null,error:renderer.error,
				frame_ids:['F1','F2'],exported_frame_ids:[],
			};
		},
		async refresh(revision) {
			renderer.renderedRevision=revision;
		},
	};
	void document;
	return renderer;
}

/** A native edit event as Tern sends it: replace UTF-16 [from,to) of a field that holds `len` units. */
export const edit=(from,to,len,text,cursor=from+text.length)=>({ev:'edit',from,to,len,text,cursor});
