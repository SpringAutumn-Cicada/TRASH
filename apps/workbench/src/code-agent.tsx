import React, { useEffect, useState } from "react";
import { Bot, Play, RefreshCw, Square } from "lucide-react";
import { useUnsavedChanges } from "./navigation.js";

type Task = {
  task_id: string; status: string; instructions: string; path: string; model: string; sandbox: string;
  created_at: string; version?: string; error?: string; response: string; logs: string; before?: string; after?: string; truncated?: boolean;
};
const statusNames: Record<string, string> = { running: "运行中", cancelling: "正在取消", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断，需核对旧进程" };
const errors: Record<string, string> = { CODE_AGENT_BUSY: "该仓库有 Agent 正在执行，请等待或先取消。", CODE_AGENT_RECOVERY_REQUIRED: "旧任务已中断，请核对旧进程并确认停止后再启动。", EXPERIMENT_ACTIVE: "该仓库有未结束实验，请先处理实验状态。", SERVER_STOPPING: "服务正在停止。", INVALID_REQUEST: "请检查任务、时限及授权选项。", NOT_FOUND: "任务不存在或已结束。" };
export function CodeAgentPanel({ projectId, repositoryPath }: { projectId: string; repositoryPath: string }) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/code-agent`;
  const [instructions, setInstructions] = useState(""), [model, setModel] = useState(""), [sandbox, setSandbox] = useState("workspace-write"), [timeout, setTimeoutValue] = useState(30), [confirmed, setConfirmed] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]), [selectedId, setSelectedId] = useState(""), [selected, setSelected] = useState<Task>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [detection, setDetection] = useState("");
  useUnsavedChanges(Boolean(instructions));
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw new Error(errors[value.error] ?? "Agent 操作失败，请查看任务日志或检查本机配置。"); return value as T;
  };
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const data = await call<{ tasks: Task[] }>("/tasks");
        if (alive) { setTasks(data.tasks); if (!selectedId && data.tasks[0]) setSelectedId(data.tasks[0].task_id); }
        if (selectedId) { const detail = await call<{ task: Task }>(`/tasks/${selectedId}`); if (alive) setSelected(detail.task); }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "读取任务失败。"); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId, selectedId]);
  const act = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败。"); } finally { setBusy(false); } };
  const active = tasks.some(task => ["running", "cancelling"].includes(task.status));
  return <section className="experiment-card code-agent-panel">
    <div className="section-heading"><div><h3><Bot size={17}/>本机 Codex Agent</h3><p>在绑定仓库中读取代码、修改文件和执行命令，使用运行 TRASH 的 WSL / 本机 Codex 配置。</p></div><button type="button" className="secondary-button" disabled={busy} onClick={() => void act(async () => { const value = await call<{ available: boolean; version?: string; wsl?: string; error?: string }>("/detect"); setDetection(value.available ? `${value.version} · ${value.wsl || "本机环境"}` : value.error || "CLI 不可用"); })}><RefreshCw size={14}/>检测 CLI</button></div>
    {detection && <p role="status">{detection}</p>}
    <form onSubmit={event => { event.preventDefault(); void act(async () => {
      const value = await call<{ task: Task }>("/tasks", { instructions, model, sandbox, timeout_seconds: timeout * 60, confirm: confirmed });
      setSelectedId(value.task.task_id); setSelected(value.task); setTasks(old => [value.task, ...old]); setInstructions(""); setConfirmed(false);
    }); }}>
      <label>交给 Agent 的任务<textarea required value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={30000} placeholder="例如：阅读仓库结构，实现训练入口，并说明修改了哪些文件。本次不运行测试。" disabled={busy}/></label>
      <div className="code-agent-settings"><label>模型（留空沿用本机配置）<input value={model} maxLength={200} onChange={event => setModel(event.target.value)}/></label><label>执行权限<select value={sandbox} onChange={event => { setSandbox(event.target.value); setConfirmed(false); }}><option value="read-only">只读分析</option><option value="workspace-write">项目目录读写</option><option value="danger-full-access">完整本机权限</option></select></label><label>最长运行时间（分钟）<input type="number" min={1} max={120} required value={timeout} onChange={event => setTimeoutValue(Number(event.target.value))}/></label></div>
      <p>目标目录：<code>{repositoryPath}</code></p>
      {sandbox === "danger-full-access" && <p className="notice error-notice">完整本机权限可访问仓库外文件、执行系统命令和联网，请核对本次任务范围。</p>}
      <label className="code-agent-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>我确认目标目录和执行权限，授权本次任务。任务会调用本机模型服务，按本机账户计费。</span></label>
      <p>不要在任务里填写密码或密钥。默认不测试、不提交、不推送；需要时请在本次任务中明确要求。超出所选权限的操作会失败，不会自动升级权限。</p>
      <button className="primary-button" disabled={busy || active || !confirmed || !instructions.trim()}><Play size={14}/>启动 Agent</button>
    </form>
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    <div className="code-agent-history">{tasks.map(task => <button type="button" key={task.task_id} className={`experiment-run ${task.task_id === selectedId ? "selected" : ""}`} onClick={() => { setSelectedId(task.task_id); setSelected(undefined); }}><span>{task.instructions.slice(0, 70)}</span><small>{statusNames[task.status] ?? task.status}</small></button>)}</div>
    {selected && <article className="code-agent-output"><p>{statusNames[selected.status]} · {selected.version} · {selected.sandbox}</p><p>实际目录：{selected.path}</p>{selected.error && <p role="alert">{selected.error}</p>}
      {["running", "cancelling"].includes(selected.status) && <button type="button" className="secondary-button" disabled={busy || selected.status === "cancelling"} onClick={() => void act(async () => { await call(`/tasks/${selected.task_id}/cancel`, { confirm: true }); setSelected({ ...selected, status: "cancelling" }); })}><Square size={13}/>取消任务</button>}
      {selected.status === "interrupted" && <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (window.confirm("请先在本机确认旧 Codex 进程已停止，并检查仓库改动。是否已完成核对？")) void act(async () => { await call(`/tasks/${selected.task_id}/acknowledge`, { confirm: true }); setSelected({ ...selected, status: "failed" }); }); }}>已确认旧进程停止，解除中断状态</button>}
      <h4>Agent 回复</h4><pre>{selected.response || "等待 Agent 回复，可在事件日志中查看执行过程。"}</pre><details><summary>执行事件与日志{selected.truncated ? "（已截断）" : ""}</summary><pre>{selected.logs || "暂无日志"}</pre></details><details><summary>运行前后 Git 状态</summary><pre>运行前：{"\n"}{selected.before || "无记录或无改动"}{"\n"}运行后：{"\n"}{selected.after || "无记录或无改动"}</pre></details>
    </article>}
  </section>;
}
