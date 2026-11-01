import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import type { CodeEnvironmentReport, EnvironmentAnalysisTask } from '@trash/protocol';
import { experimentError } from '@trash/storage';
import type { ExperimentService } from './service.js';
import { automaticExperimentInputSchema, prepareAutomaticExperiment, saveExperimentBindings } from './automatic-experiment.js';
export interface DirectoryRepair {id:string;input:z.infer<typeof automaticExperimentInputSchema>;status:'analyzing'|'checking'|'completed'|'blocked'|'cancelled';message:string;changes:string[];task?:EnvironmentAnalysisTask;report?:CodeEnvironmentReport;plan_index?:number;checks?:{dataset_name:string;path:string;errors:string[]}[];error?:string}
const active=new Map<string,AbortController>();
const file=(s:ExperimentService,p:string,id:string)=>{if(!/^env_[a-f0-9-]+$/.test(id))experimentError('ENVIRONMENT_TASK_NOT_FOUND',404);return join(s.store.root,'projects',p,'directory-repairs',id+'.json');};
function save(s:ExperimentService,p:string,value:DirectoryRepair){const path=file(s,p,value.id);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path);}
export function directoryRepair(s:ExperimentService,p:string,id:string):DirectoryRepair {
 const path=file(s,p,id);if(!existsSync(path))experimentError('ENVIRONMENT_TASK_NOT_FOUND',404);const value=JSON.parse(readFileSync(path,'utf8')) as DirectoryRepair;
 value.task=s.environmentAnalysis.tasks(p,value.input.code_id).find(t=>t.id===id);
 if(value.status==='analyzing'&&value.task&&['failed','cancelled','interrupted'].includes(value.task.status)){value.status=value.task.status==='cancelled'?'cancelled':'blocked';value.message='Agent 分析未完成，可继续恢复。';value.error=value.task.error;save(s,p,value);}
 if(value.status==='checking'&&!active.has(path)){value.status='blocked';value.message='服务已重启，修复复查中断，可点击继续。';save(s,p,value);}
 return value;
}
export async function startDirectoryRepair(s:ExperimentService,p:string,value:unknown):Promise<DirectoryRepair>{
 if(s.deployments.busyProject(p)||[...active.keys()].some(path=>path.startsWith(join(s.store.root,'projects',p,'directory-repairs')+sep))||s.data.runs(p).some(run=>s.data.active(run))||s.reproductionQueues.list(p).some(queue=>['running','paused'].includes(queue.status)))experimentError('EXPERIMENT_ACTIVE',409);
 const checked=await prepareAutomaticExperiment(s,p,value);
 if(checked.ready)experimentError('DIRECTORY_CHECK_PASSED',409);
 const input=checked.input;
 const task=s.environmentAnalysis.start(p,input.code_id,{input,checks:checked.checks,previous_report:checked.report,selected_plan:checked.plan,notes:'目录列表限深两层、最多500项，元数据限64KiB，目录不存在或文件不完整不得推断已就绪。只生成报告修正，不修改源码。'});
 const repair:DirectoryRepair={id:task.id,input,status:'analyzing',message:'Agent 正在核对源码、目录布局及预处理方案',changes:[],task};save(s,p,repair);return repair;
}
const modelSetup=String.raw`import pathlib,sys,json
root=pathlib.Path(sys.argv[1]).resolve();path=pathlib.Path(sys.argv[2]);assert root.is_dir() and path.parent.resolve().is_relative_to(root)
assert not path.is_symlink()
if path.exists(): print('exists')
else:
 path.parent.mkdir(parents=True,exist_ok=True);print('missing')`;
async function finish(s:ExperimentService,p:string,repair:DirectoryRepair,signal:AbortSignal):Promise<void>{
 const checkStopped=()=>{if(signal.aborted)throw new Error('修复已取消');};
 const report=s.environmentAnalysis.report(p,repair.input.code_id,repair.id);
 repair.report=report;save(s,p,repair);
 if(report.content.schema_version!==2||report.content.adaptation?.status!=='ready')throw new Error(report.content.schema_version===2?report.content.adaptation?.blockers.join('；')||'新报告需要源码适配或人工处理，请查看分析报告后同步代码。':'新报告不支持自动修复');
 const previous=s.environmentAnalysis.report(p,repair.input.code_id,repair.input.report_id);
 const oldPlan=previous.content.schema_version===2?previous.content.code_information?.run_plans[repair.input.plan_index]:undefined;
 const plans=report.content.schema_version===2?report.content.code_information?.run_plans??[]:[];
 const matches=plans.map((plan,index)=>({plan,index})).filter(({plan})=>plan.execution?.mode===oldPlan?.execution?.mode&&plan.execution?.processing_method===oldPlan?.execution?.processing_method);
 const selected=matches.find(item=>item.plan.name===oldPlan?.name)??(matches.length===1?matches[0]:undefined);
 if(!selected)throw new Error('新报告没有唯一匹配的处理方式与权重模式，请在报告中核对方案。');
 if((await s.environmentAnalysis.freshness(p,repair.input.code_id,report.id)).stale)throw new Error('源码已变化，请重新分析；本次不自动覆盖远端源码。');
 const remote=s.terminals.connection(p,repair.input.profile_id);
 repair.message='正在核对远端源码与修复报告的 SHA-256';save(s,p,repair);
 const sourceFiles=s.reproductions.snapshotInfo(p,report.snapshot_id).files;
 const sourceCheck=await remote.exec([posix.join(repair.input.directory,'.venv/bin/python'),'-c',String.raw`import pathlib,sys,json,hashlib
root=pathlib.Path(sys.argv[1]).resolve();bad=[]
for entry in json.loads(sys.argv[2]):
 path=(root/entry['path']).resolve()
 if not path.is_relative_to(root) or not path.is_file(): bad.append(entry['path']);continue
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1048576),b''):h.update(block)
 if h.hexdigest()!=entry['sha256']:bad.append(entry['path'])
print(json.dumps(bad))`,repair.input.directory,JSON.stringify(sourceFiles)],undefined,300000);
 if((JSON.parse(sourceCheck) as string[]).length)throw new Error('远端源码与报告不一致，请在源代码模块同步上传后重新检查；本次不覆盖远端代码。');
 const root=realpathSync(s.reproductions.get(p,repair.input.code_id).path);
 for(const binding of repair.input.bindings.filter(item=>item.enabled)){
  checkStopped();const recipe=selected.plan.execution!.dataset_runs.find(item=>item.dataset_name===binding.dataset_name);
  if(!recipe||recipe.status!=='ready'||recipe.blockers.length)throw new Error(recipe?.blockers.join('；')||'方案仍有阻塞，请查看新报告。');
  const model=recipe.model_input;
  if(model?.kind!=='weights'||!model.default_path||posix.isAbsolute(model.default_path))continue;
  const local=resolve(root,model.default_path),destination=posix.join(repair.input.directory,model.default_path);
  if(!existsSync(local))continue;
  const rel=relative(root,realpathSync(local));
  if(rel.split(sep).some(part=>['.git','.agents','.codex','.claude'].includes(part))||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||!statSync(local).isFile()||statSync(local).size>2*1024**3||! /\.(pt|pth|bin|ckpt|safetensors|pkl|pickle)$/i.test(local))throw new Error('本地默认权重不满足安全补传条件，请人工核对。');
  const state=await remote.exec([posix.join(repair.input.directory,'.venv/bin/python'),'-c',modelSetup,repair.input.directory,destination]);checkStopped();
  if(state.trim()==='exists'){const localHash=createHash('sha256');for await(const chunk of createReadStream(local,{signal}))localHash.update(chunk);const actual=await remote.exec(['sha256sum','--',destination]);if(actual.trim().split(/\s+/)[0]!==localHash.digest('hex'))throw new Error('远端默认权重与本地 SHA-256 不一致，已保留原文件，请人工核对。');continue;}
  repair.message='正在补传默认权重：'+model.default_path;save(s,p,repair);
  const sftp=await remote.sftp();let owned=false;const hash=createHash('sha256');
  try{
   const target=sftp.createWriteStream(destination,{flags:'wx',mode:0o600});target.once('open',()=>{owned=true;});
   await pipeline(createReadStream(local),new Transform({transform(chunk:Buffer,_encoding,callback){hash.update(chunk);callback(null,chunk);}}),target,{signal});
   const expected=hash.digest('hex');checkStopped();
   const actual=await remote.exec(['sha256sum','--',destination]);if(actual.trim().split(/\s+/)[0]!==expected)throw new Error('补传权重 SHA-256 不一致');
   repair.changes.push('已补传并校验默认权重：'+model.default_path+' · SHA-256 '+expected);save(s,p,repair);
  }catch(error){if(owned)await new Promise<void>(resolve=>sftp.unlink(destination,()=>resolve()));throw error;}finally{sftp.end();}
 }
 checkStopped();repair.message='修复完成，正在重新检查运行目录';save(s,p,repair);
 const input={...repair.input,report_id:report.id,plan_index:selected.index};
 const result=await prepareAutomaticExperiment(s,p,input);checkStopped();
 repair.report=report;repair.plan_index=selected.index;repair.checks=result.checks;
 repair.status=result.ready?'completed':'blocked';repair.message=result.ready?'已修正运行方案并通过目录复查；未执行实验。':'已完成分析，目录仍有阻塞，请查看复查结果及报告。';
 repair.changes.unshift('已生成包含目录诊断依据的新分析报告，原报告保留。');
 if(result.ready)saveExperimentBindings(s,p,input.code_id,{report_id:report.id,profile_id:input.profile_id,bindings:input.bindings});
}
export function applyDirectoryRepair(s:ExperimentService,p:string,id:string):DirectoryRepair {
 const repair=directoryRepair(s,p,id),key=file(s,p,id);if(active.has(key)||repair.status==='completed')return repair;
 if(repair.task?.status!=='completed')experimentError('DIRECTORY_ANALYSIS_PENDING',409);
 if(s.environmentAnalysis.busy(p)||s.deployments.busyProject(p)||s.reproductionQueues.list(p).some(queue=>['running','paused'].includes(queue.status))||s.data.runs(p).some(run=>s.data.active(run))||[...active.keys()].some(path=>path.startsWith(join(s.store.root,'projects',p,'directory-repairs')+sep)))experimentError('EXPERIMENT_ACTIVE',409);
 const controller=new AbortController();active.set(key,controller);repair.status='checking';repair.message='正在应用有依据的方案修复并检查缺失权重';repair.error=undefined;save(s,p,repair);
 void finish(s,p,repair,controller.signal).catch(error=>{repair.status=controller.signal.aborted?'cancelled':'blocked';repair.error=error instanceof Error?error.message:'目录修复失败';repair.message='未宣称运行就绪，请查看剩余问题。';}).finally(()=>{try{save(s,p,repair);}finally{active.delete(key);}}).catch(()=>{});return repair;
}
export function stopDirectoryRepair(s:ExperimentService,p:string,id:string):DirectoryRepair {
 const repair=directoryRepair(s,p,id);active.get(file(s,p,id))?.abort();
 if(repair.task&&['preparing','analyzing'].includes(repair.task.status))s.environmentAnalysis.cancel(p,repair.input.code_id,id);
 repair.status='cancelled';repair.message='修复已取消，已完成的文件与分析记录保留。';save(s,p,repair);return repair;
}
export async function resumeDirectoryRepair(s:ExperimentService,p:string,id:string):Promise<DirectoryRepair> {
 const repair=directoryRepair(s,p,id);if(repair.task&&['cancelled','failed','interrupted'].includes(repair.task.status)){repair.task=s.environmentAnalysis.resume(p,repair.input.code_id,id);repair.status='analyzing';repair.error=undefined;repair.message='正在恢复 Agent 分析';save(s,p,repair);return repair;}
 if(repair.task?.status==='completed'&&repair.status==='blocked'&&repair.report)return startDirectoryRepair(s,p,repair.input);
 return applyDirectoryRepair(s,p,id);
}
