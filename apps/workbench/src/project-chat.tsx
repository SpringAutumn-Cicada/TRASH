import React, { useEffect, useRef, useState } from "react";
import { Bot, MessageSquarePlus, Send, Square } from "lucide-react";
import { useUnsavedChanges } from "./navigation.js";
import "./project-chat.css";

type Turn = { task_id: string; conversation_id: string; session_id?: string; instructions: string; response: string; status: string; sandbox: string; model: string; error?: string; created_at: string; logs: string };
const states: Record<string, string> = { running: "正在处理…", cancelling: "正在停止…", completed: "本轮完成", failed: "本轮失败", cancelled: "已停止", interrupted: "服务中断，请核对旧进程" };
const errors: Record<string, string> = { PROJECT_HAS_ACTIVE_TASKS: "当前项目正在分析文献或处理知识任务，请等待完成或先停止分析。", CODE_AGENT_BUSY: "当前项目或绑定仓库有 Agent 正在执行，请等待或停止后再发送。", CODE_AGENT_RECOVERY_REQUIRED: "请先核对中断任务并确认旧进程停止。", CHAT_SESSION_NOT_FOUND: "未找到可恢复的 Codex 会话，请新建对话。", EXPERIMENT_ACTIVE: "项目有未结束实验，请先处理实验状态。", INVALID_REQUEST: "请检查消息和执行设置。" };
export function ProjectChat({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const [turns, setTurns] = useState<Turn[]>([]), [conversation, setConversation] = useState(""), [draft, setDraft] = useState("");
  const [model, setModel] = useState(""), [sandbox, setSandbox] = useState("workspace-write"), [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [logs, setLogs] = useState<{ id: string; text: string }>();
  const initial = useRef(false), bottom = useRef<HTMLDivElement>(null);
  useUnsavedChanges(Boolean(draft));
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(errors[data.error] ?? "对话操作失败，请检查本机 Codex 配置或查看日志。"); return data as T;
  };
  useEffect(() => {
    let alive = true, loading = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const data = await call<{ tasks: Turn[] }>("/chat/tasks");
        if (!alive) return;
        setTurns(data.tasks);
        if (!initial.current) { initial.current = true; if (data.tasks[0]) { setConversation(data.tasks[0].conversation_id); setSandbox(data.tasks[0].sandbox); setModel(data.tasks[0].model); } }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "无法读取对话。"); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId]);
  const messages = turns.filter(turn => turn.conversation_id === conversation).reverse();
  const active = turns.find(turn => ["running", "cancelling"].includes(turn.status));
  const conversations = [...new Map(turns.map(turn => [turn.conversation_id, turn])).values()];
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [conversation, messages.length, messages[messages.length - 1]?.response]);
  const act = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败。"); } finally { setBusy(false); } };
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft.trim() || !authorized || active) return;
    await act(async () => {
      const data = await call<{ task: Turn }>("/chat/tasks", { instructions: draft, model, sandbox, confirm: true, timeout_seconds: 1800, ...(conversation ? { conversation_id: conversation } : {}) });
      setConversation(data.task.conversation_id); setTurns(old => [data.task, ...old]); setDraft(""); setLogs(undefined);
    });
  };
  return <section className="project-chat">
    <div className="section-heading"><div><h2><Bot size={20}/>Agent 对话</h2><p>围绕当前论文项目连续交流，也可以让 Agent 整理资料、修订 Wiki、记录真实结果和编辑论文草稿。</p></div><button type="button" className="secondary-button" disabled={busy || Boolean(active)} onClick={() => { if (draft && !window.confirm("放弃未发送的消息并新建对话？")) return; initial.current = true; setConversation(""); setDraft(""); setLogs(undefined); setAuthorized(false); }}><MessageSquarePlus size={15}/>新建对话</button></div>
    <div className="chat-layout">
      <aside className="chat-conversations" aria-label="项目对话记录">{conversations.map(turn => <button type="button" key={turn.conversation_id} className={conversation === turn.conversation_id ? "selected" : ""} disabled={busy} onClick={() => { if (draft && !window.confirm("放弃未发送消息并切换对话？")) return; setConversation(turn.conversation_id); setSandbox(turn.sandbox); setModel(turn.model); setDraft(""); setAuthorized(false); setLogs(undefined); }}><strong>{turn.instructions.slice(0, 48)}</strong><small>{new Date(turn.created_at).toLocaleString("zh-CN")}</small></button>)}{!conversations.length && <p>发送消息，开始第一个项目对话。</p>}</aside>
      <div className="chat-main">
        <div className="chat-messages" role="log" aria-label="Agent 对话消息" aria-live="polite">
          {!messages.length && <div className="chat-welcome"><Bot size={30}/><h3>这篇论文，我们从哪里开始？</h3><p>可以让我梳理参考文献的思路、创建研究 Wiki，或把你的研究方案整理成论文草稿。</p><p>文献、卡片、Wiki 和结果通过平台工具读取与保存；写入记录保持待审，不编造实验结果。</p></div>}
          {messages.map(turn => <React.Fragment key={turn.task_id}><article className="chat-message chat-user"><span>你</span><div>{turn.instructions}</div></article><article className="chat-message chat-assistant"><span><Bot size={14}/>Agent · {states[turn.status] ?? turn.status}</span><div>{turn.response || (turn.status === "running" ? "正在读取项目资料或执行操作，可查看执行日志。" : "本轮没有返回文本。")}</div>{turn.error && <p className="chat-error">{turn.error}</p>}<div className="chat-turn-actions"><button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { const data = await call<{ task: Turn }>(`/code-agent/tasks/${turn.task_id}`); setLogs({ id: turn.task_id, text: data.task.logs }); })}>查看执行日志</button>{turn.status === "interrupted" && <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm("请先在本机确认旧 Codex 进程已停止，并检查已产生的项目改动。确认已完成？")) void act(async () => { await call(`/code-agent/tasks/${turn.task_id}/acknowledge`, { confirm: true }); }); }}>确认旧进程已停止</button>}</div>{logs?.id === turn.task_id && <pre className="chat-event-log">{logs.text || "暂无日志"}</pre>}</article></React.Fragment>)}
          <div ref={bottom}/>
        </div>
        {error && <p role="alert" className="notice error-notice">{error}</p>}
        <form className="chat-composer" onSubmit={event => void send(event)}>
          <details><summary>模型与项目操作权限</summary><div className="chat-settings"><label>模型<input value={model} maxLength={200} placeholder="沿用 WSL 本机配置" onChange={event => { setModel(event.target.value); setAuthorized(false); }}/></label><label>执行权限<select value={sandbox} onChange={event => { setSandbox(event.target.value); setAuthorized(false); }}><option value="read-only">只读交流</option><option value="workspace-write">项目资料与代码读写</option><option value="danger-full-access">完整本机权限</option></select></label></div><p>项目读写模式允许访问本机平台工具和网络；完整本机权限还可操作项目外文件。不修改全局配置。</p></details>
          <label className="chat-authorization"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)}/><span>授权此对话按所选权限操作当前项目{sandbox === "danger-full-access" ? "，包括完整本机权限" : ""}。模型调用使用本机账户。</span></label>
          <textarea aria-label="发送给项目 Agent 的消息" required value={draft} maxLength={30000} onChange={event => setDraft(event.target.value)} placeholder="描述你的研究问题，或直接交代需要修改的项目内容…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
          <div className="chat-composer-footer"><small>默认不测试、不推送、不合并。Ctrl / ⌘ + Enter 发送。</small>{active ? <button type="button" className="secondary-button" disabled={busy || active.status === "cancelling"} onClick={() => void act(async () => { await call(`/code-agent/tasks/${active.task_id}/cancel`, { confirm: true }); })}><Square size={14}/>停止生成</button> : <button className="primary-button" disabled={busy || !authorized || !draft.trim()}><Send size={14}/>发送</button>}</div>
        </form>
      </div>
    </div>
  </section>;
}
