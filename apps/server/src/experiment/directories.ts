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
