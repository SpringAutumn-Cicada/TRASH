import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, Server, X, Plus, Pencil } from "lucide-react";
import type { SshProfile } from "@trash/protocol";
import type { TerminalSession } from "./autodl-terminal.js";
import { ModalLayer } from "./modal-layer.js";
import { ErrorNotice } from "./error-notice.js";
import { AutoDlInstanceDialog } from "./autodl-instance-dialog.js";
import { AutoDlDeleteDialog } from "./autodl-delete-dialog.js";

type Profile=SshProfile&{credential_available?:boolean};
const errors:Record<string,string>={SSH_FINGERPRINT_REQUIRED:"请先探测并核对主机指纹。",SSH_FINGERPRINT_CHANGED:"主机指纹已改变，请先重新核对。",SSH_FINGERPRINT_NOT_OBSERVED:"请先探测主机指纹再确认信任。",SSH_AUTH_FAILED:"认证失败，请检查用户名和密码。",SSH_NETWORK_FAILED:"无法连接主机，请检查实例状态与网络。",SSH_CONNECTION_FAILED:"SSH 连接失败，请检查实例地址与端口。",SSH_CREDENTIAL_REQUIRED:"请补充 SSH 认证信息。",SSH_KEY_REQUIRED:"实例尚未配置私钥路径。",SSH_AGENT_UNAVAILABLE:"本机 SSH Agent 不可用。",TERMINAL_CONNECTING:"正在连接，请稍候。",SSH_TERMINAL_FAILED:"无法创建远端 Shell，请检查实例状态。",SSH_COMMAND_TIMEOUT:"远端操作超时。",EXPERIMENT_ACTIVE:"存在未结束实验，暂不能删除。",NOT_FOUND:"接口尚未加载，请重启后端后再试。"};
export function AutoDlConnectionDialog({projectId,onClose}:{projectId:string;onClose:()=>void}){
 const base=`/api/v1/projects/${encodeURIComponent(projectId)}`;
 const [profiles,setProfiles]=useState<Profile[]>([]),[selected,setSelected]=useState(""),[sessions,setSessions]=useState<TerminalSession[]>([]);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState(""),[fingerprint,setFingerprint]=useState(""),[password,setPassword]=useState(""),[passphrase,setPassphrase]=useState(""),[diagnostic,setDiagnostic]=useState("");
 const [editing,setEditing]=useState<"add"|"edit">(),[deleting,setDeleting]=useState<SshProfile>();
 const modal=useRef<HTMLDivElement>(null),alive=useRef(true);
 const profile=profiles.find(item=>item.profile_id===selected),connected=sessions.some(item=>item.profile_id===selected);
 const call=async<T,>(path:string,body?:unknown,method=body===undefined?"GET":"POST",headers?:Record<string,string>,signal?:AbortSignal):Promise<T>=>{const response=await fetch(base+path,{method,signal,cache:"no-store",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(errors[value.error]??`操作失败（${value.error??response.status}），请检查主机连接。`);return value;};
 const load=async(signal?:AbortSignal)=>{const [hosts,terminals]=await Promise.all([call<{profiles:Profile[]}>("/ssh-profiles",undefined,"GET",undefined,signal),call<{terminals:TerminalSession[]}>("/terminals",undefined,"GET",undefined,signal)]);if(!alive.current||signal?.aborted)return;setProfiles(hosts.profiles);setSessions(terminals.terminals);setSelected(old=>hosts.profiles.some(item=>item.profile_id===old)?old:terminals.terminals[0]?.profile_id??hosts.profiles[0]?.profile_id??"");};
 const changed=()=>window.dispatchEvent(new CustomEvent("trash-autodl-changed",{detail:{projectId}}));
 useEffect(()=>{alive.current=true;const controller=new AbortController(),previous=document.activeElement;modal.current?.querySelector<HTMLButtonElement>("button")?.focus();void load(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"读取主机失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>{alive.current=false;controller.abort();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[projectId]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");setNotice("");try{await work();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:"操作失败");}finally{if(alive.current)setBusy(false);}};
 const connect=()=>run(async()=>{
  if(!profile)return;
  const current=await call<{terminals:TerminalSession[]}>("/terminals");
  if(current.terminals.some(item=>item.profile_id===selected)){setSessions(current.terminals);setNotice("此主机已连接，无需重复建立 SSH。");return;}
  if(current.terminals.length)throw new Error("已有其他主机连接，请先取消连接再切换主机。");
  if(password||passphrase)await call(`/ssh-profiles/${selected}/credentials`,profile.auth==="password"?{password}:{passphrase},"PUT");
  setPassword("");setPassphrase("");await call(`/ssh-profiles/${selected}/connect`,{confirm:true});changed();await load();setNotice("已连接，可关闭弹窗后进入 AutoDL 工作区操作终端。");
 });
 const disconnect=()=>run(async()=>{const current=await call<{terminals:TerminalSession[]}>("/terminals");for(const session of current.terminals.filter(item=>item.profile_id===selected))await call(`/terminals/${session.id}`,undefined,"DELETE",{"x-terminal-token":session.token});changed();await load();setNotice("已取消所选主机的 SSH 连接。");});
 return <><ModalLayer><div className="modal-backdrop"><div ref={modal} className="modal autodl-connection-dialog" role="dialog" aria-modal="true" aria-labelledby="autodl-connection-title" aria-busy={busy} onKeyDown={event=>{
  if(editing||deleting)return;
  if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!busy)onClose();}
  if(event.key==="Tab"){const items=Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')??[]);const first=items[0],last=items[items.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}><div className="modal-heading"><div><h2 id="autodl-connection-title"><Server size={21}/>AutoDL 连接</h2><p>选择项目实例，连接后在各模块中共用 SSH。</p></div><button type="button" className="icon-button" aria-label="关闭AutoDL连接" disabled={busy} onClick={onClose}><X size={18}/></button></div>
 <div className="knowledge-toolbar"><button type="button" className="secondary-button" disabled={busy||loading} onClick={()=>setEditing("add")}><Plus size={14}/>添加已有实例</button><button type="button" className="secondary-button" disabled={busy||loading||!profiles.length} onClick={()=>setEditing("edit")}><Pencil size={14}/>编辑已有实例</button></div>
 {loading?<p role="status">正在读取主机…</p>:<label>选择主机<select value={selected} disabled={busy} onChange={event=>{setSelected(event.target.value);setFingerprint("");setPassword("");setPassphrase("");setError("");setNotice("");setDiagnostic("");}}><option value="">请选择实例</option>{profiles.map(item=><option key={item.profile_id} value={item.profile_id}>{item.name} · {item.host}:{item.port}{sessions.some(session=>session.profile_id===item.profile_id)?" · 已连接":""}</option>)}</select></label>}
 {!loading&&!profiles.length&&<p>暂无实例，请添加已有实例。</p>}
 {profile&&<><div className="autodl-connection-summary"><strong>{profile.name}</strong><span>{profile.username}@{profile.host}:{profile.port}</span><span className={connected?"connected":""}>{connected?"SSH 已连接":"尚未连接"}</span></div><details><summary>主机指纹与认证</summary><p>已信任指纹：{profile.fingerprint??"尚未确认"}</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{const value=await call<{fingerprint:string}>(`/ssh-profiles/${selected}/fingerprint`,{});setFingerprint(value.fingerprint);})}>探测主机指纹</button>{fingerprint&&<><code>{fingerprint}</code><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await call(`/ssh-profiles/${selected}/trust`,{fingerprint,confirm:true});setFingerprint("");await load();setNotice("已确认主机指纹。");})}>已核对，信任此指纹</button></>}{profile.auth==="password"&&!profile.credential_available&&<label>补充 SSH 密码<input type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>}{profile.auth==="key"&&<label>私钥口令<input type="password" autoComplete="new-password" value={passphrase} onChange={event=>setPassphrase(event.target.value)}/></label>}</details><button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{const value=await call<{environment:unknown}>(`/ssh-profiles/${selected}/diagnostics`,{});setDiagnostic(JSON.stringify(value.environment,null,2));})}>环境诊断</button></>}
 {error&&<ErrorNotice>{error}</ErrorNotice>}{notice&&<p role="status" className="notice">{notice}</p>}{diagnostic&&<pre>{diagnostic}</pre>}
 <div className="modal-actions">{connected?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>取消连接</button>:<button type="button" className="primary-button" disabled={busy||loading||!profile} onClick={()=>void connect()}>{busy?<LoaderCircle size={14} className="spin"/>:<Server size={14}/>}连接</button>}<button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div></div></div></ModalLayer>
 {editing&&<AutoDlInstanceDialog projectId={projectId} mode={editing} profiles={profiles} initialId={selected} onClose={()=>setEditing(undefined)} onDelete={item=>{setEditing(undefined);setDeleting(item);}} onSaved={item=>{setEditing(undefined);setSelected(item.profile_id);changed();void run(load);}}/>}
 {deleting&&<AutoDlDeleteDialog projectId={projectId} profile={deleting} onClose={()=>setDeleting(undefined)} onDeleted={()=>{setDeleting(undefined);changed();void run(load);}}/>}
 </>;
}
