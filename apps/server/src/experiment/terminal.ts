import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientChannel } from "ssh2";
import type { SshProfile } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { SshService, type RemoteConnection } from "./ssh.js";

interface Output { seq: number; data: string; size: number }
interface Session {
  id: string; token: string; project: string; profile: SshProfile; remote: RemoteConnection; channel: ClientChannel;
  output: Output[]; size: number; seq: number; viewers: Set<ServerResponse>; lastSeen: number; attached: boolean; onRemoteClose: () => void;
}
export class TerminalService {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
  private openingProfiles = new Set<string>();
  private closed = false;
  constructor(private ssh: SshService) {}
  list(project: string) {
    return [...this.sessions.values()].filter(session => session.project === project).map(session => ({
      id: session.id, token: session.token, profile_id: session.profile.profile_id, name: session.profile.name,
      host: session.profile.host, port: session.profile.port, username: session.profile.username,
    }));
  }
  hasProject(project: string) { return this.opening.has(project) || [...this.sessions.values()].some(session => session.project === project); }
  hasProfile(profile: string) { return this.openingProfiles.has(profile) || [...this.sessions.values()].some(session => session.profile.profile_id === profile); }
  async split(project: string, id: string, token: string) {
    const source = this.get(project, id, token);
    return this.connect(project, source.profile, source);
  }
  async connect(project: string, profile: SshProfile, source?: Session) {
    if (this.closed) experimentError("SERVER_STOPPING", 409);
    if (this.opening.has(project)) experimentError("TERMINAL_CONNECTING", 409);
    if (this.sessions.size + this.opening.size >= 20 || [...this.sessions.values()].filter(s => s.project === project).length >= 3) experimentError("TERMINAL_LIMIT", 409);
    this.opening.add(project); this.openingProfiles.add(profile.profile_id); let remote: RemoteConnection | undefined;
    try {
      remote = source ? source.remote : await this.ssh.connect(profile);
      if (source && !this.sessions.has(source.id)) experimentError("TERMINAL_NOT_FOUND", 404);
      if (this.closed) experimentError("SERVER_STOPPING", 409);
      const connection = remote;
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, stream?: ClientChannel) => { if (settled) { stream?.close(); return; } settled = true; clearTimeout(timeout); connection.client.off("close", onClose); if (error) reject(error); else resolve(stream!); };
        const onClose = () => finish(new Error("SSH_TERMINAL_FAILED"));
        const timeout = setTimeout(() => { finish(new Error("SSH_TERMINAL_FAILED")); }, 15000);
        connection.client.once("close", onClose);
        connection.client.shell({ term: "xterm-256color", cols: 100, rows: 30, width: 0, height: 0 }, (error, stream) => finish(error ? new Error("SSH_TERMINAL_FAILED") : undefined, stream));
      });
      const session: Session = { id: randomUUID(), token: randomUUID(), project, profile, remote, channel, output: [], size: 0, seq: 0, viewers: new Set(), lastSeen: Date.now(), attached: false, onRemoteClose: () => {} };
      session.onRemoteClose = () => this.disconnect(session, "SSH 连接已断开。");
      this.sessions.set(session.id, session);
      const output = (data: Buffer) => {
        if (!this.sessions.has(session.id)) return;
        const item = { seq: ++session.seq, data: data.toString("base64"), size: data.length };
        session.output.push(item); session.size += item.size;
        while (session.size > 1024 * 1024 && session.output.length) session.size -= session.output.shift()!.size;
        for (const viewer of session.viewers) this.send(session, viewer, { type: "output", seq: item.seq, data: item.data });
      };
      channel.on("data", output); channel.stderr.on("data", output);
      channel.on("error", () => this.disconnect(session, "终端通道发生错误。"));
      channel.on("close", () => this.disconnect(session, "远端终端已退出。"));
      remote.client.once("close", session.onRemoteClose);
      if (this.closed) { this.disconnect(session); experimentError("SERVER_STOPPING", 409); }
      return { id: session.id, token: session.token, profile_id: profile.profile_id, name: profile.name, host: profile.host, port: profile.port, username: profile.username };
    } catch (error) { if (!source) remote?.close(); if (error instanceof Error && error.message === "SSH_TERMINAL_FAILED") experimentError("SSH_TERMINAL_FAILED", 422); throw error; }
    finally { this.opening.delete(project); this.openingProfiles.delete(profile.profile_id); }
  }
  async upload(project: string, id: string, token: string, request: IncomingMessage, directory: string, name: string) {
    const session = this.get(project, id, token);
    const limit = 200 * 1024 * 1024;
    if (!directory.startsWith("/") || directory.includes("\0") || directory.split("/").includes("..") || !name || name === "." || name === ".." || /[/\\\0]/.test(name)) experimentError("UPLOAD_PATH_INVALID", 400);
    if (Number(request.headers["content-length"] ?? 0) > limit) experimentError("REQUEST_TOO_LARGE", 413);
    const sftp = await session.remote.sftp();
    let created = false;
    let destination = "";
    try {
      const root = await new Promise<string>((resolve, reject) => sftp.realpath(directory, (error, path) => error ? reject(error) : resolve(path)));
      destination = posix.join(root, name);
      const target = sftp.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      target.once("open", () => { created = true; });
      let bytes = 0;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) callback(Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 }));
        else callback(null, chunk);
      } });
      await pipeline(request, counter, target);
      return { path: destination, size_bytes: bytes };
    } catch (error) {
      if (created) await new Promise<void>(resolve => sftp.unlink(destination, () => resolve()));
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") throw error;
      experimentError("SSH_UPLOAD_FAILED", 422);
    } finally { sftp.end(); }
  }
  private get(project: string, id: string, token: string) {
    const session = this.sessions.get(id);
    if (!session || session.project !== project || !token || session.token !== token) experimentError("TERMINAL_NOT_FOUND", 404);
    return session;
  }
  private send(session: Session, response: ServerResponse, value: unknown) {
    if (response.destroyed || response.writableEnded || response.writableLength > 512 * 1024) { response.destroy(); session.viewers.delete(response); return; }
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  }
  attach(project: string, id: string, token: string, response: ServerResponse, after: number) {
    const session = this.get(project, id, token);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" }); response.flushHeaders();
    if (session.output[0] && after < session.output[0].seq - 1) this.send(session, response, { type: "notice", message: "部分旧输出已超过缓存上限，以下为保留内容。" });
    for (const output of session.output) if (output.seq > after) this.send(session, response, { type: "output", seq: output.seq, data: output.data });
    session.viewers.add(response); session.attached = true; session.lastSeen = Date.now();
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": keepalive\n\n"); }, 15000); heartbeat.unref();
    response.on("close", () => { clearInterval(heartbeat); session.viewers.delete(response); session.lastSeen = Date.now(); });
  }
  input(project: string, id: string, token: string, text: string) {
    const session = this.get(project, id, token); session.lastSeen = Date.now();
    if (session.channel.writableLength > 256 * 1024) experimentError("TERMINAL_INPUT_BUSY", 409);
    session.channel.write(text);
  }
  resize(project: string, id: string, token: string, cols: number, rows: number) { const session = this.get(project, id, token); session.channel.setWindow(rows, cols, 0, 0); }
  remove(project: string, id: string, token: string) { this.disconnect(this.get(project, id, token)); }
  private disconnect(session: Session, message = "终端已断开。") {
    if (!this.sessions.delete(session.id)) return;
    for (const viewer of session.viewers) { this.send(session, viewer, { type: "closed", message }); viewer.end(); }
    session.viewers.clear(); session.remote.client.off("close", session.onRemoteClose);
    try { session.channel.close(); } catch { /* Already closed. */ }
    if (![...this.sessions.values()].some(other => other.remote === session.remote)) {
      try { session.remote.close(); } catch { /* Already closed. */ }
    }
  }
  close() { this.closed = true; for (const session of this.sessions.values()) this.disconnect(session); }
}
