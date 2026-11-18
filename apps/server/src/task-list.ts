import type {TrashStore} from '@trash/storage';
import {z} from 'zod';
import {taskSummary} from './task-events.js';

type Header=Parameters<typeof taskSummary>[1];
type HeaderRow=Omit<Header,'input'> & {
 title:string; kind:Header['input']['kind']; wiki_level:Header['input']['wiki_level'];
 source_ids:string|null; abstract_mode:number|null; include_source_wiki:number|null;
};
const filters=['all','active','failed','interrupted','completed','history'] as const;
const active=(status:string)=>status==='queued'||status==='running';
const rank=(status:string)=>status==='running'?0:status==='queued'?1:2;
function taskType(task:Header){
 return task.input.abstract_mode?'摘要分析':task.input.kind==='literature-card'?'论文分析':
  task.input.wiki_level==='discovery'?'主题发现':task.input.wiki_level==='overview'?'项目总览':'Wiki 综合';
}

export function listTasks(store:TrashStore,projectId:string,url:URL){
 const {filter,q,page,limit,focus}=z.object({
  filter:z.enum(filters).default('all'),q:z.string().trim().default(''),
  page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(200).optional(),
  focus:z.string().optional(),
 }).parse(Object.fromEntries(url.searchParams));
 const rows=store.db.prepare(`SELECT task_id,project_id,status,created_at,title,kind,source_ids,abstract_mode,
  include_source_wiki,wiki_level,attempt_of,output_id,error FROM knowledge_task_summaries
  WHERE project_id=? AND archived_duplicate=0 AND deleted_at IS NULL
  ORDER BY created_at DESC,task_id DESC`).all(projectId) as HeaderRow[];
 const titles=new Map(store.listSources(projectId,true).map(source=>[source.source_id,source.title]));
 const tasks=rows.map(({title,kind,source_ids,include_source_wiki,abstract_mode,wiki_level,...row})=>{
  const input={title,kind,source_ids:JSON.parse(source_ids??'[]') as string[],
   include_source_wiki:Boolean(include_source_wiki),abstract_mode:Boolean(abstract_mode),wiki_level};
  return {...row,attempt_of:row.attempt_of??undefined,error:row.error??undefined,
   output_id:row.output_id??undefined,input,title:(kind==='literature-card'?titles.get(input.source_ids[0]):undefined)??title};
 });
 const byId=new Map(tasks.map(task=>[task.task_id,task]));
 const successors=new Map<string,typeof tasks[number]>();
 for(const candidate of [...tasks].sort((a,b)=>Number(active(b.status))-Number(active(a.status)))){
  const seen=new Set([candidate.task_id]);
  for(let id=candidate.attempt_of;id&&!seen.has(id);id=byId.get(id)?.attempt_of){
   seen.add(id);
   if(!successors.has(id))successors.set(id,candidate);
  }
 }
 const historical=(task:Header)=>['failed','interrupted','cancelled'].includes(task.status)&&successors.has(task.task_id);
 const matches=(task:Header,value:typeof filters[number])=>value==='history'?historical(task):
  !historical(task)&&(value==='all'||(value==='active'?active(task.status):value===task.status));
 const counts=Object.fromEntries(filters.map(value=>[value,tasks.filter(task=>matches(task,value)).length]));
 const filtered=tasks.filter(task=>matches(task,filter)&&(`${task.title} ${taskType(task)}`).toLowerCase().includes(q.toLowerCase()));
 filtered.sort((a,b)=>rank(a.status)-rank(b.status));
 const lastPage=limit?Math.max(1,Math.ceil(filtered.length/limit)):1;
 const currentPage=Math.min(page,lastPage);
 const displayed=limit?filtered.slice((currentPage-1)*limit,currentPage*limit):filtered;
 const summarize=(task:typeof tasks[number])=>({...taskSummary(store,task,task.title),historical:historical(task),successor_id:successors.get(task.task_id)?.task_id});
 const focused=focus?byId.get(focus):undefined;
 return {tasks:displayed.map(summarize),counts,total:filtered.length,page:currentPage,pages:lastPage,
  focused:focused&&!displayed.includes(focused)?summarize(focused):undefined};
}
