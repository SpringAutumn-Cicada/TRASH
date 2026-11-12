import React, { useEffect, useRef, useState } from 'react';
import type { ResearchProject } from '@trash/protocol';
import { FolderOpen, Settings2, X } from 'lucide-react';
import { ModalLayer } from './modal-layer.js';
import { DirectoryPicker } from './directory-picker.js';
import { ErrorNotice } from './error-notice.js';
import { api, uiError } from './api.js';
import { useUnsavedChanges } from './navigation.js';

type Migration={id:string;status:string;files:number;bytes:number;totalFiles:number;totalBytes:number;source:string;target:string;backup?:string;externalLinks:string[];error?:string;stage:string};
type Workspace={backups:{id:string;path:string}[];externalReferences:string[];path:string;configured:boolean;defaultRoot:string;folder:string;migration:Migration|null};
const states:Record<string,string>={copying:'复制工作区',verifying:'校验文件',switching:'切换目录',completed:'迁移完成',failed:'迁移失败',interrupted:'迁移已中断'};
export function ProjectWorkspaceDialog({projectId,projectTitle,onUpdated,onClose,onBrowse}:{projectId:string;projectTitle:string;onUpdated:(project:ResearchProject)=>void;onClose:()=>void;onBrowse:()=>void}){
  const [workspace,setWorkspace]=useState<Workspace>(),[root,setRoot]=useState(''),[name,setName]=useState(''),[picker,setPicker]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[dirty,setDirty]=useState(false),[confirmCleanup,setConfirmCleanup]=useState<string>();
  const [title,setTitle]=useState(projectTitle),[savedTitle,setSavedTitle]=useState(projectTitle),[saved,setSaved]=useState(false);
  const titleDirty=title.trim()!==savedTitle;
  const initialized=useRef(false),modal=useRef<HTMLFormElement>(null);
  const job=workspace?.migration,active=Boolean(job&&!['completed','failed','interrupted'].includes(job.status));
  useUnsavedChanges(titleDirty||dirty&&!active);
  useEffect(()=>{
    let alive=true;
    const load=()=>void api<Workspace>(`/projects/${encodeURIComponent(projectId)}/workspace`).then(value=>{if(alive){setWorkspace(value);if(!initialized.current){setRoot(value.defaultRoot);setName(value.folder);initialized.current=true;}}}).catch(cause=>{if(alive)setError(uiError(cause,'无法读取工作区。'));});
    const previous=document.activeElement;modal.current?.focus();
    load();const timer=window.setInterval(load,1500);return()=>{alive=false;window.clearInterval(timer);if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[projectId]);
  const call=async(path:string,body:unknown)=>{
    setBusy(true);setError('');
    try{await api(`/projects/${encodeURIComponent(projectId)}/workspace/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await api<Workspace>(`/projects/${encodeURIComponent(projectId)}/workspace`);setWorkspace(value);setDirty(false);setConfirmCleanup(undefined);}
    catch(cause){setError(uiError(cause,'工作区操作失败，请检查目录、权限及活动任务。'));}finally{setBusy(false);}
  };
  const saveName=async()=>{
    if(busy||!title.trim()||!titleDirty)return;
    setBusy(true);setError('');setSaved(false);
    try{const result=await api<{project:ResearchProject}>(`/projects/${encodeURIComponent(projectId)}`,{method:'PATCH',body:JSON.stringify({title:title.trim()})});setTitle(result.project.title);setSavedTitle(result.project.title);onUpdated(result.project);setSaved(true);}
    catch(cause){setError(uiError(cause,'项目名称保存失败，请重试。'));}finally{setBusy(false);}
  };
  return <ModalLayer><div className="modal-backdrop"><form ref={modal} tabIndex={-1} className="modal workspace-settings" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" onSubmit={event=>{event.preventDefault();if(event.target!==event.currentTarget)return;void saveName();}} onKeyDown={event=>{
      if(picker)return;
      if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}
      if(event.key==='Tab'){
        const controls=Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')??[]).filter(item=>item.getClientRects().length);
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===modal.current)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
    <div className="modal-heading"><div><span className="project-settings-eyebrow"><Settings2 size={14}/>项目设置</span><h2 id="workspace-settings-title">项目配置</h2></div><button type="button" className="icon-button" aria-label="关闭项目配置" disabled={busy} onClick={onClose}><X size={17}/></button></div>
    <div className="project-settings-body">
    <section className="project-settings-section"><h3>基本信息</h3><p>设置项目在导航与项目列表中显示的名称。</p><label>项目名称<input required maxLength={120} value={title} disabled={busy} onChange={event=>{setTitle(event.target.value);setSaved(false);}}/></label><div className="project-name-actions"><small>{saved?'名称已保存':'更改名称不会移动项目文件夹。'}</small><button type="button" className="primary-button" disabled={busy||!title.trim()||!titleDirty} onClick={()=>void saveName()}>{busy?'正在保存…':'保存名称'}</button></div></section>
    {workspace?<><section className="project-settings-section"><h3>存储位置</h3><p>当前目录：<code className="workspace-path">{workspace.path}</code></p><p>{workspace.configured?'论文材料、卡片和 Wiki 已保存到项目目录。':'旧项目尚未设置完整工作区，选择根目录后将整理并迁移已有材料。'}</p>
    {workspace.externalReferences.length>0&&<details><summary>工作区外的引用保持原位置（{workspace.externalReferences.length}）</summary>{workspace.externalReferences.map(path=><p key={path}><code className="workspace-path">{path}</code></p>)}</details>}
    <button type="button" className="secondary-button" disabled={busy||active} onClick={onBrowse}><FolderOpen size={15}/>打开当前目录</button>
    </section><details className="project-settings-section project-migration" open={active||undefined}><summary>迁移工作区<span>更改存储目录</span></summary><p>仅在需要移动项目文件时设置。</p><label>新根目录<input required value={root} disabled={busy||active} onChange={event=>{setRoot(event.target.value);setDirty(true);}}/></label><button type="button" className="secondary-button" disabled={busy||active} onClick={()=>setPicker(true)}>选择根目录</button>
    <label>项目文件夹名称<input required maxLength={120} value={name} disabled={busy||active} onChange={event=>{setName(event.target.value);setDirty(true);}}/></label>
    <p>目标：<code className="workspace-path">{root.replace(/[\\/]$/,'')}/{name}</code></p><p>迁移全部项目文件并校验，成功后保留旧目录备份。工作区外的数据、仓库和远程文件保持引用。请先结束项目任务并断开 SSH 终端。</p>
    <button type="button" className="primary-button project-migrate-submit" disabled={busy||active||!workspace||!root.trim()||!name.trim()} onClick={()=>void call('migrate',{root,name,confirm:true})}>{busy?'正在提交…':active?'迁移进行中…':'迁移工作区'}</button></details>
    <section className="project-settings-section project-migration-history"><h3>迁移记录</h3>
    {job&&<div role="status"><strong>{states[job.status]??job.status}</strong><p>{job.files}/{job.totalFiles} 个文件 · {(job.bytes/1048576).toFixed(1)}/{(job.totalBytes/1048576).toFixed(1)} MiB</p>{active&&<progress max={Math.max(1,job.totalBytes)} value={job.bytes}/>}{job.error&&<p>{job.error}</p>}{job.backup&&<p>旧目录备份：<code className="workspace-path">{job.backup}</code></p>}{['failed','interrupted'].includes(job.status)&&<p>临时副本保留在：<code className="workspace-path">{job.stage}</code>。目标目录如已形成完整副本也会保留。原工作区继续使用；重试请选择新的空目标目录。</p>}{job.externalLinks.length>0&&<details><summary>保留 {job.externalLinks.length} 个外部符号链接</summary>{job.externalLinks.map(path=><p key={path}>{path}</p>)}</details>}

    </div>}
    {workspace.backups.length>0&&<details><summary>迁移备份（{workspace.backups.length}）</summary>{workspace.backups.map(backup=><div key={backup.id}><code className="workspace-path">{backup.path}</code>{confirmCleanup===backup.id?<><p>永久删除此旧目录？请先确认新目录内容完整，此操作无法撤销。</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>setConfirmCleanup(undefined)}>取消清理</button><button type="button" className="primary-button project-delete-confirm" disabled={busy||active} onClick={()=>void call('cleanup',{job_id:backup.id,confirm:true})}>确认清理旧目录</button></>:<button type="button" className="secondary-button" disabled={busy||active} onClick={()=>setConfirmCleanup(backup.id)}>清理旧目录</button>}</div>)}</details>}
    {!job&&!workspace.backups.length&&<p>暂无迁移记录。</p>}</section></>:<p>正在读取工作区…</p>}
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    </div><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    {picker&&<DirectoryPicker base="/api/v1/workspace" title="选择工作区根目录" initialPath={root} gitEnabled={false} onClose={()=>setPicker(false)} onSelect={path=>{setRoot(path);setDirty(true);setPicker(false);}}/>}
  </form></div></ModalLayer>;
}
