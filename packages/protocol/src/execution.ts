import { z } from 'zod';
const evidence=z.array(z.object({path:z.string().min(1).max(2048),line_start:z.number().int().positive(),line_end:z.number().int().positive()}).strict()).max(30);
const attributed={attribution:z.enum(['declared','inferred','unknown']),evidence};
const note=z.string().max(20000);
export const executionRelativePathSchema=z.string().max(1024).refine(value=>!value.startsWith('/')&&!/[\\\x00-\x1f]/.test(value)&&!value.split('/').some(part=>part==='..'||part==='.git'), '必须是无上级跳转的相对路径');
const envSchema=z.record(z.string().max(4096)).refine(value=>Object.entries(value).every(([key,item])=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)&&!/^TRASH_|^(PATH|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV|CUDA_VISIBLE_DEVICES)$/i.test(key)&&!/password|token|secret|api.?key|credential/i.test(key)&&!/\bsk-[\w-]+/.test(item)), '仅支持非敏感实验环境变量');
export const executionStepSchema=z.object({stage:z.enum(['prepare','preprocess','train','evaluate','collect','other']),purpose:note,working_directory:executionRelativePathSchema,argv:z.array(z.string().min(1).max(4096).refine(value=>!value.includes('\0'))).min(1).max(100),env:envSchema,...attributed}).strict();
export const resultCollectionSchema=z.object({
 mode:z.enum(['json','csv','log','none']),root:z.enum(['run','code']),path:executionRelativePathSchema,
 metrics:z.array(z.object({name:z.string().min(1).max(200),unit:z.string().max(100),key:z.string().max(500),label:z.string().max(500),scale:z.number().finite().positive().max(1000000)}).strict()).max(100),
 notes:note,...attributed
}).strict();
export const executionResumeSchema=z.object({checkpoint_path:executionRelativePathSchema.refine(value=>Boolean(value)),steps:z.array(executionStepSchema).min(1).max(60),...attributed}).strict();
export const analysisExecutionSchema=z.object({
 resource:z.object({device:z.enum(['cpu','gpu','unknown']),notes:note,...attributed}).strict().optional(),
 dataset_runs:z.array(z.object({dataset_name:z.string().min(1).max(500),status:z.enum(['ready','blocked']),blockers:z.array(note).max(80),dataset_subdirectory:executionRelativePathSchema,required_paths:z.array(executionRelativePathSchema).max(100),
 mappings:z.array(z.object({path:executionRelativePathSchema.refine(value=>Boolean(value)&&!value.split('/').some(part=>['.venv','venv','.trash-venv-checkpoint.json'].includes(part))),subpath:executionRelativePathSchema}).strict()).max(30),
 steps:z.array(executionStepSchema).max(60),resume:executionResumeSchema.optional(),config:z.record(z.unknown()),evaluation_protocol:note,result:resultCollectionSchema,...attributed
 }).strict()).max(80),...attributed
}).strict();
export const experimentBindingsSchema=z.object({report_id:z.string().min(1).max(200),profile_id:z.string().min(1).max(200),bindings:z.array(z.object({dataset_name:z.string().min(1).max(500),dataset_id:z.string().min(1).max(200),enabled:z.boolean()}).strict()).max(80)}).strict();
export type AnalysisExecution=z.infer<typeof analysisExecutionSchema>;
export type DatasetExecution=AnalysisExecution['dataset_runs'][number];
export type ExecutionStep=z.infer<typeof executionStepSchema>;
export type ResultCollection=z.infer<typeof resultCollectionSchema>;
export type ExperimentBindings=z.infer<typeof experimentBindingsSchema>;
