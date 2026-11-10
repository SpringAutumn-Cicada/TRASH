import { visibleEntry } from "./project-layout.js";
import { constants, createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, statSync, fstatSync, unlinkSync, linkSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { KnowledgeStore, type TrashStore, parseKnowledgeMarkdown } from '@trash/storage';

const textLimit=2*1024*1024,uploadLimit=50*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{statusCode});}
const inputPath=z.string().max(4096).refine(value=>!value.includes('\\')&&!value.includes('\0')&&!isAbsolute(value)&&!value.split('/').some(part=>part==='..'||part==='.'));
const inside=(root:string,path:string)=>path===root||path.startsWith(root+sep);
const textExtensions=new Set(['.md','.markdown','.txt','.json','.jsonl','.yaml','.yml','.csv','.tsv','.log','.py','.ts','.tsx','.js','.jsx','.mjs','.cjs','.html','.css','.scss','.sh','.bash','.toml','.ini','.cfg','.xml','.bib','.ris','.tex','.rst','.sql','.r','.c','.cpp','.h','.gitignore','.svg']);
const mimeTypes:Record<string,string>={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp'};
const internal=new Set(['.trash','.git','project.yaml','raw','files','tasks','code-agent','literature-analysis','agent-workspace','environment-analysis','environment-deployments','dataset-hashes','dataset-upload-sessions','directory-repairs','experiment-bindings','experiment-runs','remote-workspaces','reproductions','reproduction-queues']);
type FileEntry={name:string;path:string;kind:'directory'|'file'|'symlink';size:number;modified:string;protected:boolean};
type Recycled={id:string;path:string;deletedAt:string;fingerprint:string;kind:'file'|'directory'};
export class ProjectFiles {
  private knowledge:KnowledgeStore;
  constructor(private store:TrashStore,private blocked:(id:string)=>boolean){this.knowledge=new KnowledgeStore(store.db);}
  private root(id:string){const root=join(this.store.root,'projects',id);if(!existsSync(root))fail('FILES_WORKSPACE_MISSING',404);return realpathSync(root);}
  private locate(id:string,value:string,allowMissing=false){
    inputPath.parse(value);const root=this.root(id),path=resolve(root,value||'.');if(!inside(root,path))fail('FILES_OUTSIDE_WORKSPACE',403);
    let current=root;
    for(const part of relative(root,path).split(sep).filter(Boolean)){
      current=join(current,part);
      try{if(lstatSync(current).isSymbolicLink())fail('FILES_SYMLINK',403);}catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
    }
    if(!allowMissing&&!inside(root,realpathSync(path)))fail('FILES_OUTSIDE_WORKSPACE',403);
    return path;
  }
  private isProtected(path:string){
    const parts=path.split('/');
    return !path||parts.some(part=>part==='.git'||part==='.trash')||internal.has(parts[0])||(parts[0]==='wiki'&&parts[1]!=='directions')||(parts[0]==='code'&&parts[1]==='reproductions')||(parts[0]==='literature'&&(parts.length===1||['originals','parsed','cards'].includes(parts[1])));
  }
  private managed(path:string){
    const match=path.match(/^(wiki|literature\/cards)\/(knowledge_[A-Za-z0-9-]+)\.md$/);
    return match?{kind:match[1]==='wiki'?'wiki-page' as const:'literature-card' as const,id:match[2]}:undefined;
  }
  private writable(id:string,path:string){
    if(this.blocked(id))fail('PROJECT_HAS_ACTIVE_TASKS');
    if(this.isProtected(path))fail('FILES_MANAGED_READONLY',403);
    const physical=this.locate(id,path,true);
    // Registered artifacts remain immutable even when stored in a nonstandard project folder.
    const rows=this.store.db.prepare('SELECT artifact_id FROM artifacts WHERE project_id=?').all(id) as {artifact_id:string}[];
    for(const row of rows){const file=this.store.artifactFile(id,row.artifact_id);if(file){const target=realpathSync(file.path);if(inside(physical,target)||inside(target,physical))fail('FILES_MANAGED_READONLY',403);}}
    return physical;
  }
  private structuralWritable(id:string,path:string){
    const physical=this.writable(id,path);
    const row=this.store.db.prepare('SELECT data FROM experiment_repositories WHERE project_id=?').get(id) as {data:string}|undefined;
    const repository=row?(JSON.parse(row.data) as {path?:string}).path:undefined;
    if(repository&&existsSync(repository)&&inside(physical,realpathSync(repository)))fail('FILES_BOUND_REPOSITORY',403);
    return physical;
  }
  private entry(id:string,parent:string,name:string):FileEntry{
    const path=parent?parent+'/'+name:name,stat=lstatSync(join(this.root(id),path));
    return {name,path,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'file',size:stat.size,modified:stat.mtime.toISOString(),protected:this.isProtected(path)};
  }
  list(id:string,path:string,hidden:boolean){
    const directory=this.locate(id,path);if(!statSync(directory).isDirectory())fail('FILES_NOT_DIRECTORY',422);
    const names=readdirSync(directory).filter(name=>visibleEntry(path,name,hidden));
    if(names.length>5000)fail('FILES_DIRECTORY_TOO_LARGE',422);
    const entries=names.map(name=>this.entry(id,path,name)).sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
    return {root:this.root(id),path,entries};
  }
  search(id:string,query:string,hidden:boolean){
    if(!query.trim()||query.length>200)fail('INVALID_REQUEST',400);
    const queue=[''],entries:FileEntry[]=[];let visited=0,truncated=false;
    while(queue.length&&entries.length<200&&visited<10000){
      const path=queue.shift()!;
      let names:string[];try{names=readdirSync(this.locate(id,path));}catch{continue;}
      for(const name of names){
        if(!visibleEntry(path,name,hidden))continue;
        visited++;if(visited>10000){truncated=true;break;}
        const entry=this.entry(id,path,name);
        if(name.toLowerCase().includes(query.toLowerCase()))entries.push(entry);
        if(entry.kind==='directory'&&name!=='.git'&&name!=='.trash')queue.push(entry.path);
        if(entries.length>=200){truncated=true;break;}
      }
    }
    return {entries,truncated:truncated||queue.length>0};
  }
  private bytes(path:string,limit=textLimit){
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit)fail('FILES_TOO_LARGE',413);return readFileSync(fd);}finally{closeSync(fd);}
  }
  preview(id:string,path:string){
    const target=this.locate(id,path);if(!statSync(target).isFile())fail('FILES_NOT_FILE',422);
    const managed=this.managed(path),record=managed&&existsSync(join(this.root(id),'project.yaml'))?this.knowledge.get(id,managed.kind,managed.id):undefined;
    const stat=statSync(target),extension=extname(path).toLowerCase(),mime=mimeTypes[extension];
    const kind=mime==='application/pdf'?'pdf':mime?'image':textExtensions.has(extension)||basename(path)==='Dockerfile'||basename(path)==='Makefile'||basename(path)==='.gitignore'?'text':'binary';
    let content:string|undefined,etag:string|undefined;
    if(kind==='text'&&stat.size<=textLimit){
      const bytes=this.bytes(target);try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(content.includes('\0'))content=undefined;else etag=hash(bytes);}catch{content=undefined;}
    }
    return {path,name:basename(path),size:stat.size,modified:stat.mtime.toISOString(),kind,content,etag,managed:record?{kind:record.kind,id:record.object_id,version:record.version}:undefined,editable:content!==undefined&&Boolean(record||!this.isProtected(path)),readonlyReason:this.isProtected(path)&&!record?'此文件由平台管理，请通过对应模块维护。':undefined};
  }
  save(id:string,value:unknown){
    const input=z.object({path:inputPath,etag:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().max(textLimit),version:z.number().int().positive().optional()}).strict().parse(value);
    if(Buffer.byteLength(input.content)>textLimit)fail('FILES_TOO_LARGE',413);
    if(this.blocked(id))fail('PROJECT_HAS_ACTIVE_TASKS');
    const path=this.locate(id,input.path),managed=this.managed(input.path);
    if(managed){
      if(!existsSync(join(this.root(id),'project.yaml')))fail('FILES_MANAGED_READONLY',403);
      const record=this.knowledge.get(id,managed.kind,managed.id);if(!record||input.version!==record.version)fail('VERSION_CONFLICT');
      if(hash(this.bytes(path))!==input.etag)fail('FILES_CHANGED');
      this.knowledge.write(id,managed.kind,{object_id:managed.id,base_version:record.version,content:parseKnowledgeMarkdown(input.content,record)});
    }else{
      if(!this.preview(id,input.path).editable)fail('FILES_MANAGED_READONLY',403);
      this.writable(id,input.path);if(hash(this.bytes(path))!==input.etag)fail('FILES_CHANGED');
      const temp=path+'.'+randomUUID()+'.tmp';
      try{writeFileSync(temp,input.content,{flag:'wx',mode:lstatSync(path).mode&0o777});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
    }
    return this.preview(id,input.path);
  }
  create(id:string,value:unknown){
    const input=z.object({path:inputPath,kind:z.enum(['file','directory'])}).strict().parse(value),path=this.writable(id,input.path);
    this.locate(id,relative(this.root(id),dirname(path)).split(sep).join('/'));
    if(input.kind==='directory')mkdirSync(path);else writeFileSync(path,'',{flag:'wx',mode:0o600});
    return {path:input.path};
  }
  move(id:string,value:unknown){
    const input=z.object({path:inputPath,target:inputPath,fingerprint:z.string()}).strict().parse(value);
    const from=this.structuralWritable(id,input.path),to=this.writable(id,input.target);
    if(inside(from,to))fail('FILES_INVALID_MOVE',422);
    this.locate(id,relative(this.root(id),dirname(to)).split(sep).join('/'));
    try{lstatSync(to);fail('FILES_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.fingerprint(from)!==input.fingerprint)fail('FILES_CHANGED');
    renameSync(from,to);return {path:input.target};
  }
  fingerprint(path:string,budget={remaining:20000},depth=0):string{
    if(--budget.remaining<0||depth>128)fail("FILES_DIRECTORY_TOO_LARGE",422);
    const stat=lstatSync(path);if(stat.isSymbolicLink())fail('FILES_SYMLINK',403);
    if(stat.isDirectory())return hash(Buffer.from(JSON.stringify(readdirSync(path).sort().map(name=>[name,this.fingerprint(join(path,name),budget,depth+1)]))));
    if(!stat.isFile())fail('FILES_NOT_FILE',422);
    // Structural operations compare filesystem identity and metadata; saves additionally compare content hashes.
    return hash(Buffer.from([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':')));
  }
  inspect(id:string,path:string){const target=this.locate(id,path);return {fingerprint:this.fingerprint(target)};}
  private recycleRoot(id:string){
    const root=this.root(id),internal=join(root,'.trash');
    for(const path of [internal,join(internal,'recycle')]){if(existsSync(path)&&lstatSync(path).isSymbolicLink())fail('FILES_SYMLINK',403);mkdirSync(path,{recursive:true});}
    return join(internal,'recycle');
  }
  recycle(id:string,value:unknown){
    const input=z.object({path:inputPath,fingerprint:z.string(),confirm:z.literal(true)}).strict().parse(value),source=this.structuralWritable(id,input.path);
    if(this.fingerprint(source)!==input.fingerprint)fail('FILES_CHANGED');
    const root=this.recycleRoot(id),entry:Recycled={id:randomUUID(),path:input.path,deletedAt:new Date().toISOString(),fingerprint:input.fingerprint,kind:lstatSync(source).isDirectory()?'directory':'file'};
    const directory=join(root,entry.id);mkdirSync(directory);writeFileSync(join(directory,'entry.json'),JSON.stringify(entry),{flag:'wx',mode:0o600});renameSync(source,join(directory,'content'));return {entry};
  }
  recycled(id:string){
    const root=this.recycleRoot(id);return {entries:readdirSync(root).filter(name=>z.string().uuid().safeParse(name).success).flatMap(name=>{
      const directory=join(root,name);if(lstatSync(directory).isSymbolicLink()||!existsSync(join(directory,'content')))return [];
      return [JSON.parse(readFileSync(join(directory,'entry.json'),'utf8')) as Recycled];
    }).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt))};
  }
  restore(id:string,value:unknown){
    if(this.blocked(id))fail('PROJECT_HAS_ACTIVE_TASKS');
    const input=z.object({id:z.string().uuid()}).strict().parse(value),directory=join(this.recycleRoot(id),input.id);
    if(lstatSync(directory).isSymbolicLink())fail('FILES_SYMLINK',403);
    const entry=JSON.parse(readFileSync(join(directory,'entry.json'),'utf8')) as Recycled;
    const target=this.writable(id,entry.path);this.locate(id,relative(this.root(id),dirname(target)).split(sep).join('/'));
    try{lstatSync(target);fail('FILES_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    renameSync(join(directory,'content'),target);return {path:entry.path};
  }
  upload(id:string,path:string,bytes:Uint8Array){
    if(bytes.length>uploadLimit)fail('FILES_TOO_LARGE',413);
    const target=this.writable(id,path);this.locate(id,relative(this.root(id),dirname(target)).split(sep).join('/'));
    const temp=target+'.'+randomUUID()+'.upload';
    try{writeFileSync(temp,bytes,{flag:'wx',mode:0o600});linkSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}
    return {path};
  }
  async stream(id:string,path:string,request:IncomingMessage,response:ServerResponse,download:boolean){
    const file=this.locate(id,path),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    let transferred=false;
    try{
      const stat=fstatSync(fd);if(!stat.isFile())fail('FILES_NOT_FILE',422);
      const mime=mimeTypes[extname(file).toLowerCase()]??'application/octet-stream';
      let start=0,end=stat.size-1,status=200;
      const range=request.headers.range;
      if(range){
        const match=range.match(/^bytes=(\d*)-(\d*)$/);
        if(!match||(!match[1]&&!match[2])){response.writeHead(416,{'content-range':`bytes */${stat.size}`});response.end();return;}
        if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
        else start=Math.max(0,stat.size-Number(match[2]));
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){response.writeHead(416,{'content-range':`bytes */${stat.size}`});response.end();return;}
        status=206;
      }
      response.writeHead(status,{'content-type':mime,'content-length':Math.max(0,end-start+1),'accept-ranges':'bytes',...(status===206?{'content-range':`bytes ${start}-${end}/${stat.size}`}:{ }),'content-disposition':`${download?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,'x-content-type-options':'nosniff','cache-control':'no-store','content-security-policy':"frame-ancestors 'self'"});
      if(!stat.size){response.end();return;}
      const source=createReadStream(file,{fd,autoClose:true,start,end});transferred=true;
      await pipeline(source,response);
    }finally{if(!transferred)closeSync(fd);}
  }
}
