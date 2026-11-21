import { ResearchFolders } from "./research-folders.js";
import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, Download, Eye, File, FileArchive, FileCode2, FileImage, FilePlus, FileText, Folder, FolderOpen, FolderPlus, FolderSearch, FolderTree, Link2, Move, Pencil, RefreshCw, Save, Search, Trash2, Upload, X } from 'lucide-react';
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
const manuscriptDocuments=(entry:Entry)=>entry.kind==='file'&&/\.(docx?|odt|pdf|tex|md|markdown|rtf)$/i.test(entry.name);
const fileLabel=(path:string,name:string)=>path==='library'&&name==='library'?'文献资料库':name;
const orderByName=new Intl.Collator('zh-CN',{numeric:true});
function FileGlyph({name,kind,expanded=false,size=16}:{name:string;kind:Entry['kind'];expanded?:boolean;size?:number}){
  if(kind==='directory')return expanded?<FolderOpen size={size} aria-hidden="true"/>:<Folder size={size} aria-hidden="true"/>;
  if(kind==='symlink')return <Link2 size={size} aria-hidden="true"/>;
  const extension=name.split('.').at(-1)?.toLowerCase()??'';
  const Icon=/^(png|jpg|jpeg|gif|webp|svg|bmp|tiff?)$/.test(extension)?FileImage
    :/^(md|markdown|txt|pdf|docx?|tex)$/.test(extension)?FileText
    :/^(py|js|jsx|ts|tsx|sh|json|ya?ml|toml|html|css)$/.test(extension)?FileCode2
    :/^(zip|tar|gz|7z|rar)$/.test(extension)?FileArchive:File;
  return <Icon size={size} aria-hidden="true"/>;
}
function FolderNode({path,label,depth=0,base,revision,hidden,directory,selected,onDirectory,onFile,onError}:{path:string;label:string;depth?:number;base:string;revision:number;hidden:boolean;directory:string;selected?:string;onDirectory:(path:string)=>void;onFile:(path:string)=>void;onError:(message:string)=>void}){
  const [expanded,setExpanded]=useState(path===''),[listing,setListing]=useState<Listing>(),[loading,setLoading]=useState(false);
  useEffect(()=>{if(path===''||directory===path||directory.startsWith(path+'/'))setExpanded(true);},[directory,path]);
  useEffect(()=>{
    if(!expanded)return;let alive=true;setLoading(true);
    void api<Listing>(`${base}?path=${encodeURIComponent(path)}&hidden=${hidden}`).then(value=>{if(alive)setListing(value);}).catch(cause=>{if(alive)onError(uiError(cause,'目录读取失败。'));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[base,path,expanded,revision,hidden]);
  return <div className="paper-file-node"><div className={`paper-file-tree-row ${directory===path&&!selected?'active':''}`} style={{paddingInlineStart:Math.min(depth,8)*12+4}}>
    <button type="button" className="icon-button" aria-label={`${expanded?'折叠':'展开'} ${label}`} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>
    <button type="button" title={label} aria-current={directory===path&&!selected?true:undefined} onClick={()=>onDirectory(path)}><FileGlyph name={label} kind="directory" expanded={expanded}/><span>{label}</span></button>
  </div>{expanded&&<div>{loading?<p className="quiet">正在读取…</p>:listing?.entries.map(entry=>entry.kind==='directory'?<FolderNode key={entry.path} path={entry.path} label={fileLabel(entry.path,entry.name)} depth={depth+1} base={base} revision={revision} hidden={hidden} directory={directory} selected={selected} onDirectory={onDirectory} onFile={onFile} onError={onError}/>:<button type="button" key={entry.path} style={{paddingInlineStart:Math.min(depth+1,8)*12+28}} className={`paper-file-leaf ${selected===entry.path?'active':''}`} aria-current={selected===entry.path?true:undefined} disabled={entry.kind==='symlink'} title={entry.kind==='symlink'?'符号链接：不跟随访问外部内容':entry.path} onClick={()=>onFile(entry.path)}><FileGlyph name={entry.name} kind={entry.kind} size={14}/><span>{entry.name}</span>{entry.kind==='symlink'&&<small>链接</small>}</button>)}</div>}</div>;
}
export function ProjectFilesPage({projectId,focusId,initialDirectory='',onNavigate}:{
  projectId:string;focusId?:string;initialDirectory?:string;onNavigate:(page:ProjectPage,options?:{focus?:string})=>void;
}){
  const base=`/projects/${encodeURIComponent(projectId)}/files`;
  const [directory,setDirectory]=useState(initialDirectory),[listing,setListing]=useState<Listing>(),[preview,setPreview]=useState<Preview>(),[draft,setDraft]=useState(''),[editing,setEditing]=useState(false),[hidden,setHidden]=useState(false),[revision,setRevision]=useState(0),[query,setQuery]=useState(''),[results,setResults]=useState<Entry[]>(),[truncated,setTruncated]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[action,setAction]=useState<Action>(),[recycleOpen,setRecycleOpen]=useState(false),[pending,setPending]=useState<(()=>void)>();
  const [listingLoading,setListingLoading]=useState(true);
  const requestId=useRef(0),alive=useRef(true);
  const dirty=Boolean(preview&&draft!==preview.content&&preview.content!==undefined);
  const clearDirty=useUnsavedChanges(dirty);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;requestId.current++;};},[]);
  const guard=(next:()=>void)=>{if(dirty)setPending(()=>next);else next();};
  const reload=()=>setRevision(value=>value+1);
  useEffect(()=>{
    let active=true;
    setListingLoading(true);
    void api<Listing>(`${base}?path=${encodeURIComponent(directory)}&hidden=${hidden}`)
      .then(value=>{if(active)setListing(value);})
      .catch(cause=>{if(active)setError(uiError(cause,'无法读取工作区，请先在本地工作区设置中配置目录。'));})
      .finally(()=>{if(active)setListingLoading(false);});
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
  const search=(event:React.FormEvent)=>{
    event.preventDefault();
    if(busy||loading||!query.trim())return;
    guard(()=>{
      setBusy(true);setError('');
      void api<{entries:Entry[];truncated:boolean}>(`${base}/search?q=${encodeURIComponent(query.trim())}&hidden=${hidden}`)
        .then(value=>{if(alive.current){setPreview(undefined);setDraft('');setEditing(false);setResults(value.entries);setTruncated(value.truncated);clearDirty();}})
        .catch(cause=>setError(uiError(cause,'文件名搜索失败。'))).finally(()=>setBusy(false));
    });
  };
  const currentListing=listing?.path===directory?listing:undefined;
  const entries=results??currentListing?.entries??[];
  const crumbs=directory.split('/').filter(Boolean);
  const manuscriptView=!results&&directory==='manuscript';
  const fileGroups=manuscriptView?[
    {label:'工作目录',entries:entries.filter(entry=>entry.kind==='directory')},
    {label:'文档与稿件',entries:entries.filter(manuscriptDocuments).sort((a,b)=>orderByName.compare(b.name,a.name))},
    {label:'其他文件',entries:entries.filter(entry=>entry.kind!=='directory'&&!manuscriptDocuments(entry))}
  ]:[{label:'',entries}];
  const contentUrl=preview?`/api/v1${base}/content?path=${encodeURIComponent(preview.path)}`:'';
  const selected=preview?entries.find(entry=>entry.path===preview.path)??{path:preview.path,name:preview.name,kind:'file' as const,size:preview.size,modified:preview.modified,protected:!preview.editable||Boolean(preview.managed)}:undefined;
  return <section className="paper-files-page">
    <header className="paper-files-header">
      <div className="paper-files-title">
        <span className="paper-files-symbol"><FolderOpen size={24} aria-hidden="true"/></span>
        <div>
          <h2>{directory==='manuscript'||directory.startsWith('manuscript/')?'论文稿件':'项目文件'}</h2>
          <code className="paper-files-root" title={listing?.root}>{listing?.root??'正在读取工作区路径…'}</code>
        </div>
      </div>
      <button type="button" className="secondary-button" disabled={busy} onClick={()=>guard(()=>{reload();if(preview)void openFile(preview.path);})}>
        <RefreshCw size={15} aria-hidden="true"/>刷新
      </button>
    </header>

    <div className="paper-files-commands">
      <div className="paper-files-toolbar" role="group" aria-label="文件操作">
        <label className={`primary-button upload-button${busy?' disabled':''}`}>
          <Upload size={15} aria-hidden="true"/>上传文件
          <input aria-label="上传项目文件" type="file" multiple disabled={busy} onChange={event=>{void upload(event.target.files);event.currentTarget.value='';}}/>
        </label>
        <button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('file')}>
          <FilePlus size={15} aria-hidden="true"/>新建文件
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('directory')}>
          <FolderPlus size={15} aria-hidden="true"/>新建文件夹
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={()=>setRecycleOpen(true)}>
          <Trash2 size={15} aria-hidden="true"/>回收站
        </button>
      </div>
      <label className="paper-files-hidden">
        <input type="checkbox" checked={hidden} onChange={event=>setHidden(event.target.checked)}/>显示内部与隐藏文件
      </label>
    </div>
    <ResearchFolders projectId={projectId} onCreated={reload}/>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {notice&&<p className="paper-files-notice" role="status">{notice}</p>}

    <div className="paper-files-explorer">
      <div className="paper-files-address">
        <div className="paper-files-location">
          <button type="button" className="paper-files-icon-button" aria-label="上一级" title="上一级" disabled={busy||!directory} onClick={()=>openDirectory(parent(directory))}>
            <ArrowUp size={16} aria-hidden="true"/>
          </button>
          <nav className="paper-files-breadcrumb" aria-label="项目目录路径">
            <button type="button" aria-current={crumbs.length===0?'location':undefined} onClick={()=>openDirectory('')}>工作区</button>
            {crumbs.map((part,index)=><React.Fragment key={index}>
              <ChevronRight size={12} aria-hidden="true"/>
              <button type="button" aria-current={index===crumbs.length-1?'location':undefined} onClick={()=>openDirectory(crumbs.slice(0,index+1).join('/'))}>{fileLabel(crumbs.slice(0,index+1).join('/'),part)}</button>
            </React.Fragment>)}
          </nav>
        </div>
        <form className="paper-file-search" onSubmit={search} aria-label="搜索工作区文件">
          <div className="paper-file-search-field">
            <Search size={15} aria-hidden="true"/>
            <input type="search" aria-label="搜索项目文件名" placeholder="搜索整个工作区" value={query} onChange={event=>setQuery(event.target.value)}/>
            {results&&<button type="button" className="paper-files-icon-button" aria-label="清除搜索" title="清除搜索" onClick={()=>{setResults(undefined);setQuery('');}}>
              <X size={14} aria-hidden="true"/>
            </button>}
          </div>
          <button className="secondary-button" disabled={busy||loading||!query.trim()}>搜索</button>
        </form>
      </div>

      <div className="paper-files-layout">
        <aside className="paper-files-tree" aria-label="项目文件树">
          <div className="paper-files-tree-heading"><FolderTree size={15} aria-hidden="true"/>目录</div>
          <div className="paper-files-tree-scroll">
            <FolderNode path="" label="论文工作区" base={base} revision={revision} hidden={hidden} directory={directory} selected={preview?.path} onDirectory={openDirectory} onFile={selectFile} onError={setError}/>
          </div>
        </aside>
        <div className="paper-files-content" aria-busy={loading||(!preview&&!results&&listingLoading)}>
          {loading?<p className="paper-files-empty" role="status">正在读取文件…</p>:preview?<>
            <div className="paper-file-heading">
              <span className="paper-file-tile" data-kind="file"><FileGlyph name={preview.name} kind="file" size={22}/></span>
              <div className="paper-file-heading-info">
                <h3>{preview.name}{dirty&&<small className="paper-file-unsaved">未保存</small>}</h3>
                <p>{size(preview.size)} · {new Date(preview.modified).toLocaleString()}</p>
                <code>{preview.path}</code>
              </div>
              <button type="button" className="paper-files-icon-button" aria-label="关闭文件预览" title="关闭文件预览" onClick={()=>openDirectory(directory)}><X size={17} aria-hidden="true"/></button>
            </div>
            <div className="paper-files-toolbar paper-file-preview-actions">
              <a className="secondary-button" href={contentUrl+'&download=true'} download><Download size={14} aria-hidden="true"/>下载</a>
              {preview.editable&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>setEditing(!editing)}>
                {editing?<Eye size={14} aria-hidden="true"/>:<Pencil size={14} aria-hidden="true"/>}{editing?'预览':'编辑源码'}
              </button>}
              {dirty&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void save()}><Save size={14} aria-hidden="true"/>保存{preview.managed?'新版本':''}</button>}
              {selected&&!selected.protected&&<>
                <button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('rename',selected)}>重命名</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('move',selected)}>移动</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={()=>startAction('delete',selected)}>移入回收站</button>
              </>}
            </div>
            {preview.managed&&<p className="quiet">平台知识对象 v{preview.managed.version}，保存会校验证据并建立草稿版本。<button type="button" className="text-button" onClick={()=>guard(()=>onNavigate(preview.managed!.kind==='wiki-page'?'wiki':'cards',{focus:preview.managed!.id}))}>打开{preview.managed.kind==='wiki-page'?'Wiki':'卡片'}模块</button></p>}
            {preview.readonlyReason&&<p className="quiet">{preview.readonlyReason}</p>}
            {preview.kind==='pdf'?<iframe key={contentUrl} className="paper-pdf-preview" title={`PDF：${preview.name}`} src={contentUrl}/>:preview.kind==='image'?<img className="paper-image-preview" src={contentUrl} alt={preview.name}/>:preview.content!==undefined?editing?<textarea className="paper-file-editor" aria-label="文件源码" spellCheck={false} value={draft} onChange={event=>setDraft(event.target.value)}/>: /\.(md|markdown)$/i.test(preview.path)?<Markdown body={draft.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')}/>:<div className="paper-text-preview">{draft.split('\n').map((line,index)=><div key={index}><span>{index+1}</span><code>{line||' '}</code></div>)}</div>:<p>此文件为二进制、非 UTF-8 文本或超过 2 MiB，暂不在线编辑，可下载查看。</p>}
          </>:<>
            <header className="paper-files-list-heading">
              <h3>{results?'搜索结果':manuscriptView?'稿件目录':fileLabel(directory,crumbs.at(-1)??'工作区文件')}</h3>
              {(results||currentListing)&&<span>{entries.length} 项</span>}
            </header>
            {truncated&&results&&<p className="quiet">搜索结果已截断，请缩小文件名范围。</p>}
            {!results&&!currentListing&&listingLoading?<p className="paper-files-empty" role="status">正在读取目录…</p>:entries.length>0?
              fileGroups.filter(group=>group.entries.length).map(group=><div className="paper-file-group" key={group.label}>
                {group.label&&<h4>{group.label} <small>{group.entries.length} 项</small></h4>}
                <ul className="paper-file-list">
                  {group.entries.map(entry=><li key={entry.path}>
                    <button type="button" className="paper-file-open" disabled={busy||entry.kind==='symlink'} onClick={()=>entry.kind==='directory'?openDirectory(entry.path):selectFile(entry.path)}>
                      <span className="paper-file-tile" data-kind={entry.kind}><FileGlyph name={entry.name} kind={entry.kind} size={19}/></span>
                      <span className="paper-file-info">
                        <strong>{fileLabel(entry.path,entry.name)}</strong>
                        <small>{entry.path==='library'&&<>library/ · </>}{results&&parent(entry.path)&&<>{parent(entry.path)} · </>}{entry.kind==='symlink'?'符号链接，不跟随访问':entry.kind==='directory'?'文件夹':size(entry.size)}</small>
                      </span>
                    </button>
                    {entry.protected&&<span className="paper-file-managed">平台管理</span>}
                    {!entry.protected&&entry.kind!=='symlink'&&<div className="paper-file-actions">
                      <button type="button" className="paper-files-icon-button" aria-label={`重命名：${entry.name}`} title="重命名" disabled={busy} onClick={()=>startAction('rename',entry)}><Pencil size={15} aria-hidden="true"/></button>
                      <button type="button" className="paper-files-icon-button" aria-label={`移动：${entry.name}`} title="移动" disabled={busy} onClick={()=>startAction('move',entry)}><Move size={15} aria-hidden="true"/></button>
                      <button type="button" className="paper-files-icon-button paper-file-delete" aria-label={`移入回收站：${entry.name}`} title="移入回收站" disabled={busy} onClick={()=>startAction('delete',entry)}><Trash2 size={15} aria-hidden="true"/></button>
                    </div>}
                  </li>)}
                </ul>
              </div>):(!error||results)&&<div className="paper-files-empty">
                {results?<FolderSearch size={26} aria-hidden="true"/>:<FolderOpen size={26} aria-hidden="true"/>}
                <p>{results?'没有匹配的文件或文件夹。':'此目录为空。'}</p>
              </div>}
          </>}
        </div>
      </div>
    </div>
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
