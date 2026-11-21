import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { consolidatedLibraryPath, libraryFolders, libraryLayoutEnabled, libraryLayoutMarker } from '@trash/storage';
import { safeKnowledgeFile } from './knowledge-base-migration.js';

const journalPath='.trash/library-migration.json';
const pendingPath='.trash/library-move-pending';
const rawBefore='literature/originals',rawAfter=libraryFolders.literature+'/originals';
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const fail=(code:string,statusCode=409):never=>{throw Object.assign(new Error(code),{statusCode});};
type Inventory={path:string;hash:string};
type Rewrite={from:string;to:string;before:string;after:string};
type Folder={from:string;to:string;present:boolean;files:number;bytes:number};
type Journal={
  version:1;id:string;at:string;state:'moving'|'completed'|'rolling-back'|'rolled-back';
  folders:Folder[];files:Inventory[];directories:string[];rewrites:Rewrite[];raw:string|null;
};
const stat=(path:string)=>{
  try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
};
const disk=(root:string,path:string)=>join(root,path);
function emit(file:string,contents:string|Buffer,mode=0o600){
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,contents,{flag:'wx',mode});
  try{renameSync(temporary,file);}finally{if(existsSync(temporary))unlinkSync(temporary);}
}
const stateFile=(root:string)=>safeKnowledgeFile(root,journalPath);
function readJournal(root:string):Journal|undefined{
  const file=stateFile(root);
  return existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as Journal:undefined;
}
const save=(root:string,job:Journal)=>emit(stateFile(root),JSON.stringify(job,null,2)+'\n');
export const libraryMigrationPending=(root:string)=>existsSync(disk(root,pendingPath));
function setPending(root:string,pending:boolean){
  const file=safeKnowledgeFile(root,pendingPath);
  if(pending)emit(file,'1\n');
  else if(existsSync(file))unlinkSync(file);
}
function fileHash(file:string){
  const fd=openSync(file,'r'),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(256*1024);
  try{for(let length;(length=readSync(fd,buffer,0,buffer.length,null));)digest.update(buffer.subarray(0,length));}
  finally{closeSync(fd);}
  return digest.digest('hex');
}
function scan(root:string,relative:string){
  const files:{path:string;size:number;mtime:number}[]=[];
  const directories:string[]=[];
  const visit=(path:string)=>{
    const info=lstatSync(disk(root,path));
    if(info.isDirectory()){
      directories.push(path);
      for(const name of readdirSync(disk(root,path)).sort())visit(path+'/'+name);
    }else if(info.isFile())files.push({path,size:info.size,mtime:info.mtimeMs});
    else fail('LIBRARY_UNSUPPORTED_ENTRY',422);
  };
  if(stat(disk(root,relative)))visit(relative);
  return {files,directories};
}
function rewriteBody(root:string,from:string,body:string){
  const to=consolidatedLibraryPath(from);
  const href=(value:string)=>{
    const split=value.match(/^([^?#]+)(.*)$/);
    if(!split||/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/api\/)/i.test(value))return value;
    let decoded:string;
    try{decoded=decodeURIComponent(split[1]);}catch{return value;}
    const old=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(from),decoded));
    if(old==='..'||old.startsWith('../')||!existsSync(disk(root,old)))return value;
    const mapped=consolidatedLibraryPath(old);
    const natural=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(to),decoded));
    if(mapped===natural)return value;
    const relative=posix.relative(posix.dirname(to),mapped)||posix.basename(mapped);
    return relative.split('/').map(part=>encodeURIComponent(part)).join('/')+split[2];
  };
  let fence='';
  return body.split(/(?<=\n)/).map(line=>{
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence='';return line;}
    if(fence)return line;
    return line.replace(/`[^`]*`|(!?\[[^\]\n]*\]\(\s*<?)([^\s)>]+)|(^\s{0,3}\[[^\]\n]+\]:\s*<?)([^\s>]+)/g,
      (all,inline:string|undefined,url:string|undefined,reference:string|undefined,refUrl:string|undefined)=>
        inline&&url?inline+href(url):reference&&refUrl?reference+href(refUrl):all);
  }).join('');
}
function planned(root:string){
  const conflicts:string[]=[];
  const files:{path:string;size:number;mtime:number}[]=[];
  const directories:string[]=[];
  if(stat(disk(root,'library')))conflicts.push('library/');
  const folders=Object.entries(libraryFolders).map(([from,to])=>{
    const info=stat(disk(root,from));
    if(info&&!info.isDirectory()){conflicts.push(from);return {from,to,present:false,files:0,bytes:0};}
    try{
      const inventory=scan(root,from);
      files.push(...inventory.files);directories.push(...inventory.directories);
      return {from,to,present:!!info,files:inventory.files.length,bytes:inventory.files.reduce((sum,file)=>sum+file.size,0)};
    }catch{conflicts.push(from+'（含不可迁移的目录项）');return {from,to,present:!!info,files:0,bytes:0};}
  });
  const rawPath=disk(root,'raw'),rawInfo=stat(rawPath);
  const raw=rawInfo?.isSymbolicLink()?readlinkSync(rawPath):null;
  if((rawInfo&&raw!==rawBefore)||!stat(disk(root,rawBefore))?.isDirectory())conflicts.push('raw（未指向项目原文目录）');
  const rewrites:Rewrite[]=[];
  const candidates=files.filter(file=>file.path.endsWith('.md')&&file.size<=2*1024*1024);
  for(const area of ['wiki','research','manuscript']){
    // Keep the scan limited to project Markdown; unrelated links and assets are untouched.
    const visit=(path:string)=>{
      const info=stat(disk(root,path));
      if(info?.isDirectory()){
        for(const name of readdirSync(disk(root,path)).sort())if(!name.startsWith('.'))visit(path+'/'+name);
      }else if(info?.isFile()&&path.endsWith('.md')&&info.size<=2*1024*1024)candidates.push({path,size:info.size,mtime:info.mtimeMs});
    };
    visit(area);
  }
  for(const {path} of candidates){
    const before=readFileSync(disk(root,path),'utf8'),after=rewriteBody(root,path,before);
    if(before!==after)rewrites.push({from:path,to:consolidatedLibraryPath(path),before,after});
  }
  const knowledgeManifest='.trash/knowledge-base-migration.json';
  if(rewrites.length&&existsSync(safeKnowledgeFile(root,knowledgeManifest))){
    const before=readFileSync(safeKnowledgeFile(root,knowledgeManifest),'utf8');
    const manifest=JSON.parse(before) as {afterHashes?:Record<string,string>};
    let changed=false;
    for(const rewrite of rewrites){
      if(manifest.afterHashes?.[rewrite.from]!==hash(rewrite.before))continue;
      manifest.afterHashes[rewrite.from]=hash(rewrite.after);changed=true;
    }
    if(changed)rewrites.push({from:knowledgeManifest,to:knowledgeManifest,before,after:JSON.stringify(manifest,null,2)+'\n'});
  }
  const fingerprint=hash(JSON.stringify({files,directories,conflicts,raw,links:rewrites.map(item=>[item.from,hash(item.before)])}));
  return {folders,conflicts,raw,files,directories,rewrites,fingerprint};
}
function publicState(root:string,job:Journal){
  return {state:job.state,id:job.id,at:job.at,folders:job.folders,conflicts:[],rewritten:job.rewrites.filter(item=>item.to.endsWith('.md')).map(({from,to})=>({from,to})),migrated:libraryLayoutEnabled(root),pending:libraryMigrationPending(root)};
}
export function libraryPreview(root:string){
  const job=readJournal(root);
  if(job&&(job.state!=='rolled-back'||libraryMigrationPending(root)))return publicState(root,job);
  if(libraryLayoutEnabled(root))return {state:'completed',migrated:true,folders:[],conflicts:[],rewritten:[]};
  const preview=planned(root);
  return {state:'ready',migrated:false,folders:preview.folders,conflicts:preview.conflicts,fingerprint:preview.fingerprint,
    rewritten:preview.rewrites.filter(item=>item.to.endsWith('.md')).map(({from,to})=>({from,to}))};
}
function rawLink(root:string,wanted:string|null){
  const raw=disk(root,'raw'),info=stat(raw);
  const current=info?.isSymbolicLink()?readlinkSync(raw):null;
  if(info&&current!==rawBefore&&current!==rawAfter)fail('LIBRARY_RAW_CONFLICT');
  if(current===wanted)return;
  if(!wanted){unlinkSync(raw);return;}
  const temp=raw+'.'+randomUUID()+'.tmp';
  symlinkSync(wanted,temp,'dir');
  try{renameSync(temp,raw);}finally{if(stat(temp))unlinkSync(temp);}
}
function patchLinks(root:string,job:Journal,rollback=false){
  for(const item of job.rewrites){
    const path=disk(root,item.to),info=stat(path);
    if(!info?.isFile())fail('LIBRARY_CONTENT_CHANGED');
    const live=readFileSync(path,'utf8'),wanted=rollback?item.before:item.after;
    if(live===wanted)continue;
    if(live!==(rollback?item.after:item.before))fail('LIBRARY_CONTENT_CHANGED');
    emit(path,wanted,info.mode&0o777);
  }
}
function verify(root:string,job:Journal,atDestination:boolean,afterRewrite:boolean){
  const actual=new Set<string>();
  const directories=new Set<string>();
  const rewrites=new Map(job.rewrites.map(item=>[item.from,item]));
  for(const folder of job.folders){
    const path=atDestination?folder.to:folder.from;
    const inventory=scan(root,path);
    for(const file of inventory.files) actual.add(file.path);
    for(const directory of inventory.directories)directories.add(directory);
  }
  for(const file of job.files){
    const target=atDestination?consolidatedLibraryPath(file.path):file.path;
    const rewrite=afterRewrite?rewrites.get(file.path):undefined;
    const expected=rewrite?hash(rewrite.after):file.hash;
    if(!actual.delete(target)||fileHash(disk(root,target))!==expected)fail('LIBRARY_CONTENT_CHANGED');
  }
  for(const directory of job.directories){
    if(!directories.delete(atDestination?consolidatedLibraryPath(directory):directory))fail('LIBRARY_CONTENT_CHANGED');
  }
  if(atDestination)for(const folder of job.folders)if(!folder.present&&!directories.delete(folder.to))fail('LIBRARY_CONTENT_CHANGED');
  if(actual.size||directories.size)fail('LIBRARY_CONTENT_CHANGED');
}
export function migrateLibrary(root:string,expected?:string){
  let job=readJournal(root);
  if(job?.state==='rolling-back')return rollbackLibrary(root);
  if(job?.state==='completed'||libraryLayoutEnabled(root)&&job?.state!=='moving'){
    setPending(root,false);
    return libraryPreview(root);
  }
  if(job?.state==='rolled-back'&&libraryMigrationPending(root)){
    setPending(root,false);
    return publicState(root,job);
  }
  if(!job||job.state==='rolled-back'){
    const preview=planned(root);
    if(preview.fingerprint!==expected)fail('VERSION_CONFLICT');
    if(preview.conflicts.length)fail('LIBRARY_CONFLICT');
    const files=preview.files.map(file=>({path:file.path,hash:fileHash(disk(root,file.path))}));
    job={version:1,id:randomUUID(),at:new Date().toISOString(),state:'moving',folders:preview.folders,files,directories:preview.directories,rewrites:preview.rewrites,raw:preview.raw};
    mkdirSync(safeKnowledgeFile(root,'.trash'),{recursive:true});
    save(root,job);
  }
  setPending(root,true);
  const library=disk(root,'library');
  if(!stat(library))mkdirSync(library);
  else if(!lstatSync(library).isDirectory())fail('LIBRARY_CONFLICT');
  for(const folder of job.folders){
    const from=disk(root,folder.from),to=disk(root,folder.to);
    const source=stat(from),target=stat(to);
    if(source&&target||source&&!source.isDirectory()||target&&!target.isDirectory())fail('LIBRARY_CONFLICT');
    if(source)renameSync(from,to);
    else if(!target){if(folder.present)fail('LIBRARY_CONTENT_CHANGED');mkdirSync(to);}
  }
  // Allow resumption after links were already updated by an interrupted run.
  patchLinks(root,job);
  verify(root,job,true,true);
  rawLink(root,rawAfter);
  emit(safeKnowledgeFile(root,libraryLayoutMarker),JSON.stringify({version:1,job:job.id})+'\n');
  job.state='completed';save(root,job);
  setPending(root,false);
  return publicState(root,job);
}
export function rollbackLibrary(root:string){
  const job=readJournal(root);
  if(!job)return fail('LIBRARY_ROLLBACK_UNAVAILABLE');
  if(job.state==='rolled-back'){setPending(root,false);return publicState(root,job);}
  if(job.state!=='completed'&&job.state!=='rolling-back')fail('LIBRARY_ROLLBACK_UNAVAILABLE');
  const library=stat(disk(root,'library'));
  if(library&&!library.isDirectory())fail('LIBRARY_CONFLICT');
  if(job.state==='completed'){
    verify(root,job,true,true);
    for(const item of job.rewrites)if(!stat(disk(root,item.to))?.isFile()||readFileSync(disk(root,item.to),'utf8')!==item.after)fail('LIBRARY_CONTENT_CHANGED');
    if(job.folders.some(folder=>stat(disk(root,folder.from))))fail('LIBRARY_CONFLICT');
    const entries=readdirSync(disk(root,'library'));
    if(entries.some(name=>!job.folders.some(folder=>folder.to==='library/'+name)))fail('LIBRARY_CONTENT_CHANGED');
    job.state='rolling-back';save(root,job);
  }
  setPending(root,true);
  for(const item of job.rewrites){
    const path=stat(disk(root,item.to))?item.to:item.from;
    patchLinks(root,{...job,rewrites:[{...item,to:path}]},true);
  }
  for(const folder of job.folders){
    const from=disk(root,folder.from),to=disk(root,folder.to);
    if(stat(to)){if(stat(from))fail('LIBRARY_CONFLICT');if(folder.present)renameSync(to,from);else rmdirSync(to);}
  }
  verify(root,job,false,false);
  rawLink(root,job.raw);
  if(stat(disk(root,libraryLayoutMarker)))unlinkSync(disk(root,libraryLayoutMarker));
  if(stat(disk(root,'library')))rmdirSync(disk(root,'library'));
  job.state='rolled-back';save(root,job);
  setPending(root,false);
  return publicState(root,job);
}
