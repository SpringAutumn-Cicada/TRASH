import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ClientChannel } from "ssh2";
import type { SshProfile } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { SshService, type RemoteConnection } from "./ssh.js";

interface Output { seq: number; data: string; size: number }
interface Session {
  id: string; token: string; project: string; profile: SshProfile; remote: RemoteConnection; channel: ClientChannel;
  output: Output[]; size: number; seq: number; viewers: Set<ServerResponse>; lastSeen: number; attached: boolean;
}
export class TerminalService {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
  private openingProfiles = new Set<string>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private ssh: SshService) {
    this.timer = setInterval(() => { for (const session of this.sessions.values()) if (!session.viewers.size && Date.now() - session.lastSeen > (session.attached ? 60000 : 30000)) this.disconnect(session); }, 10000); this.timer.unref();
  }
  hasProject(project: string) { return this.opening.has(project) || [...this.sessions.values()].some(session => session.project === project); }
  hasProfile(profile: string) { return this.openingProfiles.has(profile) || [...this.sessions.values()].some(session => session.profile.profile_id === profile); }
  async connect(project: string, profile: SshProfile) {
    if (this.closed) experimentError("SERVER_STOPPING", 409);
    if (this.opening.has(project)) experimentError("TERMINAL_CONNECTING", 409);
    if (this.sessions.size + this.opening.size >= 20 || [...this.sessions.values()].filter(s => s.project === project).length >= 3) experimentError("TERMINAL_LIMIT", 409);
    this.opening.add(project); this.openingProfiles.add(profile.profile_id); let remote: RemoteConnection | undefined;
    try {
      remote = await this.ssh.connect(profile);
      if (this.closed) experimentError("SERVER_STOPPING", 409);
      const connection = remote;
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, stream?: ClientChannel) => { if (settled) { stream?.close(); return; } settled = true; clearTimeout(timeout); connection.client.off("close", onClose); if (error) reject(error); else resolve(stream!); };
        const onClose = () => finish(new Error("SSH_TERMINAL_FAILED"));
        const timeout = setTimeout(() => { finish(new Error("SSH_TERMINAL_FAILED")); connection.client.destroy(); }, 15000);
        connection.client.once("close", onClose);
        connection.client.shell({ term: "xterm-256color", cols: 100, rows: 30, width: 0, height: 0 }, (error, stream) => finish(error ? new Error("SSH_TERMINAL_FAILED") : undefined, stream));
      });
      const session: Session = { id: randomUUID(), token: randomUUID(), project, profile, remote, channel, output: [], size: 0, seq: 0, viewers: new Set(), lastSeen: Date.now(), attached: false };
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
      remote.client.once("close", () => this.disconnect(session, "SSH 连接已断开。"));
      if (this.closed) { this.disconnect(session); experimentError("SERVER_STOPPING", 409); }
      return { id: session.id, token: session.token, profile_id: profile.profile_id, name: profile.name, host: profile.host, port: profile.port, username: profile.username };
    } catch (error) { remote?.close(); if (error instanceof Error && error.message === "SSH_TERMINAL_FAILED") experimentError("SSH_TERMINAL_FAILED", 422); throw error; }
    finally { this.opening.delete(project); this.openingProfiles.delete(profile.profile_id); }
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
    session.viewers.clear(); try { session.channel.close(); } catch { /* Already closed. */ } try { session.remote.close(); } catch { /* Already closed. */ }
  }
  close() { this.closed = true; clearInterval(this.timer); for (const session of this.sessions.values()) this.disconnect(session); }
}
