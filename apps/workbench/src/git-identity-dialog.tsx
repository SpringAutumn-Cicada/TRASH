import React, { useEffect, useId, useRef, useState } from "react";
import { Check, GitBranch, LoaderCircle, X } from "lucide-react";
import { api, uiError } from "./api.js";
import { ErrorNotice } from "./error-notice.js";
import { ModalLayer } from "./modal-layer.js";
import "./git-identity-dialog.css";

type Identity = { name: string; email: string };
const empty: Identity = { name: "", email: "" };
const path = "/settings/git-identity";
export const gitIdentityOpenEvent = "trash-git-identity-open";
export function openGitIdentity() { window.dispatchEvent(new Event(gitIdentityOpenEvent)); }

export function GitIdentityDialog({ onClose }: { onClose: () => void }) {
  const title = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [identity, setIdentity] = useState<Identity>(empty);
  const [saved, setSaved] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    return () => { if (previous?.isConnected) requestAnimationFrame(() => previous.focus()); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<{ identity: Identity | null }>(path, { signal: controller.signal, cache: "no-store" }).then(result => {
      if (controller.signal.aborted) return;
      setSaved(result.identity); setIdentity(result.identity ?? empty); setLoaded(true);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(uiError(cause, "无法读取 Git 身份，请重试。"));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => { if (loaded && !loading) nameInput.current?.focus(); }, [loaded, loading]);

  const save = async (value: Identity | null) => {
    if (saving || !loaded) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await api<{ identity: Identity | null }>(path, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
      });
      setSaved(result.identity); setIdentity(result.identity ?? empty);
      setNotice(result.identity ? "默认 Git 身份已保存。" : "默认 Git 身份已清除。");
    } catch (cause) { setError(uiError(cause, "无法保存 Git 身份，请重试。")); }
    finally { setSaving(false); }
  };
  const edit = (key: keyof Identity, value: string) => {
    setIdentity(previous => ({ ...previous, [key]: value }));
    setNotice("");
  };

  return <ModalLayer><div className="modal-backdrop"><form ref={dialog} className="modal git-identity-dialog"
    role="dialog" aria-modal="true" aria-labelledby={title} aria-busy={loading || saving}
    autoComplete="off"
    onSubmit={event => { event.preventDefault(); void save(identity); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); if (!saving) onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className="modal-heading git-identity-heading">
      <span className="git-identity-icon"><GitBranch size={21} aria-hidden="true"/></span>
      <div><h2 id={title}>Git 身份</h2><p>设置平台手动提交与 Agent 提交共用的默认署名。</p></div>
      <button ref={close} type="button" className="icon-button" aria-label="关闭 Git 身份设置"
        disabled={saving} onClick={onClose}><X size={18}/></button>
    </header>
    <div className="git-identity-fields">
      <label>提交者姓名<input ref={nameInput} autoComplete="off" required maxLength={120} value={identity.name}
        disabled={loading || !loaded || saving} onChange={event => edit("name", event.target.value)}/></label>
      <label>提交者邮箱<input type="email" autoComplete="off" required maxLength={254} value={identity.email}
        disabled={loading || !loaded || saving} onChange={event => edit("email", event.target.value)}/></label>
    </div>
    <p className="git-identity-scope">仓库里已配置完整署名时，优先使用仓库的身份。</p>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {notice && <p className="git-identity-notice" role="status"><Check size={15} aria-hidden="true"/>{notice}</p>}
    <footer className="modal-actions git-identity-actions">
      {saved && <button type="button" className="text-button git-identity-clear" disabled={saving}
        onClick={() => void save(null)}>清除默认身份</button>}
      {!loaded && !loading
        ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取</button>
        : <button type="submit" className="primary-button" disabled={loading || saving}>
          {(loading || saving) && <LoaderCircle className="spin" size={15} aria-hidden="true"/>}
          {loading ? "正在读取…" : saving ? "正在保存…" : "保存身份"}
        </button>}
    </footer>
  </form></div></ModalLayer>;
}
