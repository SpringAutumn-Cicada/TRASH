import {knowledgeDocumentId} from '@trash/protocol';
import {KnowledgeRelations} from './knowledge-relations.js';
import React,{useEffect,useRef,useState} from 'react';
import {LoaderCircle,Save,X} from 'lucide-react';
import type {Source} from '@trash/protocol';
import {api,uiError} from './api.js';
import {ModalLayer} from './modal-layer.js';
import {ChatMarkdown} from './chat-markdown.js';
import {ErrorNotice} from './error-notice.js';
import {useUnsavedChanges} from './navigation.js';
import './markdown-knowledge.css';
import './wiki-reading.css';

type Document={material_scope?:string;id:string;source_id?:string;card_type?:string;kind:string;title:string;path:string;text:string;hash:string;stale?:boolean;level?:string};
const tabs=[['basic','基础信息'],['key','关键卡片'],['detail','详细卡片'],['wiki','Wiki']];
export function LiteratureDocumentDialog({projectId,source,initialType='wiki',initialId,onClose,onSaved}:{projectId:string;source?:Source;initialType?:string;initialId?:string;onClose:()=>void;onSaved:()=>void}){
  const base=`/projects/${encodeURIComponent(projectId)}/markdown-knowledge`;
  const [type,setType]=useState(initialType),[documents,setDocuments]=useState<Document[]>([]),[doc,setDoc]=useState<Document>(),[linked,setLinked]=useState(initialId??'');
  const [loading,setLoading]=useState(true),[directoryLoaded,setDirectoryLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false),[draft,setDraft]=useState('');
  const [history,setHistory]=useState<{hash:string;text:string}[]>(),[reload,setReload]=useState(0);
  const root=useRef<HTMLDivElement>(null),acting=useRef(false);
  const dirty=editing&&draft!==doc?.text;useUnsavedChanges(dirty);
  const close=()=>{if(!busy&&(!dirty||window.confirm('放弃未保存的修改？')))onClose();};
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{
    let active=true;
    void (async()=>{
      try{
        const first=await api<{documents:Document[];total:number}>(base+'?limit=100&page=1');const all=[...first.documents];
        for(let page=2;all.length<first.total;page++){const next=await api<{documents:Document[]}>(base+`?limit=100&page=${page}`);if(!next.documents.length)break;all.push(...next.documents);}
        if(active){setDocuments(all);setDirectoryLoaded(true);}
      }catch(e){if(active){setLoading(false);setDirectoryLoaded(true);setError(uiError(e,'无法读取文档目录。'));}}
    })();return()=>{active=false;};
  },[base,reload]);
  const selected=linked||documents.find(d=>Boolean(source)&&d.source_id===source?.source_id&&(type==='wiki'?d.kind==='wiki-page':d.card_type===type))?.id;
  useEffect(()=>{
    let active=true;setDoc(undefined);setEditing(false);setHistory(undefined);setError('');setLoading(Boolean(selected));
    if(selected)void api<{document:Document}>(base+'/document?id='+encodeURIComponent(selected)).then(data=>{if(active){setDoc(data.document);setDraft(data.document.text);}}).catch(e=>{if(active)setError(uiError(e,'无法读取文档。'));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[base,selected,reload]);
  const change=(next:string)=>{if(busy||dirty&&!window.confirm('放弃未保存的修改？'))return;setLinked('');setType(next);};
  const run=async(fn:()=>Promise<void>)=>{if(acting.current)return;acting.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(uiError(e,'操作失败，当前草稿已保留。'));}finally{acting.current=false;setBusy(false);}};
  return <ModalLayer><div className="modal-backdrop library-document-backdrop" onClick={event=>{if(event.currentTarget===event.target)close();}}>
    <div ref={root} className={`library-document-dialog ${(doc?doc.kind==='wiki-page':type==='wiki')?'wiki-reading-surface':''}`} role="dialog" aria-modal="true" aria-labelledby="literature-document-title" onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();close();}
      if(event.key==='Tab'){const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href]')??[]).filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    }}>
      <header><div><small>论文内容</small><h3 id="literature-document-title">{source?.title??doc?.title??'关联知识'}</h3></div><button type="button" className="icon-button" aria-label="关闭内容" disabled={busy} onClick={close}><X size={18}/></button></header>
      {source&&<nav className="library-document-tabs" aria-label="内容类型">{tabs.map(([value,label])=><button type="button" key={value} aria-pressed={!linked&&type===value} disabled={busy||!documents.some(d=>Boolean(source)&&d.source_id===source?.source_id&&(value==='wiki'?d.kind==='wiki-page':d.card_type===value))} onClick={()=>change(value)}>{label}</button>)}</nav>}
      {error&&<ErrorNotice>{error}</ErrorNotice>}
      <div className="library-document-scroll">
        {(loading||!directoryLoaded)?<p role="status"><LoaderCircle className="spin" size={16}/> 正在读取内容…</p>:doc?<>
          {linked&&<p>关联文档：{doc.title}</p>}{doc.stale&&<p className="mk-stale">来源有变化 · 待更新</p>}
          {editing?<><p className="mk-form-note">保留顶部标识与固定字段。保存基础信息后，文献库会同步可确认的标题、作者与发表年月。</p><textarea className="mk-editor" aria-label="编辑 Markdown" value={draft} onChange={event=>setDraft(event.target.value)}/></>:<div className={`mk-body ${doc.kind==='wiki-page'?'wiki-reading-content':''}`} onClick={event=>{
            const anchor=(event.target as HTMLElement).closest('a');const href=anchor?.getAttribute('href');if(!href||/^(https?:|#)/i.test(href))return;
            event.preventDefault();const url=new URL(href,'https://knowledge.local/'+doc.path);
            if(url.pathname.startsWith(`/api/v1/projects/${encodeURIComponent(projectId)}/sources/`)&&url.pathname.endsWith('/pdf-view')){window.open(url.pathname+url.search+url.hash,'_blank','noopener,noreferrer');return;}
            const path=url.pathname.slice(1),original=path.match(/^abstract-library\/materials\/(source_[A-Za-z0-9_-]+)\.md$/);if(original){setLinked('abstract-material-'+original[1]);return;}const next=documents.find(d=>d.path===path||d.id===knowledgeDocumentId(path));if(next){setLinked(next.id);setHistory(undefined);}else setError('关联文档尚未生成或无法查看。');
          }}><ChatMarkdown text={doc.kind==='wiki-page'&&doc.level==='single'?doc.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/^#\s+.+$/m,()=>`# ${doc.title}`):doc.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')} allowRelativeLinks/></div>}
          {!editing&&<KnowledgeRelations projectId={projectId} id={doc.id} hash={doc.hash} onOpen={id=>{setLinked(id);setHistory(undefined);}}/>}
          {history&&<section className="library-document-history"><h4>版本历史</h4>{history.length?history.map(version=><details key={version.hash}><summary>快照 {version.hash.slice(0,10)}</summary><pre>{version.text}</pre></details>):<p>暂无历史版本。</p>}</section>}
        </>:!error&&<p>该内容尚未生成，请先分析这篇论文。</p>}
      </div>
      <footer><span>{editing?(dirty?'有未保存修改':'编辑 Markdown'):doc?.path}</span><div>{editing?<><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(!dirty||window.confirm('放弃未保存的修改？')){setDraft(doc!.text);setEditing(false);}}}>取消编辑</button><button type="button" className="primary-button" disabled={busy||!dirty} onClick={()=>void run(async()=>{await api(base+'/save',{method:'POST',body:JSON.stringify({path:doc!.path,text:draft,expected:doc!.hash})});setEditing(false);setReload(n=>n+1);onSaved();})}><Save size={14}/>{busy?'正在保存':'保存修改'}</button></>:<><button type="button" className="secondary-button" disabled={busy||!doc||doc.material_scope==='abstract'} onClick={()=>void run(async()=>{const result=await api<{versions:{hash:string;text:string}[]}>(base+'/history?id='+encodeURIComponent(doc!.id));setHistory(result.versions);})}>版本历史</button><button type="button" className="secondary-button" disabled={busy||!doc||doc.material_scope==='abstract'} onClick={()=>{setDraft(doc!.text);setEditing(true);setHistory(undefined);}}>编辑内容</button></>}</div></footer>
    </div>
  </div></ModalLayer>;
}
