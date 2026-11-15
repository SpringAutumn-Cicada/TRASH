import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {knowledgeTaskInputSchema} from '@trash/protocol';
import {KnowledgeStore,type TrashStore,type KnowledgeTask} from '@trash/storage';
import {KnowledgeAgent} from './knowledge-agent.js';
import {MarkdownKnowledge} from './markdown-knowledge.js';
import {projectRuntime} from './project-layout.js';

type Run={id:string;project_id:string;source_ids:string[];created_at:string;updated_at:string;stage:'summarizing'|'generating'|'completed'|'failed'|'interrupted'|'cancelled';tasks:string[];history_tasks:string[];round:number;result_id?:string;error?:string;instructions:string};
const active=(run:Run)=>['summarizing','generating'].includes(run.stage);
export class ResearchExploration {
 constructor(private store:TrashStore,private knowledge:KnowledgeStore,private agent:KnowledgeAgent){
  const previous=agent.onTaskSettled;
  agent.onTaskSettled=(project,task)=>{previous?.(project,task);for(const run of this.list(project).filter(active))this.advance(run);};
  for(const project of store.listProjects())for(const run of this.list(project.project_id).filter(active)){run.stage='interrupted';run.error='服务重启，已完成材料保留，请继续探索。';this.save(run);}
 }
 private root(project:string){return projectRuntime(this.store.root,project,'research-exploration');}
 private save(run:Run){run.updated_at=new Date().toISOString();const root=this.root(run.project_id);mkdirSync(root,{recursive:true});const file=join(root,run.id+'.json');writeFileSync(file+'.tmp',JSON.stringify(run),{mode:0o600});renameSync(file+'.tmp',file);}
 list(project:string):Run[]{const root=this.root(project);if(!existsSync(root))return [];return readdirSync(root).filter(name=>/^exploration_[a-f0-9-]+\.json$/.test(name)).flatMap(name=>{try{return [JSON.parse(readFileSync(join(root,name),'utf8')) as Run];}catch{return [];}}).sort((a,b)=>b.created_at.localeCompare(a.created_at));}
 detail(project:string,id:string){const run=this.list(project).find(run=>run.id===id);if(!run)throw Object.assign(new Error('NOT_FOUND'),{statusCode:404});return run;}
 private enqueue(run:Run,ids:string[],mode:'summary'|'directions'){
  return this.agent.enqueue(run.project_id,knowledgeTaskInputSchema.parse({kind:'wiki-page',source_ids:[],dependencies:ids.map(object_id=>({kind:'wiki-page',object_id,version:1})),title:mode==='summary'?'研究方向探索：材料分组':'研究方向探索：候选问题',instructions:run.instructions,wiki_level:mode==='summary'?'summary':'discovery',research_exploration:mode,regenerate:true}))[0];
 }
 private schedule(run:Run,ids:string[]){
  const md=new MarkdownKnowledge(this.store),docs=ids.map(id=>md.read(run.project_id,id)),groups:string[][]=[];let group:string[]=[],size=0;
  for(const doc of docs){if(doc.text.length>40000)throw new Error('单页材料超过探索预算，请先将知识页合理拆分，不截断正文');if(size+doc.text.length>40000&&group.length){groups.push(group);group=[];size=0;}group.push(doc.id);size+=doc.text.length;}if(group.length)groups.push(group);
  run.history_tasks.push(...run.tasks);run.tasks=[];
  if(groups.length===1){run.stage='generating';this.save(run);run.tasks=[this.enqueue(run,groups[0],'directions').task_id];}
  else{if(++run.round>6)throw new Error('材料归纳未能在预算内收敛，请缩小论文范围');run.stage='summarizing';this.save(run);for(const ids of groups){run.tasks.push(this.enqueue(run,ids,'summary').task_id);this.save(run);}}
  this.save(run);
 }
 start(project:string,sourceIds:string[],instructions:string){
  const existing=this.list(project).find(active);if(existing)throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  const p=this.store.getProject(project);if(!p?.research_area)throw Object.assign(new Error('RESEARCH_AREA_REQUIRED'),{statusCode:422});
  const md=new MarkdownKnowledge(this.store),all=md.index(project).documents,selected=[...new Set(sourceIds)];
  if(!selected.length)throw Object.assign(new Error('SOURCES_REQUIRED'),{statusCode:422});
  for(const id of selected)if(this.store.getSource(id)?.project_id!==project||!all.some(d=>d.source_id===id&&d.path.endsWith('/whoami.md')))throw Object.assign(new Error('SOURCE_WIKI_REQUIRED'),{statusCode:422});
  const docs=all.filter(d=>selected.includes(d.source_id??'')&&d.kind==='wiki-page'&&d.level==='single'&&d.path.startsWith('knowledge_base/papers/'));
  const at=new Date().toISOString(),run:Run={id:'exploration_'+randomUUID(),project_id:project,source_ids:selected,created_at:at,updated_at:at,stage:'summarizing',tasks:[],history_tasks:[],round:0,instructions};
  this.save(run);try{this.schedule(run,docs.map(d=>d.id));}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'探索启动失败';this.save(run);}return run;
 }
 private advance(run:Run){
  const all=this.knowledge.tasks(run.project_id),tasks=run.tasks.map(id=>all.find(t=>t.task_id===id));if(!tasks.length)return;
  if(tasks.some(t=>!t||['failed','cancelled','interrupted'].includes(t.status))){run.stage='failed';run.error='部分探索任务未完成；已完成的知识和日志保留，可继续探索。';this.save(run);return;}
  if(tasks.some(t=>t?.status!=='completed'))return;
  const done=tasks as KnowledgeTask[];
  if(run.stage==='generating'){run.result_id=done[0].output_id;run.stage='completed';this.save(run);return;}
  try{this.schedule(run,done.map(t=>t.output_id!));}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'归纳失败';this.save(run);}
 }
 resume(project:string,id:string){const run=this.detail(project,id);if(active(run)||run.stage==='completed')return run;const all=this.knowledge.tasks(project);const tasks=run.tasks.map(id=>all.find(t=>t.task_id===id));if(!tasks.length){run.stage='failed';run.error='没有可恢复的任务，请重新选择论文开始探索。';this.save(run);return run;}
  run.stage=tasks[0]?.input.research_exploration==='directions'?'generating':'summarizing';run.error=undefined;
  run.tasks=tasks.map(task=>{if(!task)throw new Error('TASK_NOT_FOUND');return task.status==='completed'?task.task_id:this.agent.enqueue(project,{...task.input,regenerate:true},task.task_id)[0].task_id;});this.save(run);this.advance(run);return run;
 }
 cancel(project:string,id:string){const run=this.detail(project,id);run.stage='cancelled';this.save(run);for(const task of this.knowledge.tasks(project).filter(t=>run.tasks.includes(t.task_id)&&['queued','running'].includes(t.status)))this.agent.cancel(project,task.task_id);return run;}
}
