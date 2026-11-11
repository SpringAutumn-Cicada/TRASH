import { z } from "zod";
import { calculateBinaryMetrics, evaluationMetrics, defaultEvaluationMetrics } from "./evaluation.js";

export const knowledgeKindSchema = z.enum(["literature-card", "wiki-page", "experiment-result"]);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;
export const reviewStatusSchema = z.enum(["draft", "pending", "accepted", "rejected"]);
const text = z.string().max(100000);
const names = z.array(z.string().trim().min(1).max(200)).max(200);
export const dependencySchema = z.object({ kind: knowledgeKindSchema, object_id: z.string().min(1), version: z.number().int().positive() }).strict();
export const evidenceSchema = z.object({ source_id: z.string().min(1), file_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), page: z.number().int().positive().optional(), paragraph: z.number().int().positive().optional(), quote: text.optional(), attribution: z.enum(["author", "user", "agent"]) }).strict();
export const literatureCardSchema = z.object({
  source_id: z.string().min(1), source_file_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), title: z.string().trim().min(1).max(500), tags: names.default([]),
  question: text.default(""), method: text.default(""), contributions: text.default(""), limitations: text.default(""),
  datasets: names.default([]), baselines: names.default([]), metrics: names.default([]), reported_results: text.default(""),
  experimental_conditions: text.default(""), ideas: text.default(""), relevance: text.default(""), open_questions: text.default(""),
  evidence: z.array(evidenceSchema).default([])
}).strict();
export const wikiPageSchema = z.object({ title: z.string().trim().min(1).max(500), tags: names.default([]), body: text, dependencies: z.array(dependencySchema).max(500).default([]) }).strict();
export const metricSchema = z.object({ name: z.string().trim().min(1).max(200), value: z.number().finite(), unit: z.string().max(100), condition: z.string().max(2000), source:z.enum(["manual","confusion_matrix"]).optional(), direction:z.enum(["max","min"]).optional() }).strict();
export const experimentResultSchema = z.object({
  schema_version: z.literal(1), title: z.string().trim().min(1).max(500), description: text.default(""),
  method: z.string().max(500), dataset: z.string().max(500), dataset_version: z.string().max(200).default(""),
  task: z.string().max(500).default(""), split: z.string().max(500).default(""), evaluation_protocol: text.default(""),
  config: z.record(z.unknown()).default({}), seed: z.number().int().optional(), environment: z.record(z.unknown()).default({}),
  run_at: z.string().datetime({ offset: true }).optional(), git_commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/).optional(),
  plan_version: z.string().optional(), external_run_id: z.string().trim().min(1).max(500).optional(),
  metrics: z.array(metricSchema).max(1000), attachments: z.array(z.object({ name: z.string().min(1), uri: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).default([]),
  notes: text.default(""),
  confusion_matrix:z.object({tn:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),fp:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),fn:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),tp:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),negative_label:z.string().trim().min(1).max(100),positive_label:z.string().trim().min(1).max(100)}).strict().refine(value=>value.negative_label!==value.positive_label,'正负类名称必须不同').optional(),
  evaluation:z.object({granularity:z.string().max(200),positive_class:z.string().max(100),threshold:z.string().max(200),averaging:z.enum(['binary','macro','micro','weighted','samples','unknown']),selected_metrics:z.array(z.string().min(1).max(200)).max(30)}).strict().optional()
}).strict().superRefine((result,ctx)=>{
 if(result.confusion_matrix&&!Number.isSafeInteger(result.confusion_matrix.tn+result.confusion_matrix.fp+result.confusion_matrix.fn+result.confusion_matrix.tp))ctx.addIssue({code:z.ZodIssueCode.custom,path:['confusion_matrix'],message:'样本总数超过安全整数范围'});
 for(const [index,metric] of result.metrics.entries())if(evaluationMetrics.some(spec=>spec.name===metric.name)&&metric.source==='manual'){
 const value=metric.unit==='%'?metric.value/100:metric.value;
 if(metric.unit!=='ratio'&&metric.unit!=='%'&&!(metric.name==='MCC'&&metric.unit===''))continue;
 if(value<(metric.name==='MCC'?-1:0)||value>1)ctx.addIssue({code:z.ZodIssueCode.custom,path:['metrics',index,'value'],message:'评估分数超出有效范围'});
 }
}).transform(result=>{
 result={...result,metrics:result.metrics.map(metric=>evaluationMetrics.some(spec=>spec.name===metric.name)&&metric.unit==='%'?{...metric,value:metric.value/100,unit:metric.name==='MCC'?'':'ratio'}:metric.name==='MCC'&&metric.unit==='ratio'?{...metric,unit:''}:metric)};
 if(!result.confusion_matrix)return {...result,metrics:result.metrics.filter(metric=>metric.source!=='confusion_matrix')};
 const computed=calculateBinaryMetrics(result.confusion_matrix),manual=result.metrics.filter(metric=>metric.source!=='confusion_matrix');
 const selected=[...new Set(result.evaluation?.selected_metrics??defaultEvaluationMetrics)];
 const derived=selected.flatMap(name=>{const value=computed[name],spec=evaluationMetrics.find(item=>item.name===name);return value===undefined||!Number.isFinite(value)?[]:[{name,value,unit:name==='MCC'?'':'ratio',condition:'二分类矩阵 · 正类 '+result.confusion_matrix!.positive_label,source:'confusion_matrix' as const,direction:spec?.direction??'max' as const}];});
 return {...result,metrics:[...manual,...derived]};
});
export const sourceDetailsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(), authors: names.optional(), year: z.number().int().min(1000).max(3000).optional(), doi: z.string().max(500).optional(),
  publication_date:z.string().regex(/^[12]\d{3}(?:-(?:0[1-9]|1[0-2]))?$/).optional(),
  tags: names.default([]), reading_status: z.enum(["unread", "reading", "organized"]).default("unread"),
  purposes: z.array(z.enum(["background", "related-work", "method", "baseline", "dataset", "other"])).default([]), normalized_names: z.record(z.string()).default({})
}).strict();
export type KnowledgeContent = z.infer<typeof literatureCardSchema> | z.infer<typeof wikiPageSchema> | z.infer<typeof experimentResultSchema>;
export interface KnowledgeVersion {
  object_id: string; project_id: string; kind: KnowledgeKind; version: number; status: z.infer<typeof reviewStatusSchema>;
  title: string; content: KnowledgeContent; created_by: "user" | "agent"; created_at: string;
}
export const knowledgeWriteSchema = z.object({ object_id: z.string().optional(), base_version: z.number().int().nonnegative(), content: z.record(z.unknown()) }).strict();
export function parseKnowledge(kind: KnowledgeKind, value: unknown): KnowledgeContent {
  if (kind === "literature-card") return literatureCardSchema.parse(value);
  if (kind === "wiki-page") return wikiPageSchema.parse(value);
  return experimentResultSchema.parse(value);
}
export const knowledgeTaskInputSchema = z.object({
  kind: z.enum(["literature-card", "wiki-page"]), source_ids: z.array(z.string().min(1)).max(100).default([]),
  dependencies: z.array(dependencySchema).max(100).default([]), target_id: z.string().optional(),
  title: z.string().min(1).max(500), instructions: z.string().max(10000).default(""),
  timeout_seconds: z.number().int().min(30).max(7200).default(900), regenerate: z.boolean().default(false), include_source_wiki: z.boolean().optional(), wiki_level:z.enum(['single','discovery','topic','hypothesis','overview']).optional()
}).strict();
export type KnowledgeTaskInput = z.infer<typeof knowledgeTaskInputSchema>;
