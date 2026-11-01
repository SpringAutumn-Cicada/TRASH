import { z } from "zod";
const text=z.string().max(20000);
export const environmentEvidenceSchema=z.object({path:z.string().min(1).max(2048),line_start:z.number().int().positive(),line_end:z.number().int().positive()}).strict();
const attributed={attribution:z.enum(["declared","inferred","unknown"]),evidence:z.array(environmentEvidenceSchema).max(30)};
const imageValue=z.object({value:text,...attributed}).strict();
const deploymentSchema=z.object({
 status:z.enum(["ready","blocked"]),venv_path:z.literal(".venv"),
 prerequisites:z.array(text).max(100),blockers:z.array(text).max(100),runtime_notes:z.array(text).max(100).optional(),
 steps:z.array(z.object({purpose:text,command:text,...attributed}).strict()).min(1).max(80)
}).strict();
const codeInformationSchema=z.object({
 datasets:z.array(z.object({name:text,version:text,role:text,format:text,paths:z.array(text).max(40),directory_structure:text,source:text,preprocessing:text,split:text,weights:text,manual_preparation:z.array(text).max(40),...attributed}).strict()).max(80),
 run_plans:z.array(z.object({name:text,scope:text,status:z.enum(['ready','blocked']),parameters:z.array(text).max(80),blockers:z.array(text).max(80),steps:z.array(z.object({stage:z.enum(['prepare','preprocess','train','evaluate','collect','other']),purpose:text,working_directory:text,entrypoint:text,command:text,inputs:z.array(text).max(40),outputs:z.array(text).max(40),metrics:z.array(text).max(40),...attributed}).strict()).max(60),...attributed}).strict()).max(40),
 unresolved:z.array(text).max(100)
}).strict();
const legacyEnvironmentContentSchema=z.object({
 schema_version:z.literal(1),summary:text,
 requirements:z.array(z.object({category:z.enum(["system","python","framework","cuda","tool","dependency","other"]),name:text,requirement:text,...attributed,check:z.object({kind:z.enum(["python","package","tool","gpu","other"]),name:z.string().max(200),operator:z.enum(["eq","gte","lte","present","unknown"]),version:z.string().max(100)}).strict()}).strict()).max(300),
 commands:z.array(z.object({purpose:text,command:text,...attributed}).strict()).max(80),
 resources:z.array(z.object({name:text,requirement:text,...attributed}).strict()).max(100),
 issues:z.array(z.object({name:text,requirement:text,...attributed}).strict()).max(100),limitations:z.array(text).max(100)
}).strict();
export const codeEnvironmentContentSchema=z.discriminatedUnion("schema_version",[
 legacyEnvironmentContentSchema,
 legacyEnvironmentContentSchema.extend({schema_version:z.literal(2),
  image_selection:z.object({framework:imageValue,framework_version:imageValue,python:imageValue,cuda:imageValue}).strict(),
  agent_deployment:deploymentSchema,code_information:codeInformationSchema.optional()
 }).strict()
]);
export type CodeEnvironmentContent=z.infer<typeof codeEnvironmentContentSchema>;
export interface EnvironmentCoverage {selected_files:number;selected_bytes:number;skipped:{path:string;reason:string}[];limits:{files:number;file_bytes:number;total_bytes:number}}
export interface EnvironmentAnalysisTask {id:string;project_id:string;reproduction_id:string;status:"preparing"|"analyzing"|"completed"|"failed"|"cancelled"|"interrupted";created_at:string;finished_at?:string;error?:string;report_id?:string;dismissed_at?:string;stage?:"snapshot"|"collecting"|"analyzing"|"validating"|"saving"|"completed";stage_message?:string;selected_files?:number;selected_bytes?:number}
export interface CodeEnvironmentReport {id:string;task_id:string;project_id:string;reproduction_id:string;created_at:string;code_fingerprint:string;snapshot_id:string;skill_name:"trash_analyze_code_environment";skill_version:string;skill_hash:string;cli_version:string;coverage:EnvironmentCoverage;content:CodeEnvironmentContent;verified:false}
export interface HostEnvironmentComparison {id:string;report_id:string;project_id:string;reproduction_id:string;profile_id:string;created_at:string;python:string;environment:Record<string,unknown>;items:{name:string;expected:string;actual:string;status:"satisfied"|"unsatisfied"|"unknown";reason:string}[]}
