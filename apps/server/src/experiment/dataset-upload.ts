import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { DatasetRef } from "@trash/protocol";
import { experimentError, type ExperimentStore } from "@trash/storage";
import type { RemoteConnection } from "./ssh.js";
import { directoryLabel, ensureRemoteDirectory } from "./workspace.js";
const execute=promisify(execFile);
const validateZip=String.raw`import sys,zipfile,stat,pathlib
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist();assert entries and len(entries)<=100000
 assert sum(e.file_size for e in entries)<=4*1024**3
 seen=set()
 for e in entries:
  n=e.filename;p=pathlib.PurePosixPath(n)
  assert n and not p.is_absolute() and not any(v in ('..','.') for v in n.rstrip('/').split('/'))
  assert not any(ord(c)<32 for c in n) and '\\' not in n
  assert p.parts and p.parts[0] not in ('.trash-upload.zip','.trash')
  assert str(p) not in seen;seen.add(str(p))
  mode=e.external_attr>>16
  assert not stat.S_ISLNK(mode) and stat.S_IFMT(mode) in (0,stat.S_IFREG,stat.S_IFDIR)
  assert not e.flag_bits&1
`;
interface Transfer {project:string;dataset:string;controller:AbortController;stage:string}
export class DatasetUploadService {
 private transfers=new Map<string,Transfer>();
 constructor(private data:ExperimentStore,projects:string[]){for(const project of projects)for(const item of data.datasets(project))if(item.transfer_status==='uploading'){data.saveDataset({...item,transfer_status:'interrupted',transfer_message:'后端重启，上传已中断；请检查远端目录。'});}}
 busy(project:string){return [...this.transfers.values()].some(item=>item.project===project);}
 cancel(project:string,id:string){const transfer=[...this.transfers.values()].find(item=>item.project===project&&item.dataset===id)??experimentError('DATASET_NOT_UPLOADING',409);if(['extracting','saving'].includes(transfer.stage))experimentError('DATASET_FINALIZING',409);transfer.controller.abort();return {requested:true};}
 close(){for(const transfer of this.transfers.values())if(!['extracting','saving'].includes(transfer.stage))transfer.controller.abort();}
 async upload(project:string,profile:string,root:string,remote:RemoteConnection,request:IncomingMessage,name:string,filename:string,extract:boolean,requestId:string){
  if(this.transfers.has(requestId)||this.busy(project))experimentError('DATASET_BUSY',409);
  if(!filename||filename==='.'||filename==='..'||filename.includes('/')||filename.includes('\\')||Array.from(filename).some(c=>c.charCodeAt(0)<32)||Buffer.byteLength(filename)>255)experimentError('UPLOAD_PATH_INVALID',400);
  if(extract&&!filename.toLowerCase().endsWith('.zip'))experimentError('DATASET_ARCHIVE_INVALID',400);
  const id='dataset_'+randomUUID(),parent=posix.join(root,'datasets'),target=posix.join(parent,directoryLabel(name));
  let dataset:DatasetRef={dataset_id:id,project_id:project,profile_id:profile,name,version:'1',notes:'',path:target,verification_status:'unverified',transfer_status:'uploading',transfer_request_id:requestId,transfer_stage:'receiving',transfer_sent:0,transfer_total:Number(request.headers['content-length'])||0};
  const transfer:Transfer={project,dataset:id,controller:new AbortController(),stage:'receiving'};this.transfers.set(requestId,transfer);
  let temporary:string|undefined,owned=false;
  const update=(stage:string,sent=0,total=0)=>{transfer.stage=stage;dataset={...dataset,transfer_stage:stage,transfer_sent:sent,transfer_total:total};this.data.saveDataset(dataset);};
  const stopped=()=>{if(transfer.controller.signal.aborted)experimentError('UPLOAD_CANCELLED',409);};
  try{
   this.data.saveDataset(dataset);temporary=await mkdtemp(join(tmpdir(),'trash-dataset-'));const file=join(temporary,'upload');let received=0,last=0;
   const limit=new Transform({transform(chunk:Buffer,_encoding,callback){received+=chunk.length;if(received>200*1024*1024){callback(Object.assign(new Error('REQUEST_TOO_LARGE'),{statusCode:413}));return;}if(Date.now()-last>250){last=Date.now();update('receiving',received,dataset.transfer_total);}callback(null,chunk);}});
   await pipeline(request,limit,createWriteStream(file,{mode:0o600}),{signal:transfer.controller.signal});stopped();
   const bytes=(await stat(file)).size;if(!bytes)experimentError('DATASET_EMPTY_FILE',400);
   update('validating',bytes,bytes);
   if(extract){try{await execute('python3',['-I','-B','-c',validateZip,file],{timeout:60000,maxBuffer:16384,signal:transfer.controller.signal});}catch{stopped();experimentError('DATASET_ARCHIVE_INVALID',422);}await remote.exec(['sh','-c','command -v unzip >/dev/null 2>&1']);}
   stopped();await ensureRemoteDirectory(remote,parent);stopped();
   const sftp=await remote.sftp();try{const exists=await new Promise<boolean>((resolve,reject)=>sftp.lstat(target,error=>{if(!error)resolve(true);else if(Number((error as Error&{code?:number}).code)===2)resolve(false);else reject(error);}));if(exists)experimentError('REPRODUCTION_REMOTE_TARGET_EXISTS',409);await new Promise<void>((resolve,reject)=>sftp.mkdir(target,{mode:0o755},error=>error?reject(error):resolve()));owned=true;}finally{sftp.end();}
   stopped();const destination=posix.join(target,extract?'.trash-upload.zip':filename);update('uploading',0,bytes);await remote.upload(file,destination,(sent,total)=>update('uploading',sent,total),transfer.controller.signal);stopped();
   if(extract){update('extracting',bytes,bytes);await remote.exec(['unzip','-q','-n',destination,'-d',target],undefined,300000);await remote.exec(['rm','--',destination]);}
   update('saving',bytes,bytes);dataset={...dataset,size_bytes:bytes,transfer_status:'ready',transfer_message:extract?'已上传并解压，数据内容尚未验证。':'已上传，数据内容尚未验证。'};this.data.saveDataset(dataset);return dataset;
  }catch(error){let cleanupFailed=false;if(owned){try{await remote.exec(['rm','-rf','--',target],undefined,60000);}catch{cleanupFailed=true;}}
   const cancelled=transfer.controller.signal.aborted;dataset={...dataset,transfer_status:cancelled?'cancelled':'failed',transfer_message:cleanupFailed?'远端清理未完成，请检查：'+target:cancelled?'上传已终止，本次目录已清理。':'上传失败，本次创建的目录已清理；已有目录未改动。'};this.data.saveDataset(dataset);
   if(cleanupFailed)experimentError('UPLOAD_CANCEL_CLEANUP_FAILED',409);if(cancelled)experimentError('UPLOAD_CANCELLED',409);if(error instanceof Error&&'statusCode' in error)throw error;experimentError('DATASET_UPLOAD_FAILED',422);
  }finally{this.transfers.delete(requestId);if(temporary)await rm(temporary,{recursive:true,force:true});}
 }
}
