import {EditorError} from './errors.mjs';

const MAX_OPERATIONS=100;
const MAX_OPERATION_BYTES=1024*1024;
const OPERATION_KEYS={
	insert:new Set(['op','parent','node']),
	copy:new Set(['op','path','parent','data']),
	update:new Set(['op','path','props']),
	replace:new Set(['op','path','node']),
	move:new Set(['op','path','parent','index']),
	delete:new Set(['op','path']),
	set_variables:new Set(['op','variables','replace']),
};

function invalid(message) {
	throw new EditorError('OPERATIONS_INVALID',message);
}

function isObject(value) {
	return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function assertJson(value,seen=new Set()) {
	if (value===null||typeof value==='string'||typeof value==='boolean') return;
	if (typeof value==='number'&&Number.isFinite(value)) return;
	if (typeof value!=='object') invalid('Operation data must contain only JSON values');
	if (seen.has(value)) invalid('Operation data must not be cyclic');
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertJson(item,seen);
	} else {
		const prototype=Object.getPrototypeOf(value);
		if (prototype!==Object.prototype&&prototype!==null) {
			invalid('Operation data must use plain objects');
		}
		for (const item of Object.values(value)) assertJson(item,seen);
	}
	seen.delete(value);
}

function assertPath(value,name) {
	if (typeof value!=='string'||value.length===0) invalid(`${name} must be a nonempty string`);
}

function assertParent(value) {
	if (value!==null) assertPath(value,'parent');
}

function assertKeys(operation,allowed) {
	for (const key of Object.keys(operation)) {
		if (!allowed.has(key)) invalid(`Unknown ${operation.op} operation key`);
	}
}

function assertObject(value,name) {
	if (!isObject(value)) invalid(`${name} must be an object`);
	assertJson(value);
}

function validateOperation(operation) {
	if (!isObject(operation)||typeof operation.op!=='string') invalid('Operation must be an object with an op');
	assertJson(operation);
	const allowed=OPERATION_KEYS[operation.op];
	if (!allowed) invalid('Unknown operation');
	assertKeys(operation,allowed);
	switch (operation.op) {
		case 'insert':
			if (!Object.hasOwn(operation,'parent')) invalid('insert requires parent');
			assertParent(operation.parent);
			assertObject(operation.node,'node');
			break;
		case 'copy':
			assertPath(operation.path,'path');
			if (!Object.hasOwn(operation,'parent')) invalid('copy requires parent');
			assertParent(operation.parent);
			if (Object.hasOwn(operation,'data')) assertObject(operation.data,'data');
			break;
		case 'update':
			assertPath(operation.path,'path');
			assertObject(operation.props,'props');
			break;
		case 'replace':
			assertPath(operation.path,'path');
			assertObject(operation.node,'node');
			break;
		case 'move':
			assertPath(operation.path,'path');
			if (Object.hasOwn(operation,'parent')) assertParent(operation.parent);
			if (Object.hasOwn(operation,'index')&&(!Number.isSafeInteger(operation.index)||operation.index<0)) {
				invalid('index must be a nonnegative safe integer');
			}
			break;
		case 'delete':
			assertPath(operation.path,'path');
			break;
		case 'set_variables':
			assertObject(operation.variables,'variables');
			if (Object.hasOwn(operation,'replace')&&typeof operation.replace!=='boolean') {
				invalid('replace must be a boolean');
			}
			break;
	}
}

/**
 * Compile structured operations into one atomic official-engine execute body.
 * @param {unknown} operations
 * @returns {string}
 */
export function compileOperations(operations) {
	if (!Array.isArray(operations)) invalid('operations must be an array');
	if (operations.length>MAX_OPERATIONS) {
		throw new EditorError('OPERATIONS_LIMIT','A batch cannot exceed 100 operations');
	}
	for (const operation of operations) validateOperation(operation);
	const data=JSON.stringify(operations);
	if (Buffer.byteLength(data,'utf8')>MAX_OPERATION_BYTES) {
		throw new EditorError('OPERATIONS_LIMIT','A batch cannot exceed 1 MiB');
	}
	return `const ops=JSON.parse(${JSON.stringify(data)});const created=[];
for(let i=0;i<ops.length;i++){
 const o=ops[i];
 switch(o.op){
  case 'insert':
   created.push({index:i,path:Insert(o.parent===null?document:o.parent,o.node)});break;
  case 'copy':
   created.push({index:i,path:Copy(o.path,o.parent===null?document:o.parent,o.data??{})});break;
  case 'update':
   Update(o.path,o.props);break;
  case 'replace':
   created.push({index:i,path:Replace(o.path,o.node)});break;
  case 'move': {
   const parent=Object.prototype.hasOwnProperty.call(o,'parent')
    ? (o.parent===null?document:o.parent) : undefined;
   Move(o.path,parent,o.index);break;
  }
  case 'delete':
   Delete(o.path);break;
  case 'set_variables':
   SetVariables(o.variables,o.replace??false);break;
  default:
   throw Error('Unknown operation');
 }
}
return {created};`;
}
