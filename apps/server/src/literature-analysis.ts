import { projectRuntime } from "./project-layout.js";
import { markdownVersions } from "./markdown-knowledge.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeStore, experimentError, type TrashStore, type KnowledgeTask } from "@trash/storage";
import type { KnowledgeTaskInput, KnowledgeVersion } from "@trash/protocol";
import { KnowledgeAgent } from "./knowledge-agent.js";

type Stage = "cards" | "groups" | "wiki" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
export interface Analysis {
  analysis_id: string; project_id: string; stage: Stage; created_at: string; updated_at: string;
  source_count: number; skipped_count: number; card_tasks: string[]; group_tasks: string[]; wiki_tasks: string[];
  error?: string;
}
const active = (value: Analysis) => ["cards", "groups", "wiki"].includes(value.stage);
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
  start(project: string) {
    const current = this.read(project); if (current && active(current)) return this.status(project);
    const sources = this.store.listSources(project);
    const eligible = sources.filter(source => this.store.listSourceSegments(source.source_id).some(segment => segment.text.trim()) || Boolean(source.abstract?.trim()));
    if (!eligible.length) experimentError("ANALYSIS_NO_READABLE_SOURCES", 422);
    const value: Analysis = { analysis_id: `analysis_${randomUUID()}`, project_id: project, stage: "cards", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_count: eligible.length, skipped_count: sources.length - eligible.length, card_tasks: [], group_tasks: [], wiki_tasks: [] };
    this.save(value);
    try {
      for (let i = 0; i < eligible.length; i += 100) {
        const input: KnowledgeTaskInput = { kind: "literature-card", source_ids: eligible.slice(i, i + 100).map(source => source.source_id), dependencies: [], title: "文献自动分析", instructions: "围绕当前论文研究问题，分析本篇文献的研究问题、方法、贡献、局限、实验条件与可借鉴思路。区分作者报告与推测，仅有摘要时明确标注分析范围。所有摘录与数值保留真实来源定位，不编造信息。", timeout_seconds: 900, regenerate: false };
        value.card_tasks.push(...this.agent.enqueue(project, input).map(task => task.task_id));
        this.save(value);
      }
      this.advance(project);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "创建分析任务失败"; this.save(value); this.stopPending(value); }
    return this.status(project);
  }
  private records(project: string, ids: string[]): KnowledgeVersion[] {
    return this.tasks(project, ids).filter(task => task.status === "completed" && task.output_id).flatMap(task => {
      const record = markdownVersions(this.store,project,task.input.kind).find(doc=>doc.object_id===task.output_id);
      return record ? [record] : [];
    });
  }
  private enqueueWiki(value: Analysis, title: string, records: KnowledgeVersion[], instructions: string) {
    const existing = markdownVersions(this.store,value.project_id,"wiki-page").find(record => record.title === title);
    const input: KnowledgeTaskInput = { kind: "wiki-page", source_ids: [], dependencies: records.map(record => ({ kind: record.kind, object_id: record.object_id, version: record.version })), title, ...(existing ? { target_id: existing.object_id } : {}), instructions: `${instructions}。本次共有 ${value.source_count} 篇可读文献，缺少正文或摘要跳过 ${value.skipped_count} 篇。只归纳实际提供的成功结果，不推测缺失材料。`, timeout_seconds: 900, regenerate: false };
    return this.agent.enqueue(value.project_id, input).map(task => task.task_id);
  }
  advance(project: string) {
    const value = this.read(project); if (!value || !active(value)) return;
    try {
      const ids = value.stage === "cards" ? value.card_tasks : value.stage === "groups" ? value.group_tasks : value.wiki_tasks;
      if (this.tasks(project, ids).some(pending)) return;
      if (value.stage === "wiki") {
        const tasks = this.tasks(project, [...value.card_tasks, ...value.group_tasks, ...value.wiki_tasks]);
        value.stage = !this.records(project, value.wiki_tasks).length ? "failed" : (tasks.some(task => task.status !== "completed") || this.records(project, value.wiki_tasks).length !== value.wiki_tasks.length || this.records(project, value.card_tasks).length !== value.source_count) ? "partial" : "completed";
        if (value.stage !== "completed") value.error = "部分任务失败、被取消或未产生有效结果，请查看任务页。";
        this.save(value); return;
      }
      const records = this.records(project, value.stage === "cards" ? value.card_tasks : value.group_tasks);
      if (!records.length) { value.stage = "failed"; value.error = "没有成功的分析结果，未生成 Wiki，请查看任务日志。"; this.save(value); return; }
      if (records.length > 100) {
        value.stage = "groups"; value.group_tasks = [];
        for (let i = 0; i < records.length; i += 100) value.group_tasks.push(...this.enqueueWiki(value, `文献知识分组汇总 ${i / 100 + 1}`, records.slice(i, i + 100), "综合这些文献卡片，归纳研究问题、方法、实验条件、共同认识、分歧与研究启发。保留来源ID与知识对象ID，不虚构实验结果。"));
        this.save(value); return;
      }
      value.stage = "wiki";
      for (const title of ["文献知识总览", "研究问题与背景", "方法与技术路线", "数据集与评价方案", "研究思路与待验证假设"]) value.wiki_tasks.push(...this.enqueueWiki(value, title, records, `生成“${title}”主题知识页。基于输入卡片或分组汇总跨文献归纳，明确共同结论、不同观点、适用条件、局限与对当前论文的启发。区分真实研究事实与待验证假设，引用真实 source ID 和 knowledge ID，保留 dependencies。若输入部分缺失，明确说明分析范围。已有已采纳内容只创建修订候选，不自动批准。`));
      this.save(value);
    } catch (error) { value.stage = "failed"; value.error = error instanceof Error ? error.message : "知识归纳失败"; this.save(value); this.stopPending(value); }
  }
  private stopPending(value: Analysis) {
    for (const task of this.tasks(value.project_id, [...value.card_tasks, ...value.group_tasks, ...value.wiki_tasks]).filter(pending)) this.agent.cancel(value.project_id, task.task_id);
  }
  cancel(project: string) {
    const value = this.read(project); if (!value || !active(value)) return this.status(project);
    value.stage = "cancelled"; this.save(value);
    this.stopPending(value);
    return this.status(project);
  }
}
