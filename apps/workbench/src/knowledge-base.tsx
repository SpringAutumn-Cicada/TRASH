import {EvidenceMigration} from './evidence-migration.js';
import {useWikiReadingNavigation} from './wiki-reading-navigation.js';
import React,{useEffect,useRef,useState} from 'react';
import type {Source,ProjectPage} from '@trash/protocol';
import {knowledgeDocumentId} from '@trash/protocol/browser';
import {BookOpen,Search,RefreshCw,ArrowUpRight,FolderOpen} from 'lucide-react';
import {api,uiError} from './api.js';
import {ErrorNotice} from './error-notice.js';
import {ChatMarkdown} from './chat-markdown.js';
import {LiteratureDocumentDialog} from './literature-document-dialog.js';
import {WikiGraph} from './wiki-graph.js';
import {KnowledgeHealth} from './knowledge-relations.js';
import {SummaryNamePreview} from './summary-name-preview.js';
import {MarkdownKnowledgePanel} from './markdown-knowledge.js';
import './knowledge-base.css';
type Doc={topic_id?:string;id:string;title:string;path:string;kind:string;card_type?:string;level?:string;source_id?:string;material_scope?:string;summary?:string;hash:string;text?:string;stale?:boolean};
type Migration={migrated:boolean;items:{from:string;to:string;active:boolean}[];conflicts:string[];fingerprint:string;backup?:string};
const groups=[['papers','论文 Wiki'],['abstracts','摘要 Wiki'],['topic','知识主题'],['hypothesis','研究假设'],['discovery','发现清单'],['summary','分批总结']] as const;
const label=(doc:Doc)=>doc.id.includes('--')?(doc.path===`knowledge_base/papers/${doc.source_id}/whoami.md`?'论文身份':doc.path===`knowledge_base/papers/${doc.source_id}/index.md`?'旧论文索引':doc.title):doc.material_scope==='abstract'?(doc.kind==='wiki-page'?'研究记忆 · 摘要级':'摘要解读'):doc.card_type?({basic:'基本信息',key:'关键卡片',detail:'详细卡片'}[doc.card_type]??doc.card_type):doc.level==='single'?'研究记忆':doc.level==='summary'?'分批总结':doc.level==='overview'?'项目总览':doc.title;
type WikiCardEntry={id:string;title:string;metadata:string;stale?:boolean;active:boolean};
function WikiDirectoryCard({item,disabled,onSelect}:{item:WikiCardEntry;disabled:boolean;onSelect:(id:string)=>void}){
 return <button type="button" className="kb-paper-card" title={item.title} aria-current={item.active?'page':undefined} disabled={disabled} onClick={()=>onSelect(item.id)}><strong>{item.title}</strong>{item.metadata&&<small title={item.metadata}>{item.metadata}</small>}{item.stale&&<small className="kb-card-status"><i/> 待更新</small>}</button>;
}
export function KnowledgeBaseWorkspace({projectId,sources,focusId,onNavigate}:{projectId:string;sources:Source[];focusId?:string;onNavigate:(page:ProjectPage,options?:{focus?:string})=>void}){
 const [evidenceMigration,setEvidenceMigration]=useState(false);
 const [readingLocked,setReadingLocked]=useState(false);
 const base='/projects/'+encodeURIComponent(projectId)+'/markdown-knowledge';
 const [docs,setDocs]=useState<Doc[]>([]),[query,setQuery]=useState(''),[view,setView]=useState<'directory'|'graph'|'maintenance'>('directory'),[selected,setSelected]=useState(focusId??'@home'),[doc,setDoc]=useState<Doc>(),[text,setText]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[preview,setPreview]=useState<string>(),[names,setNames]=useState(false),[migration,setMigration]=useState<Migration>(),[migrationOpen,setMigrationOpen]=useState(false),[busy,setBusy]=useState(false),[manageKind,setManageKind]=useState<'literature-card'|'wiki-page'>('wiki-page');
 const content=useRef<HTMLDivElement>(null),article=useRef<HTMLElement>(null);const [loadedId,setLoadedId]=useState('');
 const reading=useWikiReadingNavigation(selected,loadedId,loading,article,setSelected);
 const request=useRef(0),alive=useRef(true),lock=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(focusId){setSelected(focusId);setView('directory');}},[focusId]);
 useEffect(()=>{let active=true,loadingDirectory=false;const controller=new AbortController();const current=++request.current;
  const load=async()=>{if(!active||loadingDirectory||document.hidden)return;loadingDirectory=true;try{const first=await api<{documents:Doc[];total:number}>(base+'?limit=100&include_summaries=true&q='+encodeURIComponent(query),{signal:controller.signal});const all=[...first.documents];for(let page=2;all.length<first.total;page++){const next=await api<{documents:Doc[]}>(base+'?limit=100&include_summaries=true&page='+page+'&q='+encodeURIComponent(query),{signal:controller.signal});if(!active)break;if(!next.documents.length)break;all.push(...next.documents);}if(active&&request.current===current)setDocs(all);}catch(cause){if(active)setError(uiError(cause,'无法读取知识库目录。'));}finally{loadingDirectory=false;}};
  const delay=setTimeout(()=>void load(),180),timer=setInterval(()=>void load(),5000);return()=>{active=false;controller.abort();clearTimeout(delay);clearInterval(timer);};
 },[base,query,revision]);
 useEffect(()=>{let active=true;setLoading(true);setDoc(undefined);setText('');
  const load=async()=>{try{
   if(selected==='@home'||selected==='@log'){const data=await api<{text:string}>(base+(selected==='@home'?'/home':'/maintenance-log'));if(active)setText(data.text);}
   else if(selected.startsWith('@source:')){const data=await api<{source:Source}>('/projects/'+encodeURIComponent(projectId)+'/sources/'+encodeURIComponent(selected.slice(8)));if(active)setText('# '+data.source.title+'\n\n'+data.source.authors.join(', ')+'\n\n'+(data.source.publication_date??'')+'\n\n'+(data.source.abstract??'未录入摘要'));}
   else {const data=await api<{document:Doc}>(base+'/document?id='+encodeURIComponent(selected));if(active){setDoc(data.document);setText(data.document.text??'');}}
  }catch(cause){if(active)setError(uiError(cause,'无法读取知识文档。'));}finally{if(active){setLoadedId(selected);setLoading(false);}}};
  void load();return()=>{active=false;};
 },[base,selected,revision,docs.find(item=>item.id===selected)?.hash]);
 const navigateLink=(event:React.MouseEvent)=>{const anchor=(event.target as HTMLElement).closest('a'),href=anchor?.getAttribute('href');if(!href||/^https?:/i.test(href))return;event.preventDefault();
  const url=new URL(href,'https://knowledge.local/'+(doc?.path??(selected==='@log'?'knowledge_base/maintenance/log.md':'knowledge_base/index.md')));
  if(url.pathname.startsWith('/api/v1/')&&url.pathname.endsWith('/pdf-view')){window.open(url.pathname+url.search+url.hash,'_blank','noopener,noreferrer');return;}
  const path=url.pathname.slice(1),id=knowledgeDocumentId(path),original=path.match(/^abstract-library\/materials\/(source_[A-Za-z0-9_-]+)\.md$/);
  if(original)reading.go('@source:'+original[1],url.hash.slice(1));else if(path==='knowledge_base/index.md')reading.go('@home',url.hash.slice(1));else if(id)reading.go(id,url.hash.slice(1));else setError('此入口不属于知识文档，请到项目文件查看。');
 };
 const showMigration=async()=>{setMigrationOpen(true);setError('');try{setMigration(await api<Migration>(base+'/migration-preview'));}catch(cause){setError(uiError(cause,'无法读取目录迁移预览。'));}};
 const migrate=async(rollback=false)=>{if(lock.current||!migration)return;if(!window.confirm(rollback?'仅在迁移后的知识正文未发生变化时恢复旧目录；保留当前目录备份。确认恢复？':'将按预览迁移知识文件，保留原文件备份、文档ID和历史。确认执行？'))return;lock.current=true;setBusy(true);try{await api(base+(rollback?'/rollback-migration':'/migrate'),{method:'POST',body:JSON.stringify({confirm:true,expected:migration.fingerprint})});setMigration(await api<Migration>(base+'/migration-preview'));setRevision(value=>value+1);}catch(cause){setError(uiError(cause,'迁移未完成；如知识库已更新，恢复操作会被拒绝以保护新内容。'));}finally{lock.current=false;if(alive.current)setBusy(false);}};
 const matches=(item:Doc,key:string)=>key==='papers'?item.path.includes('/papers/')||item.material_scope!=='abstract'&&(item.kind==='literature-card'||item.level==='single'):key==='abstracts'?item.material_scope==='abstract':item.level===key;
 const paperGroups=[...new Set(docs.filter(item=>matches(item,'papers')).map(item=>item.source_id).filter((id):id is string=>Boolean(id)))].map(sourceId=>{
  const items=docs.filter(item=>item.source_id===sourceId&&matches(item,'papers'));
  const entry=items.find(item=>item.path.endsWith('/whoami.md'))??items.find(item=>item.path.endsWith('/index.md'))??items.find(item=>item.kind==='wiki-page')??items[0];
  const source=sources.find(item=>item.source_id===sourceId);
  return {sourceId,source,entry,title:source?.title??entry.title,metadata:[source?.publication_date??source?.year,source?.authors.join(', ')].filter(Boolean).join(' · ')};
 }).sort((a,b)=>a.title.localeCompare(b.title));
 const selectedPaper=docs.find(item=>item.id===selected&&matches(item,'papers'));
 const paperSource=selectedPaper?.source_id;
 const selectedWiki=docs.find(item=>item.id===selected&&item.kind==='wiki-page');
 const choose=(id:string)=>{if(readingLocked)return;setSelected(id);};
 return <section className="knowledge-base-workspace">
 <header className="kb-heading"><div><h2>知识库 <span>{docs.length}</span></h2><p>浏览论文知识与跨文献研究成果。</p></div><div><button type="button" className="secondary-button" onClick={()=>setEvidenceMigration(true)}>依据拆分</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>void showMigration()}>目录迁移</button><button type="button" className="icon-button" aria-label="刷新知识库" onClick={()=>setRevision(value=>value+1)}><RefreshCw size={16}/></button></div></header>
 <nav className="kb-views" aria-label="知识库视图">{([['directory','目录阅读'],['graph','知识图谱'],['maintenance','生成与维护']] as const).map(([key,name])=><button type="button" key={key} aria-pressed={view===key} disabled={readingLocked} onClick={()=>setView(key)}>{name}</button>)}</nav>
 {error&&<ErrorNotice>{error}</ErrorNotice>}
 {evidenceMigration&&<EvidenceMigration projectId={projectId} sources={sources.filter(source=>docs.some(doc=>doc.source_id===source.source_id&&doc.path.endsWith('/whoami.md')))} onClose={()=>setEvidenceMigration(false)} onSaved={()=>setRevision(value=>value+1)}/>}
 {migrationOpen&&<section className="kb-migration"><header><h3>知识目录迁移预览</h3><button type="button" className="text-button" disabled={busy} onClick={()=>setMigrationOpen(false)}>收起</button></header>{migration?<><p>{migration.migrated?'已使用 knowledge_base/，旧路径通过兼容映射定位。':'核对以下旧路径与新路径；未确认前不移动文件。'}</p>{migration.backup&&<code>备份：{migration.backup}</code>}{migration.conflicts.length>0&&<ErrorNotice>目标已有文件，需先处理冲突：{migration.conflicts.join('、')}</ErrorNotice>}<details><summary>{migration.items.length} 个迁移条目</summary>{migration.items.map(item=><p key={item.from}><code>{item.from}</code> → <code>{item.to}</code>{!item.active&&'（旧版本仅备份，不接入当前索引）'}</p>)}</details><button type="button" className="secondary-button" disabled={busy||migration.conflicts.length>0} onClick={()=>void migrate(migration.migrated)}>{busy?'处理中…':migration.migrated?'恢复旧目录（正文未变化时）':'确认按预览迁移'}</button></>:<p>正在读取预览…</p>}</section>}
 {view==='graph'?<WikiGraph projectId={projectId} revision={revision} focusId={focusId} onOpen={setPreview}/>:view==='maintenance'?<div className="kb-maintenance"><div className="kb-maintenance-actions"><button type="button" className="secondary-button" onClick={()=>setNames(true)}>旧名称优化</button><button type="button" className="secondary-button" onClick={()=>{setSelected('@log');setView('directory');}}>维护记录</button></div><details><summary>知识完整性与来源状态</summary><KnowledgeHealth projectId={projectId} onOpen={setPreview}/></details><details><summary>生成或更新知识</summary><div className="kb-views"><button type="button" aria-pressed={manageKind==='wiki-page'} onClick={()=>setManageKind('wiki-page')}>主题与研究记忆</button><button type="button" aria-pressed={manageKind==='literature-card'} onClick={()=>setManageKind('literature-card')}>论文卡片</button></div><MarkdownKnowledgePanel key={manageKind} projectId={projectId} sources={sources} kind={manageKind} onNavigate={onNavigate}/></details></div>:<div className="kb-layout"><aside><label className="library-filter"><Search size={15}/><input aria-label="搜索知识库" placeholder="搜索标题、关键词或正文…" value={query} onChange={event=>setQuery(event.target.value)}/></label><button type="button" className="kb-root-entry" aria-current={selected==='@home'?'page':undefined} onClick={()=>choose('@home')}><BookOpen size={15}/>知识库首页</button>{docs.filter(item=>item.level==='overview').map(item=><button type="button" className="kb-root-entry" key={item.id} onClick={()=>choose(item.id)}>项目总览</button>)}
 {groups.map(([key,name])=>{
  const items=docs.filter(item=>matches(item,key));
  const entries=key==='papers'?paperGroups.map(paper=>({id:paper.entry.id,title:paper.title,metadata:paper.metadata,stale:paper.entry.stale,active:paperSource===paper.sourceId})):key==='abstracts'?[...new Set(items.map(item=>item.source_id))].map(sourceId=>{
   const group=items.filter(item=>item.source_id===sourceId),entry=group.find(item=>item.kind==='wiki-page')??group[0],source=sources.find(item=>item.source_id===sourceId);
   return {id:entry.id,title:source?.title??entry.title,metadata:source?.authors.join(', ')??'',stale:entry.stale,active:group.some(item=>item.id===selected)};
  }):items.filter(item=>!item.topic_id||item.id===item.topic_id||Boolean(query)).map(item=>{const members=items.filter(page=>page.topic_id===item.id);return {id:item.id,title:item.title,metadata:members.length?`主题 Wiki 组 · ${members.length} 页`:(item.summary??''),stale:item.stale||members.some(page=>page.stale),active:item.id===selected||members.some(page=>page.id===selected)};});
  return <details key={key} className="kb-directory-group" open={key==='papers'||Boolean(query)||entries.some(item=>item.active)}><summary><FolderOpen size={15}/><strong>{name}</strong><span>{entries.length}</span></summary><div className="kb-directory-items">{entries.map(item=><WikiDirectoryCard key={item.id} item={item} disabled={readingLocked} onSelect={choose}/>)}{!entries.length&&<small>{query?'没有匹配内容':'暂无内容'}</small>}</div></details>;
 })}

 <button type="button" className="kb-root-entry" onClick={()=>choose('@log')}>维护记录</button></aside>{(paperSource||selectedWiki)?<LiteratureDocumentDialog key={paperSource??selected} embedded onReadingLock={setReadingLocked} projectId={projectId} source={sources.find(source=>source.source_id===paperSource)} initialId={selected} onClose={()=>setSelected('@home')} onSaved={()=>setRevision(value=>value+1)}/>:<article ref={article}><header><div><small>{doc?label(doc):selected==='@home'?'知识库首页':selected==='@log'?'知识维护记录':'原始摘要'}</small><h3>{doc?.title??(selected==='@home'?'知识库':selected==='@log'?'维护记录':'原始摘要资料')}</h3>{doc?.stale&&<p className="mk-stale">来源有变化 · 待更新</p>}</div>{doc&&<button type="button" className="secondary-button" onClick={()=>setPreview(doc.id)}>打开阅读{doc.material_scope!=='abstract'&&'与编辑'}<ArrowUpRight size={13}/></button>}</header>{selected==='@home'?<div className="kb-body"><p className="kb-home-intro">浏览论文知识与跨论文研究成果。选择左侧分类，或从下方打开论文。</p><h3>论文 Wiki · {paperGroups.length}</h3><div className="kb-home-list">{paperGroups.map(paper=><button type="button" className="kb-home-row" key={paper.sourceId} onClick={()=>choose(paper.entry.id)}><strong>{paper.title}</strong>{paper.metadata&&<small>{paper.metadata}</small>}</button>)}</div><details><summary>知识库说明与其他入口</summary><div onClick={navigateLink}><ChatMarkdown text={text.replace(/^#\s+.+$/m,'')} allowRelativeLinks/></div></details></div>:loading?<p role="status">正在读取…</p>:<div ref={content} className="kb-body" onClick={navigateLink}><ChatMarkdown text={text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(doc?/^#\s+.+$/m:/$^/,'')} allowRelativeLinks/></div>}{doc&&<footer><code>{doc.path}</code></footer>}</article>}</div>}
 {preview&&<LiteratureDocumentDialog key={preview} projectId={projectId} initialId={preview} onClose={()=>setPreview(undefined)} onSaved={()=>setRevision(value=>value+1)}/>}
 {names&&<SummaryNamePreview projectId={projectId} onClose={()=>setNames(false)} onSaved={()=>setRevision(value=>value+1)}/>}
 </section>;
}
