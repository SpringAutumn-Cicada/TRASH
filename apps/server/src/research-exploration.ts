import {knowledgeLinks} from './knowledge-links.js';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join,posix} from 'node:path';
import {knowledgeTaskInputSchema} from '@trash/protocol';
import {KnowledgeStore,type TrashStore,type KnowledgeTask} from '@trash/storage';
import {KnowledgeAgent} from './knowledge-agent.js';
import {MarkdownKnowledge,type MarkdownDocument} from './markdown-knowledge.js';
import {projectRuntime} from './project-layout.js';
import {RESEARCH_SUMMARY_HARD_MAX_CHARACTERS,topicDiscoveryEntries} from './research-exploration-format.js';

type ResearchMode='directions'|'research-map'|'comparison'|'background'|'topics';
const modeSkill=(mode:ResearchMode)=>mode==='research-map'?'map' as const:mode==='background'?'background' as const:mode==='directions'?'exploration' as const:'synthesis' as const;
const modeTitles:Record<ResearchMode,string>={directions:'研究方向探索：候选问题','research-map':'研究地图',comparison:'指定主题综合',background:'研究大背景',topics:'多主题综合'};
type Topic={id:string;title:string;body:string;source_ids:string[];material_ids:string[];existing_id?:string;status:'candidate'|'pending'|'generating'|'completed'|'failed';task_id?:string;output_id?:string;error?:string};
type WorkingSummary={origin_id:string;task_id?:string;output_id?:string};
type MaterialRef={id:string;path:string;hash:string;source_ids:string[]};
type MaterialBatch={input_ids:string[];source_ids:string[];task_id?:string;output?:MaterialRef};
type AppendRound={parent_id:string;previous_discovery_id?:string;added_ids:string[];rebuilt_ids:string[];reused:MaterialRef[];batches:MaterialBatch[];unresolved:Topic[]};
type Run={append?:AppendRound;summary_source_ids?:string[];working_summaries?:WorkingSummary[];summary_work_ids?:string[];retained_topics?:Topic[];source_hashes?:{path:string;hash:string}[];topics?:Topic[];discovery_id?:string;directory_id?:string;directory_expected?:string|null;material_ids?:string[];target_id?:string;mode?:ResearchMode;signature?:string;topic_ids?:string[];question_id?:string;question_text?:string;id:string;project_id:string;source_ids:string[];created_at:string;updated_at:string;stage:'summarizing'|'generating'|'discovering'|'topics'|'partial'|'completed'|'failed'|'interrupted'|'cancelled';tasks:string[];history_tasks:string[];round:number;result_id?:string;error?:string;instructions:string};
const active=(run:Run)=>['summarizing','generating','discovering','topics'].includes(run.stage);
const unique=(ids:string[])=>[...new Set(ids)];
const paperSource=(path:string)=>path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.[1];
type SnapshotRef=Pick<MarkdownDocument,'id'|'path'|'hash'|'source_id'|'level'>;
const snapshotDocs=(task?:KnowledgeTask)=>(task?.snapshot as {documents?:SnapshotRef[]}|undefined)?.documents??[];
function batchMaterials<T extends {characters:number}>(documents:T[]){
 const batches:T[][]=[];
 let batch:T[]=[],characters=0;
 for(const doc of documents){
  const length=doc.characters;
  if(length>40000)throw Object.assign(new Error('RESEARCH_MATERIAL_PAGE_TOO_LARGE'),{statusCode:422});
  if(batch.length&&(characters+length>40000||batch.length>=80)){batches.push(batch);batch=[];characters=0;}
  batch.push(doc);characters+=length;
 }
 if(batch.length)batches.push(batch);
 return batches;
}
export class ResearchExploration {
 constructor(private store:TrashStore,private knowledge:KnowledgeStore,private agent:KnowledgeAgent){
  const previous=agent.onTaskSettled;
  agent.onTaskSettled=(project,task)=>{try{previous?.(project,task);}finally{for(const run of this.list(project).filter(active))this.advance(run);}};
  for(const project of store.listProjects())for(const run of this.list(project.project_id).filter(active)){run.stage='interrupted';run.error='服务重启，已完成材料保留，请继续探索。';this.save(run);}
 }
 private root(project:string){return projectRuntime(this.store.root,project,'research-exploration');}
 private save(run:Run){run.updated_at=new Date().toISOString();const root=this.root(run.project_id);mkdirSync(root,{recursive:true});const file=join(root,run.id+'.json');writeFileSync(file+'.tmp',JSON.stringify(run),{mode:0o600});renameSync(file+'.tmp',file);}
 list(project:string):Run[]{const root=this.root(project);if(!existsSync(root))return [];return readdirSync(root).filter(name=>/^exploration_[a-f0-9-]+\.json$/.test(name)).flatMap(name=>{try{return [JSON.parse(readFileSync(join(root,name),'utf8')) as Run];}catch{return [];}}).sort((a,b)=>b.created_at.localeCompare(a.created_at));}
 topicDirectories(project:string){
  const directories=new MarkdownKnowledge(this.store).index(project).documents.filter(doc=>doc.page_role==='topic-index');
  const published=this.list(project).find(run=>run.mode==='topics'&&directories.some(doc=>doc.id===run.result_id));
  const current=directories.find(doc=>doc.id===published?.result_id)??directories[0];
  return {current,archived:directories.filter(doc=>doc.id!==current?.id)};
 }
 directoryVersions(project:string,id:string){
  const md=new MarkdownKnowledge(this.store);
  const {current,archived}=this.topicDirectories(project);
  const directories=[...(current?[current]:[]),...archived];
  if(!directories.some(doc=>doc.id===id))throw Object.assign(new Error('NOT_FOUND'),{statusCode:404});
  return {versions:directories.flatMap(doc=>{
   const snapshots=md.history(project,doc.id);
   if(!snapshots.some(snapshot=>snapshot.hash===doc.hash))snapshots.push({hash:doc.hash,text:md.read(project,doc.id).text,at:doc.modified});
   return snapshots.map(snapshot=>({...snapshot,id:doc.id,path:doc.path,current:doc.id===current?.id&&snapshot.hash===doc.hash,archived:doc.id!==current?.id}));
  }).sort((a,b)=>Number(b.current)-Number(a.current)||b.at.localeCompare(a.at))};
 }
 private superseded(run:Run,runs:Run[]){
  return run.mode==='topics'&&runs.some(other=>other.mode==='topics'&&other.result_id&&other.created_at>run.created_at);
 }
 summaries(project:string){
  // Project-scoped task metadata and activity timestamps only; never load model logs or snapshots.
  const tasks=this.store.db.prepare("SELECT task_id,status,json_extract(data,'$.input.title') AS title,json_extract(data,'$.input.research_exploration') AS mode,json_extract(data,'$.created_at') AS created_at FROM knowledge_tasks WHERE project_id=?").all(project) as {task_id:string;status:string;title:string;mode?:string;created_at:string}[];
  const byId=new Map(tasks.map(task=>[task.task_id,task]));
  const latest=this.store.db.prepare('SELECT at FROM knowledge_task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1');
  const runs=this.list(project);
  return runs.map(run=>{
   const details=run.tasks.map((id,index)=>{const task=byId.get(id);return {id,title:run.topics?.find(topic=>topic.task_id===id)?.title??(task?.mode==='summary'?(run.append?task.title:`第 ${index+1} 组材料`):task?.mode==='summary-working'?`第 ${index+1} 组材料工作版`:task?.mode==='topic-discovery'?'发现主题':task?.title??'任务记录缺失'),status:task?.status??'missing',last_activity_at:(task?.status==='running'?(latest.get(id) as {at:string}|undefined)?.at:undefined)??task?.created_at};});
   const phase=run.stage==='summarizing'?'materials':run.stage==='discovering'?'discovery':run.stage==='completed'?'done':run.stage==='topics'||run.topics?'synthesis':details.some(task=>byId.get(task.id)?.mode==='summary')||run.append?.batches.some(batch=>!batch.output)?'materials':run.mode==='topics'?'discovery':'synthesis';
   const countingTopics=['synthesis','done'].includes(phase)&&Boolean(run.topics);
   const states=countingTopics?run.topics!.filter(topic=>topic.status!=='candidate').map(topic=>topic.status):details.map(task=>task.status);
   const count=(names:string[])=>states.filter(state=>names.includes(state)).length;
   const current=details.find(task=>task.status==='running');
   const last=[run.updated_at,...details.flatMap(task=>task.last_activity_at?[task.last_activity_at]:[])].sort().at(-1);
   return {id:run.id,mode:run.mode,question_id:run.question_id,stage:run.stage,source_ids:run.source_ids,created_at:run.created_at,updated_at:run.updated_at,instructions:run.instructions,error:run.error,result_id:run.result_id,discovery_id:run.discovery_id,tasks:run.tasks,
    superseded:this.superseded(run,runs),
    can_append:run.mode==='topics'&&Boolean(run.result_id)&&['completed','partial'].includes(run.stage)&&!this.superseded(run,runs),
    append:run.append?{parent_id:run.append.parent_id,added_ids:run.append.added_ids,rebuilt_ids:run.append.rebuilt_ids,batches:run.append.batches.map(batch=>({source_ids:batch.source_ids,task_id:batch.task_id,output_id:batch.output?.id}))}:undefined,
    topics:run.topics?.map(({id,title,status,task_id,output_id,error})=>({id,title,status,task_id,output_id,error})),
    progress:{phase,round:run.round,total:states.length,completed:count(['completed']),running:count(['running','generating']),queued:count(['queued','pending']),failed:count(['failed','interrupted','cancelled','missing']),candidates:run.topics?.filter(topic=>topic.status==='candidate').length??0,current_title:current?.title,last_activity_at:last,details}};
  });
 }
 detail(project:string,id:string){const run=this.list(project).find(run=>run.id===id);if(!run)throw Object.assign(new Error('NOT_FOUND'),{statusCode:404});return run;}
 private planAppend(project:string,id:string,sourceIds:string[]){
  const parent=this.detail(project,id);
  if(parent.mode!=='topics'||!['completed','partial'].includes(parent.stage)||!parent.result_id)
   throw Object.assign(new Error('RESEARCH_APPEND_NOT_AVAILABLE'),{statusCode:409});
  const runs=this.list(project);
  if(runs.some(active))throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  if(this.superseded(parent,runs))
   throw Object.assign(new Error('RESEARCH_APPEND_OUTDATED'),{statusCode:409});
  const added=unique(sourceIds).sort(),selected=unique([...parent.source_ids,...added]);
  if(!added.length||added.some(source=>parent.source_ids.includes(source))||selected.length>100)
   throw Object.assign(new Error('RESEARCH_APPEND_INVALID_SOURCES'),{statusCode:422});

  const md=new MarkdownKnowledge(this.store),all=md.index(project).documents;
  const byId=new Map(all.map(doc=>[doc.id,doc]));
  const directory=byId.get(parent.result_id);
  if(!directory||directory.page_role!=='topic-index')throw Object.assign(new Error('RESEARCH_APPEND_DIRECTORY_MISSING'),{statusCode:409});
  const papers=all.filter(doc=>doc.source_id&&selected.includes(doc.source_id)&&doc.kind==='wiki-page'&&doc.level==='single'&&paperSource(doc.path)===doc.source_id&&(doc.group_status===undefined||doc.group_status==='current'));
  if(selected.some(source=>!papers.some(doc=>doc.source_id===source&&doc.path.endsWith('/whoami.md')&&!doc.stale)))
   throw Object.assign(new Error('RESEARCH_APPEND_WIKI_UNAVAILABLE'),{statusCode:422});

  const tasks=this.knowledge.tasks(project),producers=new Map(tasks.filter(task=>task.status==='completed'&&task.output_id).map(task=>[task.output_id!,task]));
  const initial=snapshotDocs(parent.discovery_id?producers.get(parent.discovery_id):undefined);
  const historical=new Map(parent.source_hashes?.map(ref=>[ref.path,ref.hash]));
  const scope=(ref:SnapshotRef,visited=new Set<string>()):string[]=>{
   const source=paperSource(ref.path);if(source)return [source];
   if(visited.has(ref.id))return [];
   visited.add(ref.id);
   const task=producers.get(ref.id);
   if(!task||ref.level!=='summary')return [];
   const inputs=snapshotDocs(task);
   for(const entry of inputs)if(paperSource(entry.path)&&!historical.has(entry.path))historical.set(entry.path,entry.hash);
   const inherited=inputs.flatMap(entry=>scope(entry,visited));
   return unique(inherited.length?inherited:task.input.research_exploration==='summary'?task.input.source_ids:[]);
  };
  const references=parent.append
   ?[...parent.append.reused,...parent.append.batches.flatMap(batch=>batch.output?[batch.output]:[])]
   :initial.map(ref=>({id:ref.id,path:ref.path,hash:ref.hash,source_ids:scope(ref)}));
  for(const ref of initial)if(paperSource(ref.path)&&!historical.has(ref.path))historical.set(ref.path,ref.hash);
  const currentHashes=new Map(papers.map(doc=>[doc.path,doc.hash]));
  const changed=new Set([...historical].flatMap(([path,hash])=>currentHashes.get(path)===hash?[]:[paperSource(path)??'']));
  if(parent.source_hashes?.length)for(const doc of papers)if(parent.source_ids.includes(doc.source_id!)&&!historical.has(doc.path))changed.add(doc.source_id!);

  const rebuilt=new Set<string>(),reused:MaterialRef[]=[];
  for(const ref of references){
   const current=byId.get(ref.id);
   if(!current||current.hash!==ref.hash||current.path!==ref.path||current.stale||ref.source_ids.some(source=>changed.has(source))){
    for(const source of ref.source_ids)rebuilt.add(source);
   }else reused.push(ref);
  }
  const covered=new Set(reused.flatMap(ref=>ref.source_ids));
  for(const source of parent.source_ids)if(changed.has(source)||!covered.has(source))rebuilt.add(source);
  const rebuiltIds=parent.source_ids.filter(source=>rebuilt.has(source));
  const group=(sources:string[])=>batchMaterials(papers
   .filter(doc=>sources.includes(doc.source_id!)&&/\/(whoami|research_problem|contributions|insights)\.md$/.test(doc.path))
   .sort((a,b)=>a.source_id!.localeCompare(b.source_id!)||a.path.localeCompare(b.path))
   .map(doc=>({id:doc.id,source_id:doc.source_id!,characters:doc.characters??md.read(project,doc.id).text.length})))
   .map(docs=>({input_ids:docs.map(doc=>doc.id),source_ids:unique(docs.map(doc=>doc.source_id!))}));
  const batches=[...group(added),...group(rebuiltIds)];
  const sourceHashes=papers.map(({path,hash})=>({path,hash}));
  const token=createHash('sha256').update(JSON.stringify({id,updated:parent.updated_at,directory:directory.hash,sourceHashes,added,rebuiltIds,reused,batches})).digest('hex');
  return {parent,directory,selected,added,rebuiltIds,reused,batches,sourceHashes,token};
 }
 previewAppend(project:string,id:string,sourceIds:string[]){
  const plan=this.planAppend(project,id,sourceIds);
  return {token:plan.token,added_ids:plan.added,rebuilt_ids:plan.rebuiltIds,reused_count:plan.parent.source_ids.length-plan.rebuiltIds.length,batch_count:plan.batches.length,total:plan.selected.length};
 }
 appendSources(project:string,id:string,sourceIds:string[],token:string){
  const plan=this.planAppend(project,id,sourceIds);
  if(token!==plan.token)throw Object.assign(new Error('RESEARCH_APPEND_PLAN_CHANGED'),{statusCode:409});
  const {parent,directory,selected,added,rebuiltIds,reused,batches,sourceHashes}=plan;
  const time=new Date().toISOString();
  const run:Run={
   id:'exploration_'+randomUUID(),project_id:project,source_ids:selected,created_at:time,updated_at:time,
   stage:'summarizing',tasks:[],history_tasks:[],round:1,instructions:parent.instructions,mode:'topics',
   source_hashes:sourceHashes,target_id:directory.id,directory_expected:directory.hash,topic_ids:parent.topic_ids,
   retained_topics:[...(parent.retained_topics??[]),...(parent.topics??[]).filter(topic=>topic.status==='completed')],
   append:{parent_id:id,previous_discovery_id:parent.discovery_id,added_ids:added,rebuilt_ids:rebuiltIds,reused,batches,unresolved:(parent.topics??[]).filter(topic=>['pending','failed'].includes(topic.status))},
  };
  this.save(run);
  return this.continueAppend(run);
 }
 private continueAppend(run:Run,retry=false){
  const append=run.append!;
  try{
   const md=new MarkdownKnowledge(this.store),docs=md.index(run.project_id).documents;
   const byId=new Map(docs.map(doc=>[doc.id,doc]));
   const hashes=new Map(docs.map(doc=>[doc.path,doc.hash]));
   if(run.source_hashes?.some(ref=>hashes.get(ref.path)!==ref.hash)||append.reused.some(ref=>hashes.get(ref.path)!==ref.hash))
    throw new Error('材料版本已变化，请从原综合重新预览追加范围。');
   const tasks=new Map(this.knowledge.tasks(run.project_id).map(task=>[task.task_id,task]));
   run.stage='summarizing';run.error=undefined;
   for(const [index,batch] of append.batches.entries()){
    if(batch.output){
     if(hashes.get(batch.output.path)!==batch.output.hash)throw new Error('已完成的追加分组发生变化，请重新预览追加范围。');
     continue;
    }
    const task=batch.task_id?tasks.get(batch.task_id):undefined;
    if(task?.status==='completed'){
     const doc=task.output_id?byId.get(task.output_id):undefined;
     if(!doc||doc.level!=='summary')throw new Error('已完成的追加分组缺少总结，无法发起主题发现。');
     batch.output={id:doc.id,path:doc.path,hash:doc.hash,source_ids:batch.source_ids};
    }else if(!batch.task_id||(retry&&(!task||!['queued','running'].includes(task.status)))){
     const title=`追加材料：第 ${index+1} 组`;
     const input=knowledgeTaskInputSchema.parse({
      kind:'wiki-page',source_ids:batch.source_ids,dependencies:batch.input_ids.map(object_id=>({kind:'wiki-page',object_id,version:1})),
      title,instructions:run.instructions,wiki_level:'summary',research_skill:'synthesis',research_exploration:'summary',regenerate:true,
     });
     const next=this.agent.enqueue(run.project_id,input,task?.task_id)[0];
     if(batch.task_id)run.history_tasks.push(batch.task_id);
     batch.task_id=next.task_id;
    }
    run.tasks=append.batches.flatMap(entry=>entry.task_id?[entry.task_id]:[]);
    this.save(run);
   }
   if(append.batches.every(batch=>batch.output)){
    const newIds=append.batches.map(batch=>batch.output!.id);
    // All new summaries are staged. Keep the inline input below the normal discovery budget.
    const inline=batchMaterials(newIds.map(id=>({id,characters:md.read(run.project_id,id).text.length})))[0];
    const inlineIds=inline.map(doc=>doc.id);
    const references=unique([...newIds,...append.reused.map(ref=>ref.id),...(append.previous_discovery_id?[append.previous_discovery_id]:[]),...(run.retained_topics??[]).flatMap(topic=>topic.output_id?[topic.output_id]:[])])
     .filter(id=>byId.has(id)&&!inlineIds.includes(id));
    const input=knowledgeTaskInputSchema.parse({
     kind:'wiki-page',source_ids:run.source_ids,dependencies:inlineIds.map(object_id=>({kind:'wiki-page',object_id,version:1})),
     title:'追加文献：主题发现清单',instructions:run.instructions,wiki_level:'discovery',research_skill:'synthesis',research_exploration:'topic-discovery',regenerate:true,
     topic_discovery_append:{
      source_ids:unique([...append.added_ids,...append.rebuilt_ids]),new_summary_ids:newIds,reference_ids:references,
      unresolved_topics:append.unresolved.slice(0,100).map(({id,title,body})=>({id,title,problem:body.slice(0,500)})),
     },
    });
    const discovery=this.agent.enqueue(run.project_id,input)[0];
    run.history_tasks.push(...run.tasks);run.tasks=[discovery.task_id];run.stage='discovering';
   }else if(append.batches.filter(batch=>!batch.output).every(batch=>{
    const task=batch.task_id?tasks.get(batch.task_id):undefined;
    return task&&['failed','interrupted','cancelled'].includes(task.status);
   })){
    run.stage='failed';run.error='部分追加材料整理失败，继续处理时仅重试未完成的分组。';
   }
  }catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'追加综合启动失败';}
  this.save(run);
  return run;
 }
 rediscover(project:string,id:string){
  const previous=this.detail(project,id);
  if(previous.mode!=='topics')throw Object.assign(new Error('TOPIC_REDISCOVERY_ONLY'),{statusCode:422});
  if(active(previous))throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  if(this.list(project).some(run=>active(run)))throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  if(this.superseded(previous,this.list(project)))throw Object.assign(new Error('RESEARCH_APPEND_OUTDATED'),{statusCode:409});
  const tasks=this.knowledge.tasks(project),outputs=[...new Set(previous.history_tasks.map(taskId=>tasks.find(task=>task.task_id===taskId)).filter(task=>task?.status==='completed'&&task.output_id&&['summary','summary-working'].includes(task.input.research_exploration??'')).map(task=>task!.output_id!))];
  if(!outputs.length)throw Object.assign(new Error('RESEARCH_MATERIALS_NOT_REUSABLE'),{statusCode:422});
  const at=new Date().toISOString(),run:Run={id:'exploration_'+randomUUID(),project_id:project,source_ids:[...previous.source_ids],created_at:at,updated_at:at,stage:'discovering',tasks:[],history_tasks:[],round:0,instructions:previous.instructions,mode:'topics',material_ids:outputs,summary_work_ids:outputs,signature:createHash('sha256').update(JSON.stringify({mode:'topics',source_ids:previous.source_ids,materials:outputs,at})).digest('hex')};
  const directory=this.topicDirectories(project).current;
  run.target_id=directory?.id;run.directory_expected=directory?.hash;
  run.retained_topics=[...(previous.retained_topics??[]),...(previous.topics??[]).filter(topic=>topic.status==='completed')];
  this.save(run);try{run.tasks=[this.enqueue(run,outputs,'topic-discovery').task_id];this.save(run);}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'重新发现主题失败';this.save(run);}return run;
 }
 candidates(project:string,id:string){
  const run=this.detail(project,id);if(run.stage!=='completed'||!run.result_id||run.question_id||run.mode&&run.mode!=='directions')return [];
  const md=new MarkdownKnowledge(this.store),doc=md.read(project,run.result_id),matches=[...doc.text.matchAll(/^## 候选方向[：:]\s*(.+)$/gm)];
  return matches.map((match,index)=>{
   const body=doc.text.slice(match.index!+match[0].length,matches[index+1]?.index??doc.text.length).split(/^## 推荐与取舍/m)[0];
   const section=(name:string)=>body.split(/^###\s+/m).slice(1).find(part=>part.split('\n')[0].trim()===name)?.split('\n').slice(1).join('\n').trim()??'';
   const indexDocs=md.index(project).documents;
   const evidence=knowledgeLinks(doc.path,body).filter(link=>run.source_ids.some(source=>link.path.startsWith('knowledge_base/papers/'+source+'/'))).map(link=>({id:indexDocs.find(d=>d.path===link.path)?.id??'',path:link.path})).filter(link=>link.id);
   return {id:createHash('sha256').update(run.id+match[1]+body).digest('hex').slice(0,20),title:match[1].trim(),question:section('研究问题'),body,evidence:[...new Map(evidence.map(item=>[item.path,item])).values()],complete:['研究问题','文献依据','已有解法与反例','候选假设','最小验证','可行性','补充检索'].every(name=>Boolean(section(name)))&&evidence.length>0};
  });
 }
 private enqueue(run:Run,ids:string[],mode:'summary'|'summary-working'|'directions'|'evidence-plan'|'research-map'|'comparison'|'background'|'topic-discovery'|'topic'){
  const docs=new MarkdownKnowledge(this.store).index(run.project_id).documents;
  const groupSources=mode==='summary'?[...new Set(docs.filter(d=>ids.includes(d.id)).flatMap(d=>[...(d.source_id?[d.source_id]:[]),...(d.dependencies??[]).flatMap(ref=>ref.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.slice(1)??[])]))].filter(id=>run.source_ids.includes(id)):run.source_ids;
  const workingInstruction=mode==='summary-working'?'\n仅压缩已有工作总结并保留原版本，不读取原始论文 Wiki 或 PDF；输出新的材料工作版供后续主题发现使用。':'';
  return this.agent.enqueue(run.project_id,knowledgeTaskInputSchema.parse({kind:'wiki-page',source_ids:groupSources,dependencies:ids.filter(id=>['summary','summary-working'].includes(mode)||id!==run.target_id).map(object_id=>({kind:'wiki-page',object_id,version:1})),title:mode==='summary'?modeTitles[run.mode??'directions']+'：材料分组':mode==='summary-working'?modeTitles[run.mode??'directions']+'：材料工作版':mode==='evidence-plan'?'研究问题：补证据计划':mode==='topic-discovery'?'文献主题发现清单':mode==='topic'?'主题Wiki组':modeTitles[mode],instructions:run.instructions+(run.question_text?'\n当前待核查研究问题：'+run.question_text:'')+workingInstruction,wiki_level:['summary','summary-working'].includes(mode)?'summary':['directions','evidence-plan','topic-discovery'].includes(mode)?'discovery':'topic',research_skill:modeSkill(run.mode??'directions'),research_exploration:mode,...(!['summary','summary-working','topic-discovery'].includes(mode)&&run.target_id?{target_id:run.target_id}:{}),regenerate:true}))[0];
 }
 private scheduleWorkingSummaries(run:Run,docs:ReturnType<MarkdownKnowledge['read']>[]){
  if(++run.round>6)throw new Error('材料工作版未能在预算内收敛，请缩小论文范围');
  run.summary_source_ids=docs.map(doc=>doc.id);run.summary_work_ids=undefined;
  run.working_summaries=docs.map(doc=>({origin_id:doc.id,...(doc.level==='summary'&&doc.text.length>RESEARCH_SUMMARY_HARD_MAX_CHARACTERS?{}:{output_id:doc.id})}));
  run.history_tasks.push(...run.tasks);run.tasks=[];this.save(run);
  for(const doc of docs){
   if(doc.level==='summary'&&doc.text.length>RESEARCH_SUMMARY_HARD_MAX_CHARACTERS){
    const task=this.enqueue(run,[doc.id],'summary-working'),item=run.working_summaries.find(entry=>entry.origin_id===doc.id);if(!item)throw new Error('材料工作版来源记录缺失');item.task_id=task.task_id;run.tasks.push(task.task_id);
   }
   this.save(run);
  }
  run.stage='summarizing';this.save(run);
 }
 private latestHistoryTaskIds(run:Run,all:KnowledgeTask[]){
  const byId=new Map(all.map(task=>[task.task_id,task]));let start=run.history_tasks.length-1;
  while(start>=0&&!byId.get(run.history_tasks[start]))start--;
  if(start<0)return [];
  const mode=byId.get(run.history_tasks[start])?.input.research_exploration;if(!mode)return [];
  const ids:string[]=[];
  for(let index=start;index>=0;index--){
   const task=byId.get(run.history_tasks[index]);if(task?.input.research_exploration!==mode)break;ids.unshift(task.task_id);
  }
  return ids;
 }
 private schedule(run:Run,ids:string[]){
  const md=new MarkdownKnowledge(this.store),docs=ids.map(id=>md.read(run.project_id,id)).sort((a,b)=>(a.source_id??a.id).localeCompare(b.source_id??b.id)||a.path.localeCompare(b.path)),groups:string[][]=[];let group:string[]=[],size=0;
  if(docs.some(doc=>doc.level==='summary'&&doc.text.length>RESEARCH_SUMMARY_HARD_MAX_CHARACTERS)){this.scheduleWorkingSummaries(run,docs);return;}
  for(const doc of docs){if(doc.text.length>40000)throw new Error('单页材料超过探索预算，请先将知识页合理拆分，不截断正文');if((size+doc.text.length>40000||group.length>=80)&&group.length){groups.push(group);group=[];size=0;}group.push(doc.id);size+=doc.text.length;}if(group.length)groups.push(group);
  run.history_tasks.push(...run.tasks);run.tasks=[];
  if(!groups.length)throw new Error('没有可用的综合材料');
  if(groups.length===1){run.stage=run.mode==='topics'?'discovering':'generating';this.save(run);run.tasks=[this.enqueue(run,groups[0],run.question_id?'evidence-plan':run.mode==='topics'?'topic-discovery':run.mode??'directions').task_id];}
  else{if(++run.round>6)throw new Error('材料归纳未能在预算内收敛，请缩小论文范围');run.stage='summarizing';this.save(run);for(const ids of groups){run.tasks.push(this.enqueue(run,ids,'summary').task_id);this.save(run);}}
  this.save(run);
 }
 start(project:string,sourceIds:string[],instructions:string,question?:{id:string;question:string},mode:ResearchMode='directions',topicIds:string[]=[]){
  const existing=this.list(project).find(active);if(existing)throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  const p=this.store.getProject(project);if(mode==='directions'&&!p?.research_area)throw Object.assign(new Error('RESEARCH_AREA_REQUIRED'),{statusCode:422});
  const md=new MarkdownKnowledge(this.store),all=md.index(project).documents,selected=[...new Set(sourceIds)];
  if(!selected.length)throw Object.assign(new Error('SOURCES_REQUIRED'),{statusCode:422});
  for(const id of selected)if(this.store.getSource(id)?.project_id!==project||!all.some(d=>d.source_id===id&&d.path.endsWith('/whoami.md')))throw Object.assign(new Error('SOURCE_WIKI_REQUIRED'),{statusCode:422});
  if(['topics','comparison'].includes(mode)&&selected.some(id=>all.some(d=>d.source_id===id&&d.path.endsWith('/whoami.md')&&d.stale)))throw Object.assign(new Error('SOURCE_WIKI_STALE'),{statusCode:422});
  if(mode==='comparison'&&!instructions.trim())throw Object.assign(new Error('TOPIC_QUESTION_REQUIRED'),{statusCode:422});
  if(question&&mode!=='directions')throw Object.assign(new Error('INVALID_REQUEST'),{statusCode:400});
  const topics=all.filter(d=>(!d.topic_id||d.topic_id===d.id)&&topicIds.includes(d.id)&&d.kind==='wiki-page'&&['topic','hypothesis','overview','discovery'].includes(d.level??''));
  if(new Set(topicIds).size!==topics.length)throw Object.assign(new Error('DEPENDENCY_NOT_FOUND'),{statusCode:404});
  const current=all.filter(d=>selected.includes(d.source_id??'')&&d.kind==='wiki-page'&&d.level==='single'&&d.path.startsWith('knowledge_base/papers/')&&(d.group_status===undefined||d.group_status==='current'));
  const firstPages=mode==='background'?/\/(whoami|background)\.md$/:mode==='comparison'?/\/(whoami|research_problem|insights|method|results)\.md$/:['directions','topics'].includes(mode)?/\/(whoami|research_problem|contributions|insights)\.md$/:/\/(whoami|research_problem|contributions)\.md$/;
  const docs=[...current.filter(d=>firstPages.test(d.path)),...topics];
  const signature=createHash('sha256').update(JSON.stringify({mode,question,source_ids:[...selected].sort(),instructions,project:p,materials:[...current,...topics].map(d=>[d.path,d.hash,d.stale]).sort(),version:18})).digest('hex');
  const runs=this.list(project),directory=mode==='topics'?this.topicDirectories(project).current:undefined;
  const reusable=runs.find(r=>r.signature===signature&&r.stage==='completed'&&r.result_id&&!this.superseded(r,runs)&&all.some(d=>d.id===r.result_id&&!d.stale)&&(r.topics??[]).filter(t=>t.status==='completed').every(t=>all.some(d=>d.id===t.output_id&&!d.stale)));
  if(reusable)return reusable;
  const previous=mode==='directions'?undefined:this.list(project).find(r=>r.stage==='completed'&&r.mode===mode&&r.instructions===instructions&&JSON.stringify([...r.source_ids].sort())===JSON.stringify([...selected].sort())&&r.result_id&&all.some(d=>d.id===r.result_id));
  const at=new Date().toISOString(),run:Run={id:'exploration_'+randomUUID(),project_id:project,source_ids:selected,created_at:at,updated_at:at,stage:'summarizing',tasks:[],history_tasks:[],round:0,instructions,question_id:question?.id,question_text:question?.question,mode,topic_ids:topicIds,signature,target_id:previous?.result_id,material_ids:docs.map(d=>d.id),source_hashes:current.map(({path,hash})=>({path,hash})),...(mode==='topics'?{retained_topics:[...(previous?.retained_topics??[]),...(previous?.topics??[]).filter(t=>t.status==='completed')],directory_expected:previous?.result_id?all.find(d=>d.id===previous.result_id)?.hash:undefined}:{})};
  if(mode==='topics'){run.target_id=directory?.id;run.directory_expected=directory?.hash;}
  this.save(run);try{this.schedule(run,docs.map(d=>d.id));}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'探索启动失败';this.save(run);}return run;
 }
 private discoverTopics(run:Run,task:KnowledgeTask){
  if(!task.output_id)throw new Error('主题发现任务没有输出');
  const md=new MarkdownKnowledge(this.store),doc=md.read(run.project_id,task.output_id),all=md.index(run.project_id).documents;
  const sections=topicDiscoveryEntries(doc.text);
  if(!sections.length&&!doc.text.includes('未发现可整理主题'))throw new Error('主题发现清单缺少主题条目；保留结果供查看');
  const sourcePages=all.filter(d=>run.source_ids.includes(d.source_id??'')&&d.level==='single'&&(d.group_status===undefined||d.group_status==='current'));
  const otherOutputs=new Set(this.list(run.project_id).filter(r=>['research-map','background'].includes(r.mode??'')).map(r=>r.result_id));
  const existing=all.filter(d=>(!d.topic_id||d.topic_id===d.id)&&!otherOutputs.has(d.id)&&d.level==='topic'&&!['research-map','research-background','topic-index'].includes(d.page_role??''));
  const normalize=(s:string)=>s.toLocaleLowerCase().replace(/[\s\p{P}]/gu,'');
  const result:Topic[]=[],seen=new Map<string,Topic>();
  for(const {kind,title,body} of sections){
   if(!title||title.length>200)continue;
   const links=new Set(knowledgeLinks(doc.path,body).map(link=>link.path));
   const material=sourcePages.filter(d=>links.has(d.path)||body.includes(d.id));
   const sources=[...new Set(material.map(d=>d.source_id!))];
   const named=body.match(/已有主题ID[：:]\s*(wiki-[A-Za-z0-9_-]+)/)?.[1];
   const prior=named?existing.find(d=>d.id===named):undefined;
   const homonym=!prior&&existing.some(d=>normalize(d.title)===normalize(title)||d.aliases?.some(alias=>normalize(alias)===normalize(title)));
   const changed=task.input.topic_discovery_append?.source_ids;
   const eligible=kind==='知识主题'&&sources.length>=2&&!homonym&&(!named||Boolean(prior))&&(!changed||sources.some(source=>changed.includes(source)));
   const key=prior?.id??normalize(title),duplicate=seen.get(key);
   if(duplicate){duplicate.material_ids=[...new Set([...duplicate.material_ids,...material.map(d=>d.id)])];duplicate.source_ids=[...new Set([...duplicate.source_ids,...sources])];duplicate.body+='\n\n'+body;if(eligible)duplicate.status='pending';continue;}
   const topic:Topic={id:createHash('sha256').update(run.id+key).digest('hex').slice(0,20),title:prior?.title??title,body,source_ids:sources,material_ids:material.map(d=>d.id),existing_id:prior?.id,status:eligible?'pending':'candidate',error:homonym?'已有同名主题，需确认问题边界':named&&!prior?'已有主题ID无效，待确认':undefined};
   seen.set(key,topic);result.push(topic);
  }
  const affected=new Set(result.filter(topic=>topic.status==='pending').map(topic=>topic.id));
  for(const old of run.append?.unresolved??[]){
   const match=result.find(topic=>topic.status==='pending'&&(normalize(topic.title)===normalize(old.title)||topic.body.match(/^既有待处理主题ID[：:]\s*([a-f0-9]+)\s*$/m)?.[1]===old.id));
   if(!match){result.push({...old});continue;}
   match.source_ids=unique([...match.source_ids,...old.source_ids]);
   match.material_ids=unique([...match.material_ids,...old.material_ids]);
   match.task_id=old.task_id;
  }
  run.discovery_id=task.output_id;run.topics=result;this.save(run);
  return affected;
 }
 private syncTopics(run:Run){
  const tasks=this.knowledge.tasks(run.project_id);
  for(const topic of run.topics??[]){
   if(topic.status!=='generating')continue;
   const task=tasks.find(t=>t.task_id===topic.task_id);
   if(task?.status==='completed'&&task.output_id){topic.status='completed';topic.output_id=task.output_id;topic.error=undefined;}
   else if(!task||['failed','interrupted','cancelled'].includes(task.status)){topic.status='failed';topic.error=task?.error??'主题任务未完成，可单独重试';}
  }
 }
 private scheduleTopics(run:Run,topicId?:string,only?:Set<string>){
  const current=new MarkdownKnowledge(this.store).index(run.project_id).documents;
  if(run.source_hashes?.some(ref=>!current.some(d=>d.path===ref.path&&d.hash===ref.hash)))throw new Error('论文材料已变化，请新建综合；已完成主题与候选清单保留。');
  this.syncTopics(run);run.history_tasks.push(...run.tasks);run.tasks=[];run.stage='topics';run.error=undefined;this.save(run);
  const md=new MarkdownKnowledge(this.store),all=md.index(run.project_id).documents;
  // This is an execution budget, not a limit on discovered themes. Resume opens the next batch.
  const next=(run.topics??[]).filter(t=>(!topicId||t.id===topicId)&&(!only||only.has(t.id))&&['pending','failed'].includes(t.status)).slice(0,8);
  for(const topic of next){
   try{
    const ids:string[]=[];let size=0;
    for(const d of all.filter(d=>topic.material_ids.includes(d.id))){const count=d.characters??md.read(run.project_id,d.id).text.length;if(size+count>30000||ids.length>=70)continue;ids.push(d.id);size+=count;}
    if(!ids.length){const first=all.find(d=>topic.source_ids.includes(d.source_id??'')&&d.path.endsWith('/whoami.md'));if(!first)throw new Error('主题缺少可用来源');ids.push(first.id);}
    const input=knowledgeTaskInputSchema.parse({kind:'wiki-page',source_ids:topic.source_ids,dependencies:ids.filter(id=>id!==topic.existing_id).map(object_id=>({kind:'wiki-page',object_id,version:1})),title:topic.title,instructions:run.instructions+'\n本次仅生成主题 Wiki 组“'+topic.title+'”。发现阶段的问题边界与来源如下：\n'+topic.body+'\n先提供预算内来源页，其余相关正文和依据在material_index及工作副本中按需读；不得宣称全部已读。保留既有页人工内容及本轮未覆盖认识；不额外发现新主题。',wiki_level:'topic',research_skill:'synthesis',research_exploration:'topic',...(topic.existing_id?{target_id:topic.existing_id}:{}),regenerate:true});
    const old=topic.task_id,task=this.agent.enqueue(run.project_id,input,old)[0];topic.task_id=task.task_id;topic.status='generating';topic.error=undefined;run.tasks.push(task.task_id);
   }catch(error){topic.status='failed';topic.error=error instanceof Error?error.message:'无法创建主题任务';}
   this.save(run);
  }
  run.tasks=[...new Set([...run.tasks,...(run.topics??[]).filter(t=>t.status==='generating'&&t.task_id).map(t=>t.task_id!)])];this.save(run);
  this.settleTopics(run);
 }
 private publishDirectory(run:Run){
  const md=new MarkdownKnowledge(this.store);
  run.directory_id??=run.target_id??this.topicDirectories(run.project_id).current?.id??'wiki-'+randomUUID();
  const all=md.index(run.project_id).documents;
  const current=all.find(d=>d.id===run.directory_id),before=current?md.read(run.project_id,current.id):undefined;
  const path=before?.path??`knowledge_base/topics/${run.directory_id}.md`;
  if(run.directory_expected===undefined)run.directory_expected=before?.hash??null;
  this.save(run);
  const label=(s:string)=>s.replace(/[\\`\[\]*_]/g,'\\$&').replace(/[\r\n]/g,' ');
  const link=(id:string,title:string)=>{const d=all.find(d=>d.id===id);if(!d)return label(title);const relative=posix.relative(posix.dirname(path),d.path);return `[${label(title)}](${relative.startsWith('.')?relative:'./'+relative})`;};
  const status={candidate:'候选线索',pending:'待展开',generating:'生成中',completed:'已完成',failed:'失败，可重试'};
  const topics=run.topics??[];
  const retained=[...new Map((run.retained_topics??[]).filter(t=>t.output_id&&all.some(d=>d.id===t.output_id)&&!topics.some(n=>n.status==='completed'&&n.output_id===t.output_id)).map(t=>[t.output_id,t])).values()];
  const formal=topics.filter(t=>t.status==='completed'&&t.output_id),pending=topics.filter(t=>['pending','generating','failed'].includes(t.status));
  const generated=['## 何时读取','查看已经形成正式 Wiki 的跨论文主题及其关联论文；候选线索和研究假设请回到主题发现清单。','## 材料范围',`选定${run.source_ids.length}篇论文；实际深入范围与论断来源见发现清单及各主题正文。`,run.discovery_id?link(run.discovery_id,'主题发现清单'):'','## 正式主题目录',...(formal.length?formal.map(t=>`- ${link(t.output_id!,t.title)}：已发布`):['尚未形成正式主题，请先查看主题发现清单。']),...(retained.length?['## 历史主题入口（本轮未覆盖）',...retained.map(t=>'- '+link(t.output_id!,t.title)+'：保留旧入口，不表示本轮已更新')]:[]),...(pending.length?['## 待处理正式主题',...pending.map(t=>`- ${label(t.title)}：${status[t.status]}${t.error?'；'+label(t.error):''}`)]:[]),'## 后续处理','候选线索和研究假设不会进入正式主题目录；只有主题 Wiki 发布成功后才会出现在上方目录。'].filter(Boolean).join('\n\n');
  const start='<!-- synthesis-directory:start -->',end='<!-- synthesis-directory:end -->',block=start+'\n'+generated+'\n'+end;
  let text=`---\nknowledge_version: 2\nid: ${run.directory_id}\nkind: wiki-page\nlevel: topic\npage_role: topic-index\n---\n\n# 文献主题综合目录${run.instructions.trim()?'：'+label(run.instructions.trim().split('\n')[0].slice(0,80)):''}\n\n${block}\n`;
  if(before){const a=before.text.indexOf(start),b=before.text.indexOf(end);if(a<0||b<a)throw new Error('目录人工内容与生成区发生冲突，已保留主题，请确认目录后继续');text=before.text.slice(0,a)+block+before.text.slice(b+end.length);}
  if(before?.text!==text){const doc=md.save(run.project_id,path,text,run.directory_expected);run.directory_expected=doc.hash;}
  else run.directory_expected=before.hash;
  const refs=all.filter(d=>d.id===run.discovery_id||[...formal,...retained].some(t=>t.output_id===d.id)).map(({path,hash})=>({path,hash}));md.stamp(run.project_id,run.directory_id,refs);
  run.result_id=run.directory_id;this.save(run);
 }
 private settleTopics(run:Run){
  this.syncTopics(run);
  if((run.topics??[]).some(t=>t.status==='generating')){this.save(run);return;}
  run.stage=(run.topics??[]).some(t=>['pending','failed'].includes(t.status))?'partial':'completed';
  run.error=run.stage==='partial'?'本轮主题已处理，待展开或失败项可继续；已完成内容保留。':undefined;
  try{this.publishDirectory(run);}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'目录发布失败';}
  this.save(run);
 }
 private advance(run:Run){
  if(run.append&&run.stage==='summarizing'){this.continueAppend(run);return;}
  const all=this.knowledge.tasks(run.project_id),tasks=run.tasks.map(id=>all.find(t=>t.task_id===id));if(!tasks.length)return;
  if(run.stage==='topics'){this.settleTopics(run);return;}
  if(tasks.some(t=>!t||['failed','cancelled','interrupted'].includes(t.status))){run.stage='failed';run.error='部分探索任务未完成；已完成的知识和日志保留，可继续探索。';this.save(run);return;}
  if(tasks.some(t=>t?.status!=='completed'))return;
  const done=tasks as KnowledgeTask[];
  if(run.stage==='discovering'){try{const affected=this.discoverTopics(run,done[0]);this.scheduleTopics(run,undefined,run.append?affected:undefined);}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'主题发现失败';this.save(run);}return;}
  if(run.stage==='generating'){run.result_id=done[0].output_id;run.stage='completed';this.save(run);return;}
  try{
   if(run.working_summaries?.length){
    const byTask=new Map(done.map(task=>[task.task_id,task]));
    const ids=run.working_summaries.map(item=>item.output_id??(item.task_id?byTask.get(item.task_id)?.output_id:undefined));
    if(ids.some(id=>!id))throw new Error('材料工作版缺少输出，请继续探索以恢复');
    run.summary_work_ids=ids as string[];run.summary_source_ids=undefined;run.working_summaries=[];this.save(run);this.schedule(run,run.summary_work_ids);return;
   }
   this.schedule(run,done.map(t=>t.output_id!));
  }catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'归纳失败';this.save(run);}
 }
 resume(project:string,id:string,topicId?:string){const run=this.detail(project,id);if(active(run)||run.stage==='completed')return run;
  const runs=this.list(project);
  if(runs.some(active))throw Object.assign(new Error('RESEARCH_EXPLORATION_BUSY'),{statusCode:409});
  if(this.superseded(run,runs))throw Object.assign(new Error('RESEARCH_APPEND_OUTDATED'),{statusCode:409});
  if(topicId&&!run.topics?.some(t=>t.id===topicId&&['pending','failed'].includes(t.status)))throw Object.assign(new Error('TOPIC_NOT_RESUMABLE'),{statusCode:409});
  if(run.mode==='topics'&&run.topics){try{this.scheduleTopics(run,topicId);}catch(error){run.stage='failed';run.error=error instanceof Error?error.message:'主题恢复失败';this.save(run);}return run;}const all=this.knowledge.tasks(project);
  if(run.append&&!run.tasks.some(id=>all.some(task=>task.task_id===id&&task.input.research_exploration==='topic-discovery')))return this.continueAppend(run,true);
  if(!run.tasks.length&&run.summary_source_ids?.length){const md=new MarkdownKnowledge(this.store),docs=run.summary_source_ids.map(id=>md.read(project,id));run.error=undefined;this.scheduleWorkingSummaries(run,docs);return run;}
  if(!run.tasks.length){const recovered=this.latestHistoryTaskIds(run,all);if(recovered.length){const restored=new Set(recovered);run.tasks=recovered;run.history_tasks=run.history_tasks.filter(id=>!restored.has(id));}}
  const tasks=run.tasks.map(id=>all.find(t=>t.task_id===id));if(!tasks.length){run.stage='failed';run.error='没有可恢复的任务，请重新选择论文开始探索。';this.save(run);return run;}
  run.stage=['summary','summary-working'].includes(tasks[0]?.input.research_exploration??'')?'summarizing':tasks[0]?.input.research_exploration==='topic-discovery'?'discovering':'generating';run.error=undefined;
  run.tasks=tasks.map(task=>{if(!task)throw new Error('TASK_NOT_FOUND');return task.status==='completed'?task.task_id:this.agent.enqueue(project,{...task.input,regenerate:true},task.task_id)[0].task_id;});this.save(run);this.advance(run);return run;
 }
 cancel(project:string,id:string){const run=this.detail(project,id);run.stage='cancelled';this.save(run);for(const task of this.knowledge.tasks(project).filter(t=>run.tasks.includes(t.task_id)&&['queued','running'].includes(t.status)))this.agent.cancel(project,task.task_id);return run;}
}
