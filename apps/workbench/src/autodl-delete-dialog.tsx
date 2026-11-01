import React, { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { SshProfile } from "@trash/protocol";
import { ModalLayer } from "./modal-layer.js";
import { ErrorNotice } from "./error-notice.js";

export function AutoDlDeleteDialog({projectId,profile,onClose,onDeleted}:{projectId:string;profile:SshProfile;onClose:()=>void;onDeleted:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState("");const modal=useRef<HTMLDivElement>(null);
 useEffect(()=>{const previous=document.activeElement;modal.current?.querySelector<HTMLButtonElement>("button")?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 const remove=async()=>{
  if(busy)return;setBusy(true);setError("");
  try{
   const response=await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/ssh-profiles/${encodeURIComponent(profile.profile_id)}`,{method:"DELETE"});
   const data=await response.json();if(!response.ok)throw new Error(({TERMINAL_PROFILE_BUSY:"该实例仍有 SSH 连接，请先取消连接再删除。",EXPERIMENT_ACTIVE:"该实例有未结束的实验，请先处理实验再删除。",REPRODUCTION_BUSY:"当前项目正在上传或部署，请等待操作结束再删除实例。",SSH_CREDENTIAL_STORE_FAILED:"删除本机密码失败，请检查凭据目录权限。"} as Record<string,string>)[data.error]??"删除实例失败，请刷新后重试。");
   onDeleted();
  }catch(cause){setError(cause instanceof Error?cause.message:"删除失败");}finally{setBusy(false);}
 };
 return <ModalLayer><div className="modal-backdrop"><div ref={modal} className="modal autodl-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="autodl-delete-title" aria-busy={busy} onKeyDown={event=>{
  if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!busy)onClose();}
  if(event.key==="Tab"){const items=Array.from(modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const first=items[0],last=items[items.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}><h2 id="autodl-delete-title"><Trash2 size={20}/>删除 AutoDL 实例</h2><strong>{profile.name}</strong><p>{profile.username}@{profile.host}:{profile.port}</p><p>将删除 TRASH 中的实例配置和已保存密码。不会关闭或释放 AutoDL 实例，不删除远端代码、环境及文件。</p>{error&&<ErrorNotice>{error}</ErrorNotice>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button project-delete-confirm" disabled={busy} onClick={()=>void remove()}>{busy?"正在删除…":"确认删除"}</button></div></div></div></ModalLayer>;
}
