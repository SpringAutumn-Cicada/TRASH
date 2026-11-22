import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { realpath, readdir, stat, readFile, mkdir, mkdtemp, rm, lstat, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ExperimentStore, experimentError } from "@trash/storage";
import { commitShaSchema, repositoryInputSchema, type ProjectRepository } from "@trash/protocol";
import { GitIdentitySettings, gitIdentityEnv } from "../git-identity.js";
const execute = promisify(execFile);
export async function git(path:string,args:string[],maxBuffer=4*1024*1024,env?:NodeJS.ProcessEnv):Promise<string> {
  try {return (await execute("git",["-C",path,...args],{encoding:"utf8",maxBuffer,timeout:60000,env})).stdout;}
  catch {return experimentError("GIT_OPERATION_FAILED",422);}
}
export class RepositoryService {
  constructor(readonly store:ExperimentStore,readonly gitIdentity=new GitIdentitySettings()) {}
  async bind(projectId:string,value:unknown,makeDefault=true):Promise<ProjectRepository> {
    if(this.store.runs(projectId).some(run=>this.store.active(run)))experimentError("EXPERIMENT_ACTIVE",409);
    const input=repositoryInputSchema.parse(value);const path=await realpath(input.path);
    const top=await realpath((await git(path,["rev-parse","--show-toplevel"])).trim());
    if(top!==path)experimentError("REPOSITORY_ROOT_REQUIRED");
    const existing=this.store.repositories(projectId).find(repo=>repo.path===path);
    const record={...existing,...input,path,repository_id:existing?.repository_id??`repo_${randomUUID()}`,project_id:projectId,bound_at:existing?.bound_at??new Date().toISOString()};
    this.store.saveRepository(record,makeDefault);return record;
  }
  bound(projectId:string,id?:string):ProjectRepository {return this.store.repository(projectId,id)??experimentError("REPOSITORY_NOT_BOUND",404);}
  forPaper(projectId:string,paperId:string){
    return this.store.repositories(projectId).find(repo=>repo.paper_id===paperId);
  }
  linkPaper(projectId:string,paperId:string,repositoryId:string){
    const current=this.forPaper(projectId,paperId),repo=this.bound(projectId,repositoryId);
    if(current&&current.repository_id!==repositoryId||repo.paper_id&&repo.paper_id!==paperId)experimentError('PAPER_REPOSITORY_CONFLICT',409);
    const record={...repo,paper_id:paperId};
    this.store.saveRepository(record,false);
    return record;
  }
  async initializePaper(projectId:string,paperId:string,projectRoot:string){
    if(this.forPaper(projectId,paperId))experimentError('PAPER_REPOSITORY_CONFLICT',409);
    const root=await realpath(projectRoot);
    let parent=root;
    for(const part of ['code','papers']){
      parent=join(parent,part);
      await mkdir(parent).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
      if(!(await lstat(parent)).isDirectory())experimentError('REPOSITORY_PATH_INVALID',403);
    }
    const path=join(parent,paperId);
    if(basename(path)!==paperId)experimentError('REPOSITORY_PATH_INVALID',403);
    await mkdir(path);
    try {await git(path,['init']);}
    catch(error){await rmdir(path).catch(()=>{});throw error;}
    const repo=await this.bind(projectId,{path,name:paperId},false);
    return this.linkPaper(projectId,paperId,repo.repository_id);
  }
  async safePath(projectId:string,path:string,id?:string):Promise<string> {
    const root=this.bound(projectId,id).path;
    if(isAbsolute(path)||path.split(/[\\/]/).some(p=>p===".."||p===".git")||path.includes("\0"))experimentError("REPOSITORY_PATH_INVALID");
    const target=await realpath(resolve(root,path||"."));const rel=relative(root,target);
    if(rel.startsWith(`..${sep}`)||rel===".."||isAbsolute(rel)||rel.split(sep).includes(".git"))experimentError("REPOSITORY_PATH_INVALID");return target;
  }
  async tree(projectId:string,path="",id?:string):Promise<unknown[]> {
    const root=await this.safePath(projectId,path,id);const entries=await readdir(root,{withFileTypes:true});
    return entries.filter(e=>e.name!==".git").slice(0,1000).map(e=>({name:e.name,path:path?`${path}/${e.name}`:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink()}));
  }
  async file(projectId:string,path:string,id?:string):Promise<unknown> {
    const target=await this.safePath(projectId,path,id),info=await stat(target);
    if(!info.isFile())experimentError("NOT_A_FILE");if(info.size>1024*1024)return {path,size_bytes:info.size,preview:false,reason:"文件超过 1 MiB"};
    const data=await readFile(target);if(data.includes(0))return {path,size_bytes:data.length,preview:false,reason:"二进制文件"};
    try{return {path,size_bytes:data.length,preview:true,text:new TextDecoder("utf-8",{fatal:true}).decode(data)};}catch{return {path,size_bytes:data.length,preview:false,reason:"非 UTF-8 文本"};}
  }
  async status(projectId:string,id?:string) {const repo=this.bound(projectId,id);const status=await git(repo.path,["status","--porcelain=v1","--untracked-files=all"]);let head="";try{head=(await git(repo.path,["rev-parse","HEAD"])).trim();}catch{/* New repository. */}return {repository:repo,head,clean:!status,status,diff:await git(repo.path,["diff","--no-ext-diff","--no-textconv"]),staged_diff:await git(repo.path,["diff","--cached","--no-ext-diff","--no-textconv"])};}
  async history(projectId:string,page:number,id?:string) {const repo=this.bound(projectId,id);return (await git(repo.path,["log","-50",`--skip=${(page-1)*50}`,"--format=%H%x09%aI%x09%s"])).trim().split("\n").filter(Boolean).map(row=>{const [sha,at,...title]=row.split("\t");return {sha,at,title:title.join("\t")};});}
  async commit(projectId:string,message:string,id?:string) {
    const repo=this.bound(projectId,id);
    if(this.store.runs(projectId).some(run=>this.store.active(run)))experimentError("EXPERIMENT_ACTIVE",409);
    const identity=await this.gitIdentity.require(repo.path);
    await git(repo.path,["commit","-m",message],undefined,{...process.env,...gitIdentityEnv(identity)});
    return this.status(projectId,id);
  }
  async editor(projectId:string,id?:string):Promise<void> {const repo=this.bound(projectId,id);if(!repo.editor)experimentError("EDITOR_NOT_CONFIGURED");const child=spawn(repo.editor.executable,[...repo.editor.args,repo.path],{cwd:repo.path,detached:true,stdio:"ignore",shell:false});await new Promise<void>((resolve,reject)=>{child.once("error",()=>reject(Object.assign(new Error("EDITOR_START_FAILED"),{statusCode:422})));child.once("spawn",resolve);});child.unref();}
  async preflight(projectId:string,sha:string,id?:string):Promise<void> {
    commitShaSchema.parse(sha);const repo=this.bound(projectId,id);
    if((await git(repo.path,["status","--porcelain=v1","--untracked-files=all"])).trim())experimentError("GIT_TREE_DIRTY",409);
    const commit=(await git(repo.path,["rev-parse",`${sha}^{commit}`])).trim();if(commit!==sha)experimentError("GIT_COMMIT_MISMATCH",409);
    const paths=(await git(repo.path,["ls-tree","-r","--name-only",sha])).split("\n");
    if(paths.some(p=>/(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|auth\.json)$/.test(p) && !p.endsWith(".env.example")))experimentError("SENSITIVE_TRACKED_FILE",422);
    if(paths.some(p=>p===".gitmodules"))experimentError("GIT_SUBMODULE_UNSUPPORTED",422);
    for(const path of paths.filter(p=>p.endsWith(".gitattributes")))if(/filter\s*=\s*lfs/.test(await git(repo.path,["show",`${sha}:${path}`])))experimentError("GIT_LFS_UNSUPPORTED",422);
  }
  async bundle(projectId:string,sha:string,id?:string):Promise<{path:string;sha256:string;size:number;cleanup:()=>Promise<void>}> {
    await this.preflight(projectId,sha,id);const repo=this.bound(projectId,id);const directory=await mkdtemp(join(tmpdir(),"trash-bundle-"));const bare=join(directory,"repo.git");const path=join(directory,"code.bundle");
    try{await mkdir(bare);await git(bare,["init","--bare"]);await git(bare,["fetch","--no-tags",repo.path,sha]);await git(bare,["update-ref","refs/heads/trash-run",sha]);await git(bare,["bundle","create",path,"refs/heads/trash-run"]);const info=await stat(path);if(info.size>200*1024*1024)experimentError("CODE_BUNDLE_TOO_LARGE",413);const hash=createHash("sha256").update(await readFile(path)).digest("hex");return {path,sha256:hash,size:info.size,cleanup:()=>rm(directory,{recursive:true,force:true})};}catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  }
  async preparation(projectId:string,sha:string,path:string,id?:string):Promise<string> {commitShaSchema.parse(sha);if(path.startsWith("/")||path.split("/").includes(".."))experimentError("PREPARATION_PATH_INVALID");return git(this.bound(projectId,id).path,["show",`${sha}:${path}`]);}
}
