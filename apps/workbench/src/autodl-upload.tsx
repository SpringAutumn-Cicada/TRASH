import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { FileUp, FolderOpen, LoaderCircle, Upload } from "lucide-react";
import type { TerminalSession } from "./autodl-terminal.js";

export function AutoDlUpload({ projectId, session }: { projectId: string; session?: TerminalSession }) {
  const [file, setFile] = useState<File>();
  const [directory, setDirectory] = useState("/root/autodl-tmp");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const [message, setMessage] = useState(""), [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null), transfer = useRef<XMLHttpRequest | null>(null);
  useEffect(() => () => { const request = transfer.current; if (request) { request.onload = null; request.onerror = null; request.onabort = null; request.upload.onprogress = null; request.abort(); } }, []);
  const upload = () => {
    if (!file || !session || busy || transfer.current) return;
    if (file.size > 200 * 1024 * 1024) { setFailed(true); setMessage("单个文件不能超过 200 MiB。"); return; }
    if (!directory.startsWith("/") || directory.split("/").includes("..")) { setFailed(true); setMessage("请填写已有远端目录的绝对路径。"); return; }
    const request = new XMLHttpRequest(); transfer.current = request;
    setBusy(true); setProgress(0); setFailed(false); setMessage("正在上传，请保持当前页面和 SSH 连接…");
    const finish = (error: boolean, text: string) => { transfer.current = null; setBusy(false); setFailed(error); setMessage(text); };
    request.open("POST", `/api/v1/projects/${encodeURIComponent(projectId)}/terminals/${session.id}/upload?${new URLSearchParams({ directory, name: file.name })}`);
    request.setRequestHeader("x-terminal-token", session.token);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      let result: { path?: string; error?: string } = {};
      try { result = JSON.parse(request.responseText); } catch { /* Non-JSON HTTP errors use the generic message. */ }
      if (request.status >= 200 && request.status < 300 && result.path) {
        setProgress(100); setFile(undefined); if (input.current) input.current.value = "";
        finish(false, `上传完成：${result.path}`);
      } else finish(true, result.error === "REQUEST_TOO_LARGE" ? "文件超过 200 MiB 上限。" : result.error === "UPLOAD_PATH_INVALID" ? "目录或文件名无效，请检查路径。" : result.error === "TERMINAL_NOT_FOUND" ? "SSH 会话已结束，请重新连接后上传。" : "上传失败，请确认目录存在、可写、空间充足且没有同名文件。");
    };
    request.onerror = () => finish(true, "上传连接中断，请检查网络及 SSH 状态，并确认远端文件状态后重试。");
    request.onabort = () => finish(true, "上传已取消；如远端连接已断开，请检查是否有未完成文件。");
    request.send(file);
  };
  return <section className="autodl-upload-card" aria-label="上传文件到 AutoDL">
    <div className="autodl-upload-title"><FileUp size={18}/><strong>文件上传</strong><span>{session ? `目标：${session.name}` : "请先连接 AutoDL 实例"}</span></div>
    <div className="autodl-upload-fields">
      <input ref={input} type="file" className="sr-only" aria-label="选择上传文件" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setMessage(""); }}/>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}><FileUp size={14}/>选择文件</button>
      <span className="autodl-upload-filename" title={file?.name}>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB` : "未选择文件"}</span>
      <label><FolderOpen size={15}/><span className="sr-only">远端目标目录</span><input aria-label="远端目标目录" value={directory} disabled={busy} onChange={event => setDirectory(event.target.value)} placeholder="远端目录，如 /root/autodl-tmp"/></label>
      <button type="button" className="primary-button" disabled={busy || !file || !session || !directory.trim()} onClick={upload}>{busy ? <LoaderCircle size={14} className="spin"/> : <Upload size={14}/>}{busy ? "正在上传…" : "上传文件"}</button>
      {busy && <button type="button" className="secondary-button" onClick={() => transfer.current?.abort()}>取消</button>}
    </div>
    <p>通过当前 SSH 连接使用 SFTP 上传，单文件上限 200 MiB；目录需已存在，同名文件不会覆盖。</p>
    {busy && <div className="autodl-upload-progress"><progress value={progress} max={100} aria-label="文件发送进度"/><span>{progress}%{progress === 100 ? " · 等待远端写入确认" : ""}</span></div>}
    {message && (failed ? <ErrorNotice className="autodl-upload-error">{message}</ErrorNotice> : <p role="status" className="autodl-upload-message">{message}</p>)}
  </section>;
}
