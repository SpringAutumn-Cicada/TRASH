import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync, readlinkSync } from 'node:fs';
import { mkdir, readdir, lstat, readlink, symlink, copyFile, realpath, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TrashStore, KnowledgeStore, libraryLayoutEnabled, libraryLayoutMarker, projectLibraryPath } from '@trash/storage';
import { z } from 'zod';
import { libraryMigrationPending } from './library-migration.js';

export function workspaceError(error:unknown):never {
  if(error instanceof z.ZodError)throw error;
  if(error&&typeof error==='object'&&'code' in error){
    const code=String(error.code);
    if(['ENOENT','ENOTDIR'].includes(code))return fail('LOCAL_DIRECTORY_NOT_FOUND',404);
    if(['EACCES','EPERM','EROFS'].includes(code))return fail('LOCAL_DIRECTORY_ACCESS_DENIED',403);
    if(code==='EEXIST')return fail('WORKSPACE_TARGET_EXISTS');
    if(code==='ENOSPC')return fail('WORKSPACE_NO_SPACE',422);
  }
  throw error;
}
function fail(message:string,statusCode=409):never {
  throw Object.assign(new Error(message),{statusCode});
}
const directories=['literature/originals','literature/parsed','code','data','experiments','manuscript','research','.trash'];
const requestSchema=z.object({root:z.string().min(1).max(4096).refine(value=>isAbsolute(value)&&!value.includes('\0')),name:z.string().trim().min(1).max(120).refine(value=>value!=='.'&&value!=='..'&&!/[\\/]/.test(value)&&!Array.from(value).some(character=>character.charCodeAt(0)<32))}).strict();
type Job={id:string;projectId:string;status:'copying'|'verifying'|'switching'|'completed'|'failed'|'interrupted';source:string;target:string;stage:string;backup?:string;files:number;bytes:number;totalFiles:number;totalBytes:number;externalLinks:string[];error?:string;createdAt:string};
type Entry={path:string;size:number;link?:string;hash?:string};
const inside=(parent:string,path:string)=>path===parent||path.startsWith(parent+sep);
const json=(path:string,value:unknown)=>{const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});renameSync(temp,path);};
export class ProjectWorkspaces {
  private active=new Set<string>();
  private closing=false;
  close(){this.closing=true;}
  private jobs=new Map<string,Job>();
  private reservations=new Set<string>();
  readonly requests=new Map<string,number>();
  constructor(private store:TrashStore,private knowledge:KnowledgeStore){
    mkdirSync(this.jobRoot(),{recursive:true});
    mkdirSync(join(this.store.root,"workspaces"),{recursive:true});
    for(const name of readdirSync(this.jobRoot()).filter(name=>name.endsWith('.json'))){
      const job=JSON.parse(readFileSync(join(this.jobRoot(),name),'utf8')) as Job;
      if(!store.getProject(job.projectId))continue;
      if(!['completed','failed','interrupted'].includes(job.status)){
        const anchor=this.anchor(job.projectId);
        const switched=existsSync(anchor)&&realpathSync(anchor)===job.target;
        job.status=switched?'completed':'interrupted';
        job.error=switched?undefined:'服务重启中断迁移，源目录和临时副本均保留；可重新迁移到其他空目录。';
        if(!switched&&!existsSync(anchor)&&job.backup&&existsSync(job.backup))renameSync(job.backup,anchor);
        if(switched){
          try{this.rebind(job.projectId,job.source,job.target);this.materialize(job.projectId);}
          catch(error){job.error=error instanceof Error?error.message:'迁移恢复后整理失败，已保留旧目录备份。';}
        }
        this.save(job);
      }
      const previous=this.jobs.get(job.projectId);
      if(!previous||previous.createdAt<job.createdAt)this.jobs.set(job.projectId,job);
    }
  }
  private jobRoot(){return join(this.store.root,'workspace-migrations');}
  private anchor(id:string){return join(this.store.root,'projects',id);}
  private save(job:Job){json(join(this.jobRoot(),job.id+'.json'),job);const current=this.jobs.get(job.projectId);if(!current||current.createdAt<=job.createdAt)this.jobs.set(job.projectId,job);}
  busy(id:string){return this.active.has(id);}
  private externalReferences(id:string,path:string){
    const refs=new Set<string>();
    const visit=(value:unknown,key='')=>{
      if(typeof value==='string'&&/(?:path|directory|cwd|root|uri)$/i.test(key)&&isAbsolute(value)&&!inside(path,value)&&!inside(this.anchor(id),value))refs.add(value);
      else if(Array.isArray(value))for(const entry of value)visit(entry,key);
      else if(value&&typeof value==='object')for(const [name,entry] of Object.entries(value))visit(entry,name);
    };
    for(const table of ['experiment_repositories','project_code_repositories','experiment_datasets','experiment_plans'])for(const row of this.store.db.prepare(`SELECT data FROM ${table} WHERE project_id=?`).all(id) as {data:string}[])visit(JSON.parse(row.data));
    return [...refs];
  }
  state(id:string){
    const anchor=this.anchor(id),path=existsSync(anchor)?realpathSync(anchor):anchor;
    const backups=readdirSync(this.jobRoot()).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(this.jobRoot(),name),'utf8')) as Job).filter(job=>job.projectId===id&&job.status==='completed'&&job.backup).map(job=>({id:job.id,path:job.backup!}));
    return {path,backups,externalReferences:this.externalReferences(id,path),configured:existsSync(join(path,'project.yaml')),defaultRoot:join(this.store.root,'workspaces'),folder:basename(path),migration:this.jobs.get(id)??null,library:{migrated:libraryLayoutEnabled(path),pending:libraryMigrationPending(path)}};
  }
  private async destination(value:unknown){
    const input=requestSchema.parse(value),root=await realpath(input.root),target=join(root,input.name);
    try{lstatSync(target);fail('WORKSPACE_TARGET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Never create project workspaces inside the platform's internal store.
    if(inside(realpathSync(this.store.root),target)&&!inside(join(realpathSync(this.store.root),'workspaces'),target))fail('WORKSPACE_INVALID_TARGET');
    if([...this.reservations].some(path=>inside(path,target)||inside(target,path)))fail('WORKSPACE_TARGET_EXISTS');
    for(const project of this.store.listProjects()){
      const anchor=this.anchor(project.project_id);
      if(existsSync(anchor)){const path=realpathSync(anchor);if(inside(path,target)||inside(target,path))fail('WORKSPACE_NESTED');}
    }
    return target;
  }
  async initialize(id:string,value?:unknown){
    if(this.active.has(id))fail('WORKSPACE_MIGRATING');
    this.active.add(id);let target:string|undefined,created=false,linked=false;
    try{
      const root=join(this.store.root,'workspaces');mkdirSync(root,{recursive:true});
      target=await this.destination(value??{root,name:id});this.reservations.add(target);
      mkdirSync(target);created=true;
      mkdirSync(join(target,'.trash'));
      json(join(target,libraryLayoutMarker),{version:1});
      this.layout(id,target);symlinkSync(target,this.anchor(id),'dir');linked=true;
      this.materialize(id);return this.state(id);
    }catch(error){
      if(linked)rmSync(this.anchor(id));
      if(created&&target)rmSync(target,{recursive:true,force:true});
      throw error;
    }finally{this.active.delete(id);if(target)this.reservations.delete(target);}
  }
  private layout(id:string,root:string){
    for(const dir of [...directories,'abstract-library','knowledge_base'].map(dir=>projectLibraryPath(root,dir))){
      let path=root;
      for(const part of dir.split('/')){
        path=join(path,part);
        if(existsSync(path)&&lstatSync(path).isSymbolicLink())fail('WORKSPACE_RESERVED_SYMLINK');
        mkdirSync(path,{recursive:true});
      }
    }
    const marker=join(root,'project.yaml');
    if(existsSync(marker)&&lstatSync(marker).isSymbolicLink())fail('WORKSPACE_RESERVED_SYMLINK');
    if(existsSync(marker)){
      const text=readFileSync(marker,'utf8');if(!text.includes(JSON.stringify(id)))fail('WORKSPACE_PROJECT_MISMATCH');
    }else writeFileSync(marker,`format_version: 2\nproject_id: ${JSON.stringify(id)}\n`,{flag:'wx',mode:0o600});
    const readme=join(root,'README.md');
    if(!existsSync(readme))writeFileSync(readme,`# 论文工作区

文献资料库 library/ 收纳原文、摘要和项目知识。代码 code/、共享数据 data/、实验 experiments/、稿件 manuscript/。

对话中明确要求保存的研究想法、方案和讨论笔记直接放在 research/。

论文仓库通过论文页创建或绑定。项目内仓库放在 code/papers/<paper_id>/，复现源码放在 code/reproductions/。

研究方向说明在 wiki/directions/<方向ID>.md，实验方案和运行归档在 experiments/<方向ID>/<方案ID>/runs/<运行ID>/。

在文件模块使用“研究目录”创建方向、实验方案和运行批次；目录创建不代表已执行实验。
平台运行记录保存在 .trash/runtime/；旧项目内部路径继续兼容，不自动移动。子目录按需创建，数据和公共代码使用引用避免重复复制。
`,{flag:'wx',mode:0o600});
    // Keep legacy artifact references valid while originals live in the public layout.
    const raw=join(root,'raw'),originalsPath=projectLibraryPath(root,'literature/originals'),originals=join(root,originalsPath);
    if(existsSync(raw)&&lstatSync(raw).isSymbolicLink()&&readlinkSync(raw)!==originalsPath)fail('WORKSPACE_RESERVED_SYMLINK');
    if(existsSync(raw)&&!lstatSync(raw).isSymbolicLink()){
      if(readdirSync(originals).length)fail('WORKSPACE_ORIGINALS_CONFLICT');
      rmSync(originals,{recursive:true});renameSync(raw,originals);
    }
    if(!existsSync(raw))symlinkSync(originalsPath,raw,'dir');
    const drafts=join(root,'agent-workspace','manuscripts'),manuscript=join(root,'manuscript');
    if(existsSync(drafts)&&!lstatSync(drafts).isSymbolicLink()&&readdirSync(manuscript).length===0){
      if(lstatSync(join(root,'agent-workspace')).isSymbolicLink())fail('WORKSPACE_RESERVED_SYMLINK');
      rmSync(manuscript,{recursive:true});renameSync(drafts,manuscript);symlinkSync('../manuscript',drafts,'dir');
    }
  }
  private materialize(id:string){
    this.layout(id,realpathSync(this.anchor(id)));
    for(const kind of ['literature-card','wiki-page'] as const){
      const records=this.knowledge.list(id,kind);
      for(const record of records){
        const history=this.knowledge.history(id,kind,record.object_id);
        this.knowledge.materializeHistory(id,history);
      }
    }
    for(const source of this.store.listSources(id))json(join(this.anchor(id),projectLibraryPath(this.anchor(id),'literature/parsed'),source.source_id+'.json'),{source,segments:this.store.listSourceSegments(source.source_id)});
    const tables=['projects','sources','artifacts','knowledge_versions','knowledge_keys','knowledge_metrics','knowledge_tasks','experiment_repositories','experiment_datasets','experiment_environments','experiment_plans','experiment_runs'];
    const snapshot=Object.fromEntries(tables.map(table=>[table,this.store.db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(id)]));
    const details={
      source_details:this.store.db.prepare('SELECT d.* FROM source_details d JOIN sources s ON s.source_id=d.source_id WHERE s.project_id=?').all(id),
      source_attachments:this.store.db.prepare('SELECT d.* FROM source_attachments d JOIN sources s ON s.source_id=d.source_id WHERE s.project_id=?').all(id),
      reviews:this.store.db.prepare('SELECT r.* FROM knowledge_reviews r WHERE r.object_id IN (SELECT object_id FROM knowledge_versions WHERE project_id=?)').all(id),
      task_events:this.store.db.prepare('SELECT e.* FROM knowledge_task_events e JOIN knowledge_tasks t ON t.task_id=e.task_id WHERE t.project_id=?').all(id)
    };
    json(join(this.anchor(id),'.trash','project-records.json'),{exportedAt:new Date().toISOString(),tables:snapshot,...details});
  }
  async start(id:string,value:unknown){
    if(this.closing)fail('SERVER_STOPPING');
    if(this.active.has(id))fail('WORKSPACE_MIGRATING');
    this.active.add(id);
    try{
      mkdirSync(join(this.store.root,'workspaces'),{recursive:true});
      const target=await this.destination(value),anchor=this.anchor(id);
      mkdirSync(anchor,{recursive:true});const source=realpathSync(anchor);
      this.reservations.add(target);
      const job:Job={id:randomUUID(),projectId:id,status:'copying',source,target,stage:join(dirname(target),'.trash-migration-'+randomUUID()),files:0,bytes:0,totalFiles:0,totalBytes:0,externalLinks:[],createdAt:new Date().toISOString()};
      this.save(job);void this.migrate(job).finally(()=>{this.active.delete(id);this.reservations.delete(target);}).catch(()=>{});return job;
    }catch(error){this.active.delete(id);throw error;}
  }
  private async scan(root:string,path='',entries:Entry[]=[]):Promise<Entry[]>{
    for(const name of await readdir(join(root,path))){
      const rel=join(path,name),full=join(root,rel),stat=await lstat(full);
      if(stat.isSymbolicLink())entries.push({path:rel,size:0,link:await readlink(full)});
      else if(stat.isDirectory()){entries.push({path:rel,size:-1});await this.scan(root,rel,entries);}
      else if(stat.isFile())entries.push({path:rel,size:stat.size});
      else fail('WORKSPACE_SPECIAL_FILE');
    }
    return entries;
  }
  private async hash(path:string){
    const {createReadStream}=await import('node:fs');
    const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
  }
  private async migrate(job:Job){
    try{
      // Flush external Markdown changes before taking a snapshot of project files.
      if(this.state(job.projectId).configured)this.materialize(job.projectId);
      const entries=await this.scan(job.source);
      job.totalFiles=entries.filter(entry=>entry.size>=0).length;job.totalBytes=entries.reduce((sum,entry)=>sum+Math.max(0,entry.size),0);
      const space=await statfs(dirname(job.target));if(Number(space.bavail)*Number(space.bsize)<job.totalBytes)fail('WORKSPACE_NO_SPACE');
      await mkdir(job.stage);
      for(const entry of entries){
        if(this.closing)fail("SERVER_STOPPING");
        const from=join(job.source,entry.path),to=join(job.stage,entry.path);
        if(entry.size===-1)await mkdir(to,{recursive:true});
        else {
          await mkdir(dirname(to),{recursive:true});
          if(entry.link!==undefined){
            const resolved=resolve(dirname(from),entry.link);
            if(!inside(job.source,resolved))job.externalLinks.push(entry.path);
            const link=inside(job.source,resolved)?relative(dirname(join(job.target,entry.path)),join(job.target,relative(job.source,resolved))):isAbsolute(entry.link)?entry.link:resolved;
            await symlink(link,to);
          }else{entry.hash=await this.hash(from);await copyFile(from,to);}
          job.files++;job.bytes+=entry.size;this.save(job);
        }
      }
      job.status='verifying';this.save(job);
      for(const entry of entries){
        if(entry.hash&&(await this.hash(join(job.stage,entry.path))!==entry.hash||await this.hash(join(job.source,entry.path))!==entry.hash))fail('WORKSPACE_SOURCE_CHANGED');
        if(entry.link!==undefined&&await readlink(join(job.source,entry.path))!==entry.link)fail('WORKSPACE_SOURCE_CHANGED');
      }
      const current=await this.scan(job.source);
      if(JSON.stringify(current.map(e=>[e.path,e.size,e.link]))!==JSON.stringify(entries.map(e=>[e.path,e.size,e.link])))fail('WORKSPACE_SOURCE_CHANGED');
      if(this.closing)fail("SERVER_STOPPING");
      this.layout(job.projectId,job.stage);
      if(existsSync(job.target))fail('WORKSPACE_TARGET_EXISTS');
      renameSync(job.stage,job.target);
      const anchor=this.anchor(job.projectId),wasLink=lstatSync(anchor).isSymbolicLink();
      job.backup=wasLink?job.source:anchor+'.before-migration-'+job.id;
      job.status='switching';this.save(job);
      const next=anchor+'.next-'+job.id;symlinkSync(job.target,next,'dir');
      if(!wasLink)renameSync(anchor,job.backup);
      try{renameSync(next,anchor);}catch(error){if(!wasLink)renameSync(job.backup,anchor);throw error;}
      this.rebind(job.projectId,job.source,job.target);
      this.materialize(job.projectId);
      job.status='completed';this.save(job);
    }catch(error){
      // The anchor is the authoritative binding, including after an interrupted switch.
      const anchor=this.anchor(job.projectId),switched=existsSync(anchor)&&realpathSync(anchor)===job.target;
      job.status=switched?'completed':'failed';job.error=error instanceof Error?error.message:'迁移失败';this.save(job);
    }
  }
  private rebind(id:string,source:string,target:string){
    const map=(value:unknown):unknown=>typeof value==='string'&&inside(source,value)?target+value.slice(source.length):Array.isArray(value)?value.map(map):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,map(entry)])):value;
    this.store.db.transaction(()=>{
      for(const table of ['experiment_repositories','project_code_repositories','experiment_datasets','experiment_plans','experiment_runs']){
        const rows=this.store.db.prepare(`SELECT rowid,data FROM ${table} WHERE project_id=?`).all(id) as {rowid:number;data:string}[];
        for(const row of rows)this.store.db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(JSON.stringify(map(JSON.parse(row.data))),row.rowid);
      }
    })();
    for(const [folder,pattern] of [
      ['reproductions',/^repro_[a-f0-9-]+\.json$/],
      ['code/reproductions',/^repro_[a-f0-9-]+\.json$/],
      ['.trash/runtime/reproductions',/^repro_[a-f0-9-]+\.json$/],
      ['.trash/code-migrations',/^(?:repository|reproduction)-[a-f0-9]{64}\.json$/]
    ] as const){
      const directory=join(target,folder);
      if(!existsSync(directory)||!lstatSync(directory).isDirectory())continue;
      for(const name of readdirSync(directory).filter(name=>pattern.test(name))){
        const file=join(directory,name);
        if(!lstatSync(file).isFile())continue;
        const before=JSON.parse(readFileSync(file,'utf8')),after=map(before);
        if(JSON.stringify(before)!==JSON.stringify(after))json(file,after);
      }
    }

  }
  cleanup(id:string,jobId:string){
    const file=join(this.jobRoot(),jobId+'.json');
    const job=existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as Job:undefined;
    if(!job||job.projectId!==id||job.id!==jobId||job.status!=='completed'||job.error||!job.backup||this.busy(id))fail('WORKSPACE_BACKUP_UNAVAILABLE');
    const path=realpathSync(job.backup),current=realpathSync(this.anchor(id));
    if(path!==job.backup||inside(path,current)||inside(current,path))fail('WORKSPACE_INVALID_TARGET');
    for(const project of this.store.listProjects())if(existsSync(this.anchor(project.project_id))&&inside(path,realpathSync(this.anchor(project.project_id))))fail('WORKSPACE_BACKUP_IN_USE');
    // Verify ownership before any explicit backup removal.
    const legacy=path===this.anchor(id)+'.before-migration-'+job.id;
    if(!legacy&&(!existsSync(join(path,'project.yaml'))||!readFileSync(join(path,'project.yaml'),'utf8').includes(JSON.stringify(id))))fail('WORKSPACE_PROJECT_MISMATCH');
    rmSync(path,{recursive:true});job.backup=undefined;this.save(job);return this.state(id);
  }
}
