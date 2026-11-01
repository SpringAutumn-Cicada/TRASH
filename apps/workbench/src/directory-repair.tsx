import React, { useEffect, useRef, useState } from 'react';
import { Wrench, LoaderCircle, Square, Play, CheckCircle2 } from 'lucide-react';
import type { CodeEnvironmentReport, EnvironmentAnalysisTask } from '@trash/protocol';
import { SourceAnalysisProgress } from './source-analysis-progress.js';
import { ErrorNotice } from './error-notice.js';
import { environmentErrors } from './environment-panel.js';
import { readPreference, writePreference } from './navigation.js';
interface Repair {id:string;input:{code_id:string};status:'analyzing'|'checking'|'completed'|'blocked'|'cancelled';message:string;changes:string[];task?:EnvironmentAnalysisTask;report?:CodeEnvironmentReport;plan_index?:number;checks?:{dataset_name:string;path:string;errors:string[]}[];error?:string}
export function DirectoryRepairPanel({projectId,codeId,payload,available,disabled,onReady,onActive}:{projectId:string;codeId:string;payload:()=>unknown;available:boolean;disabled:boolean;onReady:(report:CodeEnvironmentReport,index:number,checks:NonNullable<Repair['checks']>)=>void;onActive:(value:boolean)=>void}){
 const key=`trash-directory-repair:${projectId}:${codeId}`,base=`/api/v1/projects/${encodeURIComponent(projectId)}/directory-repairs`;
 const [id,setId]=useState(()=>readPreference(key)??''),[repair,setRepair]=useState<Repair>(),[working,setWorking]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const callbacks=useRef({onReady,onActive});callbacks.current={onReady,onActive};const applied=useRef('');
 const active=Boolean(repair&&['analyzing','checking'].includes(repair.status));
 useEffect(()=>{callbacks.current.onActive(active||working);return()=>callbacks.current.onActive(false);},[active,working]);
 const call=async(path:string,body?:unknown,signal?:AbortSignal)=>{const response=await fetch(base+path,{signal,method:body===undefined?'GET':'POST',cache:'no-store',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(environmentErrors[data.error]??({EXPERIMENT_ACTIVE:'存在未结束的实验、队列或任务，请先处理。',DIRECTORY_CHECK_PASSED:'目录已经通过检查，无需 Agent 修复。',DIRECTORY_ANALYSIS_PENDING:'Agent 分析尚未完成，请稍后继续。'} as Record<string,string>)[data.error]??`目录修复失败（${data.error??response.status}）`);return data.repair as Repair;};
 useEffect(()=>{if(!id)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{try{let value=await call('/'+id,undefined,controller.signal);if(controller.signal.aborted)return;
   if(value.status==='analyzing'&&value.task?.status==='completed')value=await call('/'+id+'/apply',{confirm:true},controller.signal);
   if(controller.signal.aborted)return;setRepair(value);setError('');
   if(value.status==='completed'&&value.report&&value.plan_index!==undefined&&applied.current!==value.id){applied.current=value.id;callbacks.current.onReady(value.report,value.plan_index,value.checks??[]);}
   if(['analyzing','checking'].includes(value.status))timer=setTimeout(()=>void poll(),1500);
  }catch(cause){if(!controller.signal.aborted){setError(cause instanceof Error?cause.message:'读取目录修复状态失败');timer=setTimeout(()=>void poll(),4000);}}};
  void poll();return()=>{controller.abort();clearTimeout(timer);};
 },[base,id,reload]);
 const operate=async(action:'start'|'cancel'|'resume')=>{if(working)return;setWorking(true);setError('');try{const value=await call(action==='start'?'':`/${id}/${action}`,action==='start'?payload():{confirm:true});setId(value.id);writePreference(key,value.id);setRepair(value);setReload(n=>n+1);}catch(cause){setError(cause instanceof Error?cause.message:'目录修复失败');}finally{setWorking(false);}};
 return <section className="directory-repair-panel"><div className="knowledge-toolbar"><button type="button" className="secondary-button" disabled={working||active||disabled||!available} onClick={()=>void operate('start')}><Wrench size={15}/>分析并修复目录问题</button>{active&&<button type="button" className="secondary-button" disabled={working} onClick={()=>void operate('cancel')}><Square size={14}/>取消修复</button>}{repair&&['blocked','cancelled'].includes(repair.status)&&<button type="button" className="secondary-button" disabled={working||disabled} onClick={()=>void operate('resume')}><Play size={14}/>继续修复</button>}</div><small>检查失败后调用 Agent 分析源码和真实目录，修正有依据的运行方案，必要时补传本地默认权重，再重新检查。不会删除公共数据、覆盖已有权重或执行训练。</small>
 {error&&<ErrorNotice>{error}</ErrorNotice>}{repair&&<article className={repair.status==='completed'?'auto-run-check':'auto-run-warning'} role="status"><strong>{active?<LoaderCircle size={16} className="spin"/>:repair.status==='completed'?<CheckCircle2 size={16}/>:<Wrench size={16}/>} {repair.message}</strong><p>{repair.error?environmentErrors[repair.error]??repair.error:''}</p>{repair.task&&<SourceAnalysisProgress task={repair.task}/>}<ol className="directory-repair-stages"><li>目录检查</li><li>Agent 分析及方案修正</li><li>核对／补传权重</li><li>运行目录复查</li></ol>{repair.changes.map((change,index)=><p key={index}>{change}</p>)}{repair.checks?.map(check=><div key={check.dataset_name}><strong>{check.dataset_name}</strong><code>{check.path}</code>{check.errors.map((message,index)=><p key={index}>{message}</p>)}</div>)}{repair.report&&<details><summary>查看 Agent 分析报告与下一步</summary><pre>{JSON.stringify(repair.report.content,null,2)}</pre></details>}</article>}
 </section>;
}
