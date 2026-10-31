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
