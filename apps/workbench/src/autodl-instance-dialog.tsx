import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Server, X } from "lucide-react";
import type { SshProfile } from "@trash/protocol";
import { useUnsavedChanges } from "./navigation.js";

export function AutoDlInstanceDialog({ projectId, mode, profiles, initialId, onClose, onSaved }: { projectId: string; mode: "add" | "edit"; profiles: SshProfile[]; initialId: string; onClose: () => void; onSaved: (profile: SshProfile) => void }) {
  const [selectedId, setSelectedId] = useState(initialId || profiles[0]?.profile_id || "");
  const selected = profiles.find(profile => profile.profile_id === selectedId);
  const commandOf = (profile?: SshProfile) => profile ? `ssh -p ${profile.port} ${profile.username}@${profile.host.includes(":") ? `[${profile.host}]` : profile.host}` : "";
  const [name, setName] = useState(mode === "edit" ? selected?.name || "" : ""), [command, setCommand] = useState(mode === "edit" ? commandOf(selected) : ""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const modal = useRef<HTMLFormElement>(null);
  useUnsavedChanges(Boolean(password || (mode === "add" ? name || command : name !== (selected?.name || "") || command !== commandOf(selected))));
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; modal.current?.querySelector<HTMLElement>(mode === "edit" ? "select" : "input")?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    const credential = password; setPassword("");
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/ssh-profiles/${mode === "add" ? "from-command" : encodeURIComponent(selectedId)}`, { method: mode === "add" ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, command, password: credential }) });
      const data = await response.json();
      if (!response.ok) throw new Error(({ SSH_LOGIN_COMMAND_INVALID: "请填写 ssh -p 端口 用户名@主机，不要附带其他命令。", SSH_NEW_CONNECTION_PASSWORD_REQUIRED: "连接信息改变后，请填写新实例的密码。", SSH_PROFILE_DUPLICATE: "已存在相同连接的主机，请选择原主机进行编辑。", EXPERIMENT_ACTIVE: "此主机有未结束实验，暂不能修改配置。", INVALID_REQUEST: "请检查主机名、SSH 指令与密码。" } as Record<string, string>)[data.error] ?? "保存实例失败，请检查输入后重试。");
      onSaved(data.profile);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="modal-backdrop autodl-instance-backdrop"><form ref={modal} className="modal autodl-instance-dialog" role="dialog" aria-modal="true" aria-labelledby="autodl-instance-title" aria-busy={busy} onSubmit={event => void save(event)} onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const items = Array.from(modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)") ?? []), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div className="modal-heading"><div><h2 id="autodl-instance-title"><Server size={18}/>{mode === "add" ? "添加已有实例" : "编辑已有实例"}</h2><p>填写 AutoDL 的 SSH 连接信息。</p></div><button type="button" className="icon-button" aria-label="关闭实例弹窗" disabled={busy} onClick={onClose}><X size={17}/></button></div>
    {mode === "edit" && <><label>选择要编辑的主机<select disabled={busy} value={selectedId} onChange={event => { const profile = profiles.find(item => item.profile_id === event.target.value); setSelectedId(event.target.value); setName(profile?.name || ""); setCommand(commandOf(profile)); setPassword(""); setError(""); }}>{profiles.map(profile => <option key={profile.profile_id} value={profile.profile_id}>{profile.name} · {profile.host}:{profile.port}</option>)}</select></label><p className="autodl-dialog-hint">切换主机会清除当前未保存的编辑。</p></>}
    <label>主机名（可选）<input value={name} maxLength={500} disabled={busy} onChange={event => setName(event.target.value)} placeholder="留空不改名，例如：论文训练机"/></label>
    <label>SSH 登录指令<input className="autodl-ssh-command" required autoComplete="off" spellCheck={false} value={command} disabled={busy} onChange={event => setCommand(event.target.value)} placeholder="ssh -p 14325 root@connect.bjb3.seetacloud.com"/></label>
    <label>{mode === "add" ? "实例密码" : "更新实例密码（可选）"}<input required={mode === "add"} type="password" autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} placeholder={mode === "add" ? "填写 SSH 登录密码" : "留空保留当前会话密码"}/></label>
    {mode === "edit" && selected && selected.auth !== "password" && <p className="autodl-dialog-hint">当前使用私钥或 SSH Agent；填写新密码将切换为密码认证，留空保留原认证方式。</p>}
    <p className="autodl-dialog-hint">主机名仅用于平台显示。密码仅存本次服务内存，不会回显；更换连接后需重新核对指纹并提供对应密码。</p>
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !command.trim() || (mode === "add" ? !password : !selectedId)}>{busy && <LoaderCircle size={14} className="spin"/>}{busy ? "正在保存…" : "保存实例"}</button></div>
  </form></div>, document.body);
}
