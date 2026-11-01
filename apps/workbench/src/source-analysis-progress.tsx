import React, { useEffect, useState } from 'react';
import { Check, FileSearch, LoaderCircle } from 'lucide-react';
import type { EnvironmentAnalysisTask } from '@trash/protocol';
const stages=[{id:'snapshot',name:'固定快照'},{id:'collecting',name:'采集文件'},{id:'analyzing',name:'Agent 分析'},{id:'validating',name:'校验依据'},{id:'saving',name:'保存报告'}];
export function SourceAnalysisProgress({task}:{task:EnvironmentAnalysisTask}){
 const running=task.status==='preparing'||task.status==='analyzing';
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{setNow(Date.now());if(!running)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[task.id,running]);
 const stage=task.stage??(task.status==='analyzing'?'analyzing':'snapshot');
 const completed=task.status==='completed'?5:Math.max(0,stages.findIndex(item=>item.id===stage));
 const seconds=Math.max(0,Math.floor(((task.finished_at?Date.parse(task.finished_at):now)-Date.parse(task.resumed_at??task.created_at))/1000));
 const elapsed=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
 const message=task.status==='completed'?'报告已生成，尚未运行实验验证':task.status==='cancelled'?'分析已停止，已保存的阶段和历史报告保留':task.status==='failed'?'分析失败，停留在以下阶段':task.status==='interrupted'?'分析已中断，可点击继续分析':task.stage_message??'正在处理源代码分析任务';
 return <div className={`source-analysis-progress ${running?'is-running':''}`}><header><span className="source-analysis-progress-icon">{task.status==='completed'?<Check size={21}/>:<FileSearch size={21}/>}</span><div><strong>{running?'正在分析源代码':task.status==='completed'?'分析完成':'分析已停止'}</strong><small>{task.resumed_at?'本次继续耗时':running?'已耗时':'耗时'} {elapsed}</small></div><b>{completed} / 5</b></header><ol>{stages.map((item,index)=><li key={item.id} className={index<completed?'done':index===completed&&running?'active':''}><span>{index<completed?<Check size={12}/>:index===completed&&running?<LoaderCircle size={13} className="spin"/>:index+1}</span>{item.name}</li>)}</ol><div className="source-analysis-progress-track" role="progressbar" aria-label="已完成分析阶段" aria-valuemin={0} aria-valuemax={5} aria-valuenow={completed} aria-valuetext={`${completed}/5 阶段；${message}`}><span style={{width:`${completed/5*100}%`}}/></div><p role="status">{message}</p>{task.selected_files!==undefined&&<small>本次选取 {task.selected_files} 个文本文件 · {((task.selected_bytes??0)/1024).toFixed(1)} KiB</small>}<small>按真实阶段推进，非 Agent 内部完成百分比；分析阶段耗时取决于代码量与模型响应。</small></div>;
}
