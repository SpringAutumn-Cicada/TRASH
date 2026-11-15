import { DirectoryPicker } from "./directory-picker.js";
import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useState } from "react";
import { ModalLayer } from "./modal-layer.js";
import { X } from "lucide-react";
import type { ResearchProject } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { readPreference, writePreference, useUnsavedChanges } from "./navigation.js";

export function CreateProjectDialog({onClose,onCreated}:{onClose:()=>void;onCreated:(project:ResearchProject)=>void}) {
  const [area,setArea]=useState(""),[interests,setInterests]=useState("");const [title,setTitle]=useState("");const [question,setQuestion]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const [root,setRoot]=useState(()=>readPreference('trash-workspace-root')??''),[folder,setFolder]=useState(''),[picker,setPicker]=useState(false);
  useEffect(()=>{if(!root)void api<{defaultRoot:string}>('/workspace/defaults').then(value=>setRoot(value.defaultRoot)).catch(()=>{});},[]);
  useUnsavedChanges(Boolean(title||area||interests||question||folder));
  const close=()=>{if(!busy&&(!(title||area||interests||question)||window.confirm("放弃尚未保存的新项目内容吗？")))onClose();};
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try {const data=await api<{project:ResearchProject}>("/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title,research_question:question,research_area:area,research_interests:interests.split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean),research_stage:question.trim()?"focused":"exploration",module:{id:"apt-provenance",version:"0.1.0"},workspace:{root:root||undefined,name:folder||title.trim().replace(/[\\/:*?"<>|]/g,"_")}})});if(root)writePreference("trash-workspace-root",root);setTitle("");setQuestion("");onCreated(data.project);}
    catch(cause){setError(uiError(cause,"创建项目失败，请重试。"));}finally{setBusy(false);}
  };
  return <ModalLayer><div className="modal-backdrop" onKeyDown={e=>{if(!picker&&e.key==="Escape")close();}}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={event=>{if(event.target===event.currentTarget)void submit(event);}}>
    <div className="modal-heading"><div><h2 id="create-title">新建研究项目</h2><p>先从研究领域开始，也可以暂不确定研究问题。</p></div><button type="button" className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={17}/></button></div>
    <label>项目名称<input autoFocus required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：基于溯源图的 APT 检测"/></label>
    <label>研究领域<input required maxLength={500} value={area} onChange={e=>setArea(e.target.value)} placeholder="例如：APT检测与溯源"/></label><label>关注线索（可选，逗号分隔）<input value={interests} onChange={e=>setInterests(e.target.value)}/></label><label>当前研究问题（可选）<textarea maxLength={2000} rows={4} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="尚未确定可留空，后续通过文献探索多个方向。"/></label>
    <label>工作区根目录<input value={root} onChange={event=>setRoot(event.target.value)} placeholder="留空使用平台默认工作区根目录"/></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={()=>setPicker(true)}>选择根目录</button>
    <label>项目文件夹名称<input maxLength={120} value={folder} onChange={event=>setFolder(event.target.value)} placeholder={title.trim().replace(/[\\/:*?"<>|]/g,'_')||'默认使用项目名称'}/></label>
    <p>项目路径：<code className="workspace-path">{root||'默认工作区根目录'}/{folder||title.trim().replace(/[\\/:*?"<>|]/g,'_')||'项目文件夹'}</code></p>
    {picker&&<DirectoryPicker base="/api/v1/workspace" title="选择工作区根目录" initialPath={root} gitEnabled={false} onClose={()=>setPicker(false)} onSelect={path=>{setRoot(path);setPicker(false);}}/>}
    <label>研究模块<select disabled><option>APT 检测与溯源 · 0.1.0</option></select></label>
    {error&&<ErrorNotice className="notice error-notice" >{error}</ErrorNotice>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button className="primary-button" disabled={busy}>{busy?"正在创建…":"创建项目"}</button></div>
  </form></div></ModalLayer>;
}
export function DeleteProjectDialog({project,onClose,onDeleted}:{project:ResearchProject;onClose:()=>void;onDeleted:(cleanupPending:boolean)=>void}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try {const data=await api<{cleanup_pending:boolean}>(`/projects/${encodeURIComponent(project.project_id)}`,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({confirm_title:project.title})});onDeleted(data.cleanup_pending);}
    catch(cause){setError(uiError(cause,"删除项目失败，请重试。"));}finally{setBusy(false);}
  };
  return <ModalLayer><div className="modal-backdrop" onKeyDown={e=>{if(e.key==="Escape"&&!busy)onClose();}}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onSubmit={event=>{if(event.target===event.currentTarget)void submit(event);}}>
    <h2 id="delete-title">删除项目</h2><p>将永久删除“{project.title}”及其文献、卡片、Wiki、实验结果和任务记录。用户选择的独立项目目录会保留，可在确认备份后手动清理。此操作无法撤销，建议先导出项目知识包。外部引用文件不受影响。</p>
    {error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
    <div className="modal-actions"><button autoFocus type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button project-delete-confirm" disabled={busy}>{busy?"正在删除…":"确认永久删除"}</button></div>
  </form></div></ModalLayer>;
}
