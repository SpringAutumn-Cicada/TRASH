import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, BookOpen, ExternalLink, FileUp, FolderOpen, Link, LoaderCircle, Palette, Plus, Search, X } from "lucide-react";
import type { LiteratureSearchResult, ResearchProject, Source, SourceLocator } from "@trash/protocol";
import "./styles.css";
import "./themes.css";

interface ProjectDetail { project: ResearchProject; sources: Source[] }
interface OpenAlexResponse { provider_id: string; results: LiteratureSearchResult[] }
interface PassageResponse { source: Source; locator: SourceLocator; text: string; rank: number }

const API = "/api/v1";
type Theme = "default" | "blue";

function ThemeControl({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return <label className="theme-control" title="切换界面主题">
    <Palette size={15} aria-hidden="true" />
    <span className="sr-only">界面主题</span>
    <select aria-label="界面主题" value={theme} onChange={(event) => onChange(event.target.value as Theme)}>
      <option value="default">默认主题</option>
      <option value="blue">蓝色科技</option>
    </select>
  </label>;
}

const errorMessages: Record<string, string> = {
  INVALID_JSON: "请求内容无法识别，请检查输入后重试。",
  INVALID_REQUEST: "请求无效，请检查输入后重试。",
  PROJECT_FIELDS_REQUIRED: "请填写项目名称和研究问题。",
  PROJECT_NOT_FOUND: "未找到该项目。",
  SOURCE_NOT_FOUND: "未找到该文献来源。",
  NOT_FOUND: "未找到请求的内容。",
  REQUEST_TOO_LARGE: "文件或请求内容过大。",
  UNSUPPORTED_FILE_TYPE: "暂不支持此文件格式。",
  URL_REQUIRED: "请输入网页地址。",
  URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED: "网页地址必须使用公开的 HTTP 或 HTTPS 链接。",
  URL_HOST_NOT_PUBLIC: "出于安全限制，不能导入本地或内网地址。",
  WEBPAGE_NOT_HTML: "该地址未返回可导入的网页。",
  WEBPAGE_TOO_LARGE: "网页内容超过允许的大小。",
  WEBPAGE_REDIRECT_LIMIT: "网页跳转次数过多，无法导入。",
  QUERY_TOO_SHORT: "检索词至少需要 2 个字符。",
  INTERNAL_ERROR: "发生意外错误，请稍后重试。"
};

function uiError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (errorMessages[cause.message]) return errorMessages[cause.message];
  if (cause.message.startsWith("OPENALEX_HTTP_")) return "OpenAlex 暂时无法响应，请稍后重试。";
  if (cause instanceof TypeError) return "无法连接本地工作台服务，请确认服务正在运行后重试。";
  return fallback;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "INTERNAL_ERROR");
  return payload;
}

function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  const navigate = (next: string) => { window.history.pushState(null, "", next); setPath(next); };
  return [path, navigate];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}

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

function App() {
  const [path, navigate] = useRoute();
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem("trash-theme") === "blue" ? "blue" : "default");
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("trash-theme", theme);
  }, [theme]);
  return projectMatch
    ? <ProjectView projectId={decodeURIComponent(projectMatch[1])} onBack={() => navigate("/")} theme={theme} onThemeChange={setTheme} />
    : <ProjectList onOpen={(id) => navigate(`/projects/${encodeURIComponent(id)}`)} theme={theme} onThemeChange={setTheme} />;
}

function ProjectList({ onOpen, theme, onThemeChange }: { onOpen: (id: string) => void; theme: Theme; onThemeChange: (theme: Theme) => void }) {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try { setProjects((await api<{ projects: ResearchProject[] }>("/projects")).projects); setError(""); }
    catch (cause) { setError(uiError(cause, "无法加载项目，请重试。")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ project: ResearchProject }>("/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, research_question: question, module: { id: "apt-provenance", version: "0.1.0" } })
      });
      setCreateOpen(false); setTitle(""); setQuestion("");
      await refresh(); onOpen(result.project.project_id);
    } catch (cause) { setError(uiError(cause, "无法创建项目，请重试。")); }
    finally { setSaving(false); }
  };

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="trash 首页"><span className="brand-mark">t.</span><span>trash</span></a>
      <div className="topbar-right"><span className="local-indicator"><i />本地工作区</span><ThemeControl theme={theme} onChange={onThemeChange} /><button className="icon-button" title="刷新项目" aria-label="刷新项目" onClick={() => void refresh()}><LoaderCircle size={16} className={loading ? "spin" : ""} /></button></div>
    </header>
    <div className="layout">
      <aside className="sidebar">
        <div className="workspace-label">工作区</div>
        <button className="side-item selected"><FolderOpen size={16} />项目<span className="count">{projects.length}</span></button>
        <div className="sidebar-bottom"><span className="module-dot" />APT 检测与溯源</div>
      </aside>
      <main className="main-content">
        <div className="page-heading">
          <div><div className="eyebrow">科研工作区</div><h1>项目</h1><p className="subheading">{projects.length} 个研究项目</p></div>
          <button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={16} />新建项目</button>
        </div>
        {error && <div role="alert" className="notice error-notice">{error}</div>}
        <section className="project-list" aria-label="研究项目">
          <div className="list-header"><span>项目</span><span>研究模块</span><span>更新时间</span><span>状态</span><span /></div>
          {loading && <div className="empty-row"><LoaderCircle className="spin" size={18} />正在加载项目</div>}
          {!loading && projects.length === 0 && <div className="empty-state"><BookOpen size={24} /><strong>还没有项目</strong><span>新建项目以开始整理文献和研究笔记。</span><button className="secondary-button" onClick={() => setCreateOpen(true)}><Plus size={15} />新建项目</button></div>}
          {!loading && projects.map((project) => <button className="project-row" key={project.project_id} onClick={() => onOpen(project.project_id)}>
            <span className="project-name"><span className="project-symbol">{project.title.slice(0, 1).toUpperCase()}</span><span><strong>{project.title}</strong><small>{project.research_question}</small></span></span>
            <span className="module-name">APT 检测与溯源</span><span className="date-cell">{formatDate(project.updated_at)}</span>
            <span><i className="status-dot" />进行中</span><span className="row-arrow">›</span>
          </button>)}
        </section>
      </main>
    </div>
    {createOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
      <form className="modal" onSubmit={(event) => void createProject(event)}>
        <div className="modal-heading"><div><h2>新建研究项目</h2><p>从研究问题和研究模块开始。</p></div><button className="icon-button" type="button" aria-label="关闭对话框" onClick={() => setCreateOpen(false)}><X size={17} /></button></div>
        <label>项目名称<input autoFocus required minLength={1} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：基于溯源图的 APT 检测" /></label>
        <label>研究问题<textarea required minLength={5} maxLength={2000} rows={4} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="这个项目希望研究什么问题？" /></label>
        <label>研究模块<select value="apt-provenance" disabled><option value="apt-provenance">APT 检测与溯源 · 0.1.0</option></select></label>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建项目</button></div>
      </form>
    </div>}
  </div>;
}

function ProjectView({ projectId, onBack, theme, onThemeChange }: { projectId: string; onBack: () => void; theme: Theme; onThemeChange: (theme: Theme) => void }) {
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

  const refresh = async () => {
    setLoading(true);
    try { setDetail(await api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`)); setError(""); }
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
      await refresh();
    } catch (cause) { setError(uiError(cause, "导入失败，请检查文件后重试。")); }
    finally { setImporting(false); }
  };

  const importUrl = async (event: React.FormEvent) => {
    event.preventDefault(); setImporting(true); setError("");
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/sources/url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: urlValue }) });
      setUrlValue(""); await refresh();
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
      setProviderResults([]); setSelectedResults(new Set()); await refresh();
    } catch (cause) { setError(uiError(cause, "无法导入所选文献，请重试。")); }
    finally { setImporting(false); }
  };

  const openSource = async (source: Source) => {
    try { setSelectedSource(await api(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}`)); }
    catch (cause) { setError(uiError(cause, "无法打开文献来源，请重试。")); }
  };

  const toggleResult = (ref: string) => setSelectedResults((previous) => {
    const next = new Set(previous);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    return next;
  });

  if (loading) return <div className="loading-screen"><LoaderCircle className="spin" />正在打开项目</div>;
  if (!detail) return <div className="loading-screen"><span>{error || "未找到该项目。"}</span><button className="secondary-button" onClick={onBack}><ArrowLeft size={15} />返回项目列表</button></div>;

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="trash 首页" onClick={(event) => { event.preventDefault(); onBack(); }}><span className="brand-mark">t.</span><span>trash</span></a><div className="topbar-right"><span className="local-indicator"><i />本地工作区</span><ThemeControl theme={theme} onChange={onThemeChange} /></div></header>
    <div className="layout">
      <aside className="sidebar"><div className="workspace-label">项目</div><button className="side-item" onClick={onBack}><ArrowLeft size={16} />全部项目</button><div className="sidebar-project"><span className="module-dot" />{detail.project.title}</div><div className="sidebar-bottom"><BookOpen size={15} />{detail.sources.length} 篇文献</div></aside>
      <main className="main-content project-content">
        <div className="breadcrumb"><button onClick={onBack}>项目</button><span>/</span><span>{detail.project.title}</span></div>
        <div className="project-title-row"><div><div className="eyebrow">APT 检测与溯源 · 0.1.0</div><h1>{detail.project.title}</h1><p className="subheading">{detail.project.research_question}</p></div><span className="project-status"><i className="status-dot" />进行中</span></div>
        {error && <div role="alert" className="notice error-notice">{error}<button className="icon-button" onClick={() => setError("")}><X size={15} /></button></div>}
        <div className="section-tabs"><button className="tab active"><BookOpen size={15} />文献 <span>{detail.sources.length}</span></button></div>
        <div className="literature-grid">
          <section className="literature-main">
            <div className="section-heading"><div><h2>项目文献</h2><p>已导入的文献记录和来源文件</p></div><label className="primary-button upload-button"><FileUp size={15} />{importing ? "正在导入…" : "导入文件"}<input aria-label="导入文献文件" type="file" multiple accept=".pdf,.bib,.bibtex,.ris,.md,.markdown" disabled={importing} onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ""; }} /></label></div>
            <form className="url-import" onSubmit={(event) => void importUrl(event)}><Link size={15} className="link-icon" /><input type="url" required value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="导入公开网页地址"/><button className="secondary-button" disabled={importing}>{importing ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}添加网页</button></form>
            {detail.sources.length === 0 ? <div className="source-empty"><FileUp size={21}/><span>尚未导入文献</span></div> : <div className="source-table">
              <div className="source-table-header"><span>标题 / 作者</span><span>年份</span><span>类型</span><span>状态</span></div>
              {detail.sources.map((source) => <button className="source-row" key={source.source_id} onClick={() => void openSource(source)}><span className="source-title"><span className={`file-type type-${source.source_type}`}>{source.source_type === "openalex" ? "OA" : source.source_type.slice(0, 2).toUpperCase()}</span><span><strong>{source.title}</strong><small>{source.authors.join(", ") || source.doi || source.source_url || "暂无元数据"}</small></span></span><span className="year-cell">{source.year ?? "—"}</span><span className="type-cell">{sourceTypeLabel(source.source_type)}</span><span><i className={`parse-dot parse-${source.parse_status}`} />{parseStatusLabel(source.parse_status)}</span></button>)}
            </div>}
            {selectedSource && <section className="source-detail"><div className="source-detail-heading"><div><div className="eyebrow">来源详情</div><h3>{selectedSource.source.title}</h3><p>{selectedSource.source.source_url ?? selectedSource.source.doi ?? sourceTypeLabel(selectedSource.source.source_type)}</p></div><button className="icon-button" aria-label="关闭来源详情" title="关闭来源详情" onClick={() => setSelectedSource(undefined)}><X size={16}/></button></div>
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
      </main>
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
