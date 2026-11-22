import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, Stats } from "ssh2";
import { experimentError } from "@trash/storage";
import type { UploadProgress } from "./experiment-code-upload.js";
import type { RemoteConnection } from "./ssh.js";
import { ensureRemoteDirectory } from "./workspace.js";
import { remoteDirectoryExists } from "./workspace-migration.js";

const sizeLimit = 200 * 1024 * 1024;
const activeDestinations = new Set<string>();

export function privateUploadPath(path: string) {
  return path.split("/").some(part =>
    [".git", ".trash", ".ssh", ".codex", ".trash-snapshot.json", "auth.json", "credentials", "id_rsa", "id_ed25519"].includes(part.toLowerCase()) ||
    /^\.env(?:\.|$)/i.test(part) && part !== ".env.example" ||
    /\.(?:pem|key|p12|pfx)$/i.test(part) ||
    part.startsWith(".trash-upload-")
  );
}

export function autoDLUploadPath(root: string, path: string) {
  const relative = path.startsWith("/") ? posix.relative(root, path) : path;
  if (!relative || privateUploadPath(relative) || path.replace(/^\//, "").split("/").some(part =>
    !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part) || Buffer.byteLength(part) > 255
  ) || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative))
    experimentError("AUTODL_UPLOAD_PATH_INVALID", 400);
  return posix.join(root, relative);
}

async function localSnapshot(source: string, destination: string, signal: AbortSignal) {
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (process.platform === "linux" && await realpath("/proc/self/fd/" + file.fd) !== source)
      experimentError("AUTODL_UPLOAD_SOURCE_INVALID", 403);
    const before = await file.stat();
    if (!before.isFile()) experimentError("AUTODL_UPLOAD_SOURCE_INVALID", 422);
    if (before.size > sizeLimit) experimentError("REQUEST_TOO_LARGE", 413);
    const hash = createHash("sha256");
    let size = 0;
    const checksum = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > sizeLimit) { callback(Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 })); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(file.createReadStream({ autoClose: false }), checksum, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
    const after = await file.stat();
    if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      experimentError("AUTODL_UPLOAD_SOURCE_CHANGED", 409);
    return { sha256: hash.digest("hex"), size, mode: before.mode & 0o111 ? 0o700 : 0o600 };
  } finally { await file.close(); }
}

function lstat(sftp: SFTPWrapper, path: string) {
  return new Promise<Stats | undefined>((resolve, reject) => sftp.lstat(path, (error, info) => {
    if (!error) resolve(info);
    else if (Number((error as Error & { code?: number }).code) === 2) resolve(undefined);
    else reject(error);
  }));
}

async function remoteHash(remote: RemoteConnection, path: string) {
  const output = await remote.exec(["sha256sum", "-z", "--", path], undefined, 120000, 16384);
  return /^([a-f0-9]{64}) [ *]/.exec(output)?.[1];
}

export async function uploadAutoDLFile(remote: RemoteConnection, root: string, host: string, source: string,
  destination: string, report: UploadProgress, signal: AbortSignal, checkWorkspace: () => void, expectedHash?: string) {
  const path = autoDLUploadPath(root, destination);
  const key = host + "\0" + path;
  if (activeDestinations.has(key)) experimentError("AUTODL_UPLOAD_TARGET_BUSY", 409);
  activeDestinations.add(key);
  const stopped = () => { if (signal.aborted) experimentError("UPLOAD_CANCELLED", 409); };
  let directory: string | undefined;
  let sftp: SFTPWrapper | undefined;
  let temporary: string | undefined;
  try {
    stopped();
    report("preparing");
    directory = await mkdtemp(join(tmpdir(), "trash-autodl-upload-"));
    const file = join(directory, "file");
    const { sha256, size, mode } = await localSnapshot(source, file, signal);
    if(expectedHash&&expectedHash!==sha256)experimentError("CHAT_DECISION_FILE_CHANGED",409);
    stopped();checkWorkspace();
    if (!await remoteDirectoryExists(remote, root)) experimentError("WORKSPACE_REQUIRED", 409);
    const parent = posix.dirname(path);
    await ensureRemoteDirectory(remote, parent);
    sftp = await remote.sftp();
    const channel = sftp;
    const verifiedExisting = async () => {
      const info = await lstat(channel, path);
      if (!info) return false;
      if (!info.isFile() || info.isSymbolicLink() || info.size !== size || await remoteHash(remote, path) !== sha256)
        experimentError("AUTODL_UPLOAD_TARGET_EXISTS", 409);
      return true;
    };
    const result = { path, sha256, size_bytes: size, verified: true };
    report("checking", 0, size);
    if (await verifiedExisting()) {
      stopped();checkWorkspace();
      return { ...result, reused: true };
    }
    stopped();
    const staging = posix.join(parent, ".trash-upload-" + randomUUID() + ".part");
    const handle = await new Promise<Buffer>((resolve, reject) => channel.open(staging, "wx", { mode }, (error, value) => error ? reject(error) : resolve(value)));
    temporary = staging;
    await new Promise<void>((resolve, reject) => channel.close(handle, error => error ? reject(error) : resolve()));
    report("uploading", 0, size);
    if (size) await remote.upload(file, staging, sent => report("uploading", sent, size), signal);
    stopped();checkWorkspace();
    report("verifying", size, size);
    if (await remoteHash(remote, staging) !== sha256) experimentError("AUTODL_UPLOAD_HASH_MISMATCH", 409);
    stopped();checkWorkspace();
    report("saving", size, size);
    try {
      await remote.exec(["ln", "-T", "--", staging, path]);
    } catch {
      if (await verifiedExisting()) return { ...result, reused: true };
      experimentError("AUTODL_UPLOAD_PUBLISH_FAILED", 422);
    }
    return { ...result, reused: false };
  } catch (error) {
    stopped();
    if (error instanceof Error && "statusCode" in error) throw error;
    experimentError("AUTODL_UPLOAD_FAILED", 422);
  } finally {
    try {
      if (temporary && sftp) {
        const channel = sftp;
        await new Promise<void>(resolve => channel.unlink(temporary!, () => resolve()));
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      sftp?.end();
      activeDestinations.delete(key);
    }
  }
}
