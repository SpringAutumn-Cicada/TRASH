import React,{useEffect,useRef,useState} from 'react';
import {X,LoaderCircle} from 'lucide-react';
import {api,uiError} from './api.js';
import {ModalLayer} from './modal-layer.js';
import {ChatMarkdown} from './chat-markdown.js';
import {ErrorNotice} from './error-notice.js';
import './summary-name-preview.css';
type Item={id:string;path:string;title:string;hash:string;text:string;summary:string;suggested:string;basis:string};
export function SummaryNamePreview({projectId,onClose,onSaved}:{projectId:string;onClose:()=>void;onSaved:()=>void}){
 const [items,setItems]=useState<Item[]>([]),[drafts,setDrafts]=useState<Record<string,string>>({}),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
 const root=useRef<HTMLDivElement>(null),lock=useRef(false);
 const base='/projects/'+encodeURIComponent(projectId)+'/markdown-knowledge';
 useEffect(()=>{let active=true;void api<{items:Item[]}>(base+'/summary-name-preview').then(data=>{if(active){setItems(data.items);setDrafts(Object.fromEntries(data.items.map(item=>[item.id,item.suggested])));}}).catch(cause=>{if(active)setError(uiError(cause,'无法读取旧名称预览。'));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[base]);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus();return()=>previous?.focus();},[]);
 const save=async(item:Item)=>{if(lock.current)return;lock.current=true;setBusy(item.id);setError('');try{await api(base+'/rename-summary',{method:'POST',body:JSON.stringify({id:item.id,title:drafts[item.id],expected:item.hash})});setItems(old=>old.filter(value=>value.id!==item.id));setNotice('已更新展示名称；原名称可搜索，ID和路径保持不变，历史版本已保留。');onSaved();}catch(cause){setError(uiError(cause,'名称更新失败；文档可能已变化，请关闭后重新预览。'));}finally{lock.current=false;setBusy('');}};
 return <ModalLayer><div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><div ref={root} className="summary-name-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-label="旧分批总结名称优化" onKeyDown={event=>{
  if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
  if(event.key==='Tab'){const controls=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary')??[]),first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===root.current)){event.preventDefault();first.focus();}}
 }}>
 <header><div><h3>旧分批总结名称优化</h3><p>先阅读内容，再逐项确认。不会重新分析论文或更改原有认识。</p></div><button type="button" className="icon-button" aria-label="关闭名称预览" disabled={Boolean(busy)} onClick={onClose}><X size={18}/></button></header>
 <main>{error&&<ErrorNotice>{error}</ErrorNotice>}{notice&&<p role="status">{notice}</p>}{loading?<p role="status"><LoaderCircle size={15} className="spin"/>正在读取…</p>:!items.length?<p>没有需要优化的旧批次名称。</p>:items.map(item=><article key={item.id}><h4>{item.title}</h4><p>{item.summary}</p><small>{item.basis}</small><details><summary>阅读原文与覆盖范围</summary><ChatMarkdown text={item.text}/></details><label>新展示名称<input value={drafts[item.id]??''} disabled={Boolean(busy)} minLength={4} maxLength={150} onChange={event=>setDrafts(old=>({...old,[item.id]:event.target.value}))} placeholder="依据正文填写具体问题或机制名称"/></label><code>{item.path}</code><button type="button" className="primary-button" disabled={Boolean(busy)||(drafts[item.id]??'').trim().length<4} onClick={()=>void save(item)}>{busy===item.id?'正在保存…':'确认更新此名称'}</button></article>)}</main>
 </div></div></ModalLayer>;
}
