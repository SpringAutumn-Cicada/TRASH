import { randomUUID } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = "v1" as const;
export const PROTOCOL_VERSION_PATTERN = /^v[1-9][0-9]*$/;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const idSchema = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9-]+$`));
export const projectIdSchema = idSchema("project");
export const workflowRunIdSchema = idSchema("wfrun");
export const agentTaskIdSchema = idSchema("agenttask");
export const experimentTaskIdSchema = idSchema("exptask");
export const artifactIdSchema = idSchema("artifact");
export const sourceIdSchema = idSchema("source");
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const refSchema = z.string().min(1);

export const researchProjectSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  project_id: projectIdSchema,
  title: z.string().trim().min(1),
  research_question: z.string().trim().min(1),
  module: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), version: z.string().min(1) }).strict(),
  status: z.enum(["active", "archived"]),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();
export type ResearchProject = z.infer<typeof researchProjectSchema>;

export const workflowRunStatusSchema = z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"]);
export const workflowRunSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  workflow_run_id: workflowRunIdSchema,
  project_id: projectIdSchema,
  workflow_id: z.string().min(1),
  status: workflowRunStatusSchema,
  current_stage: z.string().min(1),
  attempt: z.number().int().positive(),
  input_refs: z.array(refSchema),
  output_refs: z.array(refSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const agentTaskSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  agent_task_id: agentTaskIdSchema,
  project_id: projectIdSchema,
  workflow_run_id: workflowRunIdSchema.optional(),
  adapter_id: z.literal("codex-cli"),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
  workspace_root: z.string().min(1),
  context_refs: z.array(refSchema),
  output_schema_ref: refSchema.optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  created_at: timestampSchema
}).strict();
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const experimentTaskStatusSchema = z.enum(["queued", "preflight", "running", "collecting", "completed", "failed", "cancelled", "disconnected"]);
export const experimentTaskSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  experiment_task_id: experimentTaskIdSchema,
  project_id: projectIdSchema,
  workflow_run_id: workflowRunIdSchema.optional(),
  plan_version_id: refSchema,
  module: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  git: z.object({ repository: z.string().min(1), commit_sha: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), working_tree_clean: z.literal(true) }).strict(),
  dataset_refs: z.array(refSchema),
  environment_summary: z.record(z.string(), z.unknown()),
  command: z.array(z.string().min(1)).min(1),
  status: experimentTaskStatusSchema,
  artifact_ids: z.array(artifactIdSchema),
  created_at: timestampSchema
}).strict();
export type ExperimentTask = z.infer<typeof experimentTaskSchema>;

export const artifactSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  artifact_id: artifactIdSchema,
  project_id: projectIdSchema,
  kind: z.enum(["document", "log", "config", "metrics", "plot", "report", "manuscript", "other"]),
  name: z.string().min(1),
  media_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  location: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), uri: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("remote"), profile_id: z.string().min(1), uri: z.string().min(1), dataset_version: z.string().optional() }).strict()
  ]),
  created_at: timestampSchema,
  verification_status: z.enum(["unverified", "verified", "failed"])
}).strict();
export type Artifact = z.infer<typeof artifactSchema>;

export const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pdf_page"), page_number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("paragraph"), paragraph_index: z.number().int().positive(), heading: z.string().optional(), url: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal("abstract"), field: z.literal("abstract") }).strict()
]);
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;

export const sourceSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  source_id: sourceIdSchema,
  project_id: projectIdSchema,
  title: z.string().trim().min(1),
  authors: z.array(z.string().min(1)),
  year: z.number().int().min(1000).max(3000).optional(),
  doi: z.string().optional(),
  source_type: z.enum(["pdf", "bibtex", "ris", "markdown", "webpage", "openalex"]),
  source_url: z.string().url().optional(),
  provider_id: z.string().min(1).optional(),
  provider_ref: z.string().min(1).optional(),
  artifact_id: artifactIdSchema.optional(),
  imported_file_sha256: sha256Schema.optional(),
  abstract: z.string().optional(),
  parse_status: z.enum(["indexed", "metadata_only", "no_text", "failed"]),
  import_error: z.string().optional(),
  imported_at: timestampSchema
}).strict();
export type Source = z.infer<typeof sourceSchema>;

export const literatureSearchResultSchema = z.object({
  provider_id: z.string().min(1),
  provider_ref: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.number().int().min(1000).max(3000).optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  abstract: z.string().optional()
}).strict();
export type LiteratureSearchResult = z.infer<typeof literatureSearchResultSchema>;

export const evidencePassageSchema = z.object({
  source_id: sourceIdSchema,
  locator: sourceLocatorSchema,
  text: z.string().min(1),
  rank: z.number()
}).strict();
export type EvidencePassage = z.infer<typeof evidencePassageSchema>;

export const workflowEventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event_id: idSchema("event"),
  workflow_run_id: workflowRunIdSchema,
  type: z.enum(["run.started", "stage.started", "stage.completed", "approval.required", "run.paused", "run.resumed", "run.completed", "run.failed", "run.cancelled"]),
  status: workflowRunStatusSchema,
  stage: z.string().optional(),
  refs: z.array(refSchema),
  occurred_at: timestampSchema
}).strict();
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

export const agentTaskEventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event_id: idSchema("event"),
  agent_task_id: agentTaskIdSchema,
  type: z.enum(["task.started", "assistant.message", "tool.started", "tool.output", "artifact.created", "approval.required", "task.completed", "task.failed", "task.cancelled"]),
  occurred_at: timestampSchema,
  payload: z.record(z.string(), z.unknown())
}).strict();
export type AgentTaskEvent = z.infer<typeof agentTaskEventSchema>;

export const experimentTaskEventSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  event_id: idSchema("event"),
  experiment_task_id: experimentTaskIdSchema,
  type: z.enum(["task.preflight", "task.started", "task.stdout", "task.stderr", "task.artifact", "task.disconnected", "task.completed", "task.failed", "task.cancelled"]),
  status: experimentTaskStatusSchema,
  occurred_at: timestampSchema,
  artifact_id: artifactIdSchema.optional(),
  message: z.string().optional()
}).strict();
export type ExperimentTaskEvent = z.infer<typeof experimentTaskEventSchema>;

export function makeId(prefix: "project" | "wfrun" | "agenttask" | "exptask" | "artifact" | "source" | "event"): string {
  return `${prefix}_${randomUUID()}`;
}

export function parseProtocolRecord<T>(schema: z.ZodType<T>, input: unknown): T {
  return schema.parse(input);
}
