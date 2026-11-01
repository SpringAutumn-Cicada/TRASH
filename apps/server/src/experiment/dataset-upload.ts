import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
const MAX_DATASET_BYTES=5*1024**3;
const validateZip=String.raw`import sys,zipfile,stat,pathlib,hashlib,json
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist();assert entries and len(entries)<=100000
 assert sum(e.file_size for e in entries)<=5*1024**3
 seen=set();records=[]
 for e in entries:
  n=e.filename;p=pathlib.PurePosixPath(n)
  assert n and not p.is_absolute() and not any(v in ('..','.') for v in n.rstrip('/').split('/'))
  assert not any(ord(c)<32 for c in n) and chr(92) not in n
  assert p.parts and p.parts[0] not in ('.trash-upload.zip','.trash')
  assert str(p) not in seen;seen.add(str(p))
  mode=e.external_attr>>16
  assert not stat.S_ISLNK(mode) and stat.S_IFMT(mode) in (0,stat.S_IFREG,stat.S_IFDIR)
  assert not e.flag_bits&1
  if not e.is_dir():
   h=hashlib.sha256()
   with z.open(e) as f:
    for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
   records.append({'path':str(p),'sha256':h.hexdigest()})
 print(json.dumps(records))
`;
const validateTar=String.raw`import sys,tarfile,pathlib,hashlib,json
with tarfile.open(sys.argv[1],'r:*') as archive:
 seen=set();records=[];total=0;count=0
 for entry in archive:
  count+=1;assert count<=100000
  name=entry.name;p=pathlib.PurePosixPath(name)
  assert name and not p.is_absolute() and '..' not in p.parts
  assert not any(ord(c)<32 for c in name) and chr(92) not in name
  assert entry.isfile() or entry.isdir()
  if not p.parts:
   assert entry.isdir();continue
  assert p.parts[0] not in ('.trash-upload.zip','.trash-upload.tar','.trash')
  assert str(p) not in seen;seen.add(str(p))
  if entry.isfile():
   total+=entry.size;assert total<=5*1024**3
   h=hashlib.sha256()
   with archive.extractfile(entry) as file:
    for block in iter(lambda:file.read(1024*1024),b''):h.update(block)
   records.append({'path':str(p),'sha256':h.hexdigest()})
 assert records
 print(json.dumps(records))
`;
interface Transfer {project:string;dataset:string;controller:AbortController;stage:string}
export class DatasetUploadService {
 private transfers=new Map<string,Transfer>();
 private checks=new Set<string>();
 constructor(private data:ExperimentStore,projects:string[],private root:string){for(const project of projects)for(const item of data.datasets(project)){if(item.verification_progress?.status==='running')data.saveDataset({...item,verification_status:'unverified',verified_at:undefined,verification_progress:{...item.verification_progress,status:'failed',message:'后端重启，校验已中断，请重新校验。'}});if(item.transfer_status==='uploading'){data.saveDataset({...item,transfer_status:'interrupted',transfer_message:'后端重启，上传已中断；请检查远端目录。',verification_status:'unverified',verified_at:undefined,verification_progress:item.verification_progress?{...item.verification_progress,status:'failed',message:'后端重启，校验或上传已中断，请核对远端文件。'}:undefined});}}}
 hashes(project:string,id:string):{path:string;sha256:string}[]{const path=join(this.root,'projects',project,'dataset-hashes',id+'.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];}
 saveHashes(project:string,id:string,files:{path:string;sha256:string}[]){const directory=join(this.root,'projects',project,'dataset-hashes');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,id+'.json'),JSON.stringify(files),{mode:0o600});}
 busy(project:string){return this.checks.has(project)||[...this.transfers.values()].some(item=>item.project===project);}
 async verify(project:string,id:string,remote:RemoteConnection):Promise<DatasetRef>{
  if(this.checks.has(project))experimentError('DATASET_BUSY',409);
  let dataset=this.data.datasets(project).find(item=>item.dataset_id===id)??experimentError('DATASET_NOT_FOUND',404);
  this.checks.add(project);
  const save=(status:"running"|"completed"|"failed"|"unavailable",checked:number,total:number,message:string)=>{dataset={...dataset,verification_status:status==='completed'?'verified':'unverified',verified_at:status==='completed'?new Date().toISOString():undefined,verification_progress:{status,checked,total,message}};this.data.saveDataset(dataset);};
  let checked=0,total=0;
  try{
   const hashes=this.hashes(project,id);
   const files=hashes.length?hashes:dataset.sha256?[{path:dataset.checksum_manifest??dataset.path,sha256:dataset.sha256}]:[];
   total=files.length;
   if(!total){save('unavailable',0,0,'没有上传时的 SHA-256 或可信参考值，无法确认文件一致性。请补充参考哈希；当前远端生成的哈希不能证明上传一致。');return dataset;}
   save('running',0,total,'正在读取远端文件并比较 SHA-256…');
   for(let offset=0;offset<files.length;offset+=32){
    const batch=files.slice(offset,offset+32);
    if(batch.some(item=>! /^[a-f0-9]{64}$/i.test(item.sha256)||/[\x00-\x1f\\]/.test(item.path)||(hashes.length&&(posix.isAbsolute(item.path)||item.path.split('/').some(part=>part==='..'||part==='.'||!part)))))throw new Error('哈希清单路径或格式无效');
    const script=hashes.length?'set -eu; root=$(readlink -f -- "$1"); shift; for relative do file=$(readlink -f -- "$root/$relative"); case "$file" in "$root"/*) ;; *) exit 2;; esac; test -f "$file"; sha256sum -- "$file" | cut -c1-64; done':'set -eu; for file do test -f "$file"; sha256sum -- "$file" | cut -c1-64; done';
    const output=await remote.exec(['sh','-c',script,'trash-dataset-check',...(hashes.length?[dataset.path]:[]),...batch.map(item=>item.path)],undefined,1800000);
    const actual=output.trim().split(/\r?\n/);
    for(let i=0;i<batch.length;i++){if(actual[i]?.toLowerCase()!==batch[i].sha256.toLowerCase())throw new Error('文件缺失或 SHA-256 不一致：'+batch[i].path);checked++;}
    save('running',checked,total,`已核对 ${checked} / ${total} 个文件`);
   }
   save('completed',checked,total,dataset.checksum_manifest&&!hashes.length?'指定校验清单文件的 SHA-256 已匹配；尚未核对清单内各个数据文件。':'参考清单内文件的 SHA-256 全部匹配；未检查额外文件。数据格式、标签和实验适用性仍需按实验要求确认。');
  }catch(error){save('failed',checked,total,'文件一致性校验未通过，已保留远端数据。'+(error instanceof Error?error.message:'请检查 SSH 连接和远端 sha256sum/readlink 工具。'));}
  finally{this.checks.delete(project);}
  return dataset;
 }
 cancelRequest(project:string,id:string){const transfer=this.transfers.get(id);if(!transfer||transfer.project!==project)experimentError('DATASET_NOT_UPLOADING',409);return this.cancel(project,transfer.dataset);}
 cancel(project:string,id:string){const transfer=[...this.transfers.values()].find(item=>item.project===project&&item.dataset===id)??experimentError('DATASET_NOT_UPLOADING',409);if(['extracting','verifying','saving'].includes(transfer.stage))experimentError('DATASET_FINALIZING',409);transfer.controller.abort();return {requested:true};}
 close(){for(const transfer of this.transfers.values())if(!['extracting','verifying','saving'].includes(transfer.stage))transfer.controller.abort();}
 async upload(project:string,profile:string,root:string,remote:RemoteConnection,request:IncomingMessage,name:string,filename:string,extract:boolean,requestId:string){
  if(this.transfers.has(requestId)||this.busy(project))experimentError('DATASET_BUSY',409);
  if(!filename||filename==='.'||filename==='..'||filename.includes('/')||filename.includes('\\')||Array.from(filename).some(c=>c.charCodeAt(0)<32)||Buffer.byteLength(filename)>255)experimentError('UPLOAD_PATH_INVALID',400);
  const archiveType=filename.toLowerCase().endsWith('.zip')?'zip':/\.(tar|tar\.gz|tgz)$/i.test(filename)?'tar':undefined;
  if(extract&&!archiveType)experimentError('DATASET_ARCHIVE_INVALID',400);
  const declared=Number(request.headers['content-length']);if(Number.isFinite(declared)&&declared>MAX_DATASET_BYTES)experimentError('REQUEST_TOO_LARGE',413);
  const id='dataset_'+randomUUID(),parent=posix.join(root,'datasets'),target=posix.join(parent,directoryLabel(name));
  let dataset:DatasetRef={dataset_id:id,project_id:project,profile_id:profile,name,version:'1',notes:'',path:target,verification_status:'unverified',transfer_status:'uploading',transfer_request_id:requestId,transfer_stage:'receiving',transfer_sent:0,transfer_total:Number(request.headers['content-length'])||0};
  const transfer:Transfer={project,dataset:id,controller:new AbortController(),stage:'receiving'};this.transfers.set(requestId,transfer);
  let temporary:string|undefined,owned=false;
  const update=(stage:string,sent=0,total=0)=>{transfer.stage=stage;dataset={...dataset,transfer_stage:stage,transfer_sent:sent,transfer_total:total};this.data.saveDataset(dataset);};
  const stopped=()=>{if(transfer.controller.signal.aborted)experimentError('UPLOAD_CANCELLED',409);};
  try{
   this.data.saveDataset(dataset);temporary=await mkdtemp(join(tmpdir(),'trash-dataset-'));const file=join(temporary,'upload'),digest=createHash('sha256');let hashes:{path:string;sha256:string}[]=[];let received=0,last=0;
   const limit=new Transform({transform(chunk:Buffer,_encoding,callback){received+=chunk.length;digest.update(chunk);if(received>MAX_DATASET_BYTES){callback(Object.assign(new Error('REQUEST_TOO_LARGE'),{statusCode:413}));return;}if(Date.now()-last>250){last=Date.now();update('receiving',received,dataset.transfer_total);}callback(null,chunk);}});
   await pipeline(request,limit,createWriteStream(file,{mode:0o600}),{signal:transfer.controller.signal});stopped();
   const bytes=(await stat(file)).size;if(!bytes)experimentError('DATASET_EMPTY_FILE',400);
   update('validating',bytes,bytes);
   if(extract){try{const result=await execute('python3',['-I','-B','-c',archiveType==='zip'?validateZip:validateTar,file],{timeout:1800000,maxBuffer:16*1024*1024,signal:transfer.controller.signal});hashes=JSON.parse(result.stdout);}catch{stopped();experimentError('DATASET_ARCHIVE_INVALID',422);}await remote.exec(['sh','-c',archiveType==='zip'?'command -v unzip >/dev/null 2>&1':'command -v tar >/dev/null 2>&1']);}
   if(!extract)hashes=[{path:filename,sha256:digest.digest('hex')}];
   stopped();await ensureRemoteDirectory(remote,parent);stopped();
   const sftp=await remote.sftp();try{const exists=await new Promise<boolean>((resolve,reject)=>sftp.lstat(target,error=>{if(!error)resolve(true);else if(Number((error as Error&{code?:number}).code)===2)resolve(false);else reject(error);}));if(exists)experimentError('REPRODUCTION_REMOTE_TARGET_EXISTS',409);await new Promise<void>((resolve,reject)=>sftp.mkdir(target,{mode:0o755},error=>error?reject(error):resolve()));owned=true;}finally{sftp.end();}
   stopped();const destination=posix.join(target,extract?(archiveType==='zip'?'.trash-upload.zip':'.trash-upload.tar'):filename);update('uploading',0,bytes);await remote.upload(file,destination,(sent,total)=>update('uploading',sent,total),transfer.controller.signal);stopped();
   if(extract){update('extracting',bytes,bytes);await remote.exec(archiveType==='zip'?['unzip','-q','-n',destination,'-d',target]:['tar','--extract','--file',destination,'--directory',target,'--no-same-owner','--no-same-permissions','--keep-old-files'],undefined,1800000);await remote.exec(['rm','--',destination]);}
   update('saving',bytes,bytes);this.saveHashes(project,id,hashes);dataset={...dataset,size_bytes:bytes,transfer_status:'ready',transfer_message:extract?'已上传并解压。':'已上传。'};dataset={...dataset,transfer_status:'uploading',transfer_stage:'verifying'};transfer.stage='verifying';this.data.saveDataset(dataset);dataset=await this.verify(project,id,remote);dataset={...dataset,transfer_status:'ready',transfer_stage:'saving'};this.data.saveDataset(dataset);return dataset;
  }catch(error){let cleanupFailed=false;if(owned){try{await remote.exec(['rm','-rf','--',target],undefined,60000);}catch{cleanupFailed=true;}}
   const cancelled=transfer.controller.signal.aborted;dataset={...dataset,transfer_status:cancelled?'cancelled':'failed',transfer_message:cleanupFailed?'远端清理未完成，请检查：'+target:cancelled?'上传已终止，本次目录已清理。':'上传失败，本次创建的目录已清理；已有目录未改动。'};this.data.saveDataset(dataset);
   if(cleanupFailed)experimentError('UPLOAD_CANCEL_CLEANUP_FAILED',409);if(cancelled)experimentError('UPLOAD_CANCELLED',409);if(error instanceof Error&&'statusCode' in error)throw error;experimentError('DATASET_UPLOAD_FAILED',422);
  }finally{this.transfers.delete(requestId);if(temporary)await rm(temporary,{recursive:true,force:true});}
 }
}
