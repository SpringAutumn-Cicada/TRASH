import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TrashStore,KnowledgeTask} from '@trash/storage';
import {z} from 'zod';
import {projectRuntime} from './project-layout.js';
import {readFileSync} from 'node:fs';

const streams=new WeakMap<TrashStore,Set<()=>void>>();
const active=(status:string)=>['queued','running'].includes(status);
export function taskSummary(store:TrashStore,task:KnowledgeTask){
 const source=task.input.kind==='literature-card'?store.getSource(task.input.source_ids[0]):undefined;
 const latest=store.db.prepare('SELECT seq,at,message FROM knowledge_task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(task.task_id) as {seq:number;at:string;message:string}|undefined;
 const started=store.db.prepare("SELECT at FROM knowledge_task_events WHERE task_id=? AND message LIKE 'Agent 版本：%' ORDER BY seq LIMIT 1").get(task.task_id) as {at:string}|undefined;
 let chapterTitle:string|undefined;try{if(active(task.status))chapterTitle=JSON.parse(readFileSync(projectRuntime(store.root,task.project_id,'tasks',task.task_id,'reading-progress.json'),'utf8')).title;}catch{/* Legacy task. */}
 const latestProgress=store.db.prepare("SELECT at,message FROM knowledge_task_events WHERE task_id=? AND (message LIKE 'PDF %' OR message LIKE '复用已完成批次 %' OR message LIKE '启动本机 %' OR message LIKE 'Markdown 已发布：%') ORDER BY seq DESC LIMIT 1").get(task.task_id) as {at:string;message:string}|undefined;
 return {task_id:task.task_id,title:source?.title??task.input.title,input:{abstract_mode:task.input.abstract_mode,kind:task.input.kind,title:task.input.title,source_ids:task.input.source_ids,include_source_wiki:task.input.include_source_wiki,wiki_level:task.input.wiki_level},status:task.status,error:task.error,output_id:task.output_id,created_at:task.created_at,started_at:started?.at,attempt_of:task.attempt_of,last_at:latest?.at,last_seq:latest?.seq??0,progress:chapterTitle??latestProgress?.message};
}
export function taskReadingProgress(store:TrashStore,task:KnowledgeTask){
 try{
  const directory=projectRuntime(store.root,task.project_id,'tasks',task.task_id);
  const progress=JSON.parse(readFileSync(projectRuntime(store.root,task.project_id,'tasks',task.task_id,'reading-progress.json'),'utf8')) as {phase:string;title:string;warnings?:string[]};
  const source=task.input.source_ids[0];if(!source)return undefined;
  const fixed=progress as typeof progress & {total?:number;completed?:number};
  if(fixed.total!==undefined)return {unit:'pages',total:fixed.total,completed:fixed.completed??0,phase:fixed.phase,title:fixed.title};
  const plan=JSON.parse(readFileSync(directory+'/readings/'+source+'/plan.json','utf8')) as {sections:{id:string;title:string;level:number;confidence:number;reason:string;parent?:string}[];blocks:{id:string;chapter:string;pages:number[];mode:string;warnings:string[]}[];warnings:string[]};
  const legacyState=JSON.parse(readFileSync(directory+'/readings/'+source+'/state.json','utf8')) as {blocks?:{pages:number[]}[]};
  if(plan.blocks?.length){const pages=plan.blocks.flatMap(block=>block.pages),done=new Set((legacyState.blocks??[]).flatMap(block=>block.pages));return {unit:'pages',total:Math.max(...pages,0),completed:done.size,phase:progress.phase,title:'固定四页批次阅读',warnings:[]};}
  let completedIds:string[]=[];try{completedIds=JSON.parse(readFileSync(directory+'/readings/'+source+'/state.json','utf8')).blocks.map((block:{id:string})=>block.id);}catch{/* Planning has not written notes. */}
  return {unit:'blocks',total:plan.blocks.length,completed:completedIds.length,phase:progress.phase,title:progress.title,warnings:[...new Set([...(plan.warnings??[]),...(progress.warnings??[])])],sections:plan.sections,blocks:plan.blocks.map(block=>({id:block.id,title:plan.sections.find(section=>section.id===block.chapter)?.title,pages:block.pages,mode:block.mode,warnings:block.warnings,completed:completedIds.includes(block.id)}))};
 }catch{/* Legacy page batches or planning has not completed. */}
 try{
  const saved=JSON.parse(readFileSync(projectRuntime(store.root,task.project_id,'tasks',task.task_id,'pdf-reading.json'),'utf8')) as {sources:{pageCount?:number;batches:{pages:number[];status:string}[]}[]};
  return {total:saved.sources.reduce((n,s)=>n+(s.pageCount??0),0),completed:saved.sources.reduce((n,s)=>n+new Set(s.batches.filter(b=>['notes-produced','reused-notes'].includes(b.status)).flatMap(b=>b.pages)).size,0)};
 }catch{return undefined;}
}
export function taskEventPage(store:TrashStore,task:KnowledgeTask,options:{after?:number;before?:number;limit?:number}={},canResume?:(task:KnowledgeTask)=>boolean){
 const limit=options.limit??100;
 const direction=options.after!==undefined?'after':options.before!==undefined?'before':'tail';
 const rows=store.db.prepare(`SELECT seq,at,message FROM knowledge_task_events WHERE task_id=? ${direction==='after'?'AND seq>?':direction==='before'?'AND seq<?':''} ORDER BY seq ${direction==='after'?'ASC':'DESC'} LIMIT ?`).all(task.task_id,...(direction==='tail'?[]:[options.after??options.before]),limit) as {seq:number;at:string;message:string}[];
 let bytes=0;const bounded=[] as typeof rows;for(const row of rows){const size=Buffer.byteLength(row.message);if(bounded.length&&bytes+size>256*1024)break;bounded.push(row);bytes+=size;}
 const events=direction==='after'?bounded:bounded.reverse();
 const first=events[0]?.seq,last=events.at(-1)?.seq;
 return {task:{...taskSummary(store,task),can_resume:canResume?.(task)??false},reading:taskReadingProgress(store,task),events,first_seq:first??null,last_seq:last??options.after??0,
  has_older:first!==undefined&&Boolean(store.db.prepare('SELECT 1 FROM knowledge_task_events WHERE task_id=? AND seq<? LIMIT 1').get(task.task_id,first)),
  has_more:last!==undefined&&Boolean(store.db.prepare('SELECT 1 FROM knowledge_task_events WHERE task_id=? AND seq>? LIMIT 1').get(task.task_id,last))};
}
export function eventOptions(url:URL){
 const input=z.object({after:z.coerce.number().int().min(0).optional(),before:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(Object.fromEntries([...url.searchParams].filter(([name])=>['after','before','limit'].includes(name))));
 if(input.after!==undefined&&input.before!==undefined)throw Object.assign(new Error('INVALID_REQUEST'),{statusCode:400});return input;
}
export function streamTaskEvents(store:TrashStore,task:KnowledgeTask,request:IncomingMessage,response:ServerResponse,url:URL,canResume?:(task:KnowledgeTask)=>boolean){
 const options=eventOptions(url);if(options.before!==undefined)throw Object.assign(new Error('INVALID_REQUEST'),{statusCode:400});const header=request.headers['last-event-id'];
 let cursor=Math.max(options.after??0,z.coerce.number().int().min(0).parse(header??0)),blocked=false,closed=false;
 response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});response.flushHeaders();
 const registered=streams.get(store)??new Set<()=>void>();streams.set(store,registered);
 const close=()=>{if(closed)return;closed=true;clearInterval(timer);response.off('drain',drain);registered.delete(close);if(!response.writableEnded)response.end();};
 const send=(name:string,data:unknown,id?:number)=>{blocked=!response.write(`${id===undefined?'':`id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);};
 const tick=()=>{if(closed||blocked)return;try{
  const row=store.db.prepare('SELECT data FROM knowledge_tasks WHERE task_id=? AND project_id=?').get(task.task_id,task.project_id) as {data:string}|undefined;
  if(!row){send('removed',{});close();return;}
  const current=JSON.parse(row.data) as KnowledgeTask,page=taskEventPage(store,current,{after:cursor,limit:100},canResume);
  send('batch',page,page.last_seq);cursor=page.last_seq;
  if(!active(current.status)&&!page.has_more){send('done',{status:current.status});close();}
 }catch{close();}};
 const drain=()=>{blocked=false;};response.on('drain',drain);
 const timer=setInterval(tick,1000);timer.unref();registered.add(close);response.once('close',close);tick();
}
export function closeTaskStreams(store:TrashStore){for(const close of streams.get(store)??[])close();streams.delete(store);}
