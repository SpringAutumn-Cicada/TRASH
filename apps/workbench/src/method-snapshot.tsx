import { useState } from "react";
import type { ExperimentPlanVersion } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { ChatMarkdown } from "./chat-markdown.js";

export function MethodSnapshot({plan}:{plan:ExperimentPlanVersion}) {
  const [content,setContent] = useState<string>();
  const [error,setError] = useState("");
  const [loading,setLoading] = useState(false);
  const hash = plan.method_sha256;
  if (plan.reproduction || !plan.content.scheme_id || plan.status === "draft") return null;
  if (!hash) return <p className="quiet">此计划未记录方法快照。</p>;

  async function load() {
    if (content !== undefined || loading) return;
    setLoading(true); setError("");
    try {
      const document = await api<{content:string}>(`/projects/${encodeURIComponent(plan.project_id)}/experiment-method-snapshots/${hash}`);
      setContent(document.content);
    } catch (cause) { setError(uiError(cause,"读取方法快照失败。")); }
    finally { setLoading(false); }
  }

  return <details className="experiment-card" onToggle={event=>{if(event.currentTarget.open) void load();}}>
    <summary>运行计划的方法快照 · {hash.slice(0,12)}</summary>
    <p>计划 v{plan.version} · Git <code>{plan.content.commit_sha}</code></p>
    {loading && <p role="status">正在读取快照…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>void load()}>重试</button></p>}
    {content !== undefined && <ChatMarkdown text={content}/>}
  </details>;
}
