import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { experimentError, type TrashStore } from "@trash/storage";
import { remotePathSchema, type RemoteWorkspace } from "@trash/protocol";
import type { RemoteConnection } from "./ssh.js";

export function directoryLabel(name:string){const value=name.normalize('NFKC').replace(/[^\p{L}\p{N}_.-]+/gu,'_').replace(/^[._-]+|[._-]+$/g,'').slice(0,100);return value||'project';}
export class WorkspaceService {
 constructor(private store:TrashStore){}
 private file(project:string,profile:string){return join(this.store.root,'projects',project,'remote-workspaces',profile+'.json');}
 get(project:string,profile:string):RemoteWorkspace|undefined{const file=this.file(project,profile);return existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as RemoteWorkspace:undefined;}
 suggested(project:string){const name=this.store.listProjects().find(item=>item.project_id===project)?.title??project;return posix.join('/root/autodl-tmp',directoryLabel(name));}
 save(project:string,profile:string,path:string){const root=posix.normalize(remotePathSchema.parse(path));if(root==='/'||root.split('/').filter(Boolean).length<2)experimentError('WORKSPACE_PATH_INVALID',400);const old=this.get(project,profile);const value:RemoteWorkspace={project_id:project,profile_id:profile,root,updated_at:new Date().toISOString(),...(old?.root===root&&old.initialized_at?{initialized_at:old.initialized_at}:{})};const file=this.file(project,profile);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file);return value;}
 async initialize(project:string,profile:string,remote:RemoteConnection){const value=this.get(project,profile)??experimentError('WORKSPACE_REQUIRED',409);for(const path of [value.root,...['datasets','reproductions','experiments','outputs'].map(name=>posix.join(value.root,name))])await ensureRemoteDirectory(remote,path);const result={...value,initialized_at:new Date().toISOString()};const file=this.file(project,profile);writeFileSync(file+'.tmp',JSON.stringify(result),{mode:0o600});renameSync(file+'.tmp',file);return result;}
}
// Follow no symlinks and never replace a file. Existing directories are retained.
export async function ensureRemoteDirectory(remote:RemoteConnection,path:string){remotePathSchema.parse(path);const sftp=await remote.sftp();try{let current='';for(const part of posix.normalize(path).split('/').filter(Boolean)){current+='/'+part;const info=await new Promise<import('ssh2').Stats|undefined>((resolve,reject)=>sftp.lstat(current,(error,value)=>{if(!error)resolve(value);else if(Number((error as Error&{code?:number}).code)===2)resolve(undefined);else reject(error);}));if(info){if(!info.isDirectory()||info.isSymbolicLink())experimentError('WORKSPACE_PATH_UNSAFE',409);}else await new Promise<void>((resolve,reject)=>sftp.mkdir(current,{mode:0o755},error=>error?reject(error):resolve()));}}finally{sftp.end();}}
