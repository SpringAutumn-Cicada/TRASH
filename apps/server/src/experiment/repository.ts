import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { realpath, readdir, stat, readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ExperimentStore, experimentError } from "@trash/storage";
import { commitShaSchema, repositoryInputSchema, type ProjectRepository } from "@trash/protocol";
const execute = promisify(execFile);
export async function git(path:string,args:string[],maxBuffer=4*1024*1024):Promise<string> {
  try {return (await execute("git",["-C",path,...args],{encoding:"utf8",maxBuffer,timeout:60000})).stdout;}
  catch {return experimentError("GIT_OPERATION_FAILED",422);}
}
export class RepositoryService {
  constructor(readonly store:ExperimentStore) {}
  async bind(projectId:string,value:unknown):Promise<ProjectRepository> {
    if(this.store.runs(projectId).some(run=>this.store.active(run)))experimentError("EXPERIMENT_ACTIVE",409);
    const input=repositoryInputSchema.parse(value);const path=await realpath(input.path);
    const top=await realpath((await git(path,["rev-parse","--show-toplevel"])).trim());
    if(top!==path)experimentError("REPOSITORY_ROOT_REQUIRED");
    const record={...input,path,repository_id:`repo_${randomUUID()}`,project_id:projectId,bound_at:new Date().toISOString()};this.store.saveRepository(record);return record;
  }
  bound(projectId:string):ProjectRepository {return this.store.repository(projectId)??experimentError("REPOSITORY_NOT_BOUND",404);}
  async safePath(projectId:string,path:string):Promise<string> {
    const root=this.bound(projectId).path;
    if(isAbsolute(path)||path.split(/[\\/]/).some(p=>p===".."||p===".git")||path.includes("\0"))experimentError("REPOSITORY_PATH_INVALID");
    const target=await realpath(resolve(root,path||"."));const rel=relative(root,target);
    if(rel.startsWith(`..${sep}`)||rel===".."||isAbsolute(rel)||rel.split(sep).includes(".git"))experimentError("REPOSITORY_PATH_INVALID");return target;
  }
  async tree(projectId:string,path=""):Promise<unknown[]> {
    const root=await this.safePath(projectId,path);const entries=await readdir(root,{withFileTypes:true});
    return entries.filter(e=>e.name!==".git").slice(0,1000).map(e=>({name:e.name,path:path?`${path}/${e.name}`:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink()}));
  }
  async file(projectId:string,path:string):Promise<unknown> {
    const target=await this.safePath(projectId,path),info=await stat(target);
    if(!info.isFile())experimentError("NOT_A_FILE");if(info.size>1024*1024)return {path,size_bytes:info.size,preview:false,reason:"文件超过 1 MiB"};
    const data=await readFile(target);if(data.includes(0))return {path,size_bytes:data.length,preview:false,reason:"二进制文件"};
    try{return {path,size_bytes:data.length,preview:true,text:new TextDecoder("utf-8",{fatal:true}).decode(data)};}catch{return {path,size_bytes:data.length,preview:false,reason:"非 UTF-8 文本"};}
  }
  async status(projectId:string) {const repo=this.bound(projectId);const status=await git(repo.path,["status","--porcelain=v1","--untracked-files=all"]);let head="";try{head=(await git(repo.path,["rev-parse","HEAD"])).trim();}catch{/* New repository. */}return {repository:repo,head,clean:!status,status,diff:await git(repo.path,["diff","--no-ext-diff","--no-textconv"]),staged_diff:await git(repo.path,["diff","--cached","--no-ext-diff","--no-textconv"])};}
  async history(projectId:string,page:number) {const repo=this.bound(projectId);return (await git(repo.path,["log","-50",`--skip=${(page-1)*50}`,"--format=%H%x09%aI%x09%s"])).trim().split("\n").filter(Boolean).map(row=>{const [sha,at,...title]=row.split("\t");return {sha,at,title:title.join("\t")};});}
  async commit(projectId:string,message:string) {const repo=this.bound(projectId);if(this.store.runs(projectId).some(run=>this.store.active(run)))experimentError("EXPERIMENT_ACTIVE",409);await git(repo.path,["commit","-m",message]);return this.status(projectId);}
  async editor(projectId:string):Promise<void> {const repo=this.bound(projectId);if(!repo.editor)experimentError("EDITOR_NOT_CONFIGURED");const child=spawn(repo.editor.executable,[...repo.editor.args,repo.path],{cwd:repo.path,detached:true,stdio:"ignore",shell:false});await new Promise<void>((resolve,reject)=>{child.once("error",()=>reject(Object.assign(new Error("EDITOR_START_FAILED"),{statusCode:422})));child.once("spawn",resolve);});child.unref();}
  async preflight(projectId:string,sha:string):Promise<void> {
    commitShaSchema.parse(sha);const repo=this.bound(projectId);
    if((await git(repo.path,["status","--porcelain=v1","--untracked-files=all"])).trim())experimentError("GIT_TREE_DIRTY",409);
    const commit=(await git(repo.path,["rev-parse",`${sha}^{commit}`])).trim();if(commit!==sha)experimentError("GIT_COMMIT_MISMATCH",409);
    const paths=(await git(repo.path,["ls-tree","-r","--name-only",sha])).split("\n");
    if(paths.some(p=>/(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|auth\.json)$/.test(p) && !p.endsWith(".env.example")))experimentError("SENSITIVE_TRACKED_FILE",422);
    if(paths.some(p=>p===".gitmodules"))experimentError("GIT_SUBMODULE_UNSUPPORTED",422);
    for(const path of paths.filter(p=>p.endsWith(".gitattributes")))if(/filter\s*=\s*lfs/.test(await git(repo.path,["show",`${sha}:${path}`])))experimentError("GIT_LFS_UNSUPPORTED",422);
  }
  async bundle(projectId:string,sha:string):Promise<{path:string;sha256:string;size:number;cleanup:()=>Promise<void>}> {
    await this.preflight(projectId,sha);const repo=this.bound(projectId);const directory=await mkdtemp(join(tmpdir(),"trash-bundle-"));const bare=join(directory,"repo.git");const path=join(directory,"code.bundle");
    try{await mkdir(bare);await git(bare,["init","--bare"]);await git(bare,["fetch","--no-tags",repo.path,sha]);await git(bare,["update-ref","refs/heads/trash-run",sha]);await git(bare,["bundle","create",path,"refs/heads/trash-run"]);const info=await stat(path);if(info.size>200*1024*1024)experimentError("CODE_BUNDLE_TOO_LARGE",413);const hash=createHash("sha256").update(await readFile(path)).digest("hex");return {path,sha256:hash,size:info.size,cleanup:()=>rm(directory,{recursive:true,force:true})};}catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  }
  async preparation(projectId:string,sha:string,path:string):Promise<string> {commitShaSchema.parse(sha);if(path.startsWith("/")||path.split("/").includes(".."))experimentError("PREPARATION_PATH_INVALID");return git(this.bound(projectId).path,["show",`${sha}:${path}`]);}
}
