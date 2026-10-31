import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { realpath, stat, readdir, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep, posix, dirname, basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { experimentError, type TrashStore } from "@trash/storage";
import type { ReproductionCode, ReproductionSnapshot } from "@trash/protocol";
import type { RemoteConnection } from "./ssh.js";
import { REPRO_ARCHIVE } from "./reproduction-archive.js";
const execute=promisify(execFile);
export const reproductionInput=z.object({name:z.string().trim().min(1).max(200),source_id:z.string().max(200).optional(),source_url:z.string().max(2000).default(""),notes:z.string().max(10000).default("")}).strict();
export class ReproductionService {
 private pending=new Set<string>();
 constructor(private store:TrashStore){}
 busy(project:string){return this.pending.has(project);}
 acquire(project:string){if(this.pending.has(project))experimentError("REPRODUCTION_BUSY",409);this.pending.add(project);return ()=>this.pending.delete(project);}
 recordUpload(project:string,id:string,profile:string,value:{path:string;snapshot:ReproductionSnapshot}){const code=this.get(project,id);this.save({...code,uploads:[...(code.uploads??[]),{profile_id:profile,path:value.path,snapshot_id:value.snapshot.snapshot_id,sha256:value.snapshot.sha256,at:new Date().toISOString()}].slice(-50)});}

 private root(project:string){return join(this.store.root,"projects",project,"reproductions");}
 private directoryName(name:string){
  const cleaned=name.normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,"_").trim().replace(/[. ]+$/g,"");
  let slug="";for(const char of cleaned){if(Buffer.byteLength(slug+char,"utf8")>180)break;slug+=char;}
  return `repro_${slug||"未命名"}`;
 }
 private allocateDirectory(project:string,name:string){
  mkdirSync(this.root(project),{recursive:true});const base=this.directoryName(name);
  for(let suffix=1;suffix<=10000;suffix++){
   const path=join(this.root(project),suffix===1?base:`${base}_${suffix}`);
   try{mkdirSync(path,{mode:0o700});return path;}
   catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  }
  return experimentError("REPRODUCTION_NAME_CONFLICT",409);
 }
 private namedDirectory(value:ReproductionCode){
  const previous=dirname(value.path),base=this.directoryName(value.name),current=basename(previous);
  if(!value.imported||dirname(previous)!==this.root(value.project_id)||basename(value.path)!=="code"||!existsSync(previous))return value;
  if(current===base||current.startsWith(`${base}_`)&&/^\d+$/.test(current.slice(base.length+1)))return value;
  const next=this.allocateDirectory(value.project_id,value.name);
  try{renameSync(previous,next);}catch(error){try{rmdirSync(next);}catch{/* Only remove our empty reservation directory. */}throw error;}
  try{return this.save({...value,path:join(next,"code")});}
  catch(error){renameSync(next,previous);throw error;}
 }
 private record(project:string,id:string){if(!/^repro_[a-f0-9-]+$/.test(id))experimentError("REPRODUCTION_NOT_FOUND",404);return join(this.root(project),`${id}.json`);}
 list(project:string):ReproductionCode[]{const root=this.root(project);return existsSync(root)?readdirSync(root).filter(n=>/^repro_[a-f0-9-]+\.json$/.test(n)).map(n=>JSON.parse(readFileSync(join(root,n),"utf8")) as ReproductionCode).map(code=>this.busy(project)?code:this.namedDirectory(code)):[];}
 get(project:string,id:string){const path=this.record(project,id);if(!existsSync(path))experimentError("REPRODUCTION_NOT_FOUND",404);return JSON.parse(readFileSync(path,"utf8")) as ReproductionCode;}
 private save(value:ReproductionCode){mkdirSync(this.root(value.project_id),{recursive:true});const path=this.record(value.project_id,value.id),temp=`${path}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);return value;}
 private validateSource(project:string,input:z.infer<typeof reproductionInput>){if(input.source_id&&!this.store.listSources(project).some(s=>s.source_id===input.source_id))experimentError("SOURCE_NOT_FOUND",404);}

 update(project:string,id:string,value:unknown){const old=this.get(project,id),input=reproductionInput.parse(value);this.validateSource(project,input);return this.namedDirectory(this.save({...old,...input,source_id:input.source_id}));}
 remove(project:string,id:string){this.get(project,id);rmSync(this.record(project,id));}
 async importZip(project:string,request:IncomingMessage,name:string){
  const id=`repro_${randomUUID()}`,root=this.allocateDirectory(project,name);const zip=join(root,"source.zip"),code=join(root,"code");let bytes=0;
  try{await pipeline(request,new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes>200*1024*1024?new Error("ARCHIVE_LIMIT"):null,chunk);}}),createWriteStream(zip,{flags:"wx",mode:0o600}));await this.python("extract",zip,code);await rm(zip);return this.save({id,project_id:project,name:name.slice(0,200)||"复现代码",path:code,source_url:"",notes:"",created_at:new Date().toISOString(),imported:true});}
  catch{await rm(root,{recursive:true,force:true});experimentError("REPRODUCTION_IMPORT_FAILED",422);}
 }
 private async python(mode:string,source:string,target:string){try{return JSON.parse((await execute("python3",["-c",REPRO_ARCHIVE,mode,source,target],{timeout:120000,maxBuffer:16*1024*1024})).stdout);}catch{experimentError("REPRODUCTION_ARCHIVE_FAILED",422);}}
 private async safe(project:string,id:string,path:string){const root=await realpath(this.get(project,id).path);if(isAbsolute(path)||path.split(/[\\/]/).some(p=>p===".."||p===".git")||path.includes("\0"))experimentError("REPOSITORY_PATH_INVALID");const target=await realpath(resolve(root,path||".")),rel=relative(root,target);if(rel===".."||rel.startsWith(`..${sep}`)||isAbsolute(rel)||rel.split(sep).includes(".git"))experimentError("REPOSITORY_PATH_INVALID");return target;}
 async tree(project:string,id:string,path:string){return (await readdir(await this.safe(project,id,path),{withFileTypes:true})).filter(e=>e.name!==".git").slice(0,1000).map(e=>({name:e.name,path:path?`${path}/${e.name}`:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink()}));}
 async file(project:string,id:string,path:string){const target=await this.safe(project,id,path),info=await stat(target);if(!info.isFile())experimentError("NOT_A_FILE");if(info.size>1024*1024)return {path,size_bytes:info.size,preview:false,reason:"文件超过 1 MiB"};const data=await readFile(target);try{if(data.includes(0))throw new Error();return {path,size_bytes:data.length,preview:true,text:new TextDecoder("utf8",{fatal:true}).decode(data)};}catch{return {path,size_bytes:info.size,preview:false,reason:"二进制或非 UTF-8 文件"};}}
 async snapshot(project:string,id:string):Promise<ReproductionSnapshot>{const code=this.get(project,id),snapshot_id=`snapshot_${randomUUID()}`,root=join(this.root(project),"snapshots",snapshot_id);const rel=relative(code.path,root);if(rel===""||!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel))experimentError("REPRODUCTION_DIRECTORY_INVALID");await mkdir(root,{recursive:true});const path=join(root,"code.zip");try{const manifest=await this.python("snapshot",code.path,path);const bytes=await readFile(path);if(bytes.length>200*1024*1024)experimentError("ARCHIVE_LIMIT");const value:ReproductionSnapshot={snapshot_id,reproduction_id:id,name:code.name,source_id:code.source_id,sha256:createHash("sha256").update(bytes).digest("hex"),created_at:new Date().toISOString(),...manifest};writeFileSync(join(root,"manifest.json"),JSON.stringify(value),{mode:0o600});return value;}catch(error){await rm(root,{recursive:true,force:true});throw error;}}
 snapshotInfo(project:string,id:string){if(!/^snapshot_[a-f0-9-]+$/.test(id))experimentError("SNAPSHOT_NOT_FOUND",404);const path=join(this.root(project),"snapshots",id,"manifest.json");if(!existsSync(path))experimentError("SNAPSHOT_NOT_FOUND",404);return JSON.parse(readFileSync(path,"utf8")) as ReproductionSnapshot;}
 async bundle(project:string,snapshot:ReproductionSnapshot){const path=join(this.root(project),"snapshots",snapshot.snapshot_id,"code.zip"),bytes=await readFile(path);if(createHash("sha256").update(bytes).digest("hex")!==snapshot.sha256)experimentError("SNAPSHOT_HASH_MISMATCH",409);return {path,sha256:snapshot.sha256,size:bytes.length,cleanup:async()=>{}};}
 async preparation(project:string,snapshot:ReproductionSnapshot,path:string){await this.bundle(project,snapshot);const script=String.raw`import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);i=z.getinfo(sys.argv[2]);assert i.file_size<=1048576;sys.stdout.write(z.read(i).decode('utf8'))`;return (await execute("python3",["-c",script,join(this.root(project),"snapshots",snapshot.snapshot_id,"code.zip"),path],{maxBuffer:2*1024*1024})).stdout;}
 async deploy(remote:RemoteConnection,project:string,snapshot:ReproductionSnapshot,directory:string,python:string){const bundle=await this.bundle(project,snapshot);await remote.exec([python,"-c","import os,sys;os.makedirs(sys.argv[1],mode=0o700,exist_ok=False)",directory]);await remote.upload(bundle.path,posix.join(directory,"code.zip"));await remote.exec([python,"-c","import hashlib,sys;assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()==sys.argv[2]",posix.join(directory,"code.zip"),snapshot.sha256]);await remote.exec([python,"-c",REPRO_ARCHIVE,"extract",posix.join(directory,"code.zip"),posix.join(directory,"code")]);await remote.write(posix.join(directory,"snapshot.json"),JSON.stringify(snapshot));return {path:posix.join(directory,"code"),snapshot};}
}
