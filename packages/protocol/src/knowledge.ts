import { z } from "zod";

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
export const metricSchema = z.object({ name: z.string().trim().min(1).max(200), value: z.number().finite(), unit: z.string().max(100), condition: z.string().max(2000) }).strict();
export const experimentResultSchema = z.object({
  schema_version: z.literal(1), title: z.string().trim().min(1).max(500), description: text.default(""),
  method: z.string().max(500), dataset: z.string().max(500), dataset_version: z.string().max(200).default(""),
  task: z.string().max(500).default(""), split: z.string().max(500).default(""), evaluation_protocol: text.default(""),
  config: z.record(z.unknown()).default({}), seed: z.number().int().optional(), environment: z.record(z.unknown()).default({}),
  run_at: z.string().datetime({ offset: true }).optional(), git_commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/).optional(),
  plan_version: z.string().optional(), external_run_id: z.string().trim().min(1).max(500).optional(),
  metrics: z.array(metricSchema).max(1000), attachments: z.array(z.object({ name: z.string().min(1), uri: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).default([]),
  notes: text.default("")
}).strict();
export const sourceDetailsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(), authors: names.optional(), year: z.number().int().min(1000).max(3000).optional(), doi: z.string().max(500).optional(),
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
  timeout_seconds: z.number().int().min(30).max(7200).default(900), regenerate: z.boolean().default(false)
}).strict();
export type KnowledgeTaskInput = z.infer<typeof knowledgeTaskInputSchema>;
