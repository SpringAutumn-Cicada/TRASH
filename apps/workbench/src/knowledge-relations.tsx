import React,{useEffect,useState} from 'react';
import {ArrowUpRight,Link2,LoaderCircle} from 'lucide-react';
import {api,uiError} from './api.js';
import {ErrorNotice} from './error-notice.js';
import './knowledge-relations.css';
type Edge={id?:string;path:string;title:string;relation:string;reason:string;missing:boolean;stale?:boolean;changed?:boolean;source_anchor?:string;source_section?:string;source_line?:number};
type Relations={catalog?:Edge[];scope?:Edge[];evidence:Edge[];related:Edge[];backlinks:Edge[];broken:Edge[]};
export function KnowledgeRelations({projectId,id,hash,onOpen}:{projectId:string;id:string;hash:string;onOpen:(id:string,anchor?:string)=>void}){
 const [open,setOpen]=useState(false),[result,setResult]=useState<Relations>(),[error,setError]=useState('');
 useEffect(()=>{let active=true;setResult(undefined);setError('');if(open)void api<Relations>(`/projects/${encodeURIComponent(projectId)}/markdown-knowledge/relations?id=${encodeURIComponent(id)}`).then(data=>{if(active)setResult(data);}).catch(e=>{if(active)setError(uiError(e,'无法读取关联知识。'));});return()=>{active=false;};},[projectId,id,hash,open]);
 return <details className="knowledge-relations" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary><Link2 size={14}/>关联知识{result&&<span>{result.evidence.length+result.related.length+result.backlinks.length+(result.catalog?.length??0)+(result.scope?.length??0)}</span>}</summary>
  {error?<ErrorNotice>{error}</ErrorNotice>:!result?<p role="status"><LoaderCircle size={14} className="spin"/> 正在读取关联…</p>:<>
   <RelationGroup title="正文引用依据" items={result.evidence} empty="尚未记录知识文档依据。" onOpen={onOpen}/>
   {Boolean(result.catalog?.length)&&<RelationGroup title="目录收录（导航）" items={result.catalog!} empty="" onOpen={onOpen}/>}
   {Boolean(result.scope?.length)&&<RelationGroup title="公共阅读范围关联" items={result.scope!} empty="" onOpen={onOpen}/>}
   <RelationGroup title="相关主题" items={result.related} empty="暂无相关主题链接。" onOpen={onOpen}/>
   <RelationGroup title="被哪些页面引用" items={result.backlinks} empty="暂无反向引用。" onOpen={onOpen}/>
   {result.broken.length>0&&<p className="knowledge-relation-warning">有 {result.broken.length} 个链接尚无对应文档，可在编辑时修正。</p>}
  </>}
 </details>;
}
function RelationGroup({title,items,empty,onOpen}:{title:string;items:Edge[];empty:string;onOpen:(id:string,anchor?:string)=>void}){
 const [expanded,setExpanded]=useState(false);
 useEffect(()=>setExpanded(false),[items]);
 return <section className="knowledge-relation-group"><h4>{title}<span>{items.length}</span></h4>{!items.length?<p>{empty}</p>:(expanded?items:items.slice(0,8)).map((item,index)=><div className="knowledge-relation-item" key={`${item.path}-${item.relation}-${index}`}><button type="button" disabled={item.missing||!item.id} onClick={()=>item.id&&onOpen(item.id,item.source_anchor)}><span>{item.title}</span><ArrowUpRight size={12}/></button><small>{item.relation}{item.missing?' · 文档缺失':item.changed||item.stale?' · 待更新':''}</small><p>{item.source_section&&<small>{item.source_section} · 正文第{item.source_line}行 </small>}{item.reason}</p></div>)}{items.length>8&&<button type="button" className="text-button" onClick={()=>setExpanded(value=>!value)}>{expanded?'收起列表':`查看全部 ${items.length} 项`}</button>}</section>;
}
type Health={documents:number;edges:number;broken:{from:string;path:string}[];orphans:{id:string;title:string}[];stale:{id:string;title:string}[];duplicate_titles:{ids:string[];title:string}[];errors:{path:string;error:string}[];note:string};
type Event={id:string;at:string;operation:string;documents:{id:string;path:string}[];note:string};
export function KnowledgeHealth({projectId,onOpen}:{projectId:string;onOpen:(id:string,anchor?:string)=>void}){
 const [health,setHealth]=useState<Health>(),[error,setError]=useState(''),[events,setEvents]=useState<Event[]>([]),[page,setPage]=useState(1),[total,setTotal]=useState(0);
 const base=`/projects/${encodeURIComponent(projectId)}/markdown-knowledge`;
 useEffect(()=>{let active=true;void api<Health>(base+'/health').then(result=>{if(active)setHealth(result);}).catch(e=>{if(active)setError(uiError(e,'无法读取知识状态。'));});return()=>{active=false;};},[base]);
 useEffect(()=>{let active=true;void api<{events:Event[];total:number}>(base+`/log?page=${page}`).then(result=>{if(active){setEvents(result.events);setTotal(result.total);}}).catch(e=>{if(active)setError(uiError(e,'无法读取维护记录。'));});return()=>{active=false;};},[base,page]);
 return <div className="mk-drawer-content knowledge-health">{error&&<ErrorNotice>{error}</ErrorNotice>}{!health?<p>正在读取知识状态…</p>:<><div className="knowledge-health-counts"><span><strong>{health.documents}</strong>份文档</span><span><strong>{health.edges}</strong>条链接</span><span><strong>{health.stale.length}</strong>项待更新</span></div><p className="mk-form-note">{health.note}</p>
  <details><summary>缺失链接 · {health.broken.length}</summary>{health.broken.map((item,i)=><p key={i}><button className="text-button" type="button" onClick={()=>onOpen(item.from)}>查看引用页</button> → {item.path}</p>)}</details>
  <details><summary>孤立页面 · {health.orphans.length}</summary>{health.orphans.map(item=><button key={item.id} type="button" className="text-button" onClick={()=>onOpen(item.id,item.source_anchor)}>{item.title}</button>)}</details>
  <details><summary>待更新内容 · {health.stale.length}</summary>{health.stale.map(item=><button key={item.id} type="button" className="text-button" onClick={()=>onOpen(item.id,item.source_anchor)}>{item.title}</button>)}</details>
  <details><summary>同名页面 · {health.duplicate_titles.length}</summary>{health.duplicate_titles.map((item,i)=><p key={i}>{item.title}{item.ids.map((id,n)=><button key={id} className="text-button" type="button" onClick={()=>onOpen(id)}>页面 {n+1}</button>)}</p>)}</details>
  {health.errors.length>0&&<details><summary>不可读文件 · {health.errors.length}</summary>{health.errors.map(item=><p key={item.path}>{item.path}：{item.error}</p>)}</details>}
 </>}<details><summary>维护记录 · {total}</summary>{events.length?events.map(event=><div className="knowledge-memory-event" key={event.id}><small>{new Date(event.at).toLocaleString()} · {event.operation==='publish'?'发布知识':event.operation==='query'?'查询知识':event.operation}</small>{event.documents.map(doc=><button key={doc.id} type="button" className="text-button" onClick={()=>onOpen(doc.id)}>{doc.path}</button>)}{event.note&&<p>{event.note}</p>}</div>):<p>新操作会记录在这里，历史事件不补造。</p>}{total>30&&<div className="mk-pagination"><button type="button" className="secondary-button" disabled={page===1} onClick={()=>setPage(n=>n-1)}>上一页</button><span>{page} / {Math.ceil(total/30)}</span><button type="button" className="secondary-button" disabled={page*30>=total} onClick={()=>setPage(n=>n+1)}>下一页</button></div>}</details></div>;
}
