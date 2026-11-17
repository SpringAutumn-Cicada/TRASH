import {PaperWikiVersionPanel} from './paper-wiki-versions.js';
import {useWikiReadingNavigation} from './wiki-reading-navigation.js';
import {knowledgeDocumentId} from '@trash/protocol/browser';
import {KnowledgeRelations} from './knowledge-relations.js';
import React,{useEffect,useRef,useState} from 'react';
import {LoaderCircle,Save,Trash2,X} from 'lucide-react';
import type {Source} from '@trash/protocol';
import {api,uiError} from './api.js';
import {ModalLayer} from './modal-layer.js';
import {ChatMarkdown} from './chat-markdown.js';
import {ErrorNotice} from './error-notice.js';
import {useUnsavedChanges} from './navigation.js';
import './markdown-knowledge.css';
import './wiki-reading.css';

type Document={topic_id?:string;page_role?:string;material_scope?:string;id:string;source_id?:string;card_type?:string;kind:string;title:string;path:string;text:string;hash:string;stale?:boolean;level?:string};
export function LiteratureDocumentDialog({projectId,source,initialType='wiki',initialId,onClose,onSaved,embedded=false,onReadingLock}:{onReadingLock?:(locked:boolean)=>void;embedded?:boolean;projectId:string;source?:Source;initialType?:string;initialId?:string;onClose:()=>void;onSaved:()=>void}){
  const base=`/projects/${encodeURIComponent(projectId)}/markdown-knowledge`;
  const [type]=useState(initialType),[documents,setDocuments]=useState<Document[]>([]),[doc,setDoc]=useState<Document>(),[linked,setLinked]=useState(initialId??'');
  const [loading,setLoading]=useState(true),[directoryLoaded,setDirectoryLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false),[draft,setDraft]=useState('');
  const [versionSource,setVersionSource]=useState('');
  const [topicVersions,setTopicVersions]=useState<{revision:number;at:string;current:{path:string;hash:string}[]}[]>();
  const [history,setHistory]=useState<{hash:string;text:string}[]>(),[reload,setReload]=useState(0);
  const root=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null),acting=useRef(false);
  const dirty=editing&&draft!==doc?.text;useUnsavedChanges(dirty);
  useEffect(()=>{onReadingLock?.(busy||dirty);return()=>onReadingLock?.(false);},[busy,dirty,onReadingLock]);
  const close=()=>{if(!busy&&(!dirty||window.confirm('放弃未保存的修改？')))onClose();};
  useEffect(()=>{
    if(embedded)return;
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
  const selected=linked||(type==='wiki'&&source?(documents.find(d=>d.path===`knowledge_base/papers/${source.source_id}/whoami.md`)??documents.find(d=>d.path===`knowledge_base/papers/${source.source_id}/index.md`))?.id:undefined)||documents.find(d=>Boolean(source)&&d.source_id===source?.source_id&&(type==='wiki'?d.kind==='wiki-page':d.card_type===type))?.id;
  useEffect(()=>{
    let active=true;setDoc(undefined);setEditing(false);setHistory(undefined);setTopicVersions(undefined);setError('');setLoading(Boolean(selected));
    if(selected)void api<{document:Document}>(base+'/document?id='+encodeURIComponent(selected)).then(data=>{if(active){setDoc(data.document);setDraft(data.document.text);}}).catch(e=>{if(active)setError(uiError(e,'无法读取文档。'));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[base,selected,reload]);
  const reading=useWikiReadingNavigation(selected??'',doc?.id,loading,scroll,id=>{setLinked(id);setHistory(undefined);});
  const run=async(fn:()=>Promise<void>)=>{if(acting.current)return;acting.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(uiError(e,'操作失败，当前草稿已保留。'));}finally{acting.current=false;setBusy(false);}};
  const remove=()=>{if(!doc||doc.source_id||doc.level==='overview'||doc.path.endsWith('/index.md')||!window.confirm(`确认删除“${doc.title}”？条目将移入回收站。`))return;void run(async()=>{await api(base+'/delete',{method:'POST',body:JSON.stringify({id:doc.id,expected:doc.hash,confirm:true})});onSaved();onClose();});};
  const panel=<div className={embedded?"library-document-inline":"modal-backdrop library-document-backdrop"} onClick={event=>{if(event.currentTarget===event.target)close();}}>
    <div ref={root} className={`library-document-dialog ${embedded?'library-document-embedded ':''}${(doc?doc.kind==='wiki-page':type==='wiki')?'wiki-reading-surface':''}`} role={embedded?"region":"dialog"} aria-modal={embedded?undefined:true} aria-labelledby="literature-document-title" onKeyDown={event=>{
      if(!embedded&&event.key==='Escape'){event.stopPropagation();close();}
      if(!embedded&&event.key==='Tab'){const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href]')??[]).filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    }}>
      <header><div><small>{doc?.topic_id?'主题 Wiki 组':doc?.level==='single'?'论文内容':'研究知识'}</small><h3 id="literature-document-title">{doc?.id.includes('--')?doc.title:source?.title??doc?.title??'关联知识'}</h3></div><div className="library-document-header-actions">{doc&&!doc.source_id&&doc.level!=='overview'&&!doc.path.endsWith('/index.md')&&<button type="button" className="icon-button library-document-delete" aria-label="删除当前 Wiki" title="删除当前 Wiki" disabled={busy||editing} onClick={remove}><Trash2 size={16}/></button>}{!embedded&&<button type="button" className="icon-button" aria-label="关闭内容" disabled={busy} onClick={close}><X size={18}/></button>}</div></header>
      {error&&<ErrorNotice>{error}</ErrorNotice>}
      {doc?.topic_id&&<nav className="topic-wiki-navigation" aria-label="主题组页面">{documents.filter(page=>page.topic_id===doc.topic_id).sort((a,b)=>Number(b.id===doc.topic_id)-Number(a.id===doc.topic_id)||a.path.localeCompare(b.path)).map(page=><button type="button" key={page.id} className={page.id===doc.id?'selected':''} aria-current={page.id===doc.id?'page':undefined} disabled={busy||loading} onClick={()=>{if(dirty&&!window.confirm('放弃未保存的修改？'))return;reading.go(page.id);}}>{page.id===doc.topic_id?'主题总览':page.id.endsWith('--methods')?'方法与条件':page.id.endsWith('--results')?'结果与分歧':'可复用认识'}</button>)}<button type="button" disabled={busy} onClick={()=>void run(async()=>{if(topicVersions){setTopicVersions(undefined);return;}setTopicVersions((await api<{versions:NonNullable<typeof topicVersions>}>(base+'/topic-versions?id='+encodeURIComponent(doc.topic_id!))).versions);})}>整组版本</button></nav>}
      {doc?.topic_id&&topicVersions&&<div className="topic-wiki-versions">{topicVersions.map(version=><details key={version.revision}><summary>版本 {version.revision} · {new Date(version.at).toLocaleString()} · {version.current.length} 页</summary>{version.current.map(file=><p key={file.path}><code>{file.path.split('/').at(-1)} · {file.hash.slice(0,12)}</code> <button type="button" disabled={busy} onClick={()=>void run(async()=>{const id=knowledgeDocumentId(file.path);const versions=(await api<{versions:{hash:string;text:string}[]}>(base+'/history?id='+encodeURIComponent(id??''))).versions;const snapshot=versions.find(item=>item.hash===file.hash);if(!snapshot)throw new Error('该文件快照不存在');setHistory([snapshot]);})}>查看快照</button></p>)}</details>)}{!topicVersions.length&&<p>暂无整组发布快照。</p>}</div>}
      <div ref={scroll} className="library-document-scroll">
        {(loading||!directoryLoaded)?<p role="status"><LoaderCircle className="spin" size={16}/> 正在读取内容…</p>:doc?<>
          {linked&&<p>关联文档：{doc.title}</p>}{doc.stale&&<p className="mk-stale">来源有变化 · 待更新</p>}
          {editing?<><p className="mk-form-note">保留顶部标识与固定字段。保存基础信息后，文献库会同步可确认的标题、作者与发表年月。</p><textarea className="mk-editor" aria-label="编辑 Markdown" value={draft} onChange={event=>setDraft(event.target.value)}/></>:<div className={`mk-body ${doc.kind==='wiki-page'?'wiki-reading-content':''}`} onClick={event=>{
            const anchor=(event.target as HTMLElement).closest('a');const href=anchor?.getAttribute('href');if(!href||/^https?:/i.test(href))return;
            event.preventDefault();const url=new URL(href,'https://knowledge.local/'+doc.path);
            if(url.pathname.startsWith(`/api/v1/projects/${encodeURIComponent(projectId)}/sources/`)&&url.pathname.endsWith('/pdf-view')){window.open(url.pathname+url.search+url.hash,'_blank','noopener,noreferrer');return;}
            const path=url.pathname.slice(1),original=path.match(/^abstract-library\/materials\/(source_[A-Za-z0-9_-]+)\.md$/);if(original){reading.go('abstract-material-'+original[1]);return;}const next=documents.find(d=>d.path===path||d.id===knowledgeDocumentId(path));if(next){reading.go(next.id,url.hash.slice(1));}else setError('关联文档尚未生成或无法查看。');
          }}><ChatMarkdown text={doc.kind==='wiki-page'&&doc.level==='single'?doc.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/^#\s+.+$/m,()=>`# ${doc.title}`):doc.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')} allowRelativeLinks/></div>}
          {!editing&&!doc.id.startsWith('abstract-material-')&&<KnowledgeRelations projectId={projectId} id={doc.id} hash={doc.hash} onOpen={(id,anchor)=>reading.go(id,anchor)}/>}
          {history&&<section className="library-document-history"><h4>版本历史</h4>{history.length?history.map(version=><details key={version.hash}><summary>快照 {version.hash.slice(0,10)}</summary><pre>{version.text}</pre></details>):<p>暂无历史版本。</p>}</section>}
        </>:!error&&<p>该内容尚未生成，请先分析这篇论文。</p>}
      </div>
      {versionSource&&<PaperWikiVersionPanel projectId={projectId} sourceId={versionSource} onClose={()=>setVersionSource('')} onChanged={()=>{setReload(n=>n+1);onSaved();}} onWorking={setBusy}/>}
      <footer><span>{editing?(dirty?'有未保存修改':'编辑 Markdown'):doc?.path}</span><div>{editing?<><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(!dirty||window.confirm('放弃未保存的修改？')){setDraft(doc!.text);setEditing(false);}}}>取消编辑</button><button type="button" className="primary-button" disabled={busy||!dirty} onClick={()=>void run(async()=>{await api(base+'/save',{method:'POST',body:JSON.stringify({path:doc!.path,text:draft,expected:doc!.hash})});setEditing(false);setReload(n=>n+1);onSaved();})}><Save size={14}/>{busy?'正在保存':'保存修改'}</button></>:<><button type="button" className="secondary-button" disabled={busy||!doc||doc.material_scope==='abstract'||!doc.source_id} onClick={()=>setVersionSource(doc!.source_id!)}>版本管理</button><button type="button" className="secondary-button" disabled={busy||!doc||doc.material_scope==='abstract'} onClick={()=>{setDraft(doc!.text);setEditing(true);setHistory(undefined);}}>编辑内容</button></>}</div></footer>
    </div>
  </div>;
  return embedded?panel:<ModalLayer>{panel}</ModalLayer>;
}
