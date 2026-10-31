import React, { useState } from "react";
import { X } from "lucide-react";
import type { ResearchProject } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { useUnsavedChanges } from "./navigation.js";

export function CreateProjectDialog({onClose,onCreated}:{onClose:()=>void;onCreated:(project:ResearchProject)=>void}) {
  const [title,setTitle]=useState("");const [question,setQuestion]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  useUnsavedChanges(Boolean(title||question));
  const close=()=>{if(!busy&&(!(title||question)||window.confirm("放弃尚未保存的新项目内容吗？")))onClose();};
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try {const data=await api<{project:ResearchProject}>("/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title,research_question:question,module:{id:"apt-provenance",version:"0.1.0"}})});setTitle("");setQuestion("");onCreated(data.project);}
    catch(cause){setError(uiError(cause,"创建项目失败，请重试。"));}finally{setBusy(false);}
  };
  return <div className="modal-backdrop" onKeyDown={e=>{if(e.key==="Escape")close();}}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={event=>void submit(event)}>
    <div className="modal-heading"><div><h2 id="create-title">新建研究项目</h2><p>从研究问题开始整理文献与实验。</p></div><button type="button" className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={17}/></button></div>
    <label>项目名称<input autoFocus required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：基于溯源图的 APT 检测"/></label>
    <label>研究问题<textarea required minLength={5} maxLength={2000} rows={4} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="这个项目希望研究什么问题？"/></label>
    <label>研究模块<select disabled><option>APT 检测与溯源 · 0.1.0</option></select></label>
    {error&&<p className="notice error-notice" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button className="primary-button" disabled={busy}>{busy?"正在创建…":"创建项目"}</button></div>
  </form></div>;
}
export function DeleteProjectDialog({project,onClose,onDeleted}:{project:ResearchProject;onClose:()=>void;onDeleted:(cleanupPending:boolean)=>void}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try {const data=await api<{cleanup_pending:boolean}>(`/projects/${encodeURIComponent(project.project_id)}`,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({confirm_title:project.title})});onDeleted(data.cleanup_pending);}
    catch(cause){setError(uiError(cause,"删除项目失败，请重试。"));}finally{setBusy(false);}
  };
  return <div className="modal-backdrop" onKeyDown={e=>{if(e.key==="Escape"&&!busy)onClose();}}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onSubmit={event=>void submit(event)}>
    <h2 id="delete-title">删除项目</h2><p>将永久删除“{project.title}”及其文献、卡片、Wiki、实验结果、任务记录和工作区文件。此操作无法撤销，建议先导出项目知识包。外部引用文件不受影响。</p>
    {error&&<p role="alert" className="notice error-notice">{error}</p>}
    <div className="modal-actions"><button autoFocus type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button project-delete-confirm" disabled={busy}>{busy?"正在删除…":"确认永久删除"}</button></div>
  </form></div>;
}
