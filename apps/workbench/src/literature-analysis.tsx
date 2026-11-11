import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles, Square } from "lucide-react";
import { api, uiError } from "./api.js";

type Progress = { total: number; completed: number; failed: number; active: number };
type Analysis = { analysis_id: string; stage: string; active: boolean; source_count: number; skipped_count: number; cards: Progress; groups: Progress; wiki: Progress; error?: string; covered_sources?:string[];missing_sources?:string[];reused_sources?:string[] };
const stages: Record<string, string> = { "cards-only":"逐篇更新知识", cards: "逐篇生成文献卡片", groups: "分组归纳文献知识", wiki: "形成项目主题 Wiki", completed: "分析完成，内容待审核", partial: "部分完成，请查看失败任务", failed: "分析失败", cancelled: "已停止，生成内容保留", interrupted: "服务重启，流程已中断" };
export function LiteratureAnalysisButton({ projectId, sourceCount, blocked, onChanged }: { projectId: string; sourceCount: number; blocked: boolean; onChanged: () => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode,setMode]=useState('all');
  const notified = useRef(""); const changed = useRef(onChanged); changed.current = onChanged;
  const base = `/projects/${encodeURIComponent(projectId)}/literature-analysis`;
  useEffect(() => {
    let alive = true, loading = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const data = await api<{ analysis: Analysis | null }>(base);
        if (alive) {
          setAnalysis(data.analysis);
          const key = data.analysis ? `${data.analysis.analysis_id}:${data.analysis.stage}` : "";
          if (data.analysis && !data.analysis.active && notified.current !== key) { notified.current = key; changed.current(); }
        }
      } catch (cause) { if (alive) setError(uiError(cause, "无法读取 Agent 分析进度。")); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId]);
  const submit = async (cancel = false) => {
    if (busy) return; setBusy(true); setError("");
    try { const data = await api<{ analysis: Analysis }>(base + (cancel ? "/cancel" : ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true,mode }) }); setAnalysis(data.analysis); }
    catch (cause) { setError(uiError(cause, "无法启动 Agent 分析，请检查本机 Codex 配置。")); }
    finally { setBusy(false); }
  };
  return <div className="literature-analysis">
    <div className="literature-analysis-heading"><select aria-label="文献知识操作" value={mode} disabled={busy||analysis?.active} onChange={e=>setMode(e.target.value)}><option value="all">补齐更新并分层综合</option><option value="missing">仅补齐缺失分析</option><option value="changed">仅更新已有分析</option><option value="synthesis">仅综合已有新卡片</option><option value="overview">仅更新项目总览</option></select><button type="button" className="secondary-button" disabled={busy || blocked || !sourceCount || analysis?.active} onClick={() => void submit()}>{busy || analysis?.active ? <LoaderCircle size={15} className="spin"/> : <Sparkles size={15}/>} {analysis?.active ? "Agent 正在分析…" : "分析全部文献"}</button><span>补齐或更新单篇 → 按文字预算分层综合 → 主题与项目总览，使用本机 Codex，生成内容待审。</span>{analysis?.active && <button type="button" className="text-button" disabled={busy} onClick={() => void submit(true)}><Square size={12}/>停止分析</button>}</div>
    {analysis && <div className="literature-analysis-progress" role="status"><strong>{stages[analysis.stage] ?? analysis.stage}</strong><span>卡片 {analysis.cards.completed}/{analysis.cards.total}{analysis.cards.failed > 0 ? `，失败或取消 ${analysis.cards.failed}` : ""} · Wiki {analysis.wiki.completed}/{analysis.wiki.total}{analysis.wiki.failed > 0 ? `，失败或取消 ${analysis.wiki.failed}` : ""}{analysis.groups.total > 0 ? ` · 分组汇总 ${analysis.groups.completed}/${analysis.groups.total}` : ""}</span>{analysis.covered_sources&&<span>覆盖 {analysis.covered_sources.length} 篇 · 缺失 {analysis.missing_sources?.length??0} 篇 · 复用 {analysis.reused_sources?.length??0} 篇</span>}{analysis.skipped_count > 0 && <span>跳过 {analysis.skipped_count} 篇：没有可分析的正文或摘要。</span>}{analysis.error && <span>{analysis.error}</span>}<span><a href={`/projects/${encodeURIComponent(projectId)}/cards`}>查看卡片</a> · <a href={`/projects/${encodeURIComponent(projectId)}/wiki`}>查看 Wiki</a> · <a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>查看任务与日志</a></span></div>}
    {error && <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
  </div>;
}
