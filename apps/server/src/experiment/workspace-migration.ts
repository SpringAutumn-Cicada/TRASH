import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { autoDLDirectories, normalizeAutoDLRoot, remotePathSchema, type WorkspaceRecognition } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import type { ExperimentService } from "./service.js";
import type { RemoteConnection } from "./ssh.js";

// Only inspect existing paths. Never create directories during recognition/adoption.
export async function remoteDirectoryExists(remote:RemoteConnection,path:string){remotePathSchema.parse(path);const sftp=await remote.sftp();try{let current='';for(const part of posix.normalize(path).split('/').filter(Boolean)){current+='/'+part;const info=await new Promise<import('ssh2').Stats|undefined>((resolve,reject)=>sftp.lstat(current,(error,value)=>{if(!error)resolve(value);else if(Number((error as Error&{code?:number}).code)===2)resolve(undefined);else reject(error);}));if(!info)return false;if(!info.isDirectory()||info.isSymbolicLink())experimentError('WORKSPACE_PATH_UNSAFE',409);}return true;}finally{sftp.end();}}
const hashCommand='root=$(readlink -f -- "$1") || exit 1; shift; for file do canonical=$(readlink -f -- "$file") || exit 1; case "$canonical" in "$root"/*) ;; *) exit 1;; esac; [ -f "$file" ] && [ ! -L "$file" ] || exit 1; sha256sum -z -- "$file" || exit 1; done';
export async function matchesHashes(remote:RemoteConnection,root:string,files:{path:string;sha256:string}[]){
 if(!files.length)return false;
 for(let offset=0;offset<files.length;offset+=64){const batch=files.slice(offset,offset+64);for(const file of batch)if(!/^[a-f0-9]{64}$/.test(file.sha256)||!file.path||file.path.includes('\\')||file.path.startsWith('/')||file.path.split('/').some(part=>part==='..'||part==='.')||Array.from(file.path).some(char=>char.charCodeAt(0)<32))return false;
  const result=await remote.exec(['sh','-c',hashCommand,'trash-sha256',root,...batch.map(file=>posix.join(root,file.path))],undefined,300000,1024*1024);const rows=result.split('\0').filter(Boolean);if(rows.length!==batch.length||rows.some((row,index)=>row.slice(0,64)!==batch[index].sha256||!/^([a-f0-9]{64}) [ *]/.test(row)))return false;
 }return true;
}
async function generateHashes(remote:RemoteConnection,root:string){
 if(!await remoteDirectoryExists(remote,root))experimentError('REMOTE_DIRECTORY_NOT_FOUND',422);
 const script='links=$(find "$1" -type l -print -quit) || exit 1; [ -z "$links" ] || exit 1; find "$1" -type f -exec sha256sum -z -- {} +';
 const output=await remote.exec(['sh','-c',script,'trash-sha256-baseline',root],undefined,600000,16*1024*1024);
 const files=output.split('\0').filter(Boolean).map(row=>{if(!/^([a-f0-9]{64}) [ *]/.test(row))throw new Error('Invalid SHA-256 output');const path=posix.relative(root,row.slice(66));if(!path||path==='..'||path.startsWith('../')||posix.isAbsolute(path)||Array.from(path).some(char=>char.charCodeAt(0)<32))throw new Error('Invalid dataset path');return {path,sha256:row.slice(0,64)};});
 if(files.length>100000)experimentError('DATASET_HASH_LIMIT',422);return files;
}
async function matchesCode(service:ExperimentService,project:string,remote:RemoteConnection,root:string,snapshotId:string){
 const snapshot=service.reproductions.snapshotInfo(project,snapshotId);try{if(await matchesHashes(remote,root,snapshot.files))return true;}catch{/* The original ZIP wrapper may have been flattened. */}
 const wrapper=snapshot.archive_name?.replace(/\.zip$/i,'');if(!wrapper||!snapshot.files.every(file=>file.path.startsWith(wrapper+'/')))return false;
 return matchesHashes(remote,root,snapshot.files.map(file=>({...file,path:file.path.slice(wrapper.length+1)})));
}
export function mappedWorkspacePath(source:string,root:string,path:string){const relative=posix.relative(source,path);if(!relative||relative==='..'||relative.startsWith('../')||posix.isAbsolute(relative))return undefined;return posix.join(root,relative);}
export async function recognizeWorkspace(service:ExperimentService,project:string,profile:string,path:string,source?:string):Promise<WorkspaceRecognition>{
 const root=normalizeAutoDLRoot(remotePathSchema.parse(path));if(root==='/'||root.split('/').filter(Boolean).length<2)experimentError('WORKSPACE_PATH_INVALID',400);
 const remote=service.terminals.connection(project,profile);const sourceWorkspace=source?service.workspaces.get(project,source)??experimentError('WORKSPACE_SOURCE_NOT_FOUND',404):undefined;
 if(source===profile)experimentError('WORKSPACE_SOURCE_INVALID',400);
 const directories:WorkspaceRecognition['directories']=[];
 if(!await remoteDirectoryExists(remote,root))experimentError('REMOTE_DIRECTORY_NOT_FOUND',422);
 for(const name of Object.values(autoDLDirectories))directories.push({name,path:posix.join(root,name),exists:await remoteDirectoryExists(remote,posix.join(root,name))});
 const resources:WorkspaceRecognition['resources']=[];
 const check=async(kind:'dataset'|'reproduction'|'experiment',id:string,name:string,oldPath:string,snapshot?:string)=>{
  const target=sourceWorkspace?mappedWorkspacePath(sourceWorkspace.root,root,oldPath):undefined;let matched=false,baseline_generated=false,reason='原路径不在来源工作区内，保留原记录';
  if(target){try{
   if(snapshot){matched=await remoteDirectoryExists(remote,target)&&await matchesCode(service,project,remote,target,snapshot);reason=matched?'源文件 SHA-256 全部一致':'文件缺失或 SHA-256 不一致，跳过';}
   else{const recorded=service.datasetUploads.hashes(project,id);const original=service.data.datasets(project).find(item=>item.dataset_id===id)!;const checksum=original.sha256;const originalFile=original.checksum_manifest??oldPath;const file=sourceWorkspace?mappedWorkspacePath(sourceWorkspace.root,root,originalFile):undefined;
    if(recorded.length){matched=await matchesHashes(remote,target,recorded);reason=matched?'数据文件 SHA-256 全部一致':'数据文件缺失或 SHA-256 不一致，跳过';}
    else if(!checksum||!file){const files=await generateHashes(remote,target);if(files.length){service.datasetUploads.saveHashes(project,'clone_'+profile+'_'+id,files);matched=true;baseline_generated=true;reason='已计算并保存新主机 SHA-256 基线，可接管；未与旧主机内容比对';}else reason='目录为空，没有可计算哈希的文件，跳过';}
    else{matched=await matchesHashes(remote,root,[{path:posix.relative(root,file),sha256:checksum}]);reason=matched?(original.checksum_manifest?'校验清单 SHA-256 一致；数据内容未逐文件验证':'数据文件 SHA-256 一致'):'SHA-256 不一致，跳过';}
   }
  }catch{reason='无法读取文件或计算 SHA-256，待确认，不自动关联';}}
  resources.push({kind,id,name,path:target??oldPath,matched,baseline_generated,reason});
 };
 if(source&&sourceWorkspace){
  service.data.profile(project,source);
  for(const item of service.data.datasets(project).filter(item=>item.profile_id===source&&(!item.transfer_status||item.transfer_status==='ready')))await check('dataset',item.dataset_id,item.name,item.path);
  for(const code of service.reproductions.list(project)){const upload=code.uploads?.filter(item=>item.profile_id===source).at(-1);if(upload)await check('reproduction',code.id,code.name,upload.path,upload.snapshot_id);}
  for(const upload of sourceWorkspace.experiment_uploads??[])await check('experiment',upload.snapshot_id,upload.name,upload.path,upload.snapshot_id);
 }
 return {root,profile_id:profile,source_profile_id:source,source_root:sourceWorkspace?.root,recognized:directories.every(item=>item.exists),directories,resources};
}
export async function adoptWorkspace(service:ExperimentService,project:string,profile:string,path:string,source?:string){
 if(service.datasetUploads.busy(project)||service.deployments.busyProject(project)||service.data.runs(project).some(run=>service.data.active(run)))experimentError('WORKSPACE_BUSY',409);
 const release=service.reproductions.acquire(project);
 try{const result=await recognizeWorkspace(service,project,profile,path,source);if(!result.recognized)experimentError('WORKSPACE_INCOMPLETE',409);
  let datasets=0,codes=0,experiments=0;
  for(const item of result.resources.filter(item=>item.matched)){
   if(item.kind==='dataset'){
    if(service.data.datasets(project).some(value=>value.profile_id===profile&&value.path===item.path))continue;
    const original=service.data.datasets(project).find(value=>value.dataset_id===item.id)!;
    const newId='dataset_'+randomUUID();const recorded=service.datasetUploads.hashes(project,item.baseline_generated?'clone_'+profile+'_'+original.dataset_id:original.dataset_id);if(recorded.length)service.datasetUploads.saveHashes(project,newId,recorded);
    service.data.saveDataset({dataset_id:newId,project_id:project,profile_id:profile,name:original.name,version:original.version,path:item.path,notes:original.notes,verification_status:'unverified',sha256:original.sha256,transfer_status:'ready',transfer_message:item.baseline_generated?'已接管并建立当前主机 SHA-256 基线；未验证与旧主机内容一致。':recorded.length?'从克隆主机接管，已记录的数据文件 SHA-256 全部一致。':original.checksum_manifest?'从克隆主机接管，校验清单 SHA-256 一致，数据内容尚未逐文件验证。':'从克隆主机接管，数据文件 SHA-256 一致。',...(original.checksum_manifest&&result.source_root?{checksum_manifest:mappedWorkspacePath(result.source_root,result.root,original.checksum_manifest)}:{})});datasets++;
   }else if(item.kind==='reproduction'){
    const code=service.reproductions.get(project,item.id),upload=code.uploads?.filter(value=>value.profile_id===source).at(-1);
    if(upload&&!code.uploads?.some(value=>value.profile_id===profile&&value.path===item.path&&value.snapshot_id===upload.snapshot_id)){service.reproductions.recordUpload(project,code.id,profile,{path:item.path,snapshot:service.reproductions.snapshotInfo(project,upload.snapshot_id)});codes++;}
   }
  }
  let workspace=service.workspaces.save(project,profile,result.root);
  for(const item of result.resources.filter(item=>item.matched&&item.kind==='experiment')){const original=service.workspaces.get(project,source!)?.experiment_uploads?.find(value=>value.snapshot_id===item.id);if(original&&!workspace.experiment_uploads?.some(value=>value.path===item.path&&value.snapshot_id===item.id)){workspace=service.workspaces.recordExperimentUpload(project,profile,result.root,{...original,path:item.path,at:new Date().toISOString()});experiments++;}}
  workspace=service.workspaces.markAdopted(project,profile,source,result.source_root);
  return {workspace,recognition:result,imported:{datasets,reproductions:codes,experiments}};
 }finally{release();}
}
