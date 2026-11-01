/* eslint-disable no-control-regex -- Reject control characters in filesystem paths and interpreter names. */
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
 private uploadControllers=new Map<string,AbortController>();
 private uploads=new Map<string,{request_id:string;stage:string;sent:number;total:number}>();
 progress(project:string,id:string,request:string){const value=this.uploads.get(`${project}:${id}`);return value?.request_id===request?value:null;}
 report(project:string,id:string,request:string,stage:string,sent=0,total=0){this.uploads.set(`${project}:${id}`,{request_id:request,stage,sent,total});}

 beginUpload(project:string,id:string,request:string){const key=`${project}:${id}:${request}`;const controller=new AbortController();this.uploadControllers.set(key,controller);return {signal:controller.signal,finish:()=>this.uploadControllers.delete(key)};}
 cancelUpload(project:string,id:string,request:string){
  if(id!=="experiment-code")this.get(project,id);const controller=this.uploadControllers.get(`${project}:${id}:${request}`),progress=this.progress(project,id,request);
  if(!controller||!progress)experimentError("UPLOAD_NOT_RUNNING",409);
  if(!["snapshot","preparing","uploading","cancelling"].includes(progress.stage))experimentError("UPLOAD_FINALIZING",409);
  controller.abort();this.report(project,id,request,"cancelling",progress.sent,progress.total);return {requested:true};
 }
 constructor(private store:TrashStore){}
 busy(project:string){return this.pending.has(project);}
 acquire(project:string){if(this.pending.has(project))experimentError("REPRODUCTION_BUSY",409);this.pending.add(project);return ()=>this.pending.delete(project);}
 recordUpload(project:string,id:string,profile:string,value:{path:string;snapshot:ReproductionSnapshot}){const code=this.get(project,id);this.save({...code,uploads:[...(code.uploads??[]),{profile_id:profile,path:value.path,snapshot_id:value.snapshot.snapshot_id,sha256:value.snapshot.sha256,at:new Date().toISOString()}].slice(-50)});}

 private root(project:string){return join(this.store.root,"projects",project,"reproductions");}
 private archiveName(name:string){
  if(!name||name==="."||name===".."||/[\\/\x00-\x1f\x7f]/.test(name)||!name.toLowerCase().endsWith(".zip")||Buffer.byteLength(name,"utf8")>255)experimentError("REPRODUCTION_ARCHIVE_NAME_INVALID",400);
  return name;
 }
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
 async importZip(project:string,request:IncomingMessage,name:string,filename?:string){
  const archive_name=this.archiveName(filename??`${this.directoryName(name).slice(6)}.zip`);
  const id=`repro_${randomUUID()}`,root=this.allocateDirectory(project,name);const zip=join(root,"source.zip"),code=join(root,"code");let bytes=0;
  try{await pipeline(request,new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes>200*1024*1024?new Error("ARCHIVE_LIMIT"):null,chunk);}}),createWriteStream(zip,{flags:"wx",mode:0o600}));await this.python("extract",zip,code);await rm(zip);return this.save({id,project_id:project,name:name.slice(0,200)||"复现代码",archive_name,path:code,source_url:"",notes:"",created_at:new Date().toISOString(),imported:true});}
  catch{await rm(root,{recursive:true,force:true});experimentError("REPRODUCTION_IMPORT_FAILED",422);}
 }
 private async python(mode:string,source:string,target:string){try{return JSON.parse((await execute("python3",["-c",REPRO_ARCHIVE,mode,source,target],{timeout:120000,maxBuffer:16*1024*1024})).stdout);}catch{experimentError("REPRODUCTION_ARCHIVE_FAILED",422);}}
 private async safe(project:string,id:string,path:string){const root=await realpath(this.get(project,id).path);if(isAbsolute(path)||path.split(/[\\/]/).some(p=>p===".."||p===".git")||path.includes("\0"))experimentError("REPOSITORY_PATH_INVALID");const target=await realpath(resolve(root,path||".")),rel=relative(root,target);if(rel===".."||rel.startsWith(`..${sep}`)||isAbsolute(rel)||rel.split(sep).includes(".git"))experimentError("REPOSITORY_PATH_INVALID");return target;}
 async tree(project:string,id:string,path:string){return (await readdir(await this.safe(project,id,path),{withFileTypes:true})).filter(e=>e.name!==".git").slice(0,1000).map(e=>({name:e.name,path:path?`${path}/${e.name}`:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink()}));}
 async file(project:string,id:string,path:string){const target=await this.safe(project,id,path),info=await stat(target);if(!info.isFile())experimentError("NOT_A_FILE");if(info.size>1024*1024)return {path,size_bytes:info.size,preview:false,reason:"文件超过 1 MiB"};const data=await readFile(target);try{if(data.includes(0))throw new Error();return {path,size_bytes:data.length,preview:true,text:new TextDecoder("utf8",{fatal:true}).decode(data)};}catch{return {path,size_bytes:info.size,preview:false,reason:"二进制或非 UTF-8 文件"};}}
 async snapshot(project:string,id:string,analysis=false):Promise<ReproductionSnapshot>{const code=this.get(project,id),snapshot_id=`snapshot_${randomUUID()}`,root=join(this.root(project),"snapshots",snapshot_id);const rel=relative(code.path,root);if(rel===""||!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel))experimentError("REPRODUCTION_DIRECTORY_INVALID");await mkdir(root,{recursive:true});const path=join(root,"code.zip");try{const manifest=await this.python(analysis?"analysis-snapshot":"snapshot",code.path,path);const bytes=await readFile(path);if(bytes.length>200*1024*1024)experimentError("ARCHIVE_LIMIT");const value:ReproductionSnapshot={snapshot_id,reproduction_id:id,name:code.name,archive_name:code.archive_name??`${this.directoryName(code.name).slice(6)}.zip`,source_id:code.source_id,sha256:createHash("sha256").update(bytes).digest("hex"),created_at:new Date().toISOString(),...manifest};writeFileSync(join(root,"manifest.json"),JSON.stringify(value),{mode:0o600});return value;}catch(error){await rm(root,{recursive:true,force:true});throw error;}}
 async sourceSnapshot(project:string,path:string,name:string):Promise<ReproductionSnapshot>{
  const snapshot_id='snapshot_'+randomUUID(),root=join(this.root(project),'snapshots',snapshot_id),rel=relative(path,root);
  if(rel===''||!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel))experimentError('REPRODUCTION_DIRECTORY_INVALID');
  await mkdir(root,{recursive:true});const archive=join(root,'code.zip');
  try{const manifest=await this.python('snapshot',path,archive);const bytes=await readFile(archive);if(bytes.length>200*1024*1024)experimentError('ARCHIVE_LIMIT');const value:ReproductionSnapshot={snapshot_id,reproduction_id:'experiment-code',name,archive_name:name+'.zip',sha256:createHash('sha256').update(bytes).digest('hex'),created_at:new Date().toISOString(),...manifest};writeFileSync(join(root,'manifest.json'),JSON.stringify(value),{mode:0o600});return value;}catch(error){await rm(root,{recursive:true,force:true});throw error;}
 }
 snapshotInfo(project:string,id:string){if(!/^snapshot_[a-f0-9-]+$/.test(id))experimentError("SNAPSHOT_NOT_FOUND",404);const path=join(this.root(project),"snapshots",id,"manifest.json");if(!existsSync(path))experimentError("SNAPSHOT_NOT_FOUND",404);return JSON.parse(readFileSync(path,"utf8")) as ReproductionSnapshot;}
 async bundle(project:string,snapshot:ReproductionSnapshot){const path=join(this.root(project),"snapshots",snapshot.snapshot_id,"code.zip"),bytes=await readFile(path);if(createHash("sha256").update(bytes).digest("hex")!==snapshot.sha256)experimentError("SNAPSHOT_HASH_MISMATCH",409);return {path,sha256:snapshot.sha256,size:bytes.length,cleanup:async()=>{}};}
 async preparation(project:string,snapshot:ReproductionSnapshot,path:string){await this.bundle(project,snapshot);const script=String.raw`import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);i=z.getinfo(sys.argv[2]);assert i.file_size<=1048576;sys.stdout.write(z.read(i).decode('utf8'))`;return (await execute("python3",["-c",script,join(this.root(project),"snapshots",snapshot.snapshot_id,"code.zip"),path],{maxBuffer:2*1024*1024})).stdout;}
 private async cleanupCancelledUpload(remote:RemoteConnection,parent:string,directory:string,archive:string){
  // No recursive removal: cancellation is accepted only before extraction.
  if(posix.dirname(directory)!==posix.normalize(parent)||directory===parent||!posix.isAbsolute(directory))throw new Error("UNSAFE_CLEANUP_PATH");
  const sftp=await remote.sftp();
  try{
   const info=await new Promise<import("ssh2").Stats>((resolve,reject)=>sftp.lstat(directory,(error,value)=>error?reject(error):resolve(value)));
   if(!info.isDirectory()||info.isSymbolicLink())throw new Error("UNSAFE_CLEANUP_PATH");
   const ignoreMissing=(error:Error|undefined|null)=>!error||Number((error as Error&{code?:number}).code)===2;
   if(archive){if(posix.dirname(archive)!==posix.normalize(parent))throw new Error("UNSAFE_CLEANUP_PATH");await new Promise<void>((resolve,reject)=>sftp.unlink(archive,error=>ignoreMissing(error)?resolve():reject(error)));}
   
   await new Promise<void>((resolve,reject)=>sftp.rmdir(directory,error=>ignoreMissing(error)?resolve():reject(error)));
  }finally{sftp.end();}
 }
 async deploy(remote:RemoteConnection,project:string,snapshot:ReproductionSnapshot,directory:string,report:(stage:string,sent?:number,total?:number)=>void=()=>{},signal?:AbortSignal,targetName?:string){
  const archiveName=this.archiveName(snapshot.archive_name??`${this.directoryName(snapshot.name).slice(6)}.zip`);
  const parent=directory;
  let createdDirectory:string|undefined;
  let createdArchive:string|undefined;
  let stage="REPRODUCTION_SNAPSHOT_READ_FAILED";
  try{
   const bundle=await this.bundle(project,snapshot);
   if(snapshot.files.some(file=>file.path===".trash-snapshot.json"||file.path===archiveName.slice(0,-4)+"/.trash-snapshot.json"))experimentError("REPRODUCTION_RESERVED_FILE",409);
   report("preparing",0,bundle.size);
   stage="REPRODUCTION_UNZIP_UNAVAILABLE";
   await remote.exec(["sh","-c","command -v unzip >/dev/null 2>&1"]);
   stage="REPRODUCTION_SHA256SUM_UNAVAILABLE";
   await remote.exec(["sh","-c","command -v sha256sum >/dev/null 2>&1"]);
   stage="REPRODUCTION_REMOTE_DIRECTORY_FAILED";
   const sftp=await remote.sftp();
   try{
    const stem=targetName??this.directoryName(archiveName.slice(0,-4)).slice(6);
    if(!stem||stem==="."||stem===".."||/[\\/\x00-\x1f]/.test(stem))experimentError("UPLOAD_PATH_INVALID",400);
    const candidate=posix.join(parent,stem),archivePath=posix.join(parent,archiveName);
    for(const path of [candidate,archivePath]){
      const exists=await new Promise<boolean>((resolve,reject)=>sftp.lstat(path,error=>{if(!error)resolve(true);else if(Number((error as Error&{code?:number}).code)===2)resolve(false);else reject(error);}));
      if(exists)experimentError("REPRODUCTION_REMOTE_TARGET_EXISTS",409);
    }
    await new Promise<void>((resolve,reject)=>sftp.mkdir(candidate,{mode:0o700},error=>error?reject(error):resolve()));
    directory=candidate;createdDirectory=candidate;
    const handle=await new Promise<Buffer>((resolve,reject)=>sftp.open(archivePath,"wx",(error,value)=>error?reject(error):resolve(value)));
    createdArchive=archivePath;
    await new Promise<void>((resolve,reject)=>sftp.close(handle,error=>error?reject(error):resolve()));
   }finally{sftp.end();}
   stage="REPRODUCTION_TRANSFER_FAILED";
   report("uploading",0,bundle.size);
   await remote.upload(bundle.path,posix.join(parent,archiveName),(sent,total)=>report("uploading",sent,total),signal);
   report("verifying",bundle.size,bundle.size);
   stage="REPRODUCTION_REMOTE_HASH_FAILED";
   const output=await remote.exec(["sha256sum","--",posix.join(parent,archiveName)],undefined,120000,16384);
   const hash=/^([a-fA-F0-9]{64})[ \t]/.exec(output.trim())?.[1].toLowerCase();
   if(hash!==snapshot.sha256)throw new Error("REMOTE_HASH_MISMATCH");
   report("extracting",bundle.size,bundle.size);
   stage="REPRODUCTION_REMOTE_EXTRACT_FAILED";
   // Flatten only a ZIP-name wrapper; do not strip genuine source subdirectories.
   const wrapper=archiveName.slice(0,-4);
   const strip=snapshot.reproduction_id!=="experiment-code"&&Boolean(wrapper)&&snapshot.files.length>0&&snapshot.files.every(file=>file.path.startsWith(wrapper+"/"));
   if(strip){
     const staging=posix.join(directory,".trash-extract-"+randomUUID());
     await remote.exec(["mkdir","--",staging]);
     await remote.exec(["unzip","-q","-n",posix.join(parent,archiveName),"-d",staging],undefined,120000);
     await remote.exec(["sh","-c",'for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; mv -- "$entry" "$2/" || exit; done',"trash-flatten",posix.join(staging,wrapper),directory],undefined,120000);
     await remote.exec(["rmdir","--",posix.join(staging,wrapper),staging]);
   }else await remote.exec(["unzip","-q","-n",posix.join(parent,archiveName),"-d",directory],undefined,120000);
   report("saving",bundle.size,bundle.size);
   stage="REPRODUCTION_REMOTE_MANIFEST_FAILED";
   await remote.write(posix.join(directory,".trash-snapshot.json"),JSON.stringify(snapshot));
   report("completed",bundle.size,bundle.size);
   return {path:directory,snapshot};
  }catch(error){
   if(signal?.aborted){
    if(createdDirectory){
     try{await this.cleanupCancelledUpload(remote,parent,createdDirectory,createdArchive??"");}
     catch{throw Object.assign(new Error("UPLOAD_CANCEL_CLEANUP_FAILED"),{statusCode:409,residual_path:createdDirectory});}
    }
    experimentError("UPLOAD_CANCELLED",409);
   }
   if(error instanceof Error&&"statusCode" in error)throw error;
   if(error instanceof Error&&error.message==="SSH_COMMAND_TIMEOUT")experimentError("REPRODUCTION_REMOTE_TIMEOUT",422);
   experimentError(stage,422);
  }
 }
}
