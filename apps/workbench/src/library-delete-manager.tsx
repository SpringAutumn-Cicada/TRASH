import React,{useEffect,useRef,useState} from 'react';
import type {Source} from '@trash/protocol';
import {Trash2,X,Search,LoaderCircle} from 'lucide-react';
import {ModalLayer} from './modal-layer.js';
import {api,uiError} from './api.js';
import {ErrorNotice} from './error-notice.js';
import './library-delete-manager.css';
type Props={projectId:string;sources:Source[];blockedIds:string[];disabled?:boolean;onDeleted:(id:string)=>void;onBusyChange?:(busy:boolean)=>void};
export function LibraryDeleteManager(props:Props){
 const [open,setOpen]=useState(false);
 return <><button type="button" className="secondary-button library-delete-manager-trigger" disabled={props.disabled||!props.sources.length} onClick={()=>setOpen(true)}><Trash2 size={14}/>删除文献</button>{open&&<DeleteManagerDialog {...props} onClose={()=>setOpen(false)}/>}</>;
}
function DeleteManagerDialog({projectId,sources,blockedIds,disabled,onDeleted,onBusyChange,onClose}:Props&{onClose:()=>void}){
 const [query,setQuery]=useState(''),[selected,setSelected]=useState<Set<string>>(new Set()),[confirming,setConfirming]=useState(false),[busy,setBusy]=useState(false),[removed,setRemoved]=useState<Set<string>>(new Set()),[errors,setErrors]=useState<string[]>([]),[message,setMessage]=useState('');
 const root=useRef<HTMLDivElement>(null),lock=useRef(false),all=useRef<HTMLInputElement>(null);
 const blocked=new Set(blockedIds),remaining=sources.filter(source=>!removed.has(source.source_id)),filtered=remaining.filter(source=>(source.title+' '+source.authors.join(' ')+' '+(source.doi??'')).toLowerCase().includes(query.trim().toLowerCase()));
 const eligible=filtered.filter(source=>!blocked.has(source.source_id)),chosen=remaining.filter(source=>selected.has(source.source_id)),count=eligible.filter(source=>selected.has(source.source_id)).length;
 useEffect(()=>{if(all.current)all.current.indeterminate=count>0&&count<eligible.length;},[count,eligible.length]);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
 const close=()=>{if(!lock.current)onClose();};
 const toggle=(id:string)=>setSelected(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});
 const remove=async()=>{
  if(lock.current||disabled||!chosen.length)return;
  lock.current=true;setBusy(true);onBusyChange?.(true);setErrors([]);setMessage('');
  const failures:string[]=[];let succeeded=0;
  try{for(const source of chosen){
   if(blocked.has(source.source_id)){failures.push(source.title+'：有任务排队或运行中，请稍后再删。');continue;}
   try{await api('/projects/'+encodeURIComponent(projectId)+'/sources/'+encodeURIComponent(source.source_id),{method:'DELETE',body:JSON.stringify({confirm:true})});
    succeeded++;setRemoved(old=>new Set([...old,source.source_id]));setSelected(old=>{const next=new Set(old);next.delete(source.source_id);return next;});onDeleted(source.source_id);
   }catch(cause){failures.push(source.title+'：'+uiError(cause,'删除失败，可能有知识引用或活动任务。'));}
  }}finally{setErrors(failures);setMessage('已删除 '+succeeded+' 篇'+(failures.length?'，'+failures.length+' 篇未删除。':'。'));setConfirming(false);lock.current=false;setBusy(false);onBusyChange?.(false);}
 };
 return <ModalLayer><div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget)close();}}><div ref={root} className="library-delete-manager-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-label="管理文献删除" aria-busy={busy} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key==='Tab'){const controls=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]),first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===root.current)){event.preventDefault();first.focus();}}
 }}>
 <header><div><h3>{confirming?'确认删除所选文献':'管理文献删除'}</h3><p>删除文献记录、阅读信息和正文检索内容，原始文件保留；有知识引用或活动任务的文献不可删除。</p></div><button type="button" className="icon-button" disabled={busy} aria-label="关闭删除管理" onClick={close}><X size={18}/></button></header>
 <div className="library-delete-manager-body">
 {message&&<p role="status" className="library-delete-result">{message}</p>}{errors.length>0&&<ErrorNotice><ul>{errors.map((error,index)=><li key={index}>{error}</li>)}</ul></ErrorNotice>}
 {!confirming&&<><label className="library-filter"><Search size={15}/><input aria-label="筛选待删除文献" placeholder="搜索标题、作者或 DOI…" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/></label><div className="library-delete-selection"><label><input ref={all} type="checkbox" checked={eligible.length>0&&count===eligible.length} disabled={busy||!eligible.length} onChange={event=>setSelected(old=>{const next=new Set(old);for(const source of eligible)if(event.target.checked)next.add(source.source_id);else next.delete(source.source_id);return next;})}/>全选筛选结果</label><span>已选 {chosen.length} 篇</span><button type="button" className="text-button" disabled={busy||!selected.size} onClick={()=>setSelected(new Set())}>清空选择</button></div></>}
 {confirming&&<p className="library-delete-warning">将删除以下 {chosen.length} 篇文献的记录，此操作无法撤销。请核对后确认。</p>}
 <div className="library-delete-choices">{(confirming?chosen:filtered).map(source=><label key={source.source_id}><input type="checkbox" checked={selected.has(source.source_id)} disabled={busy||confirming||blocked.has(source.source_id)} onChange={()=>toggle(source.source_id)}/><span><strong>{source.title}</strong><small>{blocked.has(source.source_id)?'任务排队或运行中，暂不可删除':source.authors.join(', ')||'作者信息未提供'}</small></span></label>)}{!filtered.length&&!confirming&&<p>没有匹配的文献。</p>}</div>
 </div>
 <footer><span>{confirming?'仅删除所选条目，不影响其他文献。':'筛选前勾选的条目仍保留选择，请在下一步核对。'}</span><button type="button" className="secondary-button" disabled={busy} onClick={()=>confirming?setConfirming(false):close()}>{confirming?'返回选择':'关闭'}</button><button type="button" className="primary-button project-delete-confirm" disabled={busy||disabled||!chosen.length} onClick={()=>confirming?void remove():setConfirming(true)}>{busy?<><LoaderCircle size={14} className="spin"/>正在删除…</>:confirming?'确认删除':'删除所选（'+chosen.length+'）'}</button></footer>
 </div></div></ModalLayer>;
}
