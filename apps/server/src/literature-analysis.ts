import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge } from "./markdown-knowledge.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeStore, experimentError, type TrashStore, type KnowledgeTask } from "@trash/storage";
import type { KnowledgeTaskInput, KnowledgeVersion } from "@trash/protocol";
import { KnowledgeAgent } from "./knowledge-agent.js";

type Stage = "cards-only" | "cards" | "groups" | "wiki" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
export interface Analysis {
  analysis_id: string; project_id: string; stage: Stage; created_at: string; updated_at: string;
  source_count: number; skipped_count: number; card_tasks: string[]; group_tasks: string[]; wiki_tasks: string[];
  error?: string; reused_sources?:string[]; covered_sources?:string[]; missing_sources?:string[]; round?:number; overview?:boolean; group_history?:string[];card_documents?:string[];theme_title?:string;instructions?:string;
}
const active = (value: Analysis) => ["cards-only", "cards", "groups", "wiki"].includes(value.stage);
const pending = (task: KnowledgeTask) => ["queued", "running"].includes(task.status);
export class LiteratureAnalysis {
  constructor(private store: TrashStore, private knowledge: KnowledgeStore, private agent: KnowledgeAgent) {
    for (const project of store.listProjects()) {
      const analysis = this.read(project.project_id);
      if (analysis && active(analysis)) { analysis.stage = "interrupted"; analysis.error = "服务重启，分析流程已中断；可重新点击分析，已保存内容保留。"; this.save(analysis); }
    }
    agent.onTaskSettled = project => this.advance(project);
  }
  private path(project: string) { return projectRuntime(this.store.root,project,'literature-analysis'); }
  private save(value: Analysis) {
    value.updated_at = new Date().toISOString(); const path = this.path(value.project_id); mkdirSync(path, { recursive: true });
    const bytes = JSON.stringify(value);
    for (const name of [value.analysis_id, "current"]) { writeFileSync(join(path, `${name}.tmp`), bytes, { mode: 0o600 }); renameSync(join(path, `${name}.tmp`), join(path, `${name}.json`)); }
  }
  private read(project: string): Analysis | undefined { try { return JSON.parse(readFileSync(join(this.path(project), "current.json"), "utf8")) as Analysis; } catch { return undefined; } }
  private tasks(project: string, ids: string[]) { const all = this.knowledge.tasks(project); return ids.map(id => all.find(task => task.task_id === id)).filter((task): task is KnowledgeTask => Boolean(task)); }
  status(project: string) {
    const value = this.read(project); if (!value) return null;
    const summarize = (ids: string[]) => { const tasks = this.tasks(project, ids); return { total: ids.length, completed: tasks.filter(task => task.status === "completed").length, failed: ids.length - tasks.filter(task => task.status === "completed" || pending(task)).length, active: tasks.filter(pending).length }; };
    return { ...value, cards: summarize(value.card_tasks), groups: summarize(value.group_tasks), wiki: summarize(value.wiki_tasks), active: active(value) };
  }
  start(project: string, mode:'all'|'missing'|'changed'|'synthesis'|'overview'='all',options:{source_ids?:string[];title?:string;instructions?:string}={}) {
    const current = this.read(project); if (current && active(current)) return this.status(project);
    const allSources=this.store.listSources(project);if(options.source_ids?.some(id=>!allSources.some(s=>s.source_id===id)))experimentError('SOURCE_NOT_FOUND',404);
    const sources=options.source_ids?.length?allSources.filter(s=>options.source_ids!.includes(s.source_id)):allSources;
    const eligible = sources.filter(source => this.store.listSourceSegments(source.source_id).some(segment => segment.text.trim()) || Boolean(source.abstract?.trim()) || source.source_type==='pdf');
    if (!eligible.length) experimentError("ANALYSIS_NO_READABLE_SOURCES", 422);
    const value: Analysis = { analysis_id: `analysis_${randomUUID()}`, project_id: project, stage: "cards", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_count: eligible.length, skipped_count: sources.length - eligible.length, card_tasks: [], group_tasks: [], wiki_tasks: [] };
    value.card_documents=[];value.theme_title=options.title;value.instructions=options.instructions;value.reused_sources=[];value.covered_sources=[];value.missing_sources=[];
    this.save(value);
    try {
      const markdown=new MarkdownKnowledge(this.store);const docs=markdown.index(project).documents;
      for(const source of eligible){
        const prior=this.knowledge.tasks(project).filter(t=>t.input.kind==='literature-card'&&t.input.source_ids[0]===source.source_id&&t.status==='completed').sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
        const same=prior&&JSON.stringify((prior.snapshot as {sources?:unknown[]}).sources)===JSON.stringify([{source,segments:this.store.listSourceSegments(source.source_id)}]);
        const pair=docs.filter(d=>d.source_id===source.source_id&&['detail','key'].includes(d.card_type??''));
        if(same&&pair.length===2&&!pair.some(d=>d.stale)&&docs.some(d=>d.id===`wiki-${source.source_id}`&&!d.stale)){value.card_tasks.push(prior.task_id);value.reused_sources!.push(source.source_id);continue;}
        if(mode==='synthesis'||mode==='overview'||(mode==='missing'&&pair.length===2)||(mode==='changed'&&!pair.length)){if(pair.length===2){if(prior)value.card_tasks.push(prior.task_id);else{value.card_documents!.push(`card-${source.source_id}-key`);value.reused_sources!.push(source.source_id);}}else value.missing_sources!.push(source.source_id);continue;}
        const input:KnowledgeTaskInput={kind:'literature-card',source_ids:[source.source_id],dependencies:[],title:source.title,instructions:'完整阅读本篇全文图文，生成详细卡片、关键卡片和单篇 Wiki。数字保留真实原文定位，不编造。',timeout_seconds:3600,regenerate:false,include_source_wiki:true};
        value.card_tasks.push(...this.agent.enqueue(project,input).map(t=>t.task_id));this.save(value);
      }
      if(mode==='missing'||mode==='changed'){value.stage='cards-only';}
      if(mode==='overview'){const themes=docs.filter(d=>d.kind==='wiki-page'&&d.level==='topic');if(!themes.length)throw new Error('没有可用主题 Wiki，请先生成主题');value.stage='wiki';value.overview=true;const records=themes.map(d=>({object_id:d.id,project_id:project,kind:'wiki-page' as const,version:1,status:'pending' as const,title:d.title,content:{title:d.title,tags:[],body:new MarkdownKnowledge(this.store).read(project,d.id).text,dependencies:[]},created_by:'agent' as const,created_at:d.modified}));if(this.batches(records).length>1)throw new Error('主题材料超出总览预算，请先通过完整分层综合缩减');value.wiki_tasks=this.enqueueWiki(value,'项目知识总览',records,'总结各主题和研究方向，简洁链接导航，不重复所有细节。');}
      this.save(value);
      this.advance(project);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "创建分析任务失败"; this.save(value); this.stopPending(value); }
    return this.status(project);
  }
  private records(project:string,ids:string[],documentIds:string[]=[]):KnowledgeVersion[]{
    const markdown=new MarkdownKnowledge(this.store);const docs=markdown.index(project).documents;
    const idsToRead=[...documentIds,...this.tasks(project,ids).filter(t=>t.status==='completed').flatMap(task=>task.input.kind==='literature-card'?[`card-${task.input.source_ids[0]}-key`]:task.output_id?[task.output_id]:[])];return [...new Set(idsToRead)].flatMap(id=>{const meta=docs.find(d=>d.id===id);if(!meta)return [];const doc=markdown.read(project,meta.id);return [{object_id:doc.id,project_id:project,kind:doc.kind,version:1,status:'pending' as const,title:doc.title,content:doc.kind==='wiki-page'?{title:doc.title,tags:[],body:doc.text,dependencies:[]}:{source_id:doc.source_id!,title:doc.title,tags:[],question:doc.text,method:'',contributions:'',limitations:'',datasets:[],baselines:[],metrics:[],reported_results:'',experimental_conditions:'',ideas:'',relevance:'',open_questions:'',evidence:[]},created_by:'agent' as const,created_at:doc.modified}];});
  }
  private batches(records:KnowledgeVersion[]){const groups:KnowledgeVersion[][]=[];let current:KnowledgeVersion[]=[],size=0;for(const record of records){const length=JSON.stringify(record.content).length;if(length>30000)experimentError('KNOWLEDGE_INPUT_TOO_LARGE',422);if(current.length&&(size+length>30000||current.length>=40)){groups.push(current);current=[];size=0;}current.push(record);size+=length;}if(current.length)groups.push(current);return groups;}
  private enqueueWiki(value: Analysis, title: string, records: KnowledgeVersion[], instructions: string) {
    const markdown=new MarkdownKnowledge(this.store);const existing=markdown.index(value.project_id).documents.find(record=>record.title===title);
    const refs=records.map(r=>markdown.index(value.project_id).documents.find(d=>d.id===r.object_id)!);
    if(existing&&!existing.stale&&existing.dependencies?.length===refs.length&&refs.every(ref=>existing.dependencies?.some(d=>d.path===ref.path&&d.hash===ref.hash))){const old=this.knowledge.tasks(value.project_id).find(t=>t.output_id===existing.id&&t.status==='completed');if(old)return [old.task_id];}
    const input: KnowledgeTaskInput = { kind: "wiki-page", source_ids: [], dependencies: records.map(record => ({ kind: record.kind, object_id: record.object_id, version: record.version })), title, ...(existing ? { target_id: existing.id } : {}), instructions: `${instructions}。用户要求：${value.instructions??""}。本次共有 ${value.source_count} 篇可读文献，缺少正文或摘要跳过 ${value.skipped_count} 篇。缺失来源ID：${(value.missing_sources??[]).join(",")||"无"}。只归纳实际提供的成功结果，不推测缺失材料。`, timeout_seconds: 3600, regenerate: false, wiki_level:value.overview?"overview":"topic" };
    return this.agent.enqueue(value.project_id, input).map(task => task.task_id);
  }
  advance(project: string) {
    const value = this.read(project); if (!value || !active(value)) return;
    try {
      const ids = ["cards","cards-only"].includes(value.stage) ? value.card_tasks : value.stage === "groups" ? value.group_tasks : value.wiki_tasks;
      if (this.tasks(project, ids).some(pending)) return;
      if(value.stage==='cards-only'){value.missing_sources=[...new Set([...(value.missing_sources??[]),...this.tasks(project,value.card_tasks).filter(t=>t.status!=='completed').map(t=>t.input.source_ids[0])])];value.stage=this.tasks(project,value.card_tasks).some(t=>t.status!=='completed')?'partial':'completed';value.covered_sources=this.tasks(project,value.card_tasks).filter(t=>t.status==='completed').map(t=>t.input.source_ids[0]);this.save(value);return;}
      if(value.stage==='wiki'&&!value.overview&&!value.theme_title){
        const records=this.records(project,value.wiki_tasks);if(!records.length)throw new Error('主题综合无成功结果');
        value.overview=true;value.wiki_tasks.push(...this.enqueueWiki(value,'项目知识总览',records,'基于各主题 Wiki 生成简洁项目总览，以链接导航、研究方向、共识、分歧和待解决问题为主，不重复所有细节。'));this.save(value);return;
      }
      if (value.stage === "wiki") {
        const tasks = this.tasks(project, [...value.card_tasks, ...(value.group_history??[]),...value.group_tasks, ...value.wiki_tasks]);
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
        for(const [i,batch] of batches.entries())value.group_tasks.push(...this.enqueueWiki(value,`文献知识第${value.round}层分组${i+1}`,batch,'按实际提供来源归纳证据、共识、分歧和缺失，生成不超过3000字符的中间总结，必须保留来源链接与覆盖ID，避免逐篇重复摘要。'));
        this.save(value); return;
      }
      value.stage = "wiki";
      for (const title of value.theme_title?[value.theme_title]:["研究问题与背景", "方法与技术路线", "数据集与评价方案", "研究思路与待验证假设"]) value.wiki_tasks.push(...this.enqueueWiki(value, title, records, `生成“${title}”主题知识页。基于输入卡片或分组汇总跨文献归纳，明确共同结论、不同观点、适用条件、局限与对当前论文的启发。区分真实研究事实与待验证假设，引用真实 source ID 和 knowledge ID，保留 dependencies。若输入部分缺失，明确说明分析范围。已有已采纳内容只创建修订候选，不自动批准。`));
      this.save(value);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "知识归纳失败"; this.save(value); this.stopPending(value); }
  }
  private stopPending(value: Analysis) {
    for (const task of this.tasks(value.project_id, [...value.card_tasks, ...(value.group_history??[]),...value.group_tasks, ...value.wiki_tasks]).filter(pending)) this.agent.cancel(value.project_id, task.task_id);
  }
  cancel(project: string) {
    const value = this.read(project); if (!value || !active(value)) return this.status(project);
    value.stage = "cancelled"; this.save(value);
    this.stopPending(value);
    return this.status(project);
  }
}
