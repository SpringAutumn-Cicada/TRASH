import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { experimentError } from "@trash/storage";
import { privateUploadPath } from "./experiment/autodl-file-upload.js";

const execute=promisify(execFile);
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==="ENOENT";
export async function gitRead(path:string,args:string[]){
  try{return (await execute("git",["-C",path,"-c","core.fsmonitor=false",...args],{
    timeout:15000,maxBuffer:4*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"},
  })).stdout;}
  catch{experimentError("CHAT_GIT_READ_FAILED",409);}
}

export async function decisionFileHash(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    if(process.platform==="linux"&&await realpath("/proc/self/fd/"+file.fd)!==path)
      experimentError("CHAT_DECISION_FILE_CHANGED",409);
    const before=await file.stat();
    if(!before.isFile())experimentError("CHAT_DECISION_FILE_INVALID",409);
    const hash=createHash("sha256");
    for await(const data of file.createReadStream({autoClose:false}))hash.update(data);
    const after=await file.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
      experimentError("CHAT_DECISION_FILE_CHANGED",409);
    return {sha256:hash.digest("hex"),mode:before.mode&0o111};
  }finally{await file.close();}
}

export async function gitUploadBaseline(path:string){
  const head=(await gitRead(path,["rev-parse","HEAD"])).trim();
  const ref=(await gitRead(path,["rev-parse","--symbolic-full-name","HEAD"])).trim();
  const gitDir=(await gitRead(path,["rev-parse","--absolute-git-dir"])).trim();
  for(const state of ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-apply","rebase-merge"]){
    if(await lstat(join(gitDir,state)).catch(error=>{if(!missing(error))throw error;}))
      experimentError("CHAT_GIT_OPERATION_ACTIVE",409);
  }
  const statusArgs=["status","--porcelain=v1","-z","--no-renames","--untracked-files=all"];
  const status=await gitRead(path,statusArgs);
  const indexArgs=["diff","--cached","--raw","-z","--no-abbrev","--no-renames","--no-ext-diff"];
  const staged=await gitRead(path,indexArgs);
  const records=status.split("\0").filter(Boolean);
  if(records.some(entry=>!entry.startsWith("??")&&entry[0]!==" "&&entry[1]!==" "))
    experimentError("CHAT_GIT_MIXED_CHANGES",409);
  const files=records.map(entry=>entry.slice(3)).sort();
  const checks=[];
  for(const name of files){
    if(name.split("/").some(part=>part===".."||part==="."||!part)||isAbsolute(name)||privateUploadPath(name))
      experimentError("SENSITIVE_TRACKED_FILE",422);
    const target=join(path,name);
    const stat=await lstat(target).catch(error=>{if(!missing(error))throw error;});
    if(stat&&(!stat.isFile()||await realpath(target)!==target))experimentError("CHAT_DECISION_FILE_INVALID",409);
    checks.push(stat?await decisionFileHash(target):null);
  }
  if((await gitRead(path,["rev-parse","HEAD"])).trim()!==head||
    (await gitRead(path,["rev-parse","--symbolic-full-name","HEAD"])).trim()!==ref||await gitRead(path,statusArgs)!==status||
    await gitRead(path,indexArgs)!==staged)
    experimentError("CHAT_DECISION_FILE_CHANGED",409);
  const worktree=createHash("sha256").update(JSON.stringify({files,checks})).digest("hex");
  return {head,ref,files,worktree,fingerprint:createHash("sha256").update(JSON.stringify({head,ref,status,staged,worktree})).digest("hex")};
}

export async function readGitIndex(path:string){
  const gitDir=await realpath((await gitRead(path,["rev-parse","--absolute-git-dir"])).trim());
  const index=(await gitRead(path,["rev-parse","--path-format=absolute","--git-path","index"])).trim();
  if(relative(gitDir,index)!=="index"||!index.endsWith(sep+"index"))experimentError("CHAT_GIT_READ_FAILED",409);
  return {index,bytes:await readFile(index).catch(error=>{if(!missing(error))throw error;return undefined;})};
}

export async function restoreGitIndex(index:string,expected:Buffer,original:Buffer|undefined){
  const lock=index+".lock";
  const file=await open(lock,"wx",0o600);
  let released=false;
  try{
    const current=await readFile(index);
    if(!current.equals(expected))return;
    if(original){
      await writeFile(file,original);
      await file.close();
      await rename(lock,index);
      released=true;
    }else await unlink(index);
  }finally{
    await file.close();
    if(!released)await unlink(lock).catch(error=>{if(!missing(error))throw error;});
  }
}
