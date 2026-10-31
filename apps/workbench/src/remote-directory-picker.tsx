import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, LoaderCircle, X } from "lucide-react";
import { ModalLayer } from "./modal-layer.js";
type Listing={path:string;parent:string|null;directories:{name:string;path:string}[];truncated:boolean};
export function RemoteDirectoryPicker({projectId,profileId,hostName,initialPath,onClose,onSelect}:{projectId:string;profileId:string;hostName:string;initialPath:string;onClose:()=>void;onSelect:(path:string)=>void}){
 const [path,setPath]=useState(initialPath||"/"),[listing,setListing]=useState<Listing>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const modal=useRef<HTMLDivElement>(null),active=useRef<AbortController|null>(null);
 const open=async(target:string)=>{
  active.current?.abort();const controller=new AbortController();active.current=controller;setBusy(true);setError("");setListing(undefined);
  try{const response=await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/ssh-profiles/${encodeURIComponent(profileId)}/directories?${new URLSearchParams({path:target})}`,{signal:controller.signal,cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(({NOT_FOUND:"当前后端未提供远端目录浏览接口，请重启运行此分支的 TRASH 后端后再试；这不是 SSH 密码或目录错误。",SSH_PROFILE_NOT_FOUND:"所选主机配置已不存在，请关闭弹窗并刷新实例列表。",PROJECT_NOT_FOUND:"当前论文项目已不存在，请返回项目列表。",SSH_CREDENTIAL_REQUIRED:"请先保存实例密码。",SSH_FINGERPRINT_REQUIRED:"请先在 AutoDL 信息核对主机指纹。",SSH_FINGERPRINT_CHANGED:"主机指纹已变化，请核对主机身份。",REMOTE_DIRECTORY_READ_FAILED:"无法读取远端目录，请检查路径是否存在及访问权限。",REMOTE_DIRECTORY_INVALID:"请输入远端绝对路径，不使用上级跳转。"} as Record<string,string>)[data.error]??`读取失败（${data.error??response.status}），请检查 SSH 连接。`);if(!controller.signal.aborted){setListing(data);setPath(data.path);}}
  catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"读取目录失败。");}
  finally{if(!controller.signal.aborted)setBusy(false);}
 };
 useEffect(()=>{const previous=document.activeElement;modal.current?.focus();void open(initialPath||"/");return()=>{active.current?.abort();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[profileId,projectId]);
 return <ModalLayer><div className="modal-backdrop directory-picker-backdrop"><div ref={modal} tabIndex={-1} className="modal directory-picker" role="dialog" aria-modal="true" aria-labelledby="remote-directory-title" onKeyDown={event=>{
  if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onClose();}
  if(event.key==="Tab"){const items=Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]),first=items[0],last=items[items.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===modal.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}><div className="modal-heading"><div><h2 id="remote-directory-title">选择 AutoDL 远端目录</h2><p>目标主机：{hostName}；仅浏览，不创建或修改文件。</p></div><button type="button" className="icon-button" aria-label="关闭远端目录选择" onClick={onClose}><X size={17}/></button></div>
 <form className="directory-location" onSubmit={event=>{event.preventDefault();void open(path);}}><input aria-label="远端目录路径" value={path} disabled={busy} onChange={event=>setPath(event.target.value)} placeholder="输入远端绝对路径"/><button className="secondary-button" disabled={busy||!path.trim()}>进入</button></form>
 <div className="directory-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>void open("/")}>根目录</button><button type="button" className="secondary-button" disabled={busy||!listing?.parent} onClick={()=>listing?.parent&&void open(listing.parent)}><ArrowUp size={14}/>上一级</button></div>
 {error&&<p role="alert" className="notice error-notice">{error}</p>}
 <div className="directory-list" aria-label="远端子目录" aria-busy={busy}>{busy?<p role="status"><LoaderCircle size={14} className="spin"/>正在读取远端目录…</p>:listing?.directories.map(entry=><button type="button" className="directory-entry" key={entry.path} onClick={()=>void open(entry.path)}><Folder size={16}/><span>{entry.name}</span><span aria-hidden="true">›</span></button>)}{listing&&!listing.directories.length&&<p>此目录下没有可浏览的子目录。</p>}</div>
 {listing?.truncated&&<p role="status">目录过多，仅显示前 2000 项，可输入完整路径进入。</p>}<p className="directory-selection">当前目录：{listing?.path??"尚未读取成功"}</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy||!listing||path!==listing.path} onClick={()=>listing&&onSelect(listing.path)}>选择此目录</button></div>
 </div></div></ModalLayer>;
}
