import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderPlus, X } from "lucide-react";

type Directory = { path: string; parent: string | null; directories: { name: string; path: string }[] };
const messages: Record<string, string> = {
  LOCAL_DIRECTORY_NOT_FOUND: "目录不存在，请检查路径。", LOCAL_DIRECTORY_ACCESS_DENIED: "没有权限读取此目录。",
  LOCAL_DIRECTORY_EXISTS: "已存在同名文件或文件夹。", LOCAL_DIRECTORY_CREATE_FAILED: "创建失败，请检查目录权限。", INVALID_REQUEST: "请输入有效的路径或文件夹名称。"
};
export function DirectoryPicker({ base, initialPath, onSelect, onClose }: { base: string; initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [directory, setDirectory] = useState<Directory>();
  const [path, setPath] = useState(initialPath), [name, setName] = useState(""), [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const modal = useRef<HTMLDivElement>(null), alive = useRef(true);
  const call = async <T,>(suffix: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}/repository/directories${suffix}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(messages[data.error] ?? "目录操作失败，请重试。");
    return data as T;
  };
  const open = async (target: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { const data = await call<Directory>(target ? `?path=${encodeURIComponent(target)}` : ""); if (alive.current) { setDirectory(data); setPath(data.path); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "无法读取目录。"); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.focus(); void open(initialPath);
    return () => { alive.current = false; previous?.focus(); };
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !directory || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const created = await call<{ path: string }>("", { parent: directory.path, name: name.trim() });
      const data = await call<Directory>(`?path=${encodeURIComponent(created.path)}`);
      if (alive.current) { setDirectory(data); setPath(data.path); setCreating(false); setName(""); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "创建目录失败。"); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="modal-backdrop"><div ref={modal} tabIndex={-1} className="modal directory-picker" role="dialog" aria-modal="true" aria-labelledby="directory-picker-title" onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const items = Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="modal-heading"><div><h2 id="directory-picker-title">选择仓库目录</h2><p>浏览运行 TRASH 服务的电脑上的目录。</p></div><button type="button" className="icon-button" aria-label="关闭目录选择" disabled={busy} onClick={onClose}><X size={17}/></button></div>
    <form className="directory-location" onSubmit={event => { event.preventDefault(); void open(path); }}><input aria-label="当前目录路径" value={path} onChange={event => setPath(event.target.value)} placeholder="输入绝对路径" disabled={busy}/><button className="secondary-button" disabled={busy}>进入</button></form>
    <div className="directory-actions"><button type="button" className="secondary-button" disabled={busy || !directory?.parent} onClick={() => void open(directory!.parent!)}><ArrowUp size={14}/>上一级</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void open("")}>主目录</button><button type="button" className="secondary-button" disabled={busy || !directory} onClick={() => setCreating(!creating)}><FolderPlus size={14}/>新建文件夹</button></div>
    {creating && <form className="directory-location" onSubmit={event => void create(event)}><input autoFocus aria-label="新文件夹名称" value={name} onChange={event => setName(event.target.value)} placeholder="文件夹名称" maxLength={255} disabled={busy}/><button className="primary-button" disabled={busy || !name.trim()}>创建并进入</button></form>}
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    <div className="directory-list" aria-label="子目录" aria-busy={busy}>{busy ? <p role="status">正在读取目录…</p> : directory?.directories.map(entry => <button type="button" key={entry.path} className="directory-entry" onClick={() => void open(entry.path)}><Folder size={16}/><span>{entry.name}</span><span aria-hidden="true">›</span></button>)}{!busy && directory && !directory.directories.length && <p>此目录下没有子文件夹。</p>}</div>
    <p className="directory-selection">已浏览到：{directory?.path ?? "尚未选择"}</p>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !directory} onClick={() => directory && onSelect(directory.path)}>选择此目录</button></div>
  </div></div>;
}
