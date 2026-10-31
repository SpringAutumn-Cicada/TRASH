import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, FileUp, Link, LoaderCircle, Plus, Search, X } from "lucide-react";
import type { LiteratureSearchResult, ResearchProject, Source, SourceLocator } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { SourceManager } from "./knowledge.js";
import { useUnsavedChanges } from "./navigation.js";
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


export function LiteraturePage({projectId, action, focusId, onChanged}: {projectId:string;action?:string;focusId?:string;onChanged:()=>void}) {
  const [detail, setDetail] = useState<ProjectDetail>();
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

  const alive = useRef(true);
  const sourceRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useUnsavedChanges(Boolean(urlValue.trim()) || importing);
  useEffect(() => {
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
    if (!files || !detail) return;
    setImporting(true); setError("");
    try {
      for (const file of Array.from(files)) {
        await api(`/projects/${encodeURIComponent(projectId)}/sources/files?filename=${encodeURIComponent(file.name)}`, {
          method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file
        });
      }
      await refresh(); onChanged();
    } catch (cause) { setError(uiError(cause, "导入失败，请检查文件后重试。")); }
    finally { setImporting(false); }
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
    event.preventDefault(); setSearching(true);
    try { setPassages((await api<{ passages: PassageResponse[] }>(`/projects/${encodeURIComponent(projectId)}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).passages); }
    catch (cause) { setError(uiError(cause, "检索失败，请重试。")); }
    finally { setSearching(false); }
  };

  const runProviderSearch = async (event: React.FormEvent) => {
    event.preventDefault(); setProviderSearching(true); setSelectedResults(new Set());
    try { setProviderResults((await api<OpenAlexResponse>(`/literature/openalex/search?q=${encodeURIComponent(providerQuery)}`)).results); }
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

  const toggleResult = (ref: string) => setSelectedResults((previous) => {
    const next = new Set(previous);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    return next;
  });

  if (loading) return <div className="loading-screen"><LoaderCircle className="spin" />正在打开项目</div>;
  if (!detail) return <div role="alert">{error || "未找到该项目。"}</div>;
  return <section className="literature-page">
    {error && <div role="alert" className="notice error-notice">{error}</div>}
        <div className="literature-grid">
          <section className="literature-main">
            <div className="section-heading"><div><h2>项目文献</h2><p>已导入的文献记录和来源文件</p></div><label className="primary-button upload-button"><FileUp size={15} />{importing ? "正在导入…" : "导入文件"}<input aria-label="导入文献文件" type="file" multiple accept=".pdf,.bib,.bibtex,.ris,.md,.markdown" disabled={importing} onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ""; }} /></label></div>
            <form className="url-import" onSubmit={(event) => void importUrl(event)}><Link size={15} className="link-icon" /><input type="url" required value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="导入公开网页地址"/><button className="secondary-button" disabled={importing}>{importing ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}添加网页</button></form>
            {detail.sources.length === 0 ? <div className="source-empty"><FileUp size={21}/><span>尚未导入文献</span></div> : <div className="source-table">
              <div className="source-table-header"><span>标题 / 作者</span><span>年份</span><span>类型</span><span>状态</span></div>
              {detail.sources.map((source) => <button className="source-row" key={source.source_id} onClick={() => void openSource(source)}><span className="source-title"><span className={`file-type type-${source.source_type}`}>{source.source_type === "openalex" ? "OA" : source.source_type.slice(0, 2).toUpperCase()}</span><span><strong>{source.title}</strong><small>{source.authors.join(", ") || source.doi || source.source_url || "暂无元数据"}</small></span></span><span className="year-cell">{source.year ?? "—"}</span><span className="type-cell">{sourceTypeLabel(source.source_type)}</span><span><i className={`parse-dot parse-${source.parse_status}`} />{parseStatusLabel(source.parse_status)}</span></button>)}
            </div>}
            {selectedSource && <section className="source-detail"><div className="source-detail-heading"><div><div className="eyebrow">来源详情</div><h3>{selectedSource.source.title}</h3><p>{selectedSource.source.source_url ?? selectedSource.source.doi ?? sourceTypeLabel(selectedSource.source.source_type)}</p></div><button className="icon-button" aria-label="关闭来源详情" title="关闭来源详情" onClick={() => { sourceRequest.current++;setSelectedSource(undefined); }}><X size={16}/></button></div>
              <SourceManager key={selectedSource.source.source_id} projectId={projectId} source={selectedSource.source} onSaved={() => { void refresh(); onChanged(); void openSource(selectedSource.source); }} />
              {selectedSource.source.abstract && <p className="source-abstract">{selectedSource.source.abstract}</p>}
              {selectedSource.segments.length ? <div className="segment-list">{selectedSource.segments.map((segment, index) => <article key={`${segment.locator.kind}-${index}`}><span>{locatorLabel(segment.locator)}</span><p>{segment.text}</p></article>)}</div> : <div className="metadata-note">{selectedSource.source.parse_status === "no_text" ? "未能从该来源提取文本。" : "该记录仅包含元数据。"}</div>}
            </section>}
            <section className="search-section"><div className="section-heading compact"><div><h2>检索项目资料</h2><p>结果会标明原文来源位置</p></div></div><form className="search-form" onSubmit={(event) => void runSearch(event)}><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} placeholder="检索摘要和已导入正文"/><button className="secondary-button" disabled={searching || query.trim().length < 2}>{searching ? <LoaderCircle size={14} className="spin"/> : <Search size={14}/>}检索</button></form>
              <div className="passage-results">{passages.map((passage, index) => <article className="passage" key={`${passage.source.source_id}-${index}`}><div className="passage-meta"><button onClick={() => void openSource(passage.source)}>{passage.source.title}</button><span>{locatorLabel(passage.locator)}</span></div><p>{passage.text}</p></article>)}{passages.length === 0 && query.length > 1 && <div className="search-empty">没有匹配的段落。仅含元数据且没有摘要的记录无法检索正文。</div>}</div>
            </section>
          </section>
          <aside className="literature-tools">
            <section className="tool-section"><div className="tool-heading"><div><span className="tool-icon openalex-icon">O</span><div><h2>OpenAlex</h2><p>公开学术文献检索</p></div></div></div><form className="provider-search" onSubmit={(event) => void runProviderSearch(event)}><label htmlFor="openalex-query">搜索学术文献</label><div><input id="openalex-query" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} minLength={2} placeholder="标题、作者或关键词"/><button className="icon-button search-submit" aria-label="搜索 OpenAlex" title="搜索 OpenAlex" disabled={providerSearching || providerQuery.trim().length < 2}>{providerSearching ? <LoaderCircle size={16} className="spin"/> : <Search size={16}/>}</button></div></form>
              {providerResults.length > 0 && <><div className="provider-results-heading"><span>{providerResults.length} 条结果</span><button className="text-button" disabled={!selectedResults.size || importing} onClick={() => void importSearchResults()}><Plus size={13}/>{importing ? "正在导入…" : `导入所选（${selectedResults.size}）`}</button></div><div className="provider-results">{providerResults.map((result) => <label className="provider-result" key={result.provider_ref}><input type="checkbox" checked={selectedResults.has(result.provider_ref)} onChange={() => toggleResult(result.provider_ref)}/><span><strong>{result.title}</strong><small>{result.authors.slice(0, 3).join(", ") || "作者信息缺失"}{result.year ? ` · ${result.year}` : ""}</small></span></label>)}</div></>}
            </section>
            <section className="tool-section scholar-section"><div className="tool-heading"><div><span className="tool-icon scholar-icon">G</span><div><h2>Google Scholar</h2><p>由你主动发起的网页搜索</p></div></div><ExternalLink size={14}/></div><label htmlFor="scholar-query">搜索词</label><div className="scholar-search"><input id="scholar-query" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="APT 溯源检测"/><button className="icon-button" aria-label="打开 Google Scholar" title="打开 Google Scholar" onClick={() => window.open(`https://scholar.google.com/scholar?q=${encodeURIComponent(providerQuery)}`, "_blank", "noopener,noreferrer")}><ExternalLink size={15}/></button></div></section>
            <div className="source-format-note"><strong>支持导入</strong><span>PDF · BibTeX · RIS · Markdown · 公开网页</span></div>
          </aside>
        </div>
  </section>;
}
