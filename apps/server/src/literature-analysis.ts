import {sourceContentHash} from './source-bibliography.js';
import { discoverWikiTopics } from "./wiki-topics.js";
import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge } from "./markdown-knowledge.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeStore, experimentError, type TrashStore, type KnowledgeTask } from "@trash/storage";
import type { KnowledgeTaskInput, KnowledgeVersion } from "@trash/protocol";
import { KnowledgeAgent } from "./knowledge-agent.js";

type Stage = "discovery" | "cards-only" | "cards" | "groups" | "wiki" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
export interface Analysis {
  analysis_id: string; project_id: string; stage: Stage; created_at: string; updated_at: string;
  source_count: number; skipped_count: number; card_tasks: string[]; group_tasks: string[]; wiki_tasks: string[];
  discovery_tasks?:string[];topic_count?:number;candidate_count?:number;error?: string; reused_sources?:string[]; covered_sources?:string[]; missing_sources?:string[]; round?:number; overview?:boolean; plan?:{reuse:number;补齐:number;重读:number;综合:number}; group_history?:string[];card_documents?:string[];theme_title?:string;instructions?:string;mode?:string;incremental?:boolean;integration_task?:string;
}
const active = (value: Analysis) => ["cards-only", "cards", "groups", "discovery", "wiki"].includes(value.stage);
const pending = (task: KnowledgeTask) => ["queued", "running"].includes(task.status);
export class LiteratureAnalysis {
  constructor(private store: TrashStore, private knowledge: KnowledgeStore, private agent: KnowledgeAgent) {
    for (const project of store.listProjects()) {
      const analysis = this.read(project.project_id);
      if (analysis && active(analysis)) { analysis.stage = "interrupted"; analysis.error = "服务重启，分析流程已中断；可重新点击分析，已保存内容保留。"; this.save(analysis); }
    }
    agent.onTaskRetried=(project,previousId,task)=>{
      const value=this.read(project);if(!value)return;
      const stages=[{ids:value.card_tasks,stage:value.mode==='missing'||value.mode==='changed'?'cards-only':'cards'}, {ids:value.group_tasks,stage:'groups'}, {ids:value.discovery_tasks??[],stage:'discovery'}, {ids:value.wiki_tasks,stage:'wiki'}] as const;
      const group=stages.find(group=>group.ids.includes(previousId));if(!group)return;
      for(let i=0;i<group.ids.length;i++)if(group.ids[i]===previousId)group.ids[i]=task.task_id;
      if(['interrupted','failed','partial'].includes(value.stage)&&pending(task)){
        value.stage=group.stage;value.error=undefined;
        if(group.stage==='cards'||group.stage==='cards-only'){value.group_history=[...(value.group_history??[]),...value.group_tasks];value.group_tasks=[];}
        if(['cards','cards-only','groups'].includes(group.stage))value.discovery_tasks=[];
        if(group.stage!=='wiki'){value.wiki_tasks=[];value.overview=false;}
      }
      this.save(value);
    };
    agent.onTaskSettled = (project,task) => {this.advance(project);this.integrate(project,task);};
  }
  // Persist only future standalone completions; do not enqueue historical content on startup.
  private integrations(project:string){
    const file=join(projectRuntime(this.store.root,project,'literature-integration'),'queue.json');
    let entries:{task_id:string;source_id:string;analysis_id?:string;status:string;error?:string}[]=[];
    try{entries=JSON.parse(readFileSync(file,'utf8'));}catch{/* New queue. */}
    return {file,entries};
  }
  private integrate(project:string,task?:KnowledgeTask){
    const queue=this.integrations(project),current=this.read(project);
    if(task?.status==='completed'&&task.input.include_source_wiki&&!current?.card_tasks.includes(task.task_id)&&!queue.entries.some(e=>e.task_id===task.task_id))queue.entries.push({task_id:task.task_id,source_id:task.input.source_ids[0],status:'pending'});
    for(const entry of queue.entries)if(entry.analysis_id===current?.analysis_id&&current&&active(current))entry.status='running';
    for(const entry of queue.entries)if(entry.status==='running'&&current&&entry.analysis_id===current.analysis_id&&!active(current)){entry.status=current.stage==='completed'?'completed':'failed';entry.error=current.error;}
    if(!current||!active(current)){
      const next=queue.entries.find(e=>e.status==='pending');
      if(next){
        // Mark before enqueueing: callbacks may reenter after task settlement.
        next.status='running';mkdirSync(join(queue.file,'..'),{recursive:true});writeFileSync(queue.file,JSON.stringify(queue.entries),{mode:0o600});
        try{const result=this.start(project,'synthesis',{source_ids:[next.source_id],incremental:true,integration_task:next.task_id});next.analysis_id=result?.analysis_id;if(!result?.active){next.status=result?.stage==='completed'?'completed':'failed';next.error=result?.error;}}catch(error){next.status='failed';next.error=error instanceof Error?error.message:'增量整合失败';}
      }
    }
    mkdirSync(join(queue.file,'..'),{recursive:true});const temp=queue.file+'.tmp';writeFileSync(temp,JSON.stringify(queue.entries),{mode:0o600});renameSync(temp,queue.file);
  }
  resume(project:string){
    const value=this.read(project);if(!value)return null;if(active(value))return this.status(project);
    if(value.stage==='completed')return this.status(project);
    // Resume the earliest incomplete stage, then rebuild downstream summaries.
    const stages=[{ids:value.card_tasks,stage:value.mode==='missing'||value.mode==='changed'?'cards-only':'cards'},
      {ids:value.group_tasks,stage:'groups'},{ids:value.discovery_tasks??[],stage:'discovery'},{ids:value.wiki_tasks,stage:'wiki'}] as const;
    const first=stages.find(group=>this.tasks(project,group.ids).some(t=>t.status!=='completed'));
    if(!first)return this.status(project);
    for(let i=0;i<first.ids.length;i++){
      const task=this.tasks(project,[first.ids[i]])[0];
      if(task&&['failed','cancelled','interrupted'].includes(task.status))first.ids[i]=this.agent.enqueue(project,{...task.input,regenerate:true},task.task_id)[0].task_id;
    }
    value.error=undefined;value.stage=first.stage;
    if(['cards','cards-only'].includes(first.stage)){value.group_history=[...(value.group_history??[]),...value.group_tasks];value.group_tasks=[];}
    if(['cards','cards-only','groups'].includes(first.stage))value.discovery_tasks=[];
    if(first.stage!=='wiki'){value.wiki_tasks=[];value.overview=false;}
    this.save(value);this.advance(project);return this.status(project);
  }
  private path(project: string) { return projectRuntime(this.store.root,project,'literature-analysis'); }
  private save(value: Analysis) {
    value.updated_at = new Date().toISOString(); const path = this.path(value.project_id); mkdirSync(path, { recursive: true });
    const bytes = JSON.stringify(value);
    for (const name of [value.analysis_id, "current"]) { writeFileSync(join(path, `${name}.tmp`), bytes, { mode: 0o600 }); renameSync(join(path, `${name}.tmp`), join(path, `${name}.json`)); }
  }
  private read(project: string): Analysis | undefined { try { return JSON.parse(readFileSync(join(this.path(project), "current.json"), "utf8")) as Analysis; } catch { return undefined; } }
  private tasks(project: string, ids: string[]) { const all = this.knowledge.tasks(project); return ids.map(id => all.find(task => task.task_id === id)).filter((task): task is KnowledgeTask => Boolean(task)); }
  private reconcile(project:string){
    const value=this.read(project);if(!value)return;
    const all=this.knowledge.tasks(project);let changed=false;
    const stages=[{ids:value.card_tasks,stage:value.mode==='missing'||value.mode==='changed'?'cards-only':'cards'},{ids:value.group_tasks,stage:'groups'},{ids:value.discovery_tasks??[],stage:'discovery'},{ids:value.wiki_tasks,stage:'wiki'}] as const;
    for(const group of stages)for(let i=0;i<group.ids.length;i++){
      const previous=group.ids[i];
      const candidates=all.filter(task=>{const seen=new Set<string>();let id=task.attempt_of;while(id&&!seen.has(id)){if(id===previous)return true;seen.add(id);id=all.find(t=>t.task_id===id)?.attempt_of;}return false;}).sort((a,b)=>Number(pending(b))-Number(pending(a))||b.created_at.localeCompare(a.created_at));
      const next=candidates[0];if(!next)continue;
      group.ids[i]=next.task_id;changed=true;
      if(['failed','partial','interrupted','cancelled'].includes(value.stage)){
        value.stage=group.stage;value.error=undefined;
        if(group.stage!=='wiki'){value.wiki_tasks=[];value.overview=false;}
      }
    }
    if(changed)this.save(value);
    return value;
  }
  status(project: string) {
    const value = this.reconcile(project); if (!value) return null;
    const summarize = (ids: string[]) => { const tasks = this.tasks(project, ids); return { total: ids.length, completed: tasks.filter(task => task.status === "completed").length, failed: ids.length - tasks.filter(task => task.status === "completed" || pending(task)).length, active: tasks.filter(pending).length }; };
    return { ...value, active_tasks:this.knowledge.tasks(project).filter(pending).map(t=>({task_id:t.task_id,title:t.input.title,status:t.status})), can_resume:!active(value)&&[...value.card_tasks,...value.group_tasks,...(value.discovery_tasks??[]),...value.wiki_tasks].some(id=>['failed','interrupted','cancelled'].includes(this.tasks(project,[id])[0]?.status??'')), cards: summarize(value.card_tasks), groups: summarize([...(value.group_history??[]),...value.group_tasks,...(value.discovery_tasks??[])]), wiki: summarize(value.wiki_tasks), active: active(value) };
  }
  start(project: string, mode:'all'|'missing'|'changed'|'synthesis'|'overview'='all',options:{source_ids?:string[];title?:string;instructions?:string;incremental?:boolean;integration_task?:string}={}) {
    const current = this.read(project); if (current && active(current)) return this.status(project);
    const allSources=this.store.listSources(project);if(options.source_ids?.some(id=>!allSources.some(s=>s.source_id===id)))experimentError('SOURCE_NOT_FOUND',404);
    const sources=options.source_ids?.length?allSources.filter(s=>options.source_ids!.includes(s.source_id)):allSources;
    const eligible = sources.filter(source => this.store.listSourceSegments(source.source_id).some(segment => segment.text.trim()) || Boolean(source.abstract?.trim()) || source.source_type==='pdf');
    if (!eligible.length) experimentError("ANALYSIS_NO_READABLE_SOURCES", 422);
    const value: Analysis = { analysis_id: `analysis_${randomUUID()}`, project_id: project, stage: "cards", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_count: eligible.length, skipped_count: sources.length - eligible.length, card_tasks: [], group_tasks: [], wiki_tasks: [] };
    const existingDocs=new MarkdownKnowledge(this.store).index(project).documents;
    const plan={reuse:0,补齐:0,重读:0,综合:0};
    for(const source of eligible){const pair=existingDocs.filter(d=>d.source_id===source.source_id&&['basic','detail','key'].includes(d.card_type??''));const complete=existingDocs.some(d=>d.path===`knowledge_base/papers/${source.source_id}/whoami.md`)||pair.length===3&&existingDocs.some(d=>d.source_id===source.source_id&&d.kind==='wiki-page');if(mode==='synthesis'||mode==='overview'){if(complete)plan.reuse++;else plan.补齐++;plan.综合++;}else if(complete&&mode!=='changed')plan.reuse++;else if(pair.length)plan.补齐++;else plan.重读++;}
    value.plan=plan;
    value.mode=mode;value.incremental=options.incremental;value.integration_task=options.integration_task;value.card_documents=[];value.theme_title=options.title;value.instructions=options.instructions;value.reused_sources=[];value.covered_sources=[];value.missing_sources=[];
    this.save(value);
    try {
      const markdown=new MarkdownKnowledge(this.store);const docs=markdown.index(project).documents;
      for(const source of eligible){
        const wiki=docs.filter(d=>d.source_id===source.source_id&&d.kind==='wiki-page'&&d.level==='single'&&(d.group_status===undefined||d.group_status==='current')&&/\/(whoami|research_problem|contributions)\.md$/.test(d.path));
        if((mode==='synthesis'||mode==='overview')&&wiki.some(d=>d.path.endsWith('/whoami.md'))){value.card_documents!.push(...wiki.map(d=>d.id));value.reused_sources!.push(source.source_id);continue;}
        const prior=this.knowledge.tasks(project).filter(t=>t.input.kind==='literature-card'&&t.input.source_ids[0]===source.source_id&&t.status==='completed').sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
        const same=prior&&(prior.snapshot as {prompt_version?:number}).prompt_version===9&&(prior.snapshot as {bibliography_baselines?:Record<string,{content_hash:string}>}).bibliography_baselines?.[source.source_id]?.content_hash===sourceContentHash(source);
        const pair=docs.filter(d=>d.source_id===source.source_id&&['basic','detail','key'].includes(d.card_type??''));
        if(same&&pair.some(d=>d.card_type==='key')&&!pair.some(d=>d.stale)&&docs.some(d=>d.id===`wiki-${source.source_id}`&&!d.stale)){value.card_tasks.push(prior.task_id);value.reused_sources!.push(source.source_id);continue;}
        if(mode==='synthesis'||mode==='overview'||(mode==='missing'&&pair.length===3)||(mode==='changed'&&!pair.length)){if(pair.some(d=>d.card_type==='key')){if(prior)value.card_tasks.push(prior.task_id);else{value.card_documents!.push(`card-${source.source_id}-key`);value.reused_sources!.push(source.source_id);}}else value.missing_sources!.push(source.source_id);continue;}
        const input:KnowledgeTaskInput={kind:'literature-card',source_ids:[source.source_id],dependencies:[],title:source.title,instructions:'完整阅读本篇全文图文，生成以whoami.md为入口的背景、研究问题、方法、贡献、实验结果、局限、综合认识和统一evidence.md知识页，按需拆出机制与实验子页，题录由结构化记录保留，不生成重复题录正文。开放提取候选主题、机制、异常和边界，最后再关联项目；不为项目题目限制主题或凑线索。数字保留真实原文定位。'+(options.instructions??''),timeout_seconds:3600,regenerate:false,include_source_wiki:true};
        value.card_tasks.push(...this.agent.enqueue(project,input).map(t=>t.task_id));this.save(value);
      }
      if(mode==='missing'||mode==='changed'){value.stage='cards-only';}
      if(mode==='overview'){const themes=docs.filter(d=>d.kind==='wiki-page'&&['topic','hypothesis','discovery'].includes(d.level??''));if(!themes.length)throw new Error('没有可用主题 Wiki，请先生成主题');value.stage='wiki';value.overview=true;const records=themes.map(d=>({object_id:d.id,project_id:project,kind:'wiki-page' as const,version:1,status:'accepted' as const,title:d.title,content:{title:d.title,tags:[],body:new MarkdownKnowledge(this.store).read(project,d.id).text,dependencies:[]},created_by:'agent' as const,created_at:d.modified}));if(this.batches(records).length>1)throw new Error('主题材料超出总览预算，请先通过完整分层综合缩减');value.wiki_tasks=this.enqueueWiki(value,'项目知识总览',records,'总结各主题和研究方向，简洁链接导航，不重复所有细节。');}
      this.save(value);
      this.advance(project);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "创建分析任务失败"; this.save(value); this.stopPending(value); }
    return this.status(project);
  }
  private records(project:string,ids:string[],documentIds:string[]=[]):KnowledgeVersion[]{
    const markdown=new MarkdownKnowledge(this.store);const docs=markdown.index(project).documents;
    const idsToRead=[...documentIds,...this.tasks(project,ids).filter(t=>t.status==='completed').flatMap(task=>task.input.kind==='literature-card'?[`card-${task.input.source_ids[0]}-key`]:task.output_id?[task.output_id]:[])];return [...new Set(idsToRead)].flatMap(id=>{const meta=docs.find(d=>d.id===id);if(!meta)return [];const doc=markdown.read(project,meta.id);return [{object_id:doc.id,project_id:project,kind:doc.kind,version:1,status:'accepted' as const,title:doc.title,content:doc.kind==='wiki-page'?{title:doc.title,tags:[],body:doc.text,dependencies:[]}:{source_id:doc.source_id!,title:doc.title,tags:[],question:doc.text,method:'',contributions:'',limitations:'',datasets:[],baselines:[],metrics:[],reported_results:'',experimental_conditions:'',ideas:'',relevance:'',open_questions:'',evidence:[]},created_by:'agent' as const,created_at:doc.modified}];});
  }
  private batches(records:KnowledgeVersion[]){const groups:KnowledgeVersion[][]=[];let current:KnowledgeVersion[]=[],size=0;for(const record of records){const length=JSON.stringify(record.content).length;if(length>30000)experimentError('KNOWLEDGE_INPUT_TOO_LARGE',422);if(current.length&&(size+length>30000||current.length>=40)){groups.push(current);current=[];size=0;}current.push(record);size+=length;}if(current.length)groups.push(current);return groups;}
  private enqueueWiki(value: Analysis, title: string, records: KnowledgeVersion[], instructions: string,level?:'summary'|'discovery'|'topic'|'hypothesis'|'overview') {
    const markdown=new MarkdownKnowledge(this.store);const existing=markdown.index(value.project_id).documents.find(record=>(record.title===title||record.aliases?.includes(title)||record.batch_label===title)&&(!level||record.level===level));
    const refs=records.map(r=>markdown.index(value.project_id).documents.find(d=>d.id===r.object_id)!);
    if(existing&&!existing.stale&&existing.dependencies?.length===refs.length&&refs.every(ref=>existing.dependencies?.some(d=>d.path===ref.path&&d.hash===ref.hash))){const old=this.knowledge.tasks(value.project_id).find(t=>t.output_id===existing.id&&t.status==='completed'&&(t.snapshot as {prompt_version?:number}).prompt_version===9);if(old)return [old.task_id];}
    const input: KnowledgeTaskInput = { kind: "wiki-page", source_ids: value.reused_sources??[], dependencies: records.map(record => ({ kind: record.kind, object_id: record.object_id, version: record.version })), title, ...(existing ? { target_id: existing.id } : {}), instructions: `${instructions}。用户要求：${value.instructions??""}。本次共有 ${value.source_count} 篇可读文献，缺少正文或摘要跳过 ${value.skipped_count} 篇。缺失来源ID：${(value.missing_sources??[]).join(",")||"无"}。只归纳实际提供的成功结果，不推测缺失材料。`, timeout_seconds: 3600, regenerate: false, wiki_level:level??(value.overview?"overview":"topic") };
    return this.agent.enqueue(value.project_id, input).map(task => task.task_id);
  }
  advance(project: string) {
    const value = this.reconcile(project); if (!value || !active(value)) return;
    try {
      const ids = ["cards","cards-only"].includes(value.stage) ? value.card_tasks : value.stage === "groups" ? value.group_tasks : value.stage==='discovery' ? value.discovery_tasks??[] : value.wiki_tasks;
      if (this.tasks(project, ids).some(pending)) return;
      if(value.stage==='cards-only'){value.missing_sources=[...new Set([...(value.missing_sources??[]),...this.tasks(project,value.card_tasks).filter(t=>t.status!=='completed').map(t=>t.input.source_ids[0])])];value.stage=this.tasks(project,value.card_tasks).some(t=>t.status!=='completed')?'partial':'completed';value.covered_sources=this.tasks(project,value.card_tasks).filter(t=>t.status==='completed').map(t=>t.input.source_ids[0]);this.save(value);return;}
      if(value.stage==='discovery'){
        const discovery=this.records(project,value.discovery_tasks??[]);if(!discovery.length)throw new Error('主题发现没有有效清单，未自动创建主题');
        const base=this.records(project,value.card_tasks,value.card_documents),groups=this.records(project,[...(value.group_history??[]),...value.group_tasks]);
        const materials=[...base,...groups];
        const candidates=discoverWikiTopics(String((discovery[0].content as {body:string}).body),materials,new MarkdownKnowledge(this.store).index(project).documents.filter(d=>d.kind==='wiki-page').map(d=>d.id));
        const formal=candidates.filter(c=>c.eligible).slice(0,8);value.candidate_count=candidates.length-formal.length;value.topic_count=formal.length;
        value.stage='wiki';value.wiki_tasks=[];
        for(const topic of formal){
          const wanted=topic.body.match(/已有主题ID[：:]\s*(wiki-[A-Za-z0-9_-]+)/)?.[1];
          const prior=wanted?new MarkdownKnowledge(this.store).index(project).documents.find(d=>d.id===wanted&&d.level===topic.level):undefined;
          if(prior)topic.title=prior.title.replace(/^待验证假设[：:]\s*/, '');
          value.wiki_tasks.push(...this.enqueueWiki(value,topic.level==='hypothesis'?`待验证假设：${topic.title}`:topic.title,topic.evidence,`围绕从文献实际发现的问题“${topic.title}”整理Agent研究记忆，不围绕项目题目扩写。何时读取、核心认识、证据与分歧、未知与待验证、项目关联、深入阅读。项目关联可为暂无。${topic.level==='hypothesis'?'这是待验证研究假设，不能写成已证实事实。':''}发现依据：${topic.body}`,topic.level));}
        if(!value.wiki_tasks.length){const failed=this.tasks(project,[...value.card_tasks,...(value.group_history??[]),...value.group_tasks,...(value.discovery_tasks??[])]).some(t=>t.status!=='completed');value.stage=failed||(value.missing_sources?.length??0)>0?'partial':'completed';value.error=failed?'部分材料失败；仅保留候选线索清单，未生成正式主题。':undefined;}
        this.save(value);return;
      }
      if(value.stage==='wiki'&&!value.overview&&!value.theme_title){
        const records=[...this.records(project,value.wiki_tasks),...this.records(project,value.discovery_tasks??[])];if(!records.length)throw new Error('主题综合无成功结果');
        value.overview=true;value.wiki_tasks.push(...this.enqueueWiki(value,'项目知识总览',records,'增量修订Agent研究记忆导航，保留已有主题入口与人工方向，不删除本轮未提供的旧知识；本轮只更新直接相关认识：何时读取、研究目标、关键认识、主题链接、候选线索与待验证假设、待解决问题。保留暂无直接项目关联的独立知识主题。400–800字，不把假设写成事实，不替用户决定方向。'));this.save(value);return;
      }
      if (value.stage === "wiki") {
        const tasks = this.tasks(project, [...value.card_tasks, ...(value.group_history??[]),...value.group_tasks,...(value.discovery_tasks??[]), ...value.wiki_tasks]);
        value.stage = !this.records(project, value.wiki_tasks).length ? "failed" : (tasks.some(task => task.status !== "completed") || this.records(project, value.wiki_tasks).length !== value.wiki_tasks.length || this.records(project, value.card_tasks,value.card_documents).length !== value.source_count) ? "partial" : "completed";
        if (value.stage !== "completed") value.error = "部分任务失败、被取消或未产生有效结果，请查看任务页。";
        this.save(value); return;
      }
      const records = this.records(project, ["cards","cards-only"].includes(value.stage) ? value.card_tasks : value.group_tasks,value.stage==='cards'?value.card_documents:[]);
      if (!records.length) { value.stage = "failed"; value.error = "没有成功的分析结果，未生成 Wiki，请查看任务日志。"; this.save(value); return; }
      const batches=this.batches(records);
      const completedCards=this.tasks(project,value.card_tasks).filter(t=>t.status==='completed');value.covered_sources=[...new Set([...completedCards.map(t=>t.input.source_ids[0]),...(value.card_documents??[]).flatMap(id=>{const doc=new MarkdownKnowledge(this.store).index(project).documents.find(d=>d.id===id);return doc?.source_id?[doc.source_id]:[];})])];value.missing_sources=[...new Set([...(value.missing_sources??[]),...this.tasks(project,value.card_tasks).filter(t=>t.status!=='completed').map(t=>t.input.source_ids[0])])];
      if (batches.length > 1) {
        value.stage = "groups"; value.group_history=[...(value.group_history??[]),...value.group_tasks];value.group_tasks = [];
        value.round=(value.round??0)+1;if(value.round>8)throw new Error('分层综合超过8层，请缩小主题范围');
        for(const [i,batch] of batches.entries())value.group_tasks.push(...this.enqueueWiki(value,`文献知识第${value.round}层分组${i+1}`,batch,'按实际提供来源归纳证据、共识、分歧和缺失，生成不超过3000字符的主题线索中间总结：开放提取共同假设、分歧、异常、机制和边界，不按项目题目筛掉主题。必须保留原始Wiki页ID及链接、覆盖ID，区分事实和推断，避免逐篇重复摘要。按 summary 分批总结规范生成有内容的展示标题、何时读取、覆盖方向和材料范围；批次编号只记录在批次标识，不作为标题。','summary'));
        this.save(value); return;
      }
      if(value.theme_title){value.stage='wiki';value.wiki_tasks.push(...this.enqueueWiki(value,value.theme_title,records,`按用户明确主题“${value.theme_title}”生成精简Agent研究记忆。何时读取、核心认识、证据与分歧、未知与待验证、项目关联和深入阅读；不把假设写成事实。`));}
      else{value.stage='discovery';value.discovery_tasks=this.enqueueWiki(value,'文献主题发现清单',records,'先开放发现文献主题，跨论文聚类去重，再关联项目。项目题目不是边界；不固定生成背景/方法/数据集等栏目主题。遵守 references/wiki.md 的发现清单格式：二级标题严格为“知识主题：具体问题”“候选线索：具体问题”或“研究假设：具体问题”；各项保留实际原始卡片ID或分组Wiki ID及证据链接，说明独立价值。单篇正式主题需写“单篇价值：理由”。最多8个，不凑数，证据不足只列候选线索。清单仅用于主题发现，不返回JSON。','discovery');}
      this.save(value);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "知识归纳失败"; this.save(value); this.stopPending(value); }
  }
  private stopPending(value: Analysis) {
    for (const task of this.tasks(value.project_id, [...value.card_tasks, ...(value.group_history??[]),...value.group_tasks,...(value.discovery_tasks??[]), ...value.wiki_tasks]).filter(pending)) this.agent.cancel(value.project_id, task.task_id);
  }
  cancel(project: string) {
    const value = this.read(project); if (!value || !active(value)) return this.status(project);
    value.stage = "cancelled"; this.save(value);
    this.stopPending(value);
    return this.status(project);
  }
}
