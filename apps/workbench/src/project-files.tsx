import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Download, File, FilePlus, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Save, Search, Trash2, Upload, X } from 'lucide-react';
import type { ProjectPage } from '@trash/protocol';
import { api, uiError } from './api.js';
import { Markdown } from './knowledge.js';
import { useUnsavedChanges } from './navigation.js';
import { ModalLayer } from './modal-layer.js';
import { DiscardChangesDialog } from './discard-changes-dialog.js';
import { ErrorNotice } from './error-notice.js';
import './project-files.css';

type Entry={name:string;path:string;kind:'directory'|'file'|'symlink';size:number;modified:string;protected:boolean};
type Listing={root:string;path:string;entries:Entry[]};
type Preview={path:string;name:string;size:number;modified:string;kind:'text'|'pdf'|'image'|'binary';content?:string;etag?:string;editable:boolean;readonlyReason?:string;managed?:{kind:string;id:string;version:number}};
type Recycled={id:string;path:string;deletedAt:string};
type Action={kind:'file'|'directory'|'rename'|'move'|'delete';entry?:Entry;fingerprint?:string};
const parent=(path:string)=>path.split('/').slice(0,-1).join('/');
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1048576).toFixed(1)} MiB`;
const childPath=(directory:string,name:string)=>directory?directory+'/'+name:name;
function FolderNode({path,label,depth=0,base,revision,hidden,directory,selected,onDirectory,onFile,onError}:{path:string;label:string;depth?:number;base:string;revision:number;hidden:boolean;directory:string;selected?:string;onDirectory:(path:string)=>void;onFile:(path:string)=>void;onError:(message:string)=>void}){
  const [expanded,setExpanded]=useState(path===''),[listing,setListing]=useState<Listing>(),[loading,setLoading]=useState(false);
  useEffect(()=>{if(path===''||directory===path||directory.startsWith(path+'/'))setExpanded(true);},[directory,path]);
  useEffect(()=>{
    if(!expanded)return;let alive=true;setLoading(true);
    void api<Listing>(`${base}?path=${encodeURIComponent(path)}&hidden=${hidden}`).then(value=>{if(alive)setListing(value);}).catch(cause=>{if(alive)onError(uiError(cause,'目录读取失败。'));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[base,path,expanded,revision,hidden]);
  return <div className="paper-file-node"><div className={`paper-file-tree-row ${directory===path?'active':''}`} style={{paddingLeft:depth*15+5}}>
    <button type="button" className="icon-button" aria-label={`${expanded?'折叠':'展开'} ${label}`} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>
    <button type="button" onClick={()=>onDirectory(path)}><Folder size={15}/><span>{label}</span></button>
  </div>{expanded&&<div>{loading?<p className="quiet">正在读取…</p>:listing?.entries.map(entry=>entry.kind==='directory'?<FolderNode key={entry.path} path={entry.path} label={entry.name} depth={depth+1} base={base} revision={revision} hidden={hidden} directory={directory} selected={selected} onDirectory={onDirectory} onFile={onFile} onError={onError}/>:<button type="button" key={entry.path} style={{paddingLeft:(depth+1)*15+30}} className={`paper-file-leaf ${selected===entry.path?'active':''}`} disabled={entry.kind==='symlink'} title={entry.kind==='symlink'?'符号链接：不跟随访问外部内容':entry.path} onClick={()=>onFile(entry.path)}><File size={14}/><span>{entry.name}</span>{entry.kind==='symlink'&&<small>链接</small>}</button>)}</div>}</div>;
}
export function ProjectFilesPage({projectId,focusId,onNavigate}:{projectId:string;focusId?:string;onNavigate:(page:ProjectPage,options?:{focus?:string})=>void}){
  const base=`/projects/${encodeURIComponent(projectId)}/files`;
  const [directory,setDirectory]=useState(''),[listing,setListing]=useState<Listing>(),[preview,setPreview]=useState<Preview>(),[draft,setDraft]=useState(''),[editing,setEditing]=useState(false),[hidden,setHidden]=useState(false),[revision,setRevision]=useState(0),[query,setQuery]=useState(''),[results,setResults]=useState<Entry[]>(),[truncated,setTruncated]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[action,setAction]=useState<Action>(),[recycleOpen,setRecycleOpen]=useState(false),[pending,setPending]=useState<(()=>void)>();
  const requestId=useRef(0),alive=useRef(true);
  const dirty=Boolean(preview&&draft!==preview.content&&preview.content!==undefined);
  const clearDirty=useUnsavedChanges(dirty);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;requestId.current++;};},[]);
  const guard=(next:()=>void)=>{if(dirty)setPending(()=>next);else next();};
  const reload=()=>setRevision(value=>value+1);
  useEffect(()=>{
    let active=true;
    void api<Listing>(`${base}?path=${encodeURIComponent(directory)}&hidden=${hidden}`).then(value=>{if(active)setListing(value);}).catch(cause=>{if(active)setError(uiError(cause,'无法读取工作区，请先在本地工作区设置中配置目录。'));});
    return()=>{active=false;};
  },[base,directory,hidden,revision]);
  const openFile=async(path:string)=>{
    const id=++requestId.current;setError('');setLoading(true);
    try{const value=await api<Preview>(`${base}/preview?path=${encodeURIComponent(path)}`);if(alive.current&&id===requestId.current){setPreview(value);setDraft(value.content??'');setEditing(false);setDirectory(parent(path));clearDirty();}}
    catch(cause){if(alive.current&&id===requestId.current)setError(uiError(cause,'文件预览失败。'));}
    finally{if(alive.current&&id===requestId.current)setLoading(false);}
  };
  useEffect(()=>{if(focusId)void openFile(focusId);},[focusId]);
  const openDirectory=(path:string)=>{if(busy)return;guard(()=>{requestId.current++;setLoading(false);setDirectory(path);setPreview(undefined);setDraft('');setEditing(false);setResults(undefined);clearDirty();});};
  const selectFile=(path:string)=>{if(!busy)guard(()=>void openFile(path));};
  const mutate=async(kind:string,body:unknown)=>api(`${base}/${kind}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const startAction=(kind:Action['kind'],entry?:Entry)=>guard(()=>{
    const open=async()=>{
      setError('');setBusy(true);
      try{const value=entry?await api<{fingerprint:string}>(`${base}/inspect?path=${encodeURIComponent(entry.path)}`):undefined;if(alive.current)setAction({kind,entry,fingerprint:value?.fingerprint});}
      catch(cause){setError(uiError(cause,'无法读取文件状态。'));}finally{setBusy(false);}
    };void open();
  });
  const save=async()=>{
    if(!preview||!preview.etag)return;
    setBusy(true);setError('');
    try{
      const value=await api<Preview>(`${base}/save`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:preview.path,etag:preview.etag,content:draft,version:preview.managed?.version})});
      if(alive.current){setPreview(value);setDraft(value.content??'');clearDirty();setNotice(value.managed?'已保存新的草稿版本。':'文件已保存。');reload();}
    }catch(cause){setError(uiError(cause,'保存失败，编辑内容已保留。'));}finally{setBusy(false);}
  };
  const upload=async(files:FileList|null)=>{
    if(!files?.length)return;setBusy(true);setError('');
    const uploaded:string[]=[];
    try{for(const file of Array.from(files)){
      if(file.size>50*1048576)throw new Error('FILES_TOO_LARGE');
      const response=await fetch(`/api/v1${base}/upload?path=${encodeURIComponent(childPath(directory,file.name))}`,{method:'POST',body:file});
      if(!response.ok){const data=await response.json();throw new Error(data.error??'INTERNAL_ERROR');}uploaded.push(file.name);
    }setNotice(`已上传 ${uploaded.length} 个文件。`);}
    catch(cause){setError(uiError(cause,`上传失败，已成功保存 ${uploaded.length} 个文件；同名文件不会覆盖。`));}finally{setBusy(false);reload();}
  };
  const search=async(event:React.FormEvent)=>{
    event.preventDefault();setBusy(true);setError('');
    try{const value=await api<{entries:Entry[];truncated:boolean}>(`${base}/search?q=${encodeURIComponent(query)}&hidden=${hidden}`);setResults(value.entries);setTruncated(value.truncated);}
    catch(cause){setError(uiError(cause,'文件名搜索失败。'));}finally{setBusy(false);}
  };
  const entries=results??listing?.entries??[];
  const contentUrl=preview?`/api/v1${base}/content?path=${encodeURIComponent(preview.path)}`:'';
  const selected=preview?entries.find(entry=>entry.path===preview.path)??{path:preview.path,name:preview.name,kind:'file' as const,size:preview.size,modified:preview.modified,protected:!preview.editable||Boolean(preview.managed)}:undefined;
  return <section className="paper-files-page">
    <div className="section-heading"><div><h2><FolderOpen size={22}/> 项目文件</h2><p>浏览论文工作区，预览文献、图片和稿件，管理普通文件。</p></div><button type="button" className="secondary-button" disabled={busy} onClick={()=>guard(()=>{reload();if(preview)void openFile(preview.path);})}><RefreshCw size={15}/>刷新</button></div>
    <code className="paper-files-root">{listing?.root??'正在读取工作区路径…'}</code>
    <div className="paper-files-toolbar"><button type="button" className="secondary-button" disabled={busy||!directory} onClick={()=>openDirectory(parent(directory))}><ArrowUp size={14}/>上一级</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('file')}><FilePlus size={14}/>新建文件</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('directory')}><FolderPlus size={14}/>新建文件夹</button><label className="secondary-button upload-button"><Upload size={14}/>上传文件<input aria-label="上传项目文件" type="file" multiple disabled={busy} onChange={event=>{void upload(event.target.files);event.currentTarget.value='';}}/></label><button type="button" className="secondary-button" disabled={busy} onClick={()=>setRecycleOpen(true)}><Trash2 size={14}/>回收站</button><label><input type="checkbox" checked={hidden} onChange={event=>setHidden(event.target.checked)}/>显示隐藏项</label></div>
    <nav className="paper-files-breadcrumb" aria-label="项目目录路径"><button type="button" onClick={()=>openDirectory('')}>工作区</button>{directory.split('/').filter(Boolean).map((part,index,array)=><React.Fragment key={index}><span>/</span><button type="button" onClick={()=>openDirectory(array.slice(0,index+1).join('/'))}>{part}</button></React.Fragment>)}</nav>
    <form className="paper-file-search" onSubmit={event=>void search(event)}><Search size={15}/><input aria-label="搜索项目文件名" placeholder="按文件名搜索整个工作区" value={query} onChange={event=>setQuery(event.target.value)}/><button className="secondary-button" disabled={busy||!query.trim()}>搜索</button>{results&&<button type="button" className="text-button" onClick={()=>{setResults(undefined);setQuery('');}}>清除搜索</button>}</form>
    {error&&<ErrorNotice>{error}</ErrorNotice>}{notice&&<p role="status">{notice}</p>}
    <div className="paper-files-layout"><aside className="paper-files-tree" aria-label="项目文件树"><FolderNode path="" label="论文工作区" base={base} revision={revision} hidden={hidden} directory={directory} selected={preview?.path} onDirectory={openDirectory} onFile={selectFile} onError={setError}/></aside>
    <div className="paper-files-content" aria-busy={loading}>
      {loading?<p role="status">正在读取文件…</p>:preview?<>
        <div className="paper-file-heading"><div><h3>{preview.name}{dirty?' *':''}</h3><p>{size(preview.size)} · {new Date(preview.modified).toLocaleString()}</p><code>{preview.path}</code></div><button type="button" className="icon-button" aria-label="关闭文件预览" onClick={()=>openDirectory(directory)}><X size={16}/></button></div>
        <div className="paper-files-toolbar"><a className="secondary-button" href={contentUrl+'&download=true'} download><Download size={14}/>下载</a>{preview.editable&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>setEditing(!editing)}><Pencil size={14}/>{editing?'预览':'编辑源码'}</button>}{dirty&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void save()}><Save size={14}/>保存{preview.managed?'新版本':''}</button>}{selected&&!selected.protected&&<><button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('rename',selected)}>重命名</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('move',selected)}>移动</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('delete',selected)}>移入回收站</button></>}</div>
        {preview.managed&&<p className="quiet">平台知识对象 v{preview.managed.version}，保存会校验证据并建立草稿版本。<button type="button" className="text-button" onClick={()=>guard(()=>onNavigate(preview.managed!.kind==='wiki-page'?'wiki':'cards',{focus:preview.managed!.id}))}>打开{preview.managed.kind==='wiki-page'?'Wiki':'卡片'}模块</button></p>}
        {preview.readonlyReason&&<p className="quiet">{preview.readonlyReason}</p>}
        {preview.kind==='pdf'?<iframe key={contentUrl} className="paper-pdf-preview" title={`PDF：${preview.name}`} src={contentUrl}/>:preview.kind==='image'?<img className="paper-image-preview" src={contentUrl} alt={preview.name}/>:preview.content!==undefined?editing?<textarea className="paper-file-editor" aria-label="文件源码" spellCheck={false} value={draft} onChange={event=>setDraft(event.target.value)}/>: /\.(md|markdown)$/i.test(preview.path)?<Markdown body={draft.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')}/>:<div className="paper-text-preview">{draft.split('\n').map((line,index)=><div key={index}><span>{index+1}</span><code>{line||' '}</code></div>)}</div>:<p>此文件为二进制、非 UTF-8 文本或超过 2 MiB，暂不在线编辑，可下载查看。</p>}
      </>:<>
        <h3>{results?'文件名搜索结果':directory||'工作区文件'}</h3>{truncated&&results&&<p>搜索结果已截断，请缩小文件名范围。</p>}
        <div className="paper-file-list">{entries.map(entry=><div key={entry.path}><button type="button" disabled={entry.kind==='symlink'} onClick={()=>entry.kind==='directory'?openDirectory(entry.path):selectFile(entry.path)}>{entry.kind==='directory'?<Folder size={17}/>:<File size={17}/>}<span><strong>{results?entry.path:entry.name}</strong><small>{entry.kind==='symlink'?'符号链接，不跟随访问':entry.kind==='directory'?'文件夹':size(entry.size)}{entry.protected?' · 平台管理':''}</small></span></button>{!entry.protected&&entry.kind!=='symlink'&&<div><button type="button" className="text-button" disabled={busy} onClick={()=>startAction('rename',entry)}>重命名</button><button type="button" className="text-button" disabled={busy} onClick={()=>startAction('move',entry)}>移动</button><button type="button" className="icon-button" aria-label={`移入回收站：${entry.name}`} disabled={busy} onClick={()=>startAction('delete',entry)}><Trash2 size={14}/></button></div>}</div>)}{entries.length===0&&<p>此处暂无可显示的文件。</p>}</div>
      </>}
    </div></div>
    {pending&&<DiscardChangesDialog onCancel={()=>setPending(undefined)} onConfirm={()=>{const next=pending;setPending(undefined);setDraft(preview?.content??'');clearDirty();next();}}/>}
    {action&&<FileActionDialog action={action} directory={directory} onClose={()=>setAction(undefined)} onSubmit={async(value)=>{
      const kind=action.kind==='file'||action.kind==='directory'?'create':action.kind==='delete'?'delete':'move';
      const body=kind==='create'?{path:childPath(directory,value),kind:action.kind}:kind==='delete'?{path:action.entry!.path,fingerprint:action.fingerprint,confirm:true}:{path:action.entry!.path,target:action.kind==='rename'?childPath(parent(action.entry!.path),value):value,fingerprint:action.fingerprint};
      await mutate(kind,body);setAction(undefined);setNotice('文件操作已完成。');setResults(undefined);setPreview(undefined);setDraft('');clearDirty();reload();
    }}/>}
    {recycleOpen&&<RecycleDialog base={base} onClose={()=>setRecycleOpen(false)} onRestored={()=>{reload();setNotice('文件已恢复。');}}/>}
  </section>;
}
function trapFileDialog(event:React.KeyboardEvent,modal:HTMLElement|null,busy:boolean,onClose:()=>void){
  if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}
  if(event.key==='Tab'){
    const items=Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===modal)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
}
function FileActionDialog({action,directory,onClose,onSubmit}:{action:Action;directory:string;onClose:()=>void;onSubmit:(value:string)=>Promise<void>}){
  const [value,setValue]=useState(action.kind==='rename'?action.entry!.name:action.kind==='move'?action.entry!.path:''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const modal=useRef<HTMLFormElement>(null);
  useEffect(()=>{const previous=document.activeElement;modal.current?.querySelector<HTMLElement>(action.kind==='delete'?'button':'input')?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
  const title={file:'新建文件',directory:'新建文件夹',rename:'重命名',move:'移动文件或文件夹',delete:'移入回收站'}[action.kind];
  return <ModalLayer><div className="modal-backdrop"><form ref={modal} className="modal" role="dialog" aria-modal="true" aria-labelledby="file-action-title" onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');void onSubmit(value).catch(cause=>setError(uiError(cause,'文件操作失败，请检查名称、权限或文件是否已变化。'))).finally(()=>setBusy(false));}} onKeyDown={event=>trapFileDialog(event,modal.current,busy,onClose)}><h2 id="file-action-title">{title}</h2>
    <p>{action.entry?.path??(directory||'工作区根目录')}</p>{action.kind==='delete'?<p>将此文件或文件夹移入项目回收站，可在回收站恢复。</p>:<label>{action.kind==='move'?'目标路径（相对工作区根目录）':'名称'}<input autoFocus required value={value} onChange={event=>setValue(event.target.value)} maxLength={4096}/></label>}
    {error&&<ErrorNotice>{error}</ErrorNotice>}<div className="modal-actions"><button type="button" autoFocus={action.kind==='delete'} className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>确认</button></div></form></div></ModalLayer>;
}
function RecycleDialog({base,onClose,onRestored}:{base:string;onClose:()=>void;onRestored:()=>void}){
  const [entries,setEntries]=useState<Recycled[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const modal=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement;modal.current?.querySelector<HTMLElement>('button')?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
  const load=async()=>setEntries((await api<{entries:Recycled[]}>(base+'/recycle')).entries);
  useEffect(()=>{let alive=true;void api<{entries:Recycled[]}>(base+'/recycle').then(value=>{if(alive)setEntries(value.entries);}).catch(cause=>{if(alive)setError(uiError(cause,'无法读取回收站。'));});return()=>{alive=false;};},[base]);
  return <ModalLayer><div className="modal-backdrop"><section ref={modal} className="modal paper-recycle-dialog" role="dialog" aria-modal="true" aria-labelledby="recycle-title" onKeyDown={event=>trapFileDialog(event,modal.current,busy,onClose)}><div className="modal-heading"><h2 id="recycle-title">项目回收站</h2><button type="button" className="icon-button" aria-label="关闭回收站" disabled={busy} onClick={onClose}><X size={16}/></button></div>{error&&<ErrorNotice>{error}</ErrorNotice>}{entries.map(entry=><div key={entry.id}><code>{entry.path}</code><small>{new Date(entry.deletedAt).toLocaleString()}</small><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setBusy(true);setError('');void api(base+'/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:entry.id})}).then(async()=>{await load();onRestored();}).catch(cause=>setError(uiError(cause,'恢复失败，原路径可能已被占用。'))).finally(()=>setBusy(false));}}>恢复</button></div>)}{!entries.length&&<p>回收站为空。</p>}<p>恢复不会覆盖原路径上的同名内容；请先恢复父文件夹。</p></section></div></ModalLayer>;
}
