import { projectRuntime } from "../project-layout.js";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { experimentError, type TrashStore } from "@trash/storage";
import { autoDLDirectories, normalizeAutoDLRoot, remoteDirectoryLabel, remotePathSchema, type RemoteWorkspace } from "@trash/protocol";
import type { RemoteConnection } from "./ssh.js";

export class WorkspaceService {
 private readonly initializations=new Map<string,Promise<RemoteWorkspace>>();
 constructor(private store:TrashStore){}
 private file(project:string,profile:string){return projectRuntime(this.store.root,project,'remote-workspaces',profile+'.json');}
 get(project:string,profile:string):RemoteWorkspace|undefined{
  const file=this.file(project,profile);
  if(!existsSync(file))return undefined;
  const workspace=JSON.parse(readFileSync(file,'utf8')) as RemoteWorkspace;
  return {...workspace,root:normalizeAutoDLRoot(workspace.root)};
 }
 suggested(project:string){const name=this.store.listProjects().find(item=>item.project_id===project)?.title??project;return posix.join('/root/autodl-tmp',remoteDirectoryLabel(name));}
 save(project:string,profile:string,path:string){
  const root=normalizeAutoDLRoot(remotePathSchema.parse(path));
  if(root==='/'||root.split('/').filter(Boolean).length<2)experimentError('WORKSPACE_PATH_INVALID',400);
  const old=this.get(project,profile),file=this.file(project,profile);
  if(old?.root!==root&&this.initializations.has(file))experimentError('WORKSPACE_INITIALIZING',409);
  const value:RemoteWorkspace={project_id:project,profile_id:profile,root,updated_at:new Date().toISOString(),...(old?.root===root?{initialized_at:old.initialized_at,adopted_at:old.adopted_at,source_profile_id:old.source_profile_id,source_root:old.source_root,experiment_uploads:old.experiment_uploads}:{})};
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file);
  return value;
 }
 markAdopted(project:string,profile:string,source?:string,sourceRoot?:string){const value=this.get(project,profile)??experimentError('WORKSPACE_REQUIRED',409);const next={...value,adopted_at:new Date().toISOString(),source_profile_id:source,source_root:sourceRoot};const file=this.file(project,profile);writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(file+'.tmp',file);return next;}
 recordExperimentUpload(project:string,profile:string,root:string,upload:NonNullable<RemoteWorkspace['experiment_uploads']>[number]){const value=this.get(project,profile)??experimentError('WORKSPACE_REQUIRED',409);if(value.root!==root)experimentError('WORKSPACE_CHANGED',409);const next={...value,experiment_uploads:[...(value.experiment_uploads??[]),upload].slice(-100)};const file=this.file(project,profile);writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(file+'.tmp',file);return next;}
 async initialize(project:string,profile:string,connect:()=>RemoteConnection,expectedRoot?:string):Promise<RemoteWorkspace>{
  const workspace=this.get(project,profile)??experimentError('WORKSPACE_REQUIRED',409);
  if(expectedRoot!==undefined&&normalizeAutoDLRoot(expectedRoot)!==workspace.root)experimentError('WORKSPACE_CHANGED',409);
  if(workspace.initialized_at||workspace.adopted_at)return workspace;
  const file=this.file(project,profile),pending=this.initializations.get(file);
  if(pending)return pending;
  const initialization=this.initializeDirectories(workspace,connect());
  this.initializations.set(file,initialization);
  try{return await initialization;}
  finally{this.initializations.delete(file);}
 }
 private async initializeDirectories(workspace:RemoteWorkspace,remote:RemoteConnection){
  const {project_id:project,profile_id:profile,root}=workspace;
  for(const directory of Object.values(autoDLDirectories))await ensureRemoteDirectory(remote,posix.join(root,directory));
  const current=this.get(project,profile);
  if(current?.root!==root)experimentError('WORKSPACE_CHANGED',409);
  const result={...current,initialized_at:new Date().toISOString()};
  const file=this.file(project,profile);
  writeFileSync(file+'.tmp',JSON.stringify(result),{mode:0o600});renameSync(file+'.tmp',file);
  return result;
 }
}
// Follow no symlinks and never replace a file. Existing directories are retained.
export async function ensureRemoteDirectory(remote:RemoteConnection,path:string){
  remotePathSchema.parse(path);
  const sftp=await remote.sftp();
  const inspect=(target:string)=>new Promise<import('ssh2').Stats|undefined>((resolve,reject)=>{
    sftp.lstat(target,(error,value)=>{
      if(!error)resolve(value);
      else if(Number((error as Error&{code?:number}).code)===2)resolve(undefined);
      else reject(error);
    });
  });
  try{
    let current='';
    for(const part of posix.normalize(path).split('/').filter(Boolean)){
      current+='/'+part;
      let info=await inspect(current);
      if(!info){
        try{await new Promise<void>((resolve,reject)=>sftp.mkdir(current,{mode:0o755},error=>error?reject(error):resolve()));}
        catch(error){info=await inspect(current);if(!info)throw error;}
      }
      if(info&&(!info.isDirectory()||info.isSymbolicLink()))experimentError('WORKSPACE_PATH_UNSAFE',409);
    }
  }finally{sftp.end();}
}
