import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimentError } from "@trash/storage";

const directoryPath = z.string().min(1).max(4096).refine(p => isAbsolute(p) && !p.includes("\0"));
const execute = promisify(execFile);
export async function selectDirectory(input: unknown) {
  const value = z.object({ path: directoryPath, initialize_git: z.boolean() }).strict().parse(input);
  const path = await resolveDirectory(value.path);
  if (!value.initialize_git) return { path, initialized: false };
  const git = async (...args: string[]) => (await execute("git", ["-C", path, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    // Reuse existing repositories/worktrees without reinitializing their metadata.
    let hasGit = false;
    try { await lstat(join(path, ".git")); hasGit = true; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    if (hasGit) {
      if (await realpath(await git("rev-parse", "--show-toplevel")) !== path) return experimentError("LOCAL_GIT_INIT_FAILED", 422);
      return { path, initialized: false };
    }
    let bare = false;
    try { bare = await git("rev-parse", "--is-bare-repository") === "true"; } catch { /* An ordinary directory is expected. */ }
    if (bare) return experimentError("LOCAL_GIT_BARE_UNSUPPORTED", 422);
    await git("init", "--initial-branch=main");
    return { path, initialized: true };
  } catch (error) {
    if (error instanceof Error && error.message === "LOCAL_GIT_BARE_UNSUPPORTED") throw error;
    return experimentError("LOCAL_GIT_INIT_FAILED", 422);
  }
}
async function resolveDirectory(path: string): Promise<string> {
  try {
    const resolved = await realpath(directoryPath.parse(path));
    if (!(await stat(resolved)).isDirectory()) return experimentError("LOCAL_DIRECTORY_NOT_FOUND", 404);
    return resolved;
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    if (error && typeof error === "object" && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return experimentError("LOCAL_DIRECTORY_ACCESS_DENIED", 403);
    return experimentError("LOCAL_DIRECTORY_NOT_FOUND", 404);
  }
}
export async function browseDirectories(path?: string) {
  const current = await resolveDirectory(path || homedir());
  try {
    const entries = await readdir(current, { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory() && entry.name !== ".git")
      .map(entry => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const parent = dirname(current);
    return { path: current, name: basename(current) || current, parent: parent === current ? null : parent, directories };
  } catch { return experimentError("LOCAL_DIRECTORY_ACCESS_DENIED", 403); }
}
export async function createDirectory(input: unknown) {
  const value = z.object({ parent: directoryPath, name: z.string().trim().min(1).max(255).refine(name => name !== "." && name !== ".." && name !== ".git" && !/[\\/]/.test(name) && !Array.from(name).some(c => c.charCodeAt(0) < 32)) }).strict().parse(input);
  const parent = await resolveDirectory(value.parent);
  const target = join(parent, value.name);
  try { await mkdir(target); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return experimentError("LOCAL_DIRECTORY_EXISTS", 409);
    return experimentError("LOCAL_DIRECTORY_CREATE_FAILED", 422);
  }
  return { path: target };
}

export async function browseLocalFiles(path?:string){
 const current=await resolveDirectory(path||homedir());
 try{const entries=await readdir(current,{withFileTypes:true});return {path:current,parent:dirname(current)===current?null:dirname(current),directories:entries.filter(item=>item.isDirectory()&&item.name!=='.git').map(item=>({name:item.name,path:join(current,item.name)})).sort((a,b)=>a.name.localeCompare(b.name)),files:entries.filter(item=>item.isFile()).map(item=>({name:item.name,path:join(current,item.name)})).sort((a,b)=>a.name.localeCompare(b.name))};}catch{return experimentError('LOCAL_DIRECTORY_ACCESS_DENIED',403);}
}

let nativePickerBusy=false;
async function normalizeLocalFile(path:string){
 let selected=z.string().trim().min(1).max(4096).refine(value=>!/[\x00-\x1f]/.test(value)).parse(path);
 if(process.platform==='linux'&&/^(?:[A-Za-z]:[\\/]|\\\\)/.test(selected)){
  try{selected=(await execute('wslpath',['-u',selected],{encoding:'utf8',timeout:10000})).stdout.trim();}catch{return experimentError('LOCAL_FILE_PATH_CONVERSION_FAILED',422);}
 }
 try{const resolved=await realpath(selected);const info=await stat(resolved);if(!info.isFile()||!info.size)experimentError('LOCAL_FILE_INVALID',400);if(info.size>5*1024**3)experimentError('REQUEST_TOO_LARGE',413);return {path:resolved,name:basename(resolved),size_bytes:info.size};}catch(error){if(error&&typeof error==='object'&&'statusCode' in error)throw error;return experimentError('LOCAL_FILE_NOT_FOUND',404);}
}
export async function chooseLocalFile(input:unknown,signal?:AbortSignal){
 const value=z.object({path:z.string().max(4096).optional(),confirm:z.literal(true)}).strict().parse(input);
 if(value.path)return normalizeLocalFile(value.path);
 if(signal?.aborted)return {cancelled:true};
 if(nativePickerBusy)experimentError('LOCAL_FILE_PICKER_BUSY',409);nativePickerBusy=true;
 try{
  let windows=process.platform==='win32';
  if(process.platform==='linux'){const {release}=await import('node:os');windows=/microsoft/i.test(release())||Boolean(process.env.WSL_DISTRO_NAME);}
  if(windows){
   // Fixed script, no user input interpolation; Base64 avoids terminal code-page damage to Chinese paths.
   const script=String.raw`$ErrorActionPreference = 'Stop';
Set-Location $env:USERPROFILE;
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TrashPickerDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }';
try { if (-not [TrashPickerDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [void][TrashPickerDpi]::SetProcessDPIAware() } } catch { try { [void][TrashPickerDpi]::SetProcessDPIAware() } catch {} };
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Application]::EnableVisualStyles();
$d = New-Object System.Windows.Forms.OpenFileDialog;
$d.Title = '选择数据集文件'; $d.Multiselect = $false; $d.CheckFileExists = $true; $d.AutoUpgradeEnabled = $true;
$d.InitialDirectory = $env:USERPROFILE;
$owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1;
try { $owner.Show(); $owner.Activate(); if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.FileName))) } } finally { $d.Dispose(); $owner.Dispose() }`;
   // A Windows-mounted working directory avoids starting the dialog in a WSL UNC folder.
   let pickerCwd:string|undefined;
   if(process.platform==='linux'){try{if((await stat('/mnt/c/Windows/System32')).isDirectory())pickerCwd='/mnt/c/Windows/System32';}catch{/* Custom mounts still use USERPROFILE inside the fixed script. */}}
   const output=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:pickerCwd,encoding:'utf8',timeout:120000,maxBuffer:65536,windowsHide:true,signal});
   const encoded=output.stdout.trim();if(!encoded)return {cancelled:true};return normalizeLocalFile(Buffer.from(encoded,'base64').toString('utf8'));
  }
  try{const output=await execute('zenity',['--file-selection','--title=选择数据集文件'],{encoding:'utf8',timeout:120000,maxBuffer:65536,signal});const selected=output.stdout.trim();return selected?normalizeLocalFile(selected):{cancelled:true};}
  catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code===1)return {cancelled:true};throw error;}
 }catch(error){if(signal?.aborted)return {cancelled:true};if(error&&typeof error==='object'&&'statusCode' in error)throw error;return experimentError('LOCAL_NATIVE_PICKER_UNAVAILABLE',422);}
 finally{nativePickerBusy=false;}
}
