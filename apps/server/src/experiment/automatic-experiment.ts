import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { experimentBindingsSchema, type ExperimentBindings, type CodeEnvironmentReport } from '@trash/protocol';
import { experimentError } from '@trash/storage';
import type { ExperimentService } from './service.js';
import type { Queue } from './reproduction-queue.js';
export const automaticExperimentInputSchema=z.object({code_id:z.string().min(1),report_id:z.string().min(1),profile_id:z.string().min(1),plan_index:z.number().int().nonnegative(),directory:z.string().startsWith('/').max(2048).refine(value=>value!=='/'&&!/[\x00-\x1f]/.test(value)&&!value.split('/').includes('..')),bindings:experimentBindingsSchema.shape.bindings,gpu:z.string().regex(/^(cpu|\d+(,\d+)*)$/).default('0'),timeout_seconds:z.number().int().min(10).max(604800).default(7200),confirm:z.literal(true)}).strict();
type Input=z.infer<typeof automaticExperimentInputSchema>;
function reportFor(service:ExperimentService,project:string,code:string,id:string){return service.environmentAnalysis.report(project,code,id);}
function bindingPath(service:ExperimentService,project:string,code:string,report:string,profile:string){const key=createHash('sha256').update(JSON.stringify([code,report,profile])).digest('hex');return join(service.store.root,'projects',project,'experiment-bindings',key+'.json');}
function validateBindings(service:ExperimentService,project:string,report:CodeEnvironmentReport,input:ExperimentBindings){
 service.data.profile(project,input.profile_id);
 const names=report.content.schema_version===2?report.content.code_information?.datasets.map(item=>item.name)??[]:[];
 if(new Set(input.bindings.map(item=>item.dataset_name)).size!==input.bindings.length)experimentError('EXPERIMENT_BINDING_DUPLICATE',400);
 for(const binding of input.bindings){if(!names.includes(binding.dataset_name))experimentError('EXPERIMENT_BINDING_UNKNOWN',400);if(!service.data.datasets(project).some(item=>item.dataset_id===binding.dataset_id&&item.profile_id===input.profile_id&&(!item.transfer_status||item.transfer_status==='ready')))experimentError('DATASET_NOT_FOUND',404);}
}
export function loadExperimentBindings(service:ExperimentService,project:string,code:string,reportId:string,profile:string){reportFor(service,project,code,reportId);service.data.profile(project,profile);const path=bindingPath(service,project,code,reportId,profile);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;}
export function saveExperimentBindings(service:ExperimentService,project:string,code:string,value:unknown){
 const input=experimentBindingsSchema.parse(value),report=reportFor(service,project,code,input.report_id);validateBindings(service,project,report,input);
 const file=bindingPath(service,project,code,input.report_id,input.profile_id),directory=join(file,'..');mkdirSync(directory,{recursive:true});const saved={...input,code_fingerprint:report.code_fingerprint,saved_at:new Date().toISOString()};writeFileSync(file+'.tmp',JSON.stringify(saved),{mode:0o600});renameSync(file+'.tmp',file);return saved;
}
function resolve(service:ExperimentService,project:string,input:Input){
 const report=reportFor(service,project,input.code_id,input.report_id);validateBindings(service,project,report,input);
 const plan=report.content.schema_version===2?report.content.code_information?.run_plans[input.plan_index]:undefined;
 if(!plan?.execution)experimentError('EXPERIMENT_ANALYSIS_REQUIRED',409);
 const selected=input.bindings.filter(item=>item.enabled);if(!selected.length)experimentError('EXPERIMENT_DATASET_REQUIRED',400);
 if(new Set(selected.map(item=>item.dataset_id)).size!==selected.length)experimentError('EXPERIMENT_BINDING_DUPLICATE',400);
 return {report,plan,items:selected.map(binding=>{
  const recipe=plan.execution!.dataset_runs.find(item=>item.dataset_name===binding.dataset_name);
  if(!recipe||recipe.status!=='ready'||recipe.blockers.length||!recipe.steps.length||!recipe.evaluation_protocol.trim()||recipe.attribution==='unknown')experimentError('EXPERIMENT_RECIPE_BLOCKED',409);
  for(const step of [...recipe.steps,...(recipe.resume?.steps??[])]){
   // Never substitute paths into shell/eval strings. Existing repository scripts remain supported.
   const executable=posix.basename(step.argv[0]),python=/^python[0-9.]*$/.test(executable)||step.argv[0]==='{python}',shell=/^(bash|sh|dash|zsh)$/.test(executable);
   const flags:string[]=[];for(const value of step.argv.slice(1)){if(!value.startsWith('-'))break;flags.push(value);if(value==='-m')break;}
   if(step.attribution==='unknown'||executable==='eval'||(python&&flags.some(value=>!['-u','-B','-O','-OO','-I','-m'].includes(value)))||(shell&&flags.some(value=>!['-e','-u','-eu','-ue'].includes(value)))||(/^(pwsh|powershell)$/.test(executable))||(python&&step.argv[0].includes('/')&&step.argv[0]!=='{python}'))experimentError('EXPERIMENT_RECIPE_UNSAFE',409);
  }
  if(recipe.result.mode!=='none'&&(!recipe.result.path||(recipe.result.mode!=='json'&&!recipe.result.metrics.length)||recipe.result.attribution==='unknown'))experimentError('EXPERIMENT_COLLECTION_INCOMPLETE',409);
  if(recipe.result.root==='run'&&recipe.result.path==='outputs/trash-collected-metrics.json')experimentError('EXPERIMENT_COLLECTION_INCOMPLETE',409);
  if(recipe.result.metrics.some(metric=>recipe.result.mode==='log'&&!metric.label))experimentError('EXPERIMENT_COLLECTION_INCOMPLETE',409);
  if(new Set(recipe.result.metrics.map(metric=>metric.name+'\0'+metric.unit)).size!==recipe.result.metrics.length)experimentError('EXPERIMENT_COLLECTION_INCOMPLETE',409);
  const paths=recipe.mappings.map(mapping=>mapping.path);
  if(paths.some((path,index)=>paths.some((other,i)=>index!==i&&(other===path||other.startsWith(path+'/')))))experimentError('DATASET_MAPPING_INVALID',400);
  const dataset=service.data.datasets(project).find(item=>item.dataset_id===binding.dataset_id)!;
  if(dataset.verification_progress?.status==='running')experimentError('DATASET_BUSY',409);
  return {binding,recipe,dataset};
 })};
}
const CHECK=String.raw`import pathlib,sys,json
code=pathlib.Path(sys.argv[1]).resolve(); requests=json.loads(sys.argv[2]); results=[]
if not code.is_dir() or not (code/'.venv/bin/python').is_file(): raise RuntimeError('DEPLOYED_ENVIRONMENT_MISSING')
for request in requests:
 errors=[]; data=pathlib.Path(request['path']).resolve(); root=(data/request['subdir']).resolve()
 if not root.is_relative_to(data) or not root.exists(): errors.append('绑定的数据目录或子目录不存在')
 for name in request['required']:
  target=(root/name).resolve()
  if not target.is_relative_to(root) or not target.exists(): errors.append('缺少所需数据路径：'+name)
 for step in request['steps']:
  cwd=(code/step['working_directory']).resolve()
  if not cwd.is_relative_to(code) or not cwd.is_dir(): errors.append('工作目录不存在：'+step['working_directory'])
 for mapping in request['mappings']:
  target=(root/mapping['subpath']).resolve(); link=code/mapping['path']
  if not target.is_relative_to(root) or not target.exists(): errors.append('映射目标不存在：'+mapping['subpath'])
  if not link.parent.resolve().is_relative_to(code) or not link.parent.is_dir(): errors.append('映射父目录不存在：'+mapping['path'])
  elif (link.exists() or link.is_symlink()) and not (link.is_symlink() and link.resolve()==target): errors.append('映射位置已被占用：'+mapping['path'])
 results.append(dict(dataset_name=request['name'],path=str(root),errors=errors))
print(json.dumps(results,ensure_ascii=False))`;
export async function prepareAutomaticExperiment(service:ExperimentService,project:string,value:unknown){
 const input=automaticExperimentInputSchema.parse(value),resolved=resolve(service,project,input);
 if((await service.environmentAnalysis.freshness(project,input.code_id,input.report_id)).stale)experimentError('DEPLOYMENT_REPORT_STALE',409);
 const remote=service.terminals.connection(project,input.profile_id);
 const checks=JSON.parse(await remote.exec([posix.join(input.directory,'.venv/bin/python'),'-c',CHECK,input.directory,JSON.stringify(resolved.items.map(item=>({name:item.binding.dataset_name,path:item.dataset.path,subdir:item.recipe.dataset_subdirectory,required:item.recipe.required_paths,mappings:item.recipe.mappings,steps:item.recipe.steps})))],undefined,120000)) as {dataset_name:string;path:string;errors:string[]}[];
 return {input,...resolved,checks,ready:checks.every(item=>!item.errors.length)};
}
export async function createAutomaticExperiment(service:ExperimentService,project:string,value:unknown):Promise<Queue>{
 const prepared=await prepareAutomaticExperiment(service,project,value);if(!prepared.ready)experimentError('EXPERIMENT_DATASET_LAYOUT_INVALID',409);
 const {input,items}=prepared;
 const options=Object.fromEntries(items.map(({binding,recipe})=>[binding.dataset_id,{command:['python'],config:recipe.config,execution_resume:recipe.resume,execution_steps:recipe.steps,result_collection:recipe.result,dataset_subdirectory:recipe.dataset_subdirectory,required_dataset_paths:recipe.required_paths,data_mappings:recipe.mappings.map(mapping=>({...mapping,dataset_id:binding.dataset_id})),evaluation_protocol:recipe.evaluation_protocol,expected_metrics:recipe.result.metrics.map(metric=>({name:metric.name,unit:metric.unit}))}]));
 saveExperimentBindings(service,project,input.code_id,{report_id:input.report_id,profile_id:input.profile_id,bindings:input.bindings});
 const queue=await service.reproductionQueues.create(project,{code_id:input.code_id,report_id:input.report_id,profile_id:input.profile_id,directory:input.directory,python:posix.join(input.directory,'.venv/bin/python'),title:service.reproductions.get(project,input.code_id).name+' · '+prepared.plan.name,command:['python'],dataset_ids:items.map(item=>item.binding.dataset_id),dataset_options:options,gpu:input.gpu,timeout_seconds:input.timeout_seconds,metrics_path:'outputs/trash-collected-metrics.json',expected_metrics:[],evaluation_protocol:prepared.plan.scope,confirm:true});
 return queue;
}
