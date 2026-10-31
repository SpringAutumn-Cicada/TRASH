import React, { useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard.js";
import { ArrowUp, ChevronRight, Code2, Copy, FileCode2, FileText, Folder, FolderOpen, LoaderCircle, RefreshCw, Search } from "lucide-react";

type Entry = { name: string; path: string; directory: boolean; symlink: boolean };
type Preview = { path: string; preview: boolean; text?: string; reason?: string; size_bytes: number };
const languages: Record<string, string> = { py: "Python", ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", json: "JSON", md: "Markdown", yml: "YAML", yaml: "YAML", sh: "Shell", css: "CSS", html: "HTML", toml: "TOML", txt: "文本" };
const language = (path: string) => languages[path.split(".").pop()?.toLowerCase() ?? ""] ?? "文本";
export function RepositoryBrowser({ projectId, repositoryPath, endpoint }: { projectId: string; repositoryPath: string; endpoint?:string }) {
  const [entries, setEntries] = useState<Entry[]>([]), [directory, setDirectory] = useState(""), [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<Preview>(), [loading, setLoading] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false), [lineLimit, setLineLimit] = useState(2000);
  const directoryRequest = useRef(0), fileRequest = useRef(0);
  const base = endpoint ?? `/api/v1/projects/${encodeURIComponent(projectId)}/repository`;
  const read = async <T,>(path: string): Promise<T> => {
    const response = await fetch(base + path); const data = await response.json();
    if (!response.ok) throw new Error(data.error === "REPOSITORY_PATH_INVALID" ? "该路径不在绑定仓库内，不能访问。" : "读取失败，请刷新目录或检查本地仓库。");
    return data as T;
  };
  const openDirectory = async (path: string) => {
    const id = ++directoryRequest.current; setLoading(true); setError("");
    try { const data = await read<{ entries: Entry[] }>(`/tree?path=${encodeURIComponent(path)}`); if (directoryRequest.current === id) { setEntries(data.entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }))); setDirectory(path); setFilter(""); } }
    catch (cause) { if (directoryRequest.current === id) setError(cause instanceof Error ? cause.message : "读取目录失败。"); }
    finally { if (directoryRequest.current === id) setLoading(false); }
  };
  useEffect(() => { void openDirectory(""); return () => { directoryRequest.current++; fileRequest.current++; }; }, [projectId, repositoryPath, endpoint]);
  const openFile = async (path: string) => {
    const id = ++fileRequest.current; setOpening(true); setError(""); setCopied(false);
    try { const data = await read<Preview>(`/file?path=${encodeURIComponent(path)}`); if (fileRequest.current === id) { setPreview({ ...data, path }); setLineLimit(2000); } }
    catch (cause) { if (fileRequest.current === id) setError(cause instanceof Error ? cause.message : "读取文件失败。"); }
    finally { if (fileRequest.current === id) setOpening(false); }
  };
  const lines = preview?.preview ? (preview.text ?? "").split("\n") : [];
  const visible = entries.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()));
  const repoName = repositoryPath.split(/[\\/]/).filter(Boolean).pop() || "仓库";
  return <section className="repository-browser">
    <header className="repository-browser-heading"><div><Code2 size={18}/><strong>{repoName}</strong><span>代码浏览</span></div><span className="repository-readonly">只读预览</span></header>
    <div className="repository-browser-body">
      <aside className="repository-explorer" aria-label="代码目录">
        <div className="repository-explorer-heading"><span>文件目录</span><button type="button" className="icon-button" aria-label="刷新代码目录" title="刷新代码目录" disabled={loading} onClick={() => void openDirectory(directory)}><RefreshCw size={14} className={loading ? "spin" : ""}/></button></div>
        <label className="repository-file-filter"><Search size={14}/><input aria-label="筛选当前目录文件" placeholder="查找文件…" value={filter} onChange={event => setFilter(event.target.value)}/></label>
        <div className="repository-directory-location"><button type="button" className="text-button" disabled={loading} onClick={() => void openDirectory("")}>根目录</button>{directory && <button type="button" className="icon-button" title="返回上一级目录" aria-label="返回上一级目录" disabled={loading} onClick={() => void openDirectory(directory.split("/").slice(0, -1).join("/"))}><ArrowUp size={13}/></button>}<span title={directory || "/"}>{directory || "/"}</span></div>
        <div className="repository-entries" aria-busy={loading}>{loading ? <div className="repository-browser-empty"><LoaderCircle size={18} className="spin"/><span>正在读取目录…</span></div> : visible.map(entry => <button type="button" key={entry.path} className={`repository-entry ${preview?.path === entry.path ? "selected" : ""} ${entry.directory ? "is-directory" : ""}`} title={entry.symlink ? `${entry.name}（符号链接，不能展开）` : entry.name} disabled={entry.symlink} aria-current={preview?.path === entry.path ? "true" : undefined} onClick={() => void (entry.directory ? openDirectory(entry.path) : openFile(entry.path))}>{entry.directory ? <Folder size={15}/> : /\.(py|tsx?|jsx?|sh|json|ya?ml|css|html|toml)$/i.test(entry.name) ? <FileCode2 size={15}/> : <FileText size={15}/>}<span>{entry.name}</span>{entry.symlink ? <small>链接</small> : entry.directory ? <ChevronRight size={13}/> : null}</button>)}{!loading && !visible.length && <div className="repository-browser-empty"><FolderOpen size={24}/><span>{filter ? "没有匹配的文件" : "此目录为空"}</span></div>}</div>
        <footer className="repository-explorer-footer">{entries.filter(entry => entry.directory).length} 个目录 · {entries.filter(entry => !entry.directory).length} 个文件</footer>
      </aside>
      <div className="repository-preview">
        <div className="repository-preview-heading">{preview ? <><FileCode2 size={15}/><strong title={preview.path}>{preview.path}</strong><span className="repository-language">{language(preview.path)}</span><button type="button" className="icon-button" disabled={!preview.preview || opening} title={copied ? "已复制" : "复制文件内容"} aria-label={copied ? "文件内容已复制" : "复制文件内容"} onClick={() => void copyText(preview.text ?? "").then(() => setCopied(true)).catch(() => setError("无法复制，请手动选择文件内容。"))}><Copy size={14}/></button></> : <span>文件预览</span>}</div>
        {error && <div role="alert" className="notice error-notice">{error}</div>}
        {opening ? <div className="repository-browser-empty repository-preview-empty"><LoaderCircle size={24} className="spin"/><span>正在打开文件…</span></div> : !preview ? <div className="repository-browser-empty repository-preview-empty"><span className="repository-empty-icon"><Code2 size={28}/></span><h3>从左侧选择一个文件</h3><p>浏览实验代码，查看脚本与配置。</p></div> : !preview.preview ? <div className="repository-browser-empty repository-preview-empty"><FileText size={28}/><h3>此文件无法预览</h3><p>{preview.reason || "不支持预览此类型文件"}</p></div> : <div className="repository-code-scroll" tabIndex={0} role="region" aria-label={`${preview.path} 文件内容`}><div className="repository-code-lines">{lines.slice(0, lineLimit).map((line, index) => <div className="repository-code-line" key={index}><span className="repository-line-number" aria-hidden="true">{index + 1}</span><code>{line || " "}</code></div>)}</div>{lines.length > lineLimit && <button type="button" className="repository-more-lines" onClick={() => setLineLimit(value => value + 2000)}>已显示 {lineLimit} / {lines.length} 行，继续显示</button>}</div>}
        <footer className="repository-preview-footer"><span>{preview ? `${preview.size_bytes.toLocaleString("zh-CN")} bytes${preview.preview ? ` · ${lines.length} 行` : ""}` : "未选择文件"}</span><span>{copied ? "已复制文件内容" : "本地代码 · 只读"}</span></footer>
      </div>
    </div>
  </section>;
}
