import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles, Square, ChevronDown } from "lucide-react";
import { api, uiError } from "./api.js";

type Progress = { total: number; completed: number; failed: number; active: number };
type Analysis = { analysis_id: string; stage: string; active: boolean; source_count: number; skipped_count: number; cards: Progress; groups: Progress; wiki: Progress; error?: string; covered_sources?:string[];missing_sources?:string[];reused_sources?:string[];topic_count?:number;candidate_count?:number;can_resume?:boolean;incremental?:boolean };
const stages: Record<string, string> = { "cards-only":"逐篇更新知识", discovery:"从文献发现主题",cards: "逐篇整理卡片与线索", groups: "分组归纳文献知识", wiki: "形成项目主题 Wiki", completed: "分析完成，内容已可用", partial: "部分完成，请查看失败任务", failed: "分析失败", cancelled: "已停止，生成内容保留", interrupted: "服务重启，流程已中断" };
export function LiteratureAnalysisButton({ projectId, sourceCount, blocked, onChanged }: { projectId: string; sourceCount: number; blocked: boolean; onChanged: () => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode,setMode]=useState('all');
  const [menuOpen,setMenuOpen]=useState(false);
  const menu=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const close=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))setMenuOpen(false);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menuOpen){setMenuOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[menuOpen]);
  const options=[{id:'all',label:'补齐更新并综合',description:'补齐缺失、更新变化的论文，再从文献发现主题，再生成研究记忆与总览。'},{id:'missing',label:'补齐缺失分析',description:'仅处理缺少卡片的论文，不做跨论文综合。'},{id:'changed',label:'更新已有分析',description:'更新需要重新分析的论文，来源未变则复用。'},{id:'synthesis',label:'综合已有卡片',description:'从已有关键卡片发现主题，形成研究记忆与总览，不重新读取 PDF。'},{id:'overview',label:'更新项目总览',description:'仅根据已有主题 Wiki 更新项目总览。'}];
  const selected=options.find(option=>option.id===mode)!;
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
  const submit = async (cancel = false,resume=false) => {
    if (busy) return; setBusy(true); setError("");
    try { const data = await api<{ analysis: Analysis }>(base + (cancel ? "/cancel" : resume?"/resume":""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true,mode }) }); setAnalysis(data.analysis);setMenuOpen(false); }
    catch (cause) { setError(uiError(cause, "无法启动 Agent 分析，请检查本机 Codex 配置。")); }
    finally { setBusy(false); }
  };
  const completed=(analysis?.cards.completed??0)+(analysis?.groups.completed??0)+(analysis?.wiki.completed??0);
  const total=(analysis?.cards.total??0)+(analysis?.groups.total??0)+(analysis?.wiki.total??0);
  const progress=<div className="library-batch-progress" role="status"><div><strong>{analysis?(stages[analysis.stage]??analysis.stage):''}</strong>{analysis?.active&&<LoaderCircle size={14} className="spin"/>}<a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>查看任务</a></div>{analysis?.active&&<progress aria-label="当前阶段任务完成数" max={Math.max(total,1)} value={completed}/>}{analysis?.topic_count!==undefined&&<small>主题与假设 {analysis.topic_count} 项 · 候选线索 {analysis.candidate_count??0} 项</small>}{analysis?.incremental&&<small>单篇增量整合 · 已保存卡片不会因整合失败而撤销</small>}<span>卡片 {analysis?.cards.completed}/{analysis?.cards.total} · Wiki {analysis?.wiki.completed}/{analysis?.wiki.total}{analysis?.groups.total?` · 分组 ${analysis.groups.completed}/${analysis.groups.total}`:''}{analysis?.cards.failed?` · 卡片失败 ${analysis.cards.failed}`:''}{analysis?.wiki.failed?` · Wiki 失败 ${analysis.wiki.failed}`:''}</span>{analysis?.covered_sources&&<small>已覆盖 {analysis.covered_sources.length} 篇 · 缺失 {analysis.missing_sources?.length??0} 篇 · 复用 {analysis.reused_sources?.length??0} 篇</small>}{Boolean(analysis?.skipped_count)&&<small>跳过 {analysis?.skipped_count} 篇：缺少可分析材料。</small>}{analysis?.error&&<p>{analysis.error}</p>}{!analysis?.active&&analysis?.can_resume&&<button type="button" className="secondary-button" disabled={busy||blocked} onClick={()=>void submit(false,true)}>继续整合</button>}{analysis?.active&&<button type="button" className="text-button" disabled={busy} onClick={()=>void submit(true)}><Square size={12}/>停止批量任务</button>}</div>;
  return <div className="library-batch">
    <div className="library-batch-anchor" ref={menu} data-literature-menu>
      <button type="button" className="secondary-button" ref={trigger} aria-expanded={menuOpen} aria-controls="literature-batch-panel" onClick={()=>setMenuOpen(open=>!open)}>{analysis?.active?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}批量操作<ChevronDown size={12}/></button>
      {menuOpen&&<div className="library-popover library-batch-panel" id="literature-batch-panel"><strong>批量整理文献</strong><div className="library-batch-options">{options.map(option=><button type="button" key={option.id} aria-pressed={mode===option.id} disabled={busy||analysis?.active} onClick={()=>setMode(option.id)}><span className="library-option-dot"/>{option.label}</button>)}</div><p>{selected.description}</p><button type="button" className="primary-button" disabled={busy||blocked||!sourceCount||analysis?.active} onClick={()=>void submit()}>{busy?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}执行：{selected.label}</button>{analysis?.active&&<small>批量任务正在运行，可在下方查看进度或停止。</small>}</div>}
    </div>
    {analysis?.active?progress:analysis&&<details className="library-last-run"><summary>最近一次批量任务 · {stages[analysis.stage]??analysis.stage}</summary>{progress}</details>}
    {error&&<ErrorNotice className="library-batch-error">{error}</ErrorNotice>}
  </div>;
}
