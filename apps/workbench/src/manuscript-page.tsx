import { BookOpen, ChevronRight, FileText, Folder, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectPage } from '@trash/protocol';
import { api, uiError } from './api.js';
import { ErrorNotice } from './error-notice.js';
import './manuscript-page.css';
import { ManuscriptEvidence } from './manuscript-evidence.js';
import { ManuscriptRepository } from './manuscript-repository.js';

const statusLabels = {draft:'草稿', revision:'修订中', submitted:'已投稿'} as const;
const sectionLabels = {
  drafts:'正文与修订稿', figures:'图片', equations:'公式', tables:'表格',
  references:'引用文件', exports:'导出与投稿', work:'临时工作文件'
} as const;

type Paper = {
  id:string; path:string; title:string; status:keyof typeof statusLabels; current:string|null;
};
type PaperDetail = Paper & {
  etag:string; currentAvailable:boolean;
  drafts:{name:string;path:string}[];
  sections:{key:keyof typeof sectionLabels;path:string;exists:boolean;blocked:boolean}[];
};
type Shelf = {papers:Paper[];unfiled:number;legacy?:{folder:string;title:string}[]};
type Navigate = (page:ProjectPage,options?:{focus?:string;action?:string})=>void;

export function ManuscriptPage({projectId,focusId,onNavigate}:{
  projectId:string;focusId?:string;onNavigate:Navigate;
}){
  const base=`/projects/${encodeURIComponent(projectId)}/workspace/manuscripts`;
  const [shelf,setShelf]=useState<Shelf>();
  const [paper,setPaper]=useState<PaperDetail>();
  const [current,setCurrent]=useState('');
  const [status,setStatus]=useState<Paper['status']>('draft');
  const [title,setTitle]=useState('');
  const [slug,setSlug]=useState('');
  const [creating,setCreating]=useState(false);
  const [legacyFolder,setLegacyFolder]=useState('');
  const [legacyId,setLegacyId]=useState('');
  const [revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const applyPaper=(value:PaperDetail)=>{
    setPaper(value);
    setCurrent(value.currentAvailable?value.current??'':'');
    setStatus(value.status);
  };
  useEffect(()=>{
    let alive=true;
    setLoading(true);
    setError('');
    const request=focusId
      ? api<PaperDetail>(`${base}/detail?id=${encodeURIComponent(focusId)}`).then(value=>{if(alive)applyPaper(value);})
      : api<Shelf>(base).then(value=>{if(alive)setShelf(value);});
    void request.catch(cause=>{if(alive)setError(uiError(cause,'无法读取论文工作区。'));})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[base,focusId,revision]);
  const post=<T,>(suffix:string,body:unknown)=>api<T>(base+suffix,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const run=async(work:()=>Promise<void>,fallback:string)=>{
    if(busy)return;
    setBusy(true);setError('');
    try{await work();}catch(cause){setError(uiError(cause,fallback));}finally{setBusy(false);}
  };
  const browse=(path:string)=>onNavigate('files',{action:'directory',focus:path});
  const preview=(path:string)=>onNavigate('files',{focus:path});
  const create=(event:FormEvent)=>{
    event.preventDefault();
    void run(async()=>{
      const value=await post<PaperDetail>('',{id:slug,title});
      onNavigate('paper',{focus:value.id});
    },'创建论文失败，请检查目录名是否已被使用。');
  };
  const save=(event:FormEvent)=>{
    event.preventDefault();
    if(!paper)return;
    void run(async()=>{
      applyPaper(await post<PaperDetail>('/update',{id:paper.id,current:current||null,status,etag:paper.etag}));
    },'保存论文设置失败。');
  };

  return <section className="manuscript-page">
    <header className="manuscript-heading">
      <span className="manuscript-symbol"><BookOpen size={23} aria-hidden="true"/></span>
      <div>
        {focusId&&<button type="button" className="text-button" onClick={()=>onNavigate('paper')}>所有论文</button>}
        <h2>{focusId?paper?.title??'论文详情':'论文'}</h2>
        <code>{paper?.path??'manuscripts/'}</code>
      </div>
      <button type="button" className="secondary-button" disabled={busy||loading} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={14}/>刷新</button>
      {!focusId&&<button type="button" className="primary-button" disabled={busy||loading} onClick={()=>setCreating(value=>!value)}><Plus size={16}/>新建论文</button>}
    </header>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {creating&&!focusId&&<form className="manuscript-panel manuscript-settings" onSubmit={create}>
      <label>论文标题<input autoFocus required maxLength={160} value={title} onChange={event=>setTitle(event.target.value)}/></label>
      <label>目录名<input required maxLength={80} pattern={String.raw`[a-z0-9][a-z0-9_\-]{0,79}`} placeholder="apt-provenance-detection" value={slug} onChange={event=>setSlug(event.target.value)}/></label>
      <button className="primary-button" disabled={busy}>创建论文</button>
    </form>}
    {loading?<p role="status">正在读取论文…</p>:focusId?paper&&<>
      <section className="manuscript-panel manuscript-current">
        <h3>当前稿</h3>
        {paper.currentAvailable&&paper.current?
          <button className="text-button" type="button" onClick={()=>preview(`${paper.path}/${paper.current}`)}><FileText size={15}/>{paper.current}</button>:
          <p>{paper.current?'原当前稿已移动或删除，请重新指定。':'尚未指定当前稿。'}</p>}
        <form className="manuscript-settings" onSubmit={save}>
          <label>指定当前稿<select value={current} onChange={event=>setCurrent(event.target.value)}>
            <option value="">未指定</option>
            {paper.drafts.map(draft=><option key={draft.path} value={draft.path.slice(paper.path.length+1)}>{draft.path.slice(paper.path.length+8)}</option>)}
          </select></label>
          <label>论文状态<select value={status} onChange={event=>setStatus(event.target.value as Paper['status'])}>
            {Object.entries(statusLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}
          </select></label>
          <button className="primary-button" disabled={busy||(current===(paper.current??'')&&status===paper.status)}>保存</button>
        </form>
      </section>
      <ManuscriptRepository key={paper.id} projectId={projectId} paperId={paper.id}/>
      <ManuscriptEvidence key={"evidence-"+paper.id} projectId={projectId} paperId={paper.id} onNavigate={onNavigate}/>
      <section className="manuscript-panel">
        <h3>稿件与素材目录</h3>
        <div className="manuscript-sections">
          {paper.sections.map(section=><button key={section.key} type="button" className="secondary-button"
            disabled={busy||section.blocked} title={section.blocked?'同名文件占用了目录路径':undefined}
            onClick={()=>{if(section.exists)browse(section.path);else void run(async()=>{
              const value=await post<{path:string}>('/section',{id:paper.id,section:section.key});
              browse(value.path);
            },'无法创建素材目录。');}}>
            {section.exists?<Folder size={16}/>:<Plus size={16}/>}
            <span>{sectionLabels[section.key]}</span><code>{section.key}/</code>
          </button>)}
        </div>
      </section>
      <section className="manuscript-panel">
        <h3>历史稿件</h3>
        <div className="manuscript-history">
          {paper.drafts.filter(draft=>draft.path!==`${paper.path}/${paper.current}`).map(draft=>
            <button className="text-button" type="button" key={draft.path} onClick={()=>preview(draft.path)}><FileText size={15}/>{draft.path.slice(paper.path.length+8)}</button>)}
          {!paper.drafts.some(draft=>draft.path!==`${paper.path}/${paper.current}`)&&<p>暂无其他稿件。</p>}
        </div>
      </section>
    </>:shelf&&<>
      <div className="manuscript-list">
        {shelf.papers.map(item=><button type="button" className="manuscript-panel" key={item.id} onClick={()=>onNavigate('paper',{focus:item.id})}>
          <FileText size={19}/><span><strong>{item.title}</strong><code>{item.path}/</code></span><small>{statusLabels[item.status]}</small><ChevronRight size={16}/>
        </button>)}
      </div>
      {Boolean(shelf.legacy?.length)&&<form className="manuscript-panel manuscript-settings" onSubmit={event=>{
        event.preventDefault();
        void run(async()=>{
          const value=await post<PaperDetail>('/adopt',{folder:legacyFolder,id:legacyId});
          onNavigate('paper',{focus:value.id});
        },'登记旧稿件失败。');
      }}>
        <label>旧稿件目录<select required value={legacyFolder} onChange={event=>setLegacyFolder(event.target.value)}><option value="">选择已有稿件</option>{shelf.legacy?.map(item=><option key={item.folder} value={item.folder}>{item.title}</option>)}</select></label>
        <label>论文 ID<input required maxLength={80} pattern={String.raw`[a-z0-9][a-z0-9_\-]{0,79}`} value={legacyId} onChange={event=>setLegacyId(event.target.value)}/></label>
        <button className="secondary-button" disabled={busy||!legacyFolder}>登记旧稿件</button>
      </form>}
      {!shelf.papers.length&&<p className="manuscript-panel">暂无已登记的论文。</p>}
      {shelf.unfiled>0&&<button type="button" className="secondary-button manuscript-legacy" onClick={()=>browse('manuscripts')}><Folder size={15}/>查看未归档文件 · {shelf.unfiled} 项</button>}
    </>}
  </section>;
}
