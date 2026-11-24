import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { experimentError } from '@trash/storage';
import type { ExperimentService } from './experiment/service.js';

type Kind='repository'|'reproduction';
type Selection={kind:Kind;id:string};
type Journal=Selection&{
  version:1;state:'moving'|'completed'|'rolling-back'|'rolled-back';from:string;to:string;
  before:string;after:string;external:boolean;digest:string;files:number;bytes:number;at:string
};
const fail=(code:string,status=409):never=>experimentError(code,status);
function info(path:string){
  try{return lstatSync(path);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
function within(parent:string,path:string){return path.startsWith(parent+sep);}
function location(root:string,path:string,createParents=false){
  const parts=path.split('/');
  let current=root;
  if(parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\')||part.includes('\0')))return fail('REPOSITORY_PATH_INVALID',422);
  for(const [i,part] of parts.entries()){
    current=join(current,part);
    const stat=info(current);
    if(stat&&(stat.isSymbolicLink()||(i<parts.length-1&&!stat.isDirectory())))fail('CODE_MOVE_UNSAFE_PATH',422);
    if(!stat&&createParents&&i<parts.length-1)mkdirSync(current);
  }
  return current;
}
function inventory(path:string){
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(256*1024);let files=0,bytes=0;
  function scan(node:string,name:string){
    const stat=lstatSync(node);
    if(stat.isDirectory()){
      hash.update(JSON.stringify(['directory',name]));
      for(const entry of readdirSync(node).sort())scan(join(node,entry),name?name+'/'+entry:entry);
    }else if(stat.isFile()){
      const digest=createHash('sha256'),fd=openSync(node,'r');
      try{let length:number;while((length=readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,length));}
      finally{closeSync(fd);}
      files++;bytes+=stat.size;
      hash.update(JSON.stringify(['file',name,stat.mode&0o111,digest.digest('hex')]));
    }else fail('CODE_MOVE_UNSAFE_PATH',422);
  }
  if(!info(path)?.isDirectory())return fail('CODE_MOVE_SOURCE_MISSING',404);
  scan(path,'');
  return {digest:hash.digest('hex'),files,bytes};
}
const pendingFile='.trash/code-migrations/pending.json';
export function codeMigrationPending(root:string){return Boolean(info(join(root,pendingFile)));}
function storeJournal(file:string,job:Journal|Selection){
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600});
  try{renameSync(temporary,file);}
  finally{if(info(temporary))unlinkSync(temporary);}
}
const fingerprint=(value:object)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CodeDirectoryMigration {
  private root:string;
  constructor(private service:ExperimentService,private projectId:string){
    this.root=realpathSync(join(service.store.root,'projects',projectId));
  }
  private key(selection:Selection){return selection.kind+'-'+fingerprint({id:selection.id});}
  private journal(selection:Selection,create=false){return location(this.root,'.trash/code-migrations/'+this.key(selection)+'.json',create);}
  private saved(selection:Selection){
    const file=this.journal(selection);
    return info(file)?.isFile()?JSON.parse(readFileSync(file,'utf8')) as Journal:undefined;
  }
  private choices(){
    return [
      ...this.service.data.repositories(this.projectId).map(record=>({
        kind:'repository' as const,id:record.repository_id,name:record.name??basename(record.path),path:record.path
      })),
      ...this.service.reproductions.list(this.projectId).map(record=>({
        kind:'reproduction' as const,id:record.id,name:record.name,path:record.path
      }))
    ];
  }
  list(){return this.choices().map(item=>({kind:item.kind,id:item.id,name:item.name,path:item.path,state:this.saved(item)?.state}));}
  private pending(item:Selection,begin?:boolean){
    const path=location(this.root,pendingFile,begin===true);
    if(info(path)){
      const owner=JSON.parse(readFileSync(path,'utf8')) as Selection;
      if(owner.kind!==item.kind||owner.id!==item.id)fail('CODE_MOVE_RESUME_FIRST');
      if(begin===false)unlinkSync(path);
    }else if(begin)storeJournal(path,item);
  }
  private record(item:Selection){
    return item.kind==='repository'
      ? this.service.repository.bound(this.projectId,item.id)
      : this.service.reproductions.get(this.projectId,item.id);
  }
  private updateRecord(item:Selection,path:string,prior:string){
    const record=this.record(item);
    if(record.path===path)return;
    if(record.path!==prior)return fail('CODE_MOVE_CHANGED');
    if('repository_id' in record)this.service.data.saveRepository({...record,path},false);
    else this.service.reproductions.relocate(this.projectId,record.id,path);
  }
  private plan(item:Selection){
    const record=this.record(item);
    const resolved=realpathSync(record.path);
    const external=!within(this.root,resolved);
    let from=!external?relative(this.root,resolved).split(sep).join('/'):undefined;
    let to:string;
    if('repository_id' in record){
      if(!record.paper_id)return fail('CODE_MOVE_PAPER_REQUIRED');
      if(!from||!from.startsWith('code/'))return fail('CODE_MOVE_EXTERNAL');
      to='code/papers/'+record.paper_id;
      if(info(join(resolved,'.git'))?.isDirectory()!==true)fail('CODE_MOVE_UNSAFE_PATH',422);
      // A Git worktree can contain pointers to other directories which a rename would break.
      if(info(join(resolved,'.git','worktrees'))||info(join(resolved,'.git','objects','info','alternates')))fail('CODE_MOVE_UNSAFE_PATH',422);
    }else{
      if(!record.imported)return fail('CODE_MOVE_EXTERNAL');
      const target=this.service.reproductions.publicDirectory(this.projectId,record.id,record.source_id);
      to='code/reproductions/'+basename(dirname(target))+'/'+basename(target)+'/code';
      if(!from){
        const candidate='reproductions/'+basename(dirname(resolved))+'/code';
        const workspaceCopy=location(this.root,candidate);
        if(inventory(workspaceCopy).digest!==inventory(resolved).digest)fail('CODE_MOVE_COPIES_DIFFER');
        from=candidate;
      }
      if(!from.startsWith('reproductions/')&&!from.startsWith('code/reproductions/'))return fail('CODE_MOVE_UNSAFE_PATH',422);
    }
    if(!from||isAbsolute(from)||isAbsolute(to))return fail('CODE_MOVE_UNSAFE_PATH',422);
    if(from===to)return fail('CODE_MOVE_ALREADY_PLACED');
    const source=location(this.root,from),destination=location(this.root,to);
    if(info(destination)||within(source,destination)||within(destination,source))return fail('CODE_MOVE_TARGET_EXISTS');
    const data=inventory(source);
    return {from,to,before:record.path,after:join(this.service.store.root,"projects",this.projectId,to),external,...data};
  }
  preview(item:Selection){
    const job=this.saved(item);
    if(job&&job.state!=='rolled-back')return {...job,fingerprint:undefined};
    const plan=this.plan(item);
    return {...plan,state:'ready' as const,fingerprint:fingerprint(plan)};
  }
  migrate(item:Selection,expected?:string){
    this.pending(item);
    let job=this.saved(item);
    if(job?.state==='completed'){this.pending(item,false);return job;}
    if(job?.state==='rolling-back')return this.rollback(item);
    if(!job||job.state==='rolled-back'){
      const plan=this.plan(item);
      if(fingerprint(plan)!==expected)return fail('VERSION_CONFLICT');
      job={...item,...plan,version:1,state:'moving',at:new Date().toISOString()};
      storeJournal(this.journal(item,true),job);
    }
    const source=location(this.root,job.from),target=location(this.root,job.to,true);
    const existing=info(source);
    if(existing&&info(target))return fail('CODE_MOVE_TARGET_EXISTS');
    if(inventory(existing?source:target).digest!==job.digest)return fail('CODE_MOVE_CHANGED');
    const previous=this.record(item).path;
    if(previous!==job.before&&previous!==job.after)return fail('CODE_MOVE_CHANGED');
    this.pending(item,true);
    if(existing)renameSync(source,target);
    this.updateRecord(item,job.after,job.before);
    job.state='completed';
    storeJournal(this.journal(item),job);
    this.pending(item,false);
    return job;
  }
  rollback(item:Selection){
    this.pending(item);
    const job=this.saved(item);
    if(!job)return fail('CODE_MOVE_NO_JOURNAL');
    if(job.state==='rolled-back'){this.pending(item,false);return job;}
    if(job.state==='moving')return fail('CODE_MOVE_RESUME_FIRST');
    const source=location(this.root,job.from,true),target=location(this.root,job.to);
    const existing=info(target);
    if(existing&&info(source))return fail('CODE_MOVE_TARGET_EXISTS');
    if(inventory(existing?target:source).digest!==job.digest)return fail('CODE_MOVE_CHANGED');
    if(job.external&&inventory(realpathSync(job.before)).digest!==job.digest)return fail('CODE_MOVE_COPIES_DIFFER');
    const previous=this.record(item).path;
    if(previous!==job.before&&previous!==job.after)return fail('CODE_MOVE_CHANGED');
    job.state='rolling-back';
    storeJournal(this.journal(item),job);
    this.pending(item,true);
    if(existing)renameSync(target,source);
    this.updateRecord(item,job.before,job.after);
    job.state='rolled-back';
    storeJournal(this.journal(item),job);
    this.pending(item,false);
    return job;
  }
}
