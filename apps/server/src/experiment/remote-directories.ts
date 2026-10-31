/* eslint-disable no-control-regex -- Reject control characters in filesystem paths and interpreter names. */
import { posix } from "node:path";
import { experimentError } from "@trash/storage";
import type { RemoteConnection } from "./ssh.js";

export async function remoteDirectories(remote: RemoteConnection, path: string) {
  if (!path.startsWith("/") || path.split("/").includes("..") || /[\x00-\x1f]/.test(path)) experimentError("REMOTE_DIRECTORY_INVALID", 400);
  const sftp = await remote.sftp();
  try {
    const canonical = await new Promise<string>((resolve, reject) => sftp.realpath(path, (error, value) => error ? reject(error) : resolve(value)));
    const entries = await new Promise<import("ssh2").FileEntryWithStats[]>((resolve, reject) => sftp.readdir(canonical, (error, value) => error ? reject(error) : resolve(value)));
    const directories = entries.filter(entry => entry.attrs.isDirectory() && entry.filename !== "." && entry.filename !== ".." && !entry.filename.includes("/") && !/[\x00-\x1f]/.test(entry.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
    return { path: canonical, parent: canonical === "/" ? null : posix.dirname(canonical), directories: directories.slice(0, 2000).map(entry => ({ name: entry.filename, path: posix.join(canonical, entry.filename) })), truncated: directories.length > 2000 };
  } catch (error) {
    const code=error&&typeof error==="object"&&"code" in error?Number(error.code):0;
    if(code===2)experimentError("REMOTE_DIRECTORY_NOT_FOUND",422);
    if(code===3)experimentError("REMOTE_DIRECTORY_ACCESS_DENIED",422);
    if(code===6||code===7)experimentError("REMOTE_DIRECTORY_CONNECTION_LOST",422);
    experimentError("REMOTE_DIRECTORY_READ_FAILED", 422);
  }
  finally { sftp.end(); }
}

export async function createRemoteDirectory(remote: RemoteConnection, parent: string, name: string) {
  if (!parent.startsWith("/") || parent.split("/").includes("..") || /[\x00-\x1f]/.test(parent) || !name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name) || Buffer.byteLength(name,"utf8") > 255) experimentError("REMOTE_DIRECTORY_INVALID",400);
  const sftp=await remote.sftp();
  try {
    const canonical=await new Promise<string>((resolve,reject)=>sftp.realpath(parent,(error,path)=>error?reject(error):resolve(path)));
    const target=posix.join(canonical,name);
    const existing=await new Promise<boolean>((resolve,reject)=>sftp.lstat(target,(error)=>{if(!error)resolve(true);else if(Number((error as Error & {code?:number}).code)===2)resolve(false);else reject(error);}));
    if(existing)experimentError("REMOTE_DIRECTORY_EXISTS",409);
    await new Promise<void>((resolve,reject)=>sftp.mkdir(target,{mode:0o755},error=>error?reject(error):resolve()));
    return {path:target};
  } catch(error) {
    if(error instanceof Error&&error.message==="REMOTE_DIRECTORY_EXISTS")throw error;
    const code=error&&typeof error==="object"&&"code" in error?Number(error.code):0;
    if(code===3)experimentError("REMOTE_DIRECTORY_ACCESS_DENIED",422);
    if(code===2)experimentError("REMOTE_DIRECTORY_NOT_FOUND",422);
    experimentError("REMOTE_DIRECTORY_CREATE_FAILED",422);
  } finally {sftp.end();}
}
