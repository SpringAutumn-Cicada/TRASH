import { z } from "zod";
const text = z.string().trim().min(1).max(500);
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
export const remotePathSchema = z.string().min(2).max(2048).refine(p => p.startsWith("/") && !p.split("/").includes("..") && !Array.from(p).some(c => c.charCodeAt(0) < 32), "必须为无上级跳转的绝对路径");
export const outputPathSchema = z.string().min(1).max(1024).refine(p => !p.startsWith("/") && !p.split(/[\\/]/).some(s => s === ".." || s === ".git") && !p.includes("\\") && !Array.from(p).some(c => c.charCodeAt(0) < 32), "必须为运行目录内的相对路径");
export const repositoryInputSchema = z.object({ path: z.string().min(1).max(4096), editor: z.object({ executable: text, args: z.array(z.string().max(2000)).max(30) }).optional() }).strict();
export type ProjectRepository = z.infer<typeof repositoryInputSchema> & { repository_id: string; project_id: string; bound_at: string };
export const sshProfileInputSchema = z.object({ name: text, host: z.string().regex(/^[A-Za-z0-9.:-]+$/).max(253), port: z.number().int().min(1).max(65535), username: z.string().regex(/^[A-Za-z0-9_.-]+$/), remote_root: remotePathSchema.refine(p => p !== "/" && p.split("/").filter(Boolean).length >= 2, "请选择平台专属子目录"), auth: z.enum(["password", "key", "agent"]), key_path: z.string().min(1).max(4096).optional() }).strict();
export type SshProfile = z.infer<typeof sshProfileInputSchema> & { profile_id: string; project_id: string; fingerprint?: string; created_at: string };
export const sessionCredentialSchema = z.object({ password: z.string().min(1).max(10000).optional(), passphrase: z.string().max(10000).optional() }).strict();
export const datasetInputSchema = z.object({ name: text, version: text, path: remotePathSchema, profile_id: text, size_bytes: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), checksum_manifest: remotePathSchema.optional(), notes: z.string().max(10000).default("") }).strict();
export type DatasetRef = z.infer<typeof datasetInputSchema> & { dataset_id: string; project_id: string; verification_status: "unverified" | "verified"; verified_at?: string };
export const experimentPlanInputSchema = z.object({
  title: text, purpose: z.string().max(20000), method: text, baseline: z.string().max(2000).default(""), evaluation_protocol: z.string().max(20000),
  code_source:z.enum(["git","reproduction"]).default("git"), reproduction_id:text.optional(), snapshot_id:text.optional(),
  commit_sha: z.union([commitShaSchema,z.literal("")]).default(""), profile_id: text, dataset_ids: z.array(text).max(50), python: remotePathSchema,
  command: z.array(z.string().min(1).max(4096)).min(1).max(100), env: z.record(z.string().max(4096)).default({}),
  config: z.record(z.unknown()).default({}), seed: z.number().int().optional(), gpu: z.string().regex(/^(cpu|\d+(,\d+)*)$/),
  timeout_seconds: z.number().int().min(10).max(604800).default(7200),
  metrics_path: outputPathSchema.default("outputs/metrics.json"), expected_metrics: z.array(z.object({ name: text, unit: z.string().max(100) }).strict()).min(1).max(100),
  artifact_paths: z.array(outputPathSchema).max(100).default([]), preparation_script: outputPathSchema.optional()
}).strict().superRefine((input, ctx) => {
  if(input.code_source==="git"&&!commitShaSchema.safeParse(input.commit_sha).success)ctx.addIssue({code:z.ZodIssueCode.custom,path:["commit_sha"],message:"实验代码需要完整 commit"});
  if(input.code_source==="reproduction"&&(!input.reproduction_id||!input.snapshot_id))ctx.addIssue({code:z.ZodIssueCode.custom,path:["snapshot_id"],message:"请选择复现代码快照"});
  for (const [key, value] of Object.entries(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /password|token|secret|api.?key|credential/i.test(key) || /\bsk-[\w-]+/.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["env", key], message: "仅允许非敏感环境变量" });
  }
});
export type ExperimentPlanContent = z.infer<typeof experimentPlanInputSchema>;
export interface ExperimentPlanVersion { plan_id: string; project_id: string; version: number; status: "draft" | "confirmed" | "superseded"; repository: ProjectRepository; reproduction?:ReproductionSnapshot; profile: SshProfile; datasets: DatasetRef[]; content: ExperimentPlanContent; created_at: string; confirmed_at?: string }
export const experimentRunStateSchema = z.enum(["queued", "preflight", "syncing", "running", "collecting", "completed", "failed", "cancel_requested", "cancelled", "disconnected", "unknown_remote_state"]);
export type ExperimentRunState = z.infer<typeof experimentRunStateSchema>;
export const ACTIVE_EXPERIMENT_STATES = ["queued", "preflight", "syncing", "running", "collecting", "cancel_requested", "disconnected", "unknown_remote_state"] as const;
export interface ExperimentArtifact { path: string; size_bytes: number; sha256: string; downloaded: boolean; artifact_id?: string; reason?: string }
export interface ExperimentRun { run_id: string; project_id: string; profile_id: string; host_key: string; plan: ExperimentPlanVersion; idempotency_key: string; status: ExperimentRunState; remote_dir: string; token: string; created_at: string; updated_at: string; started_at?: string; finished_at?: string; exit_code?: number; error?: string; process_status?: string; collection_status?: string; metrics_status?: string; result_id?: string; artifacts: ExperimentArtifact[]; retry_of?: string; preparation: boolean; remote_status?: Record<string, unknown> }
export const runSubmitSchema = z.object({ plan_id: text, version: z.number().int().positive(), idempotency_key: z.string().uuid(), confirm: z.literal(true), preparation: z.boolean().default(false) }).strict();

export interface ReproductionCode {id:string;project_id:string;name:string;archive_name?:string;path:string;source_id?:string;source_url:string;notes:string;created_at:string;imported:boolean;uploads?:{profile_id:string;path:string;snapshot_id:string;sha256:string;at:string}[]}
export interface ReproductionSnapshot {analysis_excluded?:{path:string;reason:string}[];snapshot_id:string;reproduction_id:string;name:string;archive_name?:string;source_id?:string;sha256:string;created_at:string;size_bytes:number;files:{path:string;size_bytes:number;sha256:string}[]}

export interface RemoteWorkspace {project_id:string;profile_id:string;root:string;updated_at:string;initialized_at?:string}
