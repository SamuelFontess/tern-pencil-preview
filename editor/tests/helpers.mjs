import {mkdtemp,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export async function withTemp(fn) {
  const dir=await mkdtemp(join(tmpdir(),'pencil-editor-test-'));
  try { return await fn(dir); }
  finally { await rm(dir,{recursive:true,force:true}); }
}
export async function sampleFile(dir) {
  const source=join(dir,'source');
  await mkdir(source,{recursive:true});
  const path=join(source,'design.pen');
  await copyFile(new URL('../../tests/fixtures/sample.pen',import.meta.url),path);
  return path;
}
