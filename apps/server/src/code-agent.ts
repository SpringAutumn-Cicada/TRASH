import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { TrashStore } from "@trash/storage";
import { experimentError } from "@trash/storage";
import type { ExperimentService } from "./experiment/service.js";
import { redact } from "./experiment/ssh.js";

const execute = promisify(execFile);
const inputSchema = z.object({
  instructions: z.string().trim().min(1).max(30000), model: z.string().trim().max(200).default(""),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  timeout_seconds: z.number().int().min(30).max(7200).default(1800), confirm: z.literal(true)
}).strict();
type Input = z.infer<typeof inputSchema>;
export interface CodeTask {
  task_id: string; project_id: string; path: string; instructions: string; model: string; sandbox: Input["sandbox"];
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
  created_at: string; finished_at?: string; version?: string; exit_code?: number | null; error?: string;
  logs: string; response: string; before?: string; after?: string; truncated?: boolean;
}
export class CodeAgent {
  private active = new Map<string, { task: CodeTask; child?: ChildProcess; stop?: string }>();
  private closed = false;
  private command = process.env.TRASH_CODEX_COMMAND || "codex";
  constructor(private store: TrashStore, private experiments: ExperimentService) {
    for (const project of store.listProjects()) for (const task of this.list(project.project_id)) {
      if (task.status === "running" || task.status === "cancelling") { task.status = "interrupted"; task.error = "服务重启，旧任务状态未确认，请检查仓库与本机进程后再启动。"; this.save(task); }
    }
  }
  private directory(project: string) { return join(this.store.root, "projects", project, "code-agent"); }
  private save(task: CodeTask) {
    const directory = this.directory(task.project_id); mkdirSync(directory, { recursive: true });
    const path = join(directory, `${task.task_id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(task), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  }
  list(project: string): CodeTask[] {
    let names: string[];
    try { names = readdirSync(this.directory(project)); } catch { return []; }
    return names.filter(name => /^code_[a-f0-9-]+\.json$/.test(name)).flatMap(name => {
      try { return [JSON.parse(readFileSync(join(this.directory(project), name), "utf8")) as CodeTask]; } catch { return []; }
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  busy(project: string): boolean {
    const path = this.experiments.data.repository(project)?.path;
    return [...this.active.values()].some(item => item.task.project_id === project || item.task.path === path) || this.store.listProjects().some(p => this.list(p.project_id).some(task => task.status === "interrupted" && (task.project_id === project || task.path === path)));
  }
  async detect() {
    try { const result = await execute(this.command, ["--version"], { timeout: 10000, maxBuffer: 65536 }); return { available: true, version: redact(result.stdout.trim()), platform: process.platform, wsl: process.env.WSL_DISTRO_NAME ?? null }; }
    catch { return { available: false, error: "未找到可调用的 Codex CLI，请确认运行 TRASH 的 WSL 终端能执行 codex。", platform: process.platform, wsl: process.env.WSL_DISTRO_NAME ?? null }; }
  }
  async start(project: string, value: unknown): Promise<CodeTask> {
    const input = inputSchema.parse(value);
    if (this.closed) experimentError("SERVER_STOPPING", 409);
    const repo = this.experiments.repository.bound(project);
    const path = await realpath(repo.path);
    if (this.busy(project) || [...this.active.values()].some(item => item.task.path === path)) experimentError("CODE_AGENT_BUSY", 409);
    if (this.experiments.data.runs().some(run => this.experiments.data.active(run) && run.plan.repository.path === path)) experimentError("EXPERIMENT_ACTIVE", 409);
    if (this.list(project).some(task => task.status === "interrupted")) experimentError("CODE_AGENT_RECOVERY_REQUIRED", 409);
    const task: CodeTask = { task_id: `code_${randomUUID()}`, project_id: project, path, instructions: input.instructions, model: input.model, sandbox: input.sandbox, status: "running", created_at: new Date().toISOString(), logs: "", response: "" };
    this.save(task); this.active.set(task.task_id, { task });
    void this.run(task, input).catch(() => { /* run records errors and releases ownership. */ });
    return task;
  }
  acknowledge(project: string, id: string) {
    const task = this.list(project).find(item => item.task_id === id) ?? experimentError("NOT_FOUND", 404);
    if (task.status !== "interrupted") experimentError("CODE_AGENT_NOT_INTERRUPTED", 409);
    task.status = "failed"; task.error = "用户已确认旧进程停止并检查仓库，可重新提交任务。"; this.save(task);
  }
  cancel(project: string, id: string) {
    const item = this.active.get(id);
    if (!item || item.task.project_id !== project) experimentError("NOT_FOUND", 404);
    item.stop = "cancelled"; item.task.status = "cancelling"; this.save(item.task); if (item.child) this.terminate(item.child);
  }
  private terminate(child: ChildProcess) {
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already stopped. */ } };
    kill("SIGTERM"); const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) kill("SIGKILL"); }, 3000); timer.unref();
  }
  close() { this.closed = true; for (const item of this.active.values()) { item.stop = "interrupted"; item.task.status = "interrupted"; this.save(item.task); if (item.child) this.terminate(item.child); } }
  private async run(task: CodeTask, input: Input) {
    const item = this.active.get(task.task_id)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      task.version = (await execute(this.command, ["--version"], { timeout: 10000, maxBuffer: 65536 })).stdout.trim();
      const status = async () => { try { return (await execute("git", ["-C", task.path, "status", "--short"], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout; } catch { return "Git 状态读取失败"; } };
      task.before = await status(); this.save(task);
      if (item.stop || this.closed) return;
      const args = ["exec", "--sandbox", task.sandbox, "-c", 'approval_policy="never"', "--ephemeral", "--json", "--color", "never", "-C", task.path, ...(task.model ? ["--model", task.model] : []), "-"];
      const child = spawn(this.command, args, { cwd: task.path, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }); item.child = child;
      let pending = ""; let reportedFailure = "";
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      const append = (value: string) => {
        if (task.logs.length >= 1024 * 1024) { task.truncated = true; return; }
        task.logs += redact(value).slice(0, 1024 * 1024 - task.logs.length); this.save(task);
      };
      child.stdout?.on("data", (text: string) => {
        append(text); pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try { const event = JSON.parse(line); if (event.type === "turn.failed") reportedFailure = redact(String(event.error?.message ?? "Codex 任务失败")); if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") { task.response = redact(event.item.text).slice(0, 1024 * 1024); this.save(task); } } catch { /* Preserve unknown events in bounded logs. */ }
        }
        if (pending.length > 1024 * 1024) pending = "";
      });
      child.stderr?.on("data", (text: string) => append(text));
      const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      timer = setTimeout(() => { item.stop = "timeout"; this.terminate(child); }, input.timeout_seconds * 1000);
      child.stdin?.on("error", () => {});
      child.stdin?.end(`你是 TRASH 项目的本机开发 Agent。工作目录是用户选择的仓库。先阅读适用的 AGENTS.md，保留已有改动。遵守：未经本次任务明确要求，不运行 lint、类型检查、测试、构建或浏览器验证；不修改全局配置、不推送、不合并、不自动发起 SSH 实验。除非任务明确要求，不暂存或提交代码。完成后说明修改、验证状态和遗留问题。用户任务：\n${input.instructions}`);
      task.exit_code = await completion; task.after = await status();
      task.status = item.stop === "cancelled" ? "cancelled" : item.stop === "interrupted" ? "interrupted" : task.exit_code === 0 && !item.stop && !reportedFailure ? "completed" : "failed";
      if (item.stop === "timeout") task.error = "任务超时，已停止进程；请检查保留的文件改动。";
      else if (task.status === "failed") task.error = reportedFailure || `Codex 退出码 ${task.exit_code}，请查看日志。`;
    } catch (error) { task.status = item.stop === "cancelled" ? "cancelled" : item.stop === "interrupted" ? "interrupted" : "failed"; task.error = redact(error instanceof Error ? error.message : "启动失败"); }
    finally { if (timer) clearTimeout(timer); if (task.status === "cancelling" || (item.stop === "cancelled" && task.status === "running")) task.status = "cancelled"; if (item.stop === "interrupted") task.status = "interrupted"; task.finished_at = new Date().toISOString(); this.save(task); this.active.delete(task.task_id); }
  }
}
