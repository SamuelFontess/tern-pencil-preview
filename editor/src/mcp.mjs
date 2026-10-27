import {isEntry} from './entry.mjs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {SessionClient} from './client.mjs';
import {MCP_METHODS,publicError} from './protocol.mjs';

const string={type:'string',minLength:1};
const integer={type:'integer',minimum:0};
const expected={session_id:string,base_revision:integer};
const operationSchemas=[
	{required:['op','parent','node'],properties:{op:{const:'insert'},parent:{anyOf:[string,{type:'null'}]},node:{type:'object'}}},
	{required:['op','path','parent'],properties:{op:{const:'copy'},path:string,parent:{anyOf:[string,{type:'null'}]},data:{type:'object'}}},
	{required:['op','path','props'],properties:{op:{const:'update'},path:string,props:{type:'object'}}},
	{required:['op','path','node'],properties:{op:{const:'replace'},path:string,node:{type:'object'}}},
	{required:['op','path'],properties:{op:{const:'move'},path:string,parent:{anyOf:[string,{type:'null'}]},index:integer}},
	{required:['op','path'],properties:{op:{const:'delete'},path:string}},
	{required:['op','variables'],properties:{op:{const:'set_variables'},variables:{type:'object'},replace:{type:'boolean'}}},
].map(schema=>({...schema,type:'object',additionalProperties:false}));

function schema(properties={},required=[]) {
	return {type:'object',properties,required,additionalProperties:false};
}

const TOOL_SCHEMAS={
	get_document:schema(),
	get_nodes:schema({paths:{type:'array',items:string,maxItems:64}},['paths']),
	get_variables:schema(),
	get_schema:schema(),
	apply_changes:schema({...expected,operations:{type:'array',items:{oneOf:operationSchemas},maxItems:100}},['session_id','base_revision','operations']),
	get_frame_image:schema({frame_id:string,max_side:{type:'number',exclusiveMinimum:0,maximum:4096}},['frame_id']),
	undo_document:schema(expected,['session_id','base_revision']),
	redo_document:schema(expected,['session_id','base_revision']),
	save_document:schema(expected,['session_id','base_revision']),
	save_recovery_copy:schema(expected,['session_id','base_revision']),
};
const DESCRIPTIONS={
	get_document:'Read the explicitly bound document identity, revision, state, frames, and capabilities.',
	get_nodes:'Read up to 64 canonical node paths from the bound document.',
	get_variables:'Read current Pen variables and themes.',
	get_schema:'Read the official Pen schema and the bridge operation names.',
	apply_changes:'Atomically apply up to 100 structured Pen operations at an expected revision.',
	get_frame_image:'Read an official PNG for a top-level frame at the current revision.',
	undo_document:'Restore the previous document checkpoint and advance revision.',
	redo_document:'Restore the next document checkpoint and advance revision.',
	save_document:'Explicitly publish the current confirmed checkpoint to the original file.',
	save_recovery_copy:'Write an exclusive recovery copy without retargeting the session.',
};

/** Return exactly the document-scoped tools exposed by this MCP adapter. */
export function createTools() {
	return MCP_METHODS.map(name=>({name,description:DESCRIPTIONS[name],inputSchema:TOOL_SCHEMAS[name]}));
}

/** Convert backend JSON or image results to MCP content. */
export function toToolResult(result) {
	if (result?.kind==='image') return {content:[
		{type:'text',text:JSON.stringify(result.metadata)},
		{type:'image',mimeType:'image/png',data:result.base64},
	]};
	return {content:[{type:'text',text:JSON.stringify(result)}]};
}

/** Run the official MCP stdio server over one pre-bound SessionClient. */
export async function runMcp({client}) {
	if (!client||typeof client.call!=='function') throw Error('client is required');
	const server=new Server({name:'tern-pencil-editor',version:'0.5.0'},{capabilities:{tools:{}}});
	server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:createTools()}));
	server.setRequestHandler(CallToolRequestSchema,async({params})=>{
		try {
			if (!MCP_METHODS.includes(params.name)) {
				const error=Error('Method is not supported');
				error.code='METHOD_NOT_FOUND';
				throw error;
			}
			return toToolResult(await client.call(params.name,params.arguments??{}));
		} catch (error) {
			return {isError:true,content:[{type:'text',text:JSON.stringify(publicError(error))}]};
		}
	});
	server.onclose=()=>{ void client.close(); };
	await server.connect(new StdioServerTransport());
	return server;
}

function parseArguments(argv) {
	const values={};
	for (let index=2;index<argv.length;index+=2) {
		const option=argv[index];
		const value=argv[index+1];
		if (!['--document','--data-dir'].includes(option)||value===undefined||Object.hasOwn(values,option)) {
			throw Error('Usage: mcp.mjs --document <original> --data-dir <dir>');
		}
		values[option]=value;
	}
	if (Object.keys(values).length!==2) throw Error('Usage: mcp.mjs --document <original> --data-dir <dir>');
	return {original_path:values['--document'],data_dir:values['--data-dir']};
}

async function main() {
	const options=parseArguments(process.argv);
	const client=await SessionClient.connect(options);
	try {
		await runMcp({client});
	} catch (error) {
		await client.close();
		throw error;
	}
}

if (isEntry(import.meta.url)) {
	main().catch(error=>{
		const code=typeof error?.code==='string'?error.code:'MCP_FAILED';
		process.stderr.write(`MCP adapter failed: ${code}\n`);
		process.exitCode=1;
	});
}
