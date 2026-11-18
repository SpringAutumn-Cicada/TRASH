import {lstatSync,watch,type FSWatcher} from 'node:fs';
import {join} from 'node:path';
import type {ServerResponse} from 'node:http';
import {projectStream} from './project-updates.js';
import type {TrashStore} from '@trash/storage';
import type {KnowledgeAgent} from './knowledge-agent.js';
import {currentPaperWiki,MarkdownKnowledge} from './markdown-knowledge.js';
import {parseIdcard} from './source-bibliography.js';
import {cacheSourceAnalysis,sourceAnalysisReady,resetSourceAnalysis} from './source-analysis-cache.js';

const emptyDisplay={hasWiki:false,stale:false,currentWikiFiles:0,oldWikiFiles:0,hasOutputs:false,hasBasic:false,hasKey:false,hasDetail:false,hasCards:false};
type Display=typeof emptyDisplay & {bibliography?:ReturnType<typeof parseIdcard>};
type DisplayRow={source_id:string;data:string;idcard_hash:string|null};

export function refreshSourceAnalysisDisplay(store:TrashStore,project:string){
 if(sourceAnalysisReady(store,project))return;
 const markdown=new MarkdownKnowledge(store);
 const documents=markdown.index(project).documents;
 const bySource=new Map<string,typeof documents>();
 for(const doc of documents){
  if(!doc.source_id)continue;
  const group=bySource.get(doc.source_id)??[];
  group.push(doc);
  bySource.set(doc.source_id,group);
 }
 const rows=store.db.prepare('SELECT source_id,data,idcard_hash FROM source_analysis_display WHERE project_id=?').all(project) as DisplayRow[];
 const previous=new Map(rows.map(row=>[row.source_id,row]));
 const write=store.db.prepare(`INSERT INTO source_analysis_display(source_id,project_id,data,idcard_hash)
  VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET data=excluded.data,idcard_hash=excluded.idcard_hash`);
 let complete=true;
 store.db.transaction(()=>{
  for(const source of store.listSources(project)){
   const id=source.source_id,docs=bySource.get(id)??[],old=previous.get(id);
   const idcard=docs.find(doc=>doc.path===`knowledge_base/papers/${id}/idcard.md`);
   const fingerprint=idcard?.hash??null;
   let bibliography:Display['bibliography'];
   if(idcard){
    try{bibliography=old&&old.idcard_hash===fingerprint?JSON.parse(old.data).bibliography:parseIdcard(markdown.readIndexed(project,idcard).text);}
    catch{complete=false;}
   }
   const wiki=currentPaperWiki(docs,id),types=new Set(docs.map(doc=>doc.card_type));
   const data=JSON.stringify({bibliography,hasWiki:wiki.hasWiki,stale:wiki.stale,
    currentWikiFiles:wiki.current_paths.length,oldWikiFiles:wiki.retired_paths.length,hasOutputs:docs.length>0,
    hasBasic:types.has('basic'),hasKey:types.has('key'),hasDetail:types.has('detail'),hasCards:types.has('key')&&types.has('detail')} satisfies Display);
   const idcardHash=idcard&&!bibliography?null:fingerprint;
   if(data!==old?.data||idcardHash!==old?.idcard_hash)write.run(id,project,data,idcardHash);
  }
 })();
 if(complete)cacheSourceAnalysis(store,project);
}

export function sourceAnalyses(store:TrashStore,agent:KnowledgeAgent,project:string,sourceId?:string){
 refreshSourceAnalysisDisplay(store,project);
 const rows=store.db.prepare(`SELECT s.source_id,d.data AS display,
  json_object('title',json_extract(s.data,'$.title'),'authors',json_extract(s.data,'$.authors'),
   'year',json_extract(s.data,'$.year'),'publication_date',json_extract(s.data,'$.publication_date')) AS metadata,
  json_extract(b.data,'$.manual') AS manual,json_type(b.data,'$.suggestion') AS suggestion,
  t.task_id,t.status,t.error
  FROM sources s LEFT JOIN source_analysis_display d ON d.source_id=s.source_id
  LEFT JOIN source_bibliography b ON b.source_id=s.source_id
  LEFT JOIN knowledge_task_summaries t ON t.task_id=(
   SELECT task_id FROM knowledge_task_summaries
   WHERE project_id=s.project_id AND include_source_wiki=1 AND json_extract(source_ids,'$[0]')=s.source_id
    AND prompt_version>=4 AND dismissed_reanalysis=0
   ORDER BY created_at DESC,task_id DESC LIMIT 1
  )
  WHERE s.project_id=? AND coalesce(json_extract(s.data,'$.material_scope'),'fulltext')<>'abstract'
  ${sourceId?'AND s.source_id=?':''} ORDER BY s.imported_at DESC`).all(...(sourceId?[project,sourceId]:[project])) as {
   source_id:string;display:string|null;metadata:string;manual:string|null;suggestion:string|null;
   task_id:string|null;status:string|null;error:string|null;
  }[];
 return rows.map(row=>{
  const display:Display=row.display?JSON.parse(row.display):emptyDisplay;
  if(display.bibliography&&row.manual){
   const manual: string[]=JSON.parse(row.manual);
   for(const field of ['title','authors','publication_date'] as const)if(manual.includes(field))delete display.bibliography[field];
  }
  return {...display,metadata:JSON.parse(row.metadata) as {title:string;authors:string[]|null;year:number|null;publication_date:string|null},source_id:row.source_id,status:row.status??undefined,error:row.error??undefined,
   task_id:row.task_id??undefined,metadataPending:Boolean(row.suggestion&&row.suggestion!=='null'),
   can_resume:row.task_id&&row.status?agent.resumeHintFor(project,row.task_id,row.status):false};
 });
}

type WatchGroup={watchers:FSWatcher[];count:number};
const watches=new WeakMap<TrashStore,Map<string,WatchGroup>>();
function watchKnowledge(store:TrashStore,project:string,response:ServerResponse){
 const projects=watches.get(store)??new Map<string,WatchGroup>();
 watches.set(store,projects);
 let group=projects.get(project);
 if(!group){
  const markdown=new MarkdownKnowledge(store),root=markdown.root(project);
  const watchers:FSWatcher[]=[];
  for(const part of ['knowledge_base','wiki','literature/cards']){
   try{
    const path=join(root,part);
    if(!lstatSync(path).isDirectory())continue;
    const watcher=watch(path,{recursive:true,persistent:false},(_event,filename)=>{
     if(!filename||filename.endsWith('.md')||!filename.includes('.'))markdown.invalidate(project);
    });
    watcher.on('error',()=>watcher.close());
    watchers.push(watcher);
   }catch{/* Legacy projects might not have all knowledge directories. */}
  }
  group={watchers,count:0};
  projects.set(project,group);
  resetSourceAnalysis(store,project);
 }
 const subscription=group;
 subscription.count++;
 response.once('close',()=>{
  if(--subscription.count)return;
  for(const watcher of subscription.watchers)watcher.close();
  projects.delete(project);
 });
}

export function streamSourceAnalyses(store:TrashStore,agent:KnowledgeAgent,project:string,response:ServerResponse){
 watchKnowledge(store,project,response);
 const initial=sourceAnalyses(store,agent,project);
 const stream=projectStream(store,project,response);
 const previous=new Map(initial.map(row=>[row.source_id,JSON.stringify(row)]));
 stream.onUpdate(update=>{
  if(!update.wiki&&!update.sources.size)return;
  const rows=update.wiki?sourceAnalyses(store,agent,project):
   [...update.sources].flatMap(id=>sourceAnalyses(store,agent,project,id));
  const present=new Set(rows.map(row=>row.source_id));
  const removed=[...(update.wiki?previous.keys():update.sources)].filter(id=>!present.has(id)&&previous.delete(id));
  const changed=rows.filter(row=>{
   const data=JSON.stringify(row);
   if(previous.get(row.source_id)===data)return false;
   previous.set(row.source_id,data);
   return true;
  });
  if(changed.length||removed.length)stream.send('change',{analyses:changed,removed});
 });
 // The snapshot and subscription are established in the same server turn.
 // Every connection starts with fresh state, including after a reconnect.
 stream.send('snapshot',{analyses:initial});
}
