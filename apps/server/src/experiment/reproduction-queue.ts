import { projectRuntime } from "../project-layout.js";
/* eslint-disable no-control-regex -- Explicitly reject control characters in paths and identifiers. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { experimentError } from '@trash/storage';
import { executionStepSchema, resultCollectionSchema, executionRelativePathSchema, executionResumeSchema, executionModeSchema, modelOutputSchema, executionResourceSchema, processingMethodSchema } from '@trash/protocol';
import type { ExperimentService } from './service.js';
const inputSchema=z.object({code_id:z.string(),report_id:z.string(),profile_id:z.string(),directory:z.string().startsWith('/').refine(value=>value!=='/'&&!value.split('/').includes('..')&&!/[\x00-\x1f]/.test(value)),python:z.string().startsWith('/'),title:z.string().min(1).max(500),command:z.array(z.string().min(1).max(4096)).min(1).max(100),dataset_ids:z.array(z.string()).min(1).max(50),mapping_path:z.string().max(1024).default(''),dataset_options:z.record(z.object({command:z.array(z.string().min(1).max(4096)).min(1).max(100).optional(),config:z.record(z.unknown()).optional(),processing_method:processingMethodSchema.optional(),resource_policy:executionResourceSchema.optional(),source_dataset_name:z.string().max(500).optional(),model_outputs:z.array(modelOutputSchema).max(20).optional(),execution_mode:executionModeSchema.optional(),model_input_kind:z.enum(['none','weights','checkpoint']).optional(),model_source:z.string().startsWith('/').optional(),execution_resume:executionResumeSchema.optional(),execution_steps:z.array(executionStepSchema).min(1).max(60).optional(),result_collection:resultCollectionSchema.optional(),dataset_subdirectory:executionRelativePathSchema.optional(),required_dataset_paths:z.array(executionRelativePathSchema).max(100).optional(),data_mappings:z.array(z.object({path:executionRelativePathSchema,subpath:executionRelativePathSchema,dataset_id:z.string()}).strict()).max(30).optional(),evaluation_protocol:z.string().optional(),expected_metrics:z.array(z.object({name:z.string(),unit:z.string()})).max(100).optional()}).strict()).default({}),gpu:z.string().default('0'),timeout_seconds:z.number().int().min(10).max(604800).default(7200),metrics_path:z.string().default('outputs/metrics.json'),expected_metrics:z.array(z.object({name:z.string(),unit:z.string()})).max(100),evaluation_protocol:z.string().min(1).max(20000),confirm:z.literal(true)}).strict();
export interface Queue {id:string;project_id:string;code_id:string;created_at:string;status:'running'|'paused'|'completed'|'cancelled';message:string;items:{plan_id:string;version:number;dataset:string;key:string;run_id?:string;skipped?:boolean}[]}
export class ReproductionQueueService{
 private creating=new Set<string>();private actions=new Set<string>();
 private timer:ReturnType<typeof setInterval>;private busy=false;private closed=false;
 constructor(private service:ExperimentService){for(const project of service.store.listProjects())for(const queue of this.list(project.project_id))if(queue.status==='running'){queue.status='paused';queue.message='服务重启，队列暂停；请先同步已有远端运行状态，再继续';this.save(queue);}this.timer=setInterval(()=>void this.tick().catch(()=>{}),3000);this.timer.unref();}
 close(){this.closed=true;clearInterval(this.timer);}
 private root(project:string){return projectRuntime(this.service.store.root,project,'reproduction-queues');}
 list(project:string):Queue[]{const root=this.root(project);return existsSync(root)?readdirSync(root).filter(name=>/^rq_[a-f0-9-]+\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(root,name),'utf8')) as Queue).sort((a,b)=>b.created_at.localeCompare(a.created_at)):[];}
 private save(queue:Queue){mkdirSync(this.root(queue.project_id),{recursive:true});const file=join(this.root(queue.project_id),queue.id+'.json');writeFileSync(file+'.tmp',JSON.stringify(queue),{mode:0o600});renameSync(file+'.tmp',file);}
 async create(project:string,value:unknown){const input=inputSchema.parse(value),s=this.service;if(this.creating.has(project))experimentError('REPRODUCTION_QUEUE_BUSY',409);this.creating.add(project);try{s.terminals.connection(project,input.profile_id);
  if(this.list(project).some(queue=>queue.status==='running'||queue.status==='paused'))experimentError('REPRODUCTION_QUEUE_BUSY',409);
  if(s.deployments.busyProject(project)||s.reproductions.busy(project))experimentError('REPRODUCTION_BUSY',409);
  const report=s.environmentAnalysis.report(project,input.code_id,input.report_id);if((await s.environmentAnalysis.freshness(project,input.code_id,report.id)).stale)experimentError('DEPLOYMENT_REPORT_STALE',409);
  if(input.python!==posix.join(input.directory,'.venv/bin/python'))experimentError('VENV_PATH_INVALID',400);
  if(input.command.some(value=>/[\x00]/.test(value)))experimentError('INVALID_REQUEST',400);
  const ids=[...new Set(input.dataset_ids)];const items:Queue['items']=[];
  s.store.db.transaction(()=>{for(const id of ids){const dataset=s.data.datasets(project).find(value=>value.dataset_id===id&&value.profile_id===input.profile_id)??experimentError('DATASET_NOT_FOUND',404);
   const option=input.dataset_options[id];
   const plan=s.createPlan(project,{title:input.title+' · '+dataset.name,method:s.reproductions.get(project,input.code_id).name,purpose:'文献复现串行实验',evaluation_protocol:option?.evaluation_protocol??input.evaluation_protocol,processing_method:option?.processing_method,resource_policy:option?.resource_policy,source_dataset_name:option?.source_dataset_name,model_outputs:option?.model_outputs,execution_mode:option?.execution_mode,model_input_kind:option?.model_input_kind,model_source:option?.model_source,execution_resume:option?.execution_resume,execution_steps:option?.execution_steps,result_collection:option?.result_collection,dataset_subdirectory:option?.dataset_subdirectory,required_dataset_paths:option?.required_dataset_paths,code_source:'reproduction',reproduction_id:input.code_id,snapshot_id:report.snapshot_id,report_id:report.id,deployed_directory:input.directory,profile_id:input.profile_id,dataset_ids:[id],python:input.python,command:input.dataset_options[id]?.command??input.command,data_mappings:option?.data_mappings??(input.mapping_path?[{path:input.mapping_path,dataset_id:id}]:[]),env:{},config:option?.execution_steps?(option.config??{}):{...option?.config,analysis_report_id:report.id},gpu:input.gpu,timeout_seconds:input.timeout_seconds,metrics_path:input.metrics_path,expected_metrics:option?.expected_metrics??input.expected_metrics,artifact_paths:[...new Set([...(option?.model_outputs??[]).map(model=>model.path),...(option?.execution_resume?[option.execution_resume.checkpoint_path]:[])])]});
   items.push({plan_id:plan.plan_id,version:plan.version,dataset:dataset.name,key:randomUUID()});
  }})();
  const queue:Queue={id:'rq_'+randomUUID(),project_id:project,code_id:input.code_id,created_at:new Date().toISOString(),status:'running',message:'等待依次检查并运行',items};this.save(queue);void this.tick().catch(()=>{});return queue;}finally{this.creating.delete(project);}
 }
 async action(project:string,id:string,action:'resume'|'resume-checkpoint'|'skip'|'cancel'){
  if(this.actions.has(id)&&action!=='cancel')experimentError('EXPERIMENT_BUSY',409);
  const locked=action!=='cancel';if(locked)this.actions.add(id);try{
  if(this.busy&&action!=='cancel')experimentError('EXPERIMENT_BUSY',409);
  const queue=this.list(project).find(value=>value.id===id)??experimentError('NOT_FOUND',404);if(queue.status==='completed'||queue.status==='cancelled')experimentError('EXPERIMENT_FINISHED',409);
  const item=queue.items.find(value=>!value.skipped&&(!value.run_id||!this.done(project,value.run_id)));
  if(action==='cancel'){queue.status='cancelled';queue.message='队列已终止';this.save(queue);if(item?.run_id&&this.service.data.active(this.service.data.run(project,item.run_id)))await this.service.cancel(project,item.run_id);return queue;}
  if(queue.status!=='paused')experimentError('EXPERIMENT_ACTIVE',409);
  if(item?.run_id&&this.service.data.active(this.service.data.run(project,item.run_id)))experimentError('EXPERIMENT_ACTIVE',409);
  if(action==='skip'&&item)item.skipped=true;
  if(action==='resume-checkpoint'&&item?.run_id){
   const old=this.service.data.run(project,item.run_id),resume=old.plan.content.execution_resume;
   if(!resume||resume.attribution==='unknown')experimentError('EXPERIMENT_CHECKPOINT_UNAVAILABLE',409);
   const checkpoint=posix.join(old.remote_dir,resume.checkpoint_path);
   const remote=this.service.terminals.connection(project,old.profile_id);
   await remote.exec([old.plan.content.python,'-c',"import pathlib,sys; r=pathlib.Path(sys.argv[1]).resolve(); p=pathlib.Path(sys.argv[2]).resolve(); assert p.is_relative_to(r) and p.is_file(),'CHECKPOINT_NOT_FOUND'",old.remote_dir,checkpoint]);
   // Re-check cancellation after the asynchronous checkpoint probe.
   const current=this.list(project).find(value=>value.id===id);if(current?.status!=='paused')experimentError('EXPERIMENT_FINISHED',409);
   const plan=this.service.createPlan(project,{...old.plan.content,execution_mode:'resume',model_input_kind:'checkpoint',model_source:checkpoint,execution_steps:resume.steps,checkpoint_source:checkpoint,config:{...old.plan.content.config,resumed_from_run:old.run_id}});
   item.plan_id=plan.plan_id;item.version=plan.version;item.run_id=undefined;item.key=randomUUID();
  }else if(action==='resume-checkpoint')experimentError('EXPERIMENT_CHECKPOINT_UNAVAILABLE',409);
  if(action==='resume'&&item?.run_id){item.run_id=undefined;item.key=randomUUID();}
  queue.status='running';queue.message=action==='skip'?'已跳过当前项':action==='resume-checkpoint'?'准备从源码支持的 checkpoint 继续':'准备从头重新尝试当前项';this.save(queue);void this.tick().catch(()=>{});return queue;}finally{if(locked)this.actions.delete(id);}
 }
 private done(project:string,id:string){const run=this.service.data.run(project,id);return run.status==='completed'&&(Boolean(run.result_id)||run.plan.content.result_collection?.mode==='none');}
 private async tick(){if(this.closed||this.busy)return;this.busy=true;try{for(const project of this.service.store.listProjects())for(const queue of this.list(project.project_id).filter(value=>value.status==='running')){if(this.closed)return;try{
  const item=queue.items.find(value=>!value.skipped&&(!value.run_id||!this.done(queue.project_id,value.run_id)));
  if(!item){queue.status='completed';queue.message='队列结束；指标完整性以各运行收集结果为准';this.save(queue);continue;}
  if(item.run_id){const run=this.service.data.run(queue.project_id,item.run_id);if(['failed','cancelled','disconnected','unknown_remote_state','completed'].includes(run.status)){queue.status='paused';queue.message='当前实验失败、取消、缺少有效指标或状态未确认，队列已暂停，请先查看日志并确认远端状态';this.save(queue);}continue;}
  const recovered=this.service.data.runs(queue.project_id).find(run=>run.idempotency_key===item.key);
  if(recovered){item.run_id=recovered.run_id;this.save(queue);continue;}
  const plan=this.service.data.plan(queue.project_id,item.plan_id,item.version);
  // Other aliases of the same physical host must also finish before this queue advances.
  if(this.service.data.runs().some(run=>this.service.data.active(run)&&run.plan.profile.host.toLowerCase()===plan.profile.host.toLowerCase()&&run.plan.profile.port===plan.profile.port))continue;
  if(this.service.deployments.busyProject(queue.project_id))continue;
  await this.service.confirmPlan(queue.project_id,plan.plan_id,plan.version);if(this.closed)return;
  const current=this.list(queue.project_id).find(value=>value.id===queue.id);if(current?.status!=='running')continue;
  const run=this.service.submit(queue.project_id,{plan_id:plan.plan_id,version:plan.version,idempotency_key:item.key,preparation:false});item.run_id=run.run_id;queue.message='正在运行 '+item.dataset;this.save(queue);
 }catch(error){if(this.list(queue.project_id).find(value=>value.id===queue.id)?.status!=='running')continue;queue.status='paused';queue.message=error instanceof Error?error.message:'队列执行失败';this.save(queue);}}}finally{this.busy=false;}}
}
