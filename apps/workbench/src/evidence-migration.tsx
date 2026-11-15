import React,{useEffect,useRef,useState} from 'react';
import type {Source} from '@trash/protocol';
import {api,uiError} from './api.js';
import {ErrorNotice} from './error-notice.js';

type Preview={source_id:string;converted:boolean;fingerprint:string;conflicts:string[];items:{path:string;action:string}[];evidence_count:number};
export function EvidenceMigration({projectId,sources,onSaved,onClose}:{projectId:string;sources:Source[];onSaved:()=>void;onClose:()=>void}){
 const [source,setSource]=useState(sources[0]?.source_id??''),[preview,setPreview]=useState<Preview>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const lock=useRef(false),base=`/projects/${encodeURIComponent(projectId)}/markdown-knowledge`;
 useEffect(()=>{let active=true;setPreview(undefined);setError('');if(source)void api<Preview>(base+'/evidence-migration-preview?source_id='+encodeURIComponent(source)).then(data=>{if(active)setPreview(data);}).catch(cause=>{if(active)setError(uiError(cause,'无法读取依据拆分预览。'));});return()=>{active=false;};},[base,source,revision]);
 const apply=async()=>{
  if(!preview||lock.current)return;lock.current=true;setBusy(true);setError('');
  try{await api(base+'/evidence-migrate',{method:'POST',body:JSON.stringify({source_id:source,expected:preview.fingerprint,confirm:true})});onSaved();setRevision(value=>value+1);}catch(cause){setError(uiError(cause,'迁移未完成。存在活动任务或版本变化时，请稍后重新预览。'));}finally{lock.current=false;setBusy(false);}
 };
 return <section className="kb-migration"><header><h3>独立依据迁移</h3><button type="button" className="text-button" disabled={busy} onClick={onClose}>收起</button></header>
  <p>拆分现有原文依据、更新同篇链接并移除顶部论文名和总览。保留文档ID及旧正文历史，不重新阅读PDF，不修改历史任务。</p>
  <label>论文 <select value={source} disabled={busy} onChange={event=>setSource(event.target.value)}>{sources.map(item=><option key={item.source_id} value={item.source_id}>{item.title}</option>)}</select></label>
  {error&&<ErrorNotice>{error}</ErrorNotice>}
  {!source?<p>暂无可迁移的完整Wiki。</p>:!preview&&!error?<p>正在读取预览…</p>:preview&&<>{preview.converted?<p>这篇论文已使用独立依据。</p>:<><p>将拆分 {preview.evidence_count} 个依据条目，涉及 {preview.items.length} 个文件。迁移不会增加已核验范围。</p>{preview.conflicts.length>0&&<ErrorNotice>{preview.conflicts.join('；')}</ErrorNotice>}<details><summary>查看文件变更</summary>{preview.items.map(item=><p key={item.path}>{item.action==='create'?'新增':'更新'} <code>{item.path}</code></p>)}</details><button type="button" className="secondary-button" disabled={busy||preview.conflicts.length>0||!preview.items.length} onClick={()=>void apply()}>{busy?'正在迁移…':'按预览迁移这篇论文'}</button></>}</>}
 </section>;
}
