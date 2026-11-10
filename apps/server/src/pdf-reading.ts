import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectPdf} from '@trash/literature';
import type {TrashStore} from '@trash/storage';
const execute=promisify(execFile);
function fail(code:string,statusCode=422):never{throw Object.assign(new Error(code),{statusCode});}
const pending=new Map<string,Promise<void>>();
export class PdfReading{
 constructor(private store:TrashStore){}
 original(project:string,id:string){const source=this.store.getSource(id);if(!source||source.project_id!==project)fail('SOURCE_NOT_FOUND',404);
  const ids=[source.artifact_id,...(this.store.db.prepare('SELECT artifact_id FROM source_attachments WHERE source_id=?').all(id) as {artifact_id:string}[]).map(row=>row.artifact_id)];
  for(const artifact of ids){if(!artifact)continue;const file=this.store.artifactFile(project,artifact);if(!file)continue;const bytes=readFileSync(file.path);if(bytes.subarray(0,5).toString()==='%PDF-')return {artifact_id:artifact,path:file.path,hash:createHash('sha256').update(bytes).digest('hex'),bytes};}
  fail('PDF_ORIGINAL_NOT_FOUND',404);
 }
 private cache(project:string,hash:string){let path=join(this.store.root,'projects',project);for(const part of ['.trash','cache','pdf',hash]){path=join(path,part);try{if(lstatSync(path).isSymbolicLink())fail('KNOWLEDGE_PATH_INVALID',403);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}mkdirSync(path,{recursive:true});return path;}
 async document(project:string,id:string){const original=this.original(project,id),cache=this.cache(project,original.hash),file=join(cache,'pages.json');
  let data:Awaited<ReturnType<typeof inspectPdf>>;
  if(existsSync(file))data=JSON.parse(readFileSync(file,'utf8'));else{data=await inspectPdf(original.bytes);const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(data),{mode:0o600});renameSync(temp,file);}
  return {...data,source_id:id,hash:original.hash,original:original.path,artifact_id:original.artifact_id,cache};
 }
 async page(project:string,id:string,page:number,scale=2200,known?:Awaited<ReturnType<PdfReading["document"]>>){const doc=known??await this.document(project,id);if(![400,2200,4400].includes(scale))fail("INVALID_REQUEST",400);if(!Number.isInteger(page)||page<1||page>doc.pageCount)fail('PDF_PAGE_OUT_OF_RANGE',400);const file=join(doc.cache,`page-${page}-${scale}.png`);
  if(!existsSync(file)){let job=pending.get(file);if(!job){job=(async()=>{const prefix=join(doc.cache,randomUUID());try{await execute('pdftoppm',['-f',String(page),'-l',String(page),'-scale-to',String(scale),'-png','-singlefile',doc.original,prefix],{timeout:60000,maxBuffer:1024*1024});renameSync(prefix+'.png',file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')fail('PDF_RENDERER_UNAVAILABLE',503);throw error;}})();pending.set(file,job);}try{await job;}finally{pending.delete(file);}}
  return {path:file,page,label:doc.pages[page-1].label,hash:doc.hash,text:doc.pages[page-1].text};
 }
}
