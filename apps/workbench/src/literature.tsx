import {LibraryDeleteManager} from './library-delete-manager.js';
import {AbstractLibrary} from './abstract-library.js';
import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import "./literature-ui.css";
import "./literature-visual.css";
import { LiteratureDocumentDialog } from "./literature-document-dialog.js";
import { ModalLayer } from "./modal-layer.js";
import { LiteratureAnalysisButton } from "./literature-analysis.js";
import { ExternalLink, FileUp, Link, LoaderCircle, Plus, Search, Sparkles, X, ChevronDown, BookOpen, CircleCheck } from "lucide-react";
import type { LiteratureSearchResult, ResearchProject, Source, SourceLocator } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { SourceManager } from "./knowledge.js";
import { projectPath, useUnsavedChanges } from "./navigation.js";
interface SourceAnalysisState {wiki_task?:{task_id:string;status:string;error?:string};source_id:string;status?:string;error?:string;hasOutputs:boolean;hasBasic?:boolean;metadataPending?:boolean;hasCards?:boolean;hasWiki?:boolean;stale?:boolean;task_id?:string;can_resume?:boolean;hasKey?:boolean;hasDetail?:boolean}
interface ProjectDetail { project: ResearchProject; sources: Source[] }
interface OpenAlexResponse { provider_id: string; results: LiteratureSearchResult[] }
interface PassageResponse { source: Source; locator: SourceLocator; text: string; rank: number }
function locatorLabel(locator: SourceLocator): string {
  if (locator.kind === "pdf_page") return `PDF 第 ${locator.page_number} 页`;
  if (locator.kind === "abstract") return "摘要";
  return `${locator.heading ? `${locator.heading} · ` : ""}第 ${locator.paragraph_index} 段`;
}

function sourceTypeLabel(sourceType: Source["source_type"]): string {
  const labels: Record<Source["source_type"], string> = {
    pdf: "PDF",
    bibtex: "BibTeX",
    ris: "RIS",
    markdown: "Markdown",
    webpage: "网页",
    openalex: "OpenAlex"
  };
  return labels[sourceType];
}

export function LiteraturePage({projectId, action, focusId, onChanged, searchOnly=false, onOpenSource}: {projectId:string;action?:string;focusId?:string;onChanged:()=>void;searchOnly?:boolean;onOpenSource?:(source:Source)=>void}) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [searchScope,setSearchScope]=useState<'project'|'external'>('project');
  const [projectSearched,setProjectSearched]=useState(false),[externalSearched,setExternalSearched]=useState(false);
  const [fileDragging,setFileDragging]=useState(false);
  const dragDepth=useRef(0),uploadLock=useRef(false);
  const [libraryScope,setLibraryScope]=useState<'fulltext'|'abstract'>('fulltext');
  const [libraryQuery,setLibraryQuery]=useState("");
  const [importOpen,setImportOpen]=useState(false);
  const [regenerateTarget,setRegenerateTarget]=useState<Source>();
  const [regenerateError,setRegenerateError]=useState("");
  const [documentTarget,setDocumentTarget]=useState<{source:Source;type:string}>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [passages, setPassages] = useState<PassageResponse[]>([]);
  const [searching, setSearching] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [providerResults, setProviderResults] = useState<LiteratureSearchResult[]>([]);
  const [selectedResults, setSelectedResults] = useState<Set<string>>(new Set());
  const [providerSearching, setProviderSearching] = useState(false);
  const [selectedSource, setSelectedSource] = useState<{ source: Source; segments: Array<{ locator: SourceLocator; text: string }> }>();
  const [importing, setImporting] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [deleting, setDeleting] = useState<string>();

  const [analyses,setAnalyses]=useState<SourceAnalysisState[]>([]);
  const [submitting,setSubmitting]=useState<string[]>([]);
  const [wikiSubmitting,setWikiSubmitting]=useState<string>();
  const wikiLock=useRef(false);
  const [wikiNotice,setWikiNotice]=useState<{sourceId:string;taskId:string}>();
  const analyzeWiki=async(source:Source)=>{
    if(wikiLock.current||analyses.some(item=>item.source_id===source.source_id&&['queued','running'].includes(item.wiki_task?.status??'')))return;wikiLock.current=true;setWikiSubmitting(source.source_id);setError('');
    try{const result=await api<{task_id:string;status:string}>(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/analyze-wiki`,{method:'POST',body:JSON.stringify({confirm:true})});setAnalyses(previous=>previous.map(item=>item.source_id===source.source_id?{...item,wiki_task:{task_id:result.task_id,status:result.status}}:item));setWikiNotice({sourceId:source.source_id,taskId:result.task_id});}
    catch(cause){setError(uiError(cause,'无法单独更新 Wiki，请确认已有关键、详细卡片及 Wiki，且没有进行中的分析。'));}
    finally{wikiLock.current=false;setWikiSubmitting(undefined);}
  };
  const submissionLock=useRef(new Set<string>());
  const completedAnalysis=useRef('');
  useEffect(()=>{
    let active=true,loadingStatus=false;
    type KnowledgeSummary={source_id?:string;kind:string;card_type?:string;stale?:boolean};
    const load=async()=>{
      if(loadingStatus)return;loadingStatus=true;
      try{
        const base=`/projects/${encodeURIComponent(projectId)}`;
        const [result,first]=await Promise.all([api<SourceAnalysisState[]>(`${base}/source-analyses`),api<{documents:KnowledgeSummary[];total:number}>(`${base}/markdown-knowledge?limit=100&page=1`)]);
        const documents=[...first.documents];
        for(let page=2;documents.length<first.total;page++){const next=await api<{documents:KnowledgeSummary[]}>(`${base}/markdown-knowledge?limit=100&page=${page}`);if(!next.documents.length)break;documents.push(...next.documents);}
        const completion=result.filter(item=>item.status==='completed').map(item=>item.task_id).sort().join(',');
        if(active&&completion!==completedAnalysis.current){completedAnalysis.current=completion;const updated=await api<ProjectDetail>(`${base}`);if(active)setDetail(updated);}
        if(active)setAnalyses(result.map(item=>{const docs=documents.filter(d=>d.source_id===item.source_id);return {...item,hasKey:docs.some(d=>d.card_type==='key'),hasDetail:docs.some(d=>d.card_type==='detail'),hasCards:['detail','key'].every(type=>docs.some(d=>d.card_type===type)),hasWiki:docs.some(d=>d.kind==='wiki-page'),stale:docs.some(d=>d.stale)};}));
      }catch(cause){if(active)setError(uiError(cause,'无法读取单篇分析状态。'));}
      finally{loadingStatus=false;}
    };
    void load();const timer=setInterval(()=>void load(),4000);return()=>{active=false;clearInterval(timer);};
  },[projectId]);
  const analyzeSource=async(source:Source,confirmed=false)=>{
    if(submissionLock.current.has(source.source_id))return;
    const previous=analyses.find(item=>item.source_id===source.source_id);
    const resume=!confirmed&&['failed','interrupted','cancelled'].includes(previous?.status??'');
    if(!confirmed&&!resume&&previous?.hasOutputs){setRegenerateError('');setRegenerateTarget(source);return false;}
    submissionLock.current.add(source.source_id);setSubmitting([...submissionLock.current]);setError('');setRegenerateError('');
    try{const task=await api<{task_id:string;status:string}>(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/analyze`,{method:'POST',body:JSON.stringify({confirm:true,regenerate:Boolean(previous?.hasOutputs),resume})});if(alive.current)setAnalyses(items=>[...items.filter(item=>item.source_id!==source.source_id),{...previous,source_id:source.source_id,hasOutputs:previous?.hasOutputs??false,...task}]);return true;}
    catch(cause){if(alive.current){const message=uiError(cause,'无法启动这篇论文的分析，请稍后重试。');if(confirmed)setRegenerateError(message);else setError(message);}return false;}
    finally{submissionLock.current.delete(source.source_id);if(alive.current)setSubmitting([...submissionLock.current]);}
  };

  const alive = useRef(true);
  const sourceRequest = useRef(0);
  useEffect(()=>{const close=(event:PointerEvent)=>{const target=event.target as Element;if(!target.closest('.library-import'))setImportOpen(false);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){const trigger=document.activeElement?.closest('.library-import')?.querySelector<HTMLButtonElement>('button[aria-expanded]');setImportOpen(false);trigger?.focus();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useUnsavedChanges(Boolean(urlValue.trim()) || importing);
  useEffect(() => {
    if (action === "import") {setImportOpen(true);}
    if (action === "import") document.querySelector<HTMLInputElement>('[aria-label="导入文献文件"]')?.focus();
  }, [action, loading]);
  useEffect(() => {
    if (!focusId) return;
    const source = detail?.sources.find(item => item.source_id === focusId);
    if (source) void openSource(source);
  }, [focusId, detail?.sources]);
  const refresh = async (quiet=false) => {
    if(!quiet)setLoading(true);
    try { const result = await api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`); if (alive.current) { setDetail(result); setError(""); } }
    catch (cause) { setError(uiError(cause, "无法打开项目，请重试。")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [projectId]);

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !detail || uploadLock.current || importing) return;
    const selectedFiles=Array.from(files);
    if(selectedFiles.some(file=>! /\.(pdf|bib|bibtex|ris|md|markdown)$/i.test(file.name))){setError('请选择 PDF、BibTeX、RIS 或 Markdown 文件；文件夹请展开后再拖入。');return;}
    uploadLock.current=true;
    setImporting(true); setError("");
    try {
      for (const file of selectedFiles) {
        await api(`/projects/${encodeURIComponent(projectId)}/sources/files?filename=${encodeURIComponent(file.name)}`, {
          method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file
        });
      }
      await refresh(); onChanged();
    } catch (cause) { setError(uiError(cause, "导入失败，请检查文件后重试。")); }
    finally { uploadLock.current=false;setImporting(false); }
  };

  const importUrl = async (event: React.FormEvent) => {
    event.preventDefault(); setImporting(true); setError("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/sources/url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: urlValue }) });
      setUrlValue(""); await refresh(); onChanged();
    } catch (cause) { setError(uiError(cause, "网页导入失败，请检查地址后重试。")); }
    finally { setImporting(false); }
  };

  const runSearch = async (event: React.FormEvent) => {
    setProjectSearched(false);
    event.preventDefault(); setSearching(true);
    try { setPassages((await api<{ passages: PassageResponse[] }>(`/projects/${encodeURIComponent(projectId)}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).passages);setProjectSearched(true); }
    catch (cause) { setError(uiError(cause, "检索失败，请重试。")); }
    finally { setSearching(false); }
  };

  const runProviderSearch = async (event: React.FormEvent) => {
    event.preventDefault();setExternalSearched(false); setProviderSearching(true); setSelectedResults(new Set());
    try { setProviderResults((await api<OpenAlexResponse>(`/literature/openalex/search?q=${encodeURIComponent(providerQuery)}`)).results);setExternalSearched(true);setSelectedResults(new Set()); }
    catch (cause) { setError(uiError(cause, "文献搜索失败，请重试。")); }
    finally { setProviderSearching(false); }
  };

  const importSearchResults = async () => {
    const results = providerResults.filter((item) => selectedResults.has(item.provider_ref));
    if (!results.length) return;
    setImporting(true);
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/sources/import-search-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ results }) });
      setProviderResults([]); setSelectedResults(new Set()); await refresh(); onChanged();
    } catch (cause) { setError(uiError(cause, "无法导入所选文献，请重试。")); }
    finally { setImporting(false); }
  };

  const openSource = async (source: Source) => {
    const requestId = ++sourceRequest.current;
    try { const result = await api<NonNullable<typeof selectedSource>>(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}`); if (alive.current && requestId === sourceRequest.current) setSelectedSource(result); }
    catch (cause) { setError(uiError(cause, "无法打开文献来源，请重试。")); }
  };

  const onSourceDeleted=(id:string)=>{
    sourceRequest.current++;
    setSelectedSource(current=>current?.source.source_id===id?undefined:current);
    setPassages(current=>current.filter(item=>item.source.source_id!==id));
    setDetail(current=>current?{...current,sources:current.sources.filter(item=>item.source_id!==id)}:current);
    setAnalyses(current=>current.filter(item=>item.source_id!==id));
    setWikiNotice(current=>current?.sourceId===id?undefined:current);
    setDocumentTarget(current=>current?.source.source_id===id?undefined:current);
    onChanged();
  };

  const toggleResult = (ref: string) => setSelectedResults((previous) => {
    const next = new Set(previous);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    return next;
  });

  if (loading) return <div className="loading-screen"><LoaderCircle className="spin" />正在打开项目</div>;
  const keepOriginal=async(source:Source,item:SourceAnalysisState)=>{
    if(!item.task_id||submissionLock.current.has(source.source_id))return;
    submissionLock.current.add(source.source_id);setSubmitting(previous=>[...previous,source.source_id]);
    try{await api(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/keep-original`,{method:'POST',body:JSON.stringify({confirm:true,task_id:item.task_id})});setAnalyses(previous=>previous.map(entry=>entry.source_id===source.source_id?{...entry,status:'completed',error:undefined,task_id:undefined,can_resume:false}:entry));}
    catch(cause){setError(uiError(cause,'无法退出重新分析，请刷新任务状态。'));}
    finally{submissionLock.current.delete(source.source_id);setSubmitting(previous=>previous.filter(id=>id!==source.source_id));}
  };
  if (!detail) return <ErrorNotice >{error || "未找到该项目。"}</ErrorNotice>;
  return <section className={`literature-page ${fileDragging?'literature-file-dragging':''}`} onDragEnter={event=>{if(searchOnly||libraryScope==='abstract'||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth.current++;setFileDragging(true);}} onDragOver={event=>{if(searchOnly||libraryScope==='abstract'||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect=importing?'none':'copy';}} onDragLeave={event=>{if(searchOnly)return;event.preventDefault();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setFileDragging(false);}} onDrop={event=>{if(searchOnly||libraryScope==='abstract'||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.stopPropagation();dragDepth.current=0;setFileDragging(false);if(importing||uploadLock.current)return;void uploadFiles(event.dataTransfer.files);}}>
    {fileDragging&&!searchOnly&&<div className="literature-drop-overlay" role="status"><FileUp size={30}/><strong>{importing?'正在导入，请稍候':'松开以导入文献'}</strong><span>PDF · BibTeX · RIS · Markdown · 支持多个文件</span></div>}
    {regenerateTarget&&<RegenerateSourceDialog source={regenerateTarget} busy={submitting.includes(regenerateTarget.source_id)} error={regenerateError} onClose={()=>{if(!submissionLock.current.has(regenerateTarget.source_id))setRegenerateTarget(undefined);}} onConfirm={()=>{void analyzeSource(regenerateTarget,true).then(ok=>{if(ok&&alive.current)setRegenerateTarget(undefined);});}}/>}
    {documentTarget&&<LiteratureDocumentDialog key={documentTarget.source.source_id} projectId={projectId} source={documentTarget.source} initialType={documentTarget.type} onClose={()=>setDocumentTarget(undefined)} onSaved={()=>{void refresh(true);onChanged();}}/>}
    {wikiNotice&&(()=>{const task=analyses.find(item=>item.source_id===wikiNotice.sourceId)?.wiki_task;const status=task?.task_id===wikiNotice.taskId?task.status:'queued';return <div className="wiki-task-notice" role="status"><span>{status==='completed'?'Wiki 分析已完成。':status==='failed'?'Wiki 分析失败，可重试。':status==='interrupted'||status==='cancelled'?'Wiki 分析已停止，可重新提交。':status==='running'?'Wiki 正在分析，完成前无法重复提交。':'Wiki 分析已提交，正在排队，完成前无法重复提交。'}</span><a href={projectPath(projectId,'tasks',{focus:wikiNotice.taskId})}>查看任务</a></div>;})()}
    {error && <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
        <div className="literature-grid literature-module-content">
          <section className="literature-main" hidden={searchOnly}>
            <div className="abstract-library-tabs" role="group" aria-label="文献材料范围"><button type="button" aria-pressed={libraryScope==='fulltext'} onClick={()=>setLibraryScope('fulltext')}>全文库</button><button type="button" aria-pressed={libraryScope==='abstract'} onClick={()=>setLibraryScope('abstract')}>摘要库</button></div>
            {libraryScope==='abstract'?<AbstractLibrary projectId={projectId}/>:<>
            <header className="library-heading"><div><h2>文献库 <span>{detail.sources.length}</span></h2><p>阅读原文，整理每一篇论文的研究知识。</p></div></header>
            <div className="library-toolbar">
              <label className="library-filter"><Search size={16}/><input aria-label="筛选已导入文献" value={libraryQuery} onChange={event=>setLibraryQuery(event.target.value)} placeholder="搜索已导入的标题、作者…"/>{libraryQuery&&<button type="button" aria-label="清空文献筛选" onClick={()=>setLibraryQuery('')}><X size={14}/></button>}</label>
              <div className="library-toolbar-actions"><div className="library-import" data-literature-menu>
                <button type="button" className="primary-button" aria-expanded={importOpen} aria-controls="literature-import-panel" onClick={()=>{setImportOpen(v=>!v);}}><Plus size={15}/>导入文献<ChevronDown size={12}/></button>
                {importOpen&&<div id="literature-import-panel" className="library-popover library-import-panel"><strong>添加到文献库</strong><label className="library-file-picker"><FileUp size={17}/><span>{importing?'正在导入…':'选择本地文件'}<small>PDF、BibTeX、RIS、Markdown，也可拖入页面</small></span><input aria-label="导入文献文件" type="file" multiple accept=".pdf,.bib,.bibtex,.ris,.md,.markdown" disabled={importing} onChange={event=>{void uploadFiles(event.target.files);event.currentTarget.value='';}}/></label><form className="url-import" onSubmit={event=>void importUrl(event)}><label htmlFor="library-url">或导入公开网页</label><div><Link size={14}/><input id="library-url" type="url" required value={urlValue} onChange={event=>setUrlValue(event.target.value)} placeholder="https://…"/><button type="submit" aria-label="添加网页" title="添加网页" disabled={importing}>{importing?<LoaderCircle size={15} className="spin"/>:<Plus size={15}/>}</button></div></form></div>}
              </div><LibraryDeleteManager projectId={projectId} sources={detail.sources} disabled={importing||searching} blockedIds={[...submitting,...analyses.filter(item=>['queued','running'].includes(item.status??'')||['queued','running'].includes(item.wiki_task?.status??'')).map(item=>item.source_id),...(wikiSubmitting?[wikiSubmitting]:[])]} onBusyChange={busy=>setDeleting(busy?'batch':undefined)} onDeleted={onSourceDeleted}/></div>
              <LiteratureAnalysisButton projectId={projectId} sourceCount={detail.sources.length} blocked={importing||Boolean(deleting)} onChanged={onChanged}/>
            </div>
            {detail.sources.length===0?<div className="library-empty"><BookOpen size={28}/><strong>从第一篇论文开始</strong><p>导入 PDF，阅读原文并生成卡片与 Wiki。</p><button type="button" className="secondary-button" onClick={()=>setImportOpen(true)}>导入文献</button></div>:<div className="library-table">
              <div className="library-table-heading"><span>标题 / 作者</span><span>内容</span><span>状态 / 操作</span></div>
              {detail.sources.filter(source=>(source.title+' '+source.authors.join(' ')+' '+(source.doi??'')).toLowerCase().includes(libraryQuery.trim().toLowerCase())).map(source=>{
                const item=analyses.find(entry=>entry.source_id===source.source_id);
                const wikiPending=['queued','running'].includes(item?.wiki_task?.status??'');
                const activeTaskId=wikiPending?item?.wiki_task?.task_id:item?.task_id;
                const fullPending=submitting.includes(source.source_id)||['queued','running'].includes(item?.status??'');
                const pending=fullPending||wikiSubmitting===source.source_id||wikiPending;
                const status=pending?((wikiPending?item?.wiki_task?.status:item?.status)==='running'?'分析中':'排队中'):item?.status==='failed'?'分析失败':item?.stale?'待更新':item?.hasCards&&item?.hasWiki?'已整理':item?.hasOutputs?'部分整理':item?.status==='cancelled'?'已停止':item?.status==='interrupted'?'已中断':'未分析';
                const tone=pending?'active':item?.status==='failed'?'failed':item?.stale?'warning':item?.hasCards&&item?.hasWiki?'done':'idle';
                const retry=['failed','interrupted','cancelled'].includes(item?.status??'');
                const label=submitting.includes(source.source_id)?'正在提交':pending?'查看进度':retry?(item?.can_resume?'继续分析':'重试分析'):item?.hasOutputs?'重新分析':'开始分析';
                const date=String(source.publication_date??source.year??'').replace('-','');
                return <article className={`library-row ${pending?'library-row-active':''}`} key={source.source_id}>
                  <button type="button" className="library-paper" onClick={()=>{if(source.source_type==='pdf')window.open(`/api/v1/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/pdf-view`,'_blank','noopener,noreferrer');else void openSource(source);}} title={source.title}>
                    <span className={`file-type type-${source.source_type}`}>{source.source_type==='pdf'?'PDF':source.source_type==='openalex'?'OA':source.source_type.slice(0,2).toUpperCase()}</span><span><strong>{source.title}</strong><small className="library-bibliography" title={[date,source.authors.join(', ')].filter(Boolean).join(' · ')}>{date&&<><time>{date}</time><span aria-hidden="true">·</span></>}<span>{source.authors.join(', ')||'作者信息未提供'}</span></small></span>
                  </button>
                  <div className="library-document-modules" aria-label="论文内容">
                    {[['basic','基础信息',item?.hasBasic],['key','关键卡片',item?.hasKey],['detail','详细卡片',item?.hasDetail],['wiki','Wiki',item?.hasWiki]].map(([type,name,available])=><button type="button" key={String(type)} className={type==='wiki'?'wiki-entry-button':undefined} disabled={!available} title={available?String(name):'分析生成后可查看'} onClick={()=>setDocumentTarget({source,type:String(type)})}>{name}</button>)}
                  </div>
                  <div className="library-row-controls">
                    <div className="library-state">{item?.hasCards&&item?.hasWiki&&<button type="button" className="library-wiki-analyze" disabled={pending||Boolean(wikiSubmitting)||Boolean(deleting)} onClick={()=>void analyzeWiki(source)} title="仅更新 Wiki，复用已有卡片">{wikiPending||wikiSubmitting===source.source_id?<LoaderCircle size={13} className="spin"/>:<Sparkles size={13}/>}{wikiSubmitting===source.source_id?'提交中…':wikiPending?(item?.wiki_task?.status==='running'?'分析中':'排队中'):'分析 Wiki'}</button>}<span className={`library-status ${tone}`}>{tone==='done'?<CircleCheck size={13} strokeWidth={2.2} aria-hidden="true"/>:<i aria-hidden="true"/>}{status}</span></div>
                    <div className="library-row-actions">{item?.hasCards&&item?.hasBasic&&item?.hasWiki&&!wikiPending&&wikiSubmitting!==source.source_id&&(retry||fullPending)&&item.task_id&&<button type="button" className="library-keep-original" disabled={submitting.includes(source.source_id)} onClick={()=>void keepOriginal(source,item)} title="退出本次重新分析，保留当前已整理内容">保留原版</button>}<div className="library-analysis-action"><button type="button" className={`library-analyze ${submitting.includes(source.source_id)?'library-analyze-submitting':pending?'library-analyze-progress':retry?'library-analyze-retry':''}`} disabled={Boolean(deleting)||submitting.includes(source.source_id)} onClick={()=>{if(pending&&activeTaskId)window.location.assign(projectPath(projectId,'tasks',{focus:activeTaskId}));else void analyzeSource(source);}}>{pending?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}<span>{label}</span></button>{item?.error&&!pending&&<details className="library-error"><summary>查看原因</summary><p>{item.error}</p></details>}</div></div>
                  </div>
                </article>;
              })}
              {detail.sources.length>0&&!detail.sources.some(source=>(source.title+' '+source.authors.join(' ')+' '+(source.doi??'')).toLowerCase().includes(libraryQuery.trim().toLowerCase()))&&<div className="library-empty library-no-results"><Search size={23}/><strong>没有找到匹配的文献</strong><button type="button" className="text-button" onClick={()=>setLibraryQuery('')}>清空筛选</button></div>}
            </div>}
            {selectedSource && <section className="source-detail"><div className="source-detail-heading"><div><div className="eyebrow">来源详情</div><h3>{selectedSource.source.title}</h3><p>{selectedSource.source.source_url ?? selectedSource.source.doi ?? sourceTypeLabel(selectedSource.source.source_type)}</p></div><button className="icon-button" aria-label="关闭来源详情" title="关闭来源详情" onClick={() => { sourceRequest.current++;setSelectedSource(undefined); }}><X size={16}/></button></div>
              <SourceManager key={selectedSource.source.source_id} projectId={projectId} source={selectedSource.source} onSaved={() => { void refresh(); onChanged(); void openSource(selectedSource.source); }} />
              {selectedSource.source.abstract && <p className="source-abstract">{selectedSource.source.abstract}</p>}
              {selectedSource.segments.length ? <details><summary>查看解析文字（搜索索引，非原文排版）</summary><div className="segment-list">{selectedSource.segments.map((segment, index) => <article key={`${segment.locator.kind}-${index}`}><span>{locatorLabel(segment.locator)}</span><p>{segment.text}</p></article>)}</div></details> : <div className="metadata-note">{selectedSource.source.parse_status === "no_text" ? "未能从该来源提取文本。" : "该记录仅包含元数据。"}</div>}
            </section>}
            </>}
          </section>
          <aside className="literature-tools literature-discovery" hidden={!searchOnly}>
            <header className="library-heading"><h2>搜索文献</h2><p>查找项目资料，或发现新的研究来源。</p></header>
            <div className="discovery-scope" role="group" aria-label="搜索范围"><button type="button" aria-pressed={searchScope==='project'} onClick={()=>setSearchScope('project')}>项目资料</button><button type="button" aria-pressed={searchScope==='external'} onClick={()=>setSearchScope('external')}>外部文献</button></div>
            {searchScope==='project'?<section className="discovery-content"><form className="discovery-search" onSubmit={event=>void runSearch(event)}><Search size={17}/><input aria-label="搜索项目资料" value={query} onChange={event=>{setQuery(event.target.value);setProjectSearched(false);}} minLength={2} placeholder="搜索已导入论文的摘要或正文…"/><button type="submit" className="primary-button" disabled={searching||query.trim().length<2}>{searching?<LoaderCircle size={14} className="spin"/>:<Search size={14}/>}搜索</button></form><p className="discovery-note">搜索范围为已导入资料，结果保留原文位置。</p>
            {projectSearched&&passages.length>0?<div className="discovery-results"><div className="discovery-results-heading">{passages.length} 条匹配段落</div>{passages.map((passage,index)=><article key={`${passage.source.source_id}-${index}`}><header><button type="button" onClick={()=>onOpenSource?onOpenSource(passage.source):void openSource(passage.source)}>{passage.source.title}</button><span>{locatorLabel(passage.locator)}</span></header><p>{passage.text}</p><button type="button" className="text-button" onClick={()=>onOpenSource?onOpenSource(passage.source):void openSource(passage.source)}>查看来源<ExternalLink size={12}/></button></article>)}</div>:<div className="library-empty"><Search size={27}/><strong>{projectSearched?'未找到匹配段落':'从一个研究问题开始'}</strong><p>{projectSearched?'换个关键词再试，只有元数据的论文可能没有可检索正文。':'输入关键词，查找论文中的论点、方法与实验。'}</p></div>}</section>:<section className="discovery-content"><form className="discovery-search" onSubmit={event=>void runProviderSearch(event)}><Search size={17}/><input aria-label="搜索外部文献" value={providerQuery} onChange={event=>{setProviderQuery(event.target.value);setExternalSearched(false);}} minLength={2} placeholder="输入论文标题、作者或关键词…"/><button type="submit" className="primary-button" disabled={providerSearching||providerQuery.trim().length<2}>{providerSearching?<LoaderCircle size={14} className="spin"/>:<Search size={14}/>}搜索</button></form><div className="discovery-provider"><span>文献来源：OpenAlex</span><a href={`https://scholar.google.com/scholar?q=${encodeURIComponent(providerQuery)}`} target="_blank" rel="noreferrer">在 Google Scholar 中搜索<ExternalLink size={12}/></a></div>
            {externalSearched&&providerResults.length>0?<div className="discovery-results"><div className="discovery-results-heading"><span>{providerResults.length} 条结果</span><button type="button" className="secondary-button" disabled={!selectedResults.size||importing} onClick={()=>void importSearchResults()}><Plus size={13}/>{importing?'正在导入…':`导入所选（${selectedResults.size}）`}</button></div>{providerResults.map(result=><label className="discovery-result" key={result.provider_ref}><input type="checkbox" checked={selectedResults.has(result.provider_ref)} onChange={()=>toggleResult(result.provider_ref)}/><span><strong>{result.title}</strong><small>{result.authors.slice(0,3).join(', ')||'作者信息缺失'}{result.year?` · ${result.year}`:''}</small></span></label>)}</div>:<div className="library-empty"><BookOpen size={27}/><strong>{externalSearched?'未找到匹配文献':'发现新的研究来源'}</strong><p>{externalSearched?'尝试调整标题、作者或关键词。':'检索公开学术文献，勾选结果加入文献库。'}</p></div>}</section>}
          </aside>
        </div>
  </section>;
}

function RegenerateSourceDialog({source,busy,error,onClose,onConfirm}:{source:Source;busy:boolean;error:string;onClose:()=>void;onConfirm:()=>void}){
  const modal=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    modal.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[]);
  return <ModalLayer><div className="modal-backdrop literature-regenerate-backdrop" onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <div ref={modal} tabIndex={-1} className="modal literature-regenerate-dialog" role="dialog" aria-modal="true" aria-labelledby="literature-regenerate-title" aria-describedby="literature-regenerate-description" aria-busy={busy} onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
      if(event.key==='Tab'){
        const buttons=Array.from(modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
        const first=buttons[0],last=buttons.at(-1);
        if(!first){event.preventDefault();return;}
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===modal.current)){event.preventDefault();first.focus();}
      }
    }}>
      <header><span className="literature-regenerate-icon"><Sparkles size={22}/></span><button type="button" className="icon-button" aria-label="关闭重新分析确认" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <h2 id="literature-regenerate-title">重新分析这篇论文？</h2>
      <p id="literature-regenerate-description">将根据论文原文重新生成以下内容，已有版本会保留在历史记录中。</p>
      <div className="literature-regenerate-paper"><span>当前论文</span><strong>{source.title}</strong></div>
      <div className="literature-regenerate-outputs"><span>基础信息</span><span>关键卡片</span><span>详细卡片</span><span>Wiki</span></div>
      {error&&<ErrorNotice>{error}</ErrorNotice>}
      <footer><button type="button" data-cancel className="secondary-button" disabled={busy} onClick={onClose}>暂不生成</button><button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>{busy?<LoaderCircle size={15} className="spin"/>:<Sparkles size={15}/>}<span>{busy?'正在提交':'重新生成'}</span></button></footer>
    </div>
  </div></ModalLayer>;
}
