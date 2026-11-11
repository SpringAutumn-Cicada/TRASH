import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import "./literature-ui.css";
import { ModalLayer } from "./modal-layer.js";
import { LiteratureAnalysisButton } from "./literature-analysis.js";
import { ExternalLink, FileUp, Link, LoaderCircle, Plus, Search, Sparkles, Trash2, X, MoreHorizontal, ChevronDown, BookOpen, Info } from "lucide-react";
import type { LiteratureSearchResult, ResearchProject, Source, SourceLocator } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { SourceManager } from "./knowledge.js";
import { projectPath, useUnsavedChanges } from "./navigation.js";
interface SourceAnalysisState {source_id:string;status?:string;error?:string;hasOutputs:boolean;hasBasic?:boolean;metadataPending?:boolean;hasCards?:boolean;hasWiki?:boolean;stale?:boolean;task_id?:string}
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

function parseStatusLabel(status: Source["parse_status"]): string {
  const labels: Record<Source["parse_status"], string> = {
    indexed: "已索引",
    metadata_only: "仅元数据",
    no_text: "未提取到文本",
    failed: "解析失败"
  };
  return labels[status];
}


export function LiteraturePage({projectId, action, focusId, onChanged, searchOnly=false, onOpenSource}: {projectId:string;action?:string;focusId?:string;onChanged:()=>void;searchOnly?:boolean;onOpenSource?:(source:Source)=>void}) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [searchScope,setSearchScope]=useState<'project'|'external'>('project');
  const [projectSearched,setProjectSearched]=useState(false),[externalSearched,setExternalSearched]=useState(false);
  const [fileDragging,setFileDragging]=useState(false);
  const dragDepth=useRef(0),uploadLock=useRef(false);
  const [libraryQuery,setLibraryQuery]=useState("");
  const [importOpen,setImportOpen]=useState(false);
  const [rowMenu,setRowMenu]=useState<string>();
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
  const [deleteTarget, setDeleteTarget] = useState<Source>();
  const [deleteError, setDeleteError] = useState("");

  const [analyses,setAnalyses]=useState<SourceAnalysisState[]>([]);
  const [submitting,setSubmitting]=useState<string[]>([]);
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
        if(active)setAnalyses(result.map(item=>{const docs=documents.filter(d=>d.source_id===item.source_id);return {...item,hasCards:['detail','key'].every(type=>docs.some(d=>d.card_type===type)),hasWiki:docs.some(d=>d.kind==='wiki-page'),stale:docs.some(d=>d.stale)};}));
      }catch(cause){if(active)setError(uiError(cause,'无法读取单篇分析状态。'));}
      finally{loadingStatus=false;}
    };
    void load();const timer=setInterval(()=>void load(),4000);return()=>{active=false;clearInterval(timer);};
  },[projectId]);
  const analyzeSource=async(source:Source)=>{
    if(submissionLock.current.has(source.source_id))return;
    const previous=analyses.find(item=>item.source_id===source.source_id);
    if(previous?.hasOutputs&&!window.confirm('重新生成这篇论文的基本信息、详细卡片、关键信息卡片和 Wiki 线索？已有版本会保留在历史记录中。'))return;
    submissionLock.current.add(source.source_id);setSubmitting([...submissionLock.current]);setError('');
    try{const task=await api<{task_id:string;status:string}>(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/analyze`,{method:'POST',body:JSON.stringify({confirm:true,regenerate:Boolean(previous?.hasOutputs)})});if(alive.current)setAnalyses(items=>[...items.filter(item=>item.source_id!==source.source_id),{...previous,source_id:source.source_id,hasOutputs:previous?.hasOutputs??false,...task}]);}
    catch(cause){if(alive.current)setError(uiError(cause,'无法启动这篇论文的分析，请稍后重试。'));}
    finally{submissionLock.current.delete(source.source_id);if(alive.current)setSubmitting([...submissionLock.current]);}
  };

  const alive = useRef(true);
  const sourceRequest = useRef(0);
  useEffect(()=>{const close=(event:PointerEvent)=>{const target=event.target as Element;if(!target.closest('.library-import'))setImportOpen(false);if(!target.closest('.library-more'))setRowMenu(undefined);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){const trigger=document.activeElement?.closest('.library-import,.library-more')?.querySelector<HTMLButtonElement>('button[aria-expanded]');setImportOpen(false);setRowMenu(undefined);trigger?.focus();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[]);
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
  const refresh = async () => {
    setLoading(true);
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

  const deleteSource = async (source: Source) => {
    if (deleting) return;
    if (importing || searching) { setDeleteError("正在导入或检索，请等待操作完成后再确认删除。"); return; }
    setDeleting(source.source_id); setDeleteError(""); setError("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      sourceRequest.current++;
      if (alive.current) {
        setSelectedSource(current => current?.source.source_id === source.source_id ? undefined : current);
        setPassages(current => current.filter(item => item.source.source_id !== source.source_id));
        setDetail(current => current ? { ...current, sources: current.sources.filter(item => item.source_id !== source.source_id) } : current);
        setDeleteTarget(undefined); onChanged();
      }
    } catch (cause) { if (alive.current) setDeleteError(uiError(cause, "删除文献失败，请重试。")); }
    finally { if (alive.current) setDeleting(undefined); }
  };

  const toggleResult = (ref: string) => setSelectedResults((previous) => {
    const next = new Set(previous);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    return next;
  });

  if (loading) return <div className="loading-screen"><LoaderCircle className="spin" />正在打开项目</div>;
  if (!detail) return <ErrorNotice >{error || "未找到该项目。"}</ErrorNotice>;
  return <section className={`literature-page ${fileDragging?'literature-file-dragging':''}`} onDragEnter={event=>{if(searchOnly||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth.current++;setFileDragging(true);}} onDragOver={event=>{if(searchOnly||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect=importing?'none':'copy';}} onDragLeave={event=>{if(searchOnly)return;event.preventDefault();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setFileDragging(false);}} onDrop={event=>{if(searchOnly||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.stopPropagation();dragDepth.current=0;setFileDragging(false);if(importing||uploadLock.current)return;void uploadFiles(event.dataTransfer.files);}}>
    {fileDragging&&!searchOnly&&<div className="literature-drop-overlay" role="status"><FileUp size={30}/><strong>{importing?'正在导入，请稍候':'松开以导入文献'}</strong><span>PDF · BibTeX · RIS · Markdown · 支持多个文件</span></div>}
    {deleteTarget && <DeleteSourceDialog source={deleteTarget} busy={Boolean(deleting)} blocked={importing || searching} error={deleteError} onClose={() => { if (!deleting) setDeleteTarget(undefined); }} onConfirm={() => void deleteSource(deleteTarget)}/>}
    {error && <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
        <div className="literature-grid literature-module-content">
          <section className="literature-main" hidden={searchOnly}>
            <header className="library-heading"><div><h2>文献库 <span>{detail.sources.length}</span></h2><p>阅读原文，整理每一篇论文的研究知识。</p></div></header>
            <div className="library-toolbar">
              <label className="library-filter"><Search size={16}/><input aria-label="筛选已导入文献" value={libraryQuery} onChange={event=>setLibraryQuery(event.target.value)} placeholder="搜索已导入的标题、作者…"/>{libraryQuery&&<button type="button" aria-label="清空文献筛选" onClick={()=>setLibraryQuery('')}><X size={14}/></button>}</label>
              <div className="library-toolbar-actions"><div className="library-import" data-literature-menu>
                <button type="button" className="primary-button" aria-expanded={importOpen} aria-controls="literature-import-panel" onClick={()=>{setImportOpen(v=>!v);setRowMenu(undefined);}}><Plus size={15}/>导入文献<ChevronDown size={12}/></button>
                {importOpen&&<div id="literature-import-panel" className="library-popover library-import-panel"><strong>添加到文献库</strong><label className="library-file-picker"><FileUp size={17}/><span>{importing?'正在导入…':'选择本地文件'}<small>PDF、BibTeX、RIS、Markdown，也可拖入页面</small></span><input aria-label="导入文献文件" type="file" multiple accept=".pdf,.bib,.bibtex,.ris,.md,.markdown" disabled={importing} onChange={event=>{void uploadFiles(event.target.files);event.currentTarget.value='';}}/></label><form className="url-import" onSubmit={event=>void importUrl(event)}><label htmlFor="library-url">或导入公开网页</label><div><Link size={14}/><input id="library-url" type="url" required value={urlValue} onChange={event=>setUrlValue(event.target.value)} placeholder="https://…"/><button type="submit" aria-label="添加网页" title="添加网页" disabled={importing}>{importing?<LoaderCircle size={15} className="spin"/>:<Plus size={15}/>}</button></div></form></div>}
              </div></div>
              <LiteratureAnalysisButton projectId={projectId} sourceCount={detail.sources.length} blocked={importing||Boolean(deleting)} onChanged={onChanged}/>
            </div>
            {detail.sources.length===0?<div className="library-empty"><BookOpen size={28}/><strong>从第一篇论文开始</strong><p>导入 PDF，阅读原文并生成卡片与 Wiki。</p><button type="button" className="secondary-button" onClick={()=>setImportOpen(true)}>导入文献</button></div>:<div className="library-table">
              <div className="library-table-heading"><span>标题 / 作者</span><span className="library-year">发表时间</span><span>状态</span><span>操作</span></div>
              {detail.sources.filter(source=>(source.title+' '+source.authors.join(' ')+' '+(source.doi??'')).toLowerCase().includes(libraryQuery.trim().toLowerCase())).map(source=>{
                const item=analyses.find(entry=>entry.source_id===source.source_id);
                const pending=submitting.includes(source.source_id)||['queued','running'].includes(item?.status??'');
                const status=pending?(item?.status==='running'?'分析中':'排队中'):item?.status==='failed'?'分析失败':item?.stale?'待更新':item?.hasCards&&item?.hasWiki?'已整理':item?.hasOutputs?'部分整理':item?.status==='cancelled'?'已停止':item?.status==='interrupted'?'已中断':'未分析';
                const tone=pending?'active':item?.status==='failed'?'failed':item?.stale?'warning':item?.hasCards&&item?.hasWiki?'done':'idle';
                return <article className="library-row" key={source.source_id}>
                  <button type="button" className="library-paper" onClick={()=>{if(source.source_type==='pdf')window.open(`/api/v1/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/pdf-view`,'_blank','noopener,noreferrer');else void openSource(source);}} title={source.title}>
                    <span className={`file-type type-${source.source_type}`}>{source.source_type==='pdf'?'PDF':source.source_type==='openalex'?'OA':source.source_type.slice(0,2).toUpperCase()}</span><span><strong>{source.title}</strong><small>{source.authors.join(', ')||source.doi||'作者信息未提供'}</small><span className="library-mobile-year">{source.publication_date??source.year??'发表时间未提供'}</span></span>
                  </button>
                  <span className="library-year">{source.publication_date??source.year??'—'}</span>
                  <div className="library-state"><span className={`library-status ${tone}`}><i/>{status}</span><small>{pending?'生成信息卡片与 Wiki 线索':parseStatusLabel(source.parse_status)}</small>{(item?.hasCards||item?.hasWiki)&&<div className="library-outputs">{item.hasBasic&&<a href={projectPath(projectId,'cards',{focus:`card-${source.source_id}-basic`})}>信息</a>}{item.hasCards&&<a href={projectPath(projectId,'cards',{focus:`card-${source.source_id}-key`})}>卡片</a>}{item.hasWiki&&<a href={projectPath(projectId,'wiki',{focus:`wiki-${source.source_id}`})}>Wiki</a>}</div>}{item?.metadataPending&&<button type="button" className="text-button" onClick={()=>void openSource(source)}>信息待确认</button>}{item?.error&&!pending&&<details className="library-error"><summary>查看原因</summary><p>{item.error}</p></details>}</div>
                  <div className="library-row-actions"><button type="button" className="library-analyze" title="只分析这篇论文，生成三种卡片和 Wiki 线索" aria-label={`分析文献：${source.title}`} disabled={Boolean(deleting)||pending} onClick={()=>void analyzeSource(source)}>{pending?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}分析</button><div className="library-more" data-literature-menu>
                    <button type="button" className="icon-button" aria-label={`更多操作：${source.title}`} aria-expanded={rowMenu===source.source_id} aria-controls={`source-menu-${source.source_id}`} onClick={()=>{setRowMenu(current=>current===source.source_id?undefined:source.source_id);setImportOpen(false);}}><MoreHorizontal size={17}/></button>
                    {rowMenu===source.source_id&&<div className="library-popover library-row-menu" id={`source-menu-${source.source_id}`}><button type="button" onClick={()=>{setRowMenu(undefined);void openSource(source);}}><Info size={14}/>文献信息</button><button type="button" disabled={Boolean(deleting)||pending} onClick={()=>{setRowMenu(undefined);void analyzeSource(source);}}><Sparkles size={14}/>{item?.hasOutputs?'重新分析':'分析此篇'}</button><button type="button" className="library-danger" disabled={Boolean(deleting)||pending} onClick={()=>{setRowMenu(undefined);setDeleteError('');setDeleteTarget(source);}}><Trash2 size={14}/>删除文献</button></div>}
                  </div></div>
                </article>;
              })}
              {detail.sources.length>0&&!detail.sources.some(source=>(source.title+' '+source.authors.join(' ')+' '+(source.doi??'')).toLowerCase().includes(libraryQuery.trim().toLowerCase()))&&<div className="library-empty library-no-results"><Search size={23}/><strong>没有找到匹配的文献</strong><button type="button" className="text-button" onClick={()=>setLibraryQuery('')}>清空筛选</button></div>}
            </div>}
            {selectedSource && <section className="source-detail"><div className="source-detail-heading"><div><div className="eyebrow">来源详情</div><h3>{selectedSource.source.title}</h3><p>{selectedSource.source.source_url ?? selectedSource.source.doi ?? sourceTypeLabel(selectedSource.source.source_type)}</p></div><button className="icon-button" aria-label="关闭来源详情" title="关闭来源详情" onClick={() => { sourceRequest.current++;setSelectedSource(undefined); }}><X size={16}/></button></div>
              <SourceManager key={selectedSource.source.source_id} projectId={projectId} source={selectedSource.source} onSaved={() => { void refresh(); onChanged(); void openSource(selectedSource.source); }} />
              {selectedSource.source.abstract && <p className="source-abstract">{selectedSource.source.abstract}</p>}
              {selectedSource.segments.length ? <details><summary>查看解析文字（搜索索引，非原文排版）</summary><div className="segment-list">{selectedSource.segments.map((segment, index) => <article key={`${segment.locator.kind}-${index}`}><span>{locatorLabel(segment.locator)}</span><p>{segment.text}</p></article>)}</div></details> : <div className="metadata-note">{selectedSource.source.parse_status === "no_text" ? "未能从该来源提取文本。" : "该记录仅包含元数据。"}</div>}
            </section>}

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

function DeleteSourceDialog({ source, busy, blocked, error, onClose, onConfirm }: { source: Source; busy: boolean; blocked: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <ModalLayer><div className="modal-backdrop source-delete-backdrop"><div ref={modal} className="modal source-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="source-delete-title" aria-describedby="source-delete-description" aria-busy={busy} onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const buttons = Array.from(modal.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <h2 id="source-delete-title">删除参考文献</h2><p className="source-delete-name">{source.title}</p>
    <p id="source-delete-description">将删除此文献的记录、阅读信息与正文检索内容，原始文件保留。此操作无法撤销；被知识内容历史引用的文献不能删除。</p>
    {blocked && <p role="status" className="notice">正在导入或检索，请等待操作结束后再确认删除。</p>}
    {error && <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button project-delete-confirm" disabled={busy || blocked} onClick={onConfirm}>{busy ? "正在删除…" : "确认删除"}</button></div>
  </div></div></ModalLayer>;
}
