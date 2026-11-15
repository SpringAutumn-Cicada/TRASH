import React from 'react';
import {Check,BookOpen,FileText,Send} from 'lucide-react';

export function TaskReadingProgress({total,completed,title,running,status,publishing=false,unit='pages'}:{unit?:string;total:number;completed:number;title?:string;running:boolean;status:string;publishing?:boolean}){
 if(!Number.isFinite(total)||total<=0)return null;
 const pages=Math.max(0,Math.min(total,Number.isFinite(completed)?completed:0));
 const pageMode=unit!=='blocks',unitLabel=pageMode?'页':'块';
 const percent=Math.floor(pages/total*100),count=Math.ceil(total/4),current=Math.min(count,Math.floor(pages/4)+1);
 const stage=status==='completed'?3:publishing?2:pages===total?1:0;
 const stages=[{label:'PDF 阅读',icon:BookOpen},{label:'Wiki 生成',icon:FileText},{label:'发布',icon:Send}];
 return <section className="task-reading-panel" aria-label="PDF阅读进度">
  <div className="task-reading-meter"><div className="task-reading-number"><strong>{percent}<small>%</small></strong><span>{pages} / {total} {unitLabel}</span></div><div className="task-reading-track">
   <div className="task-reading-caption"><strong>{title??'PDF 阅读进度'}</strong><span>{!pageMode?'历史阅读记录':pages===total?'阅读已完成':`${running?'当前阅读':'下一批'} ${((current-1)*4)+1}–${Math.min(current*4,total)} 页 · 批次 ${current}/${count}`}</span></div>
   <div className="task-batch-track" role="progressbar" aria-label={`PDF已完成阅读${unitLabel}数`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={pages} aria-valuetext={`已完成 ${pages}/${total} ${unitLabel}`}>
    {pageMode&&count<=24?Array.from({length:count},(_,i)=>{const first=i*4+1,last=Math.min((i+1)*4,total),done=pages>=last,working=running&&!done&&i===current-1;return <span key={first} className={`task-batch ${done?'done':working?'working':''}`} style={{flex:last-first+1}} title={`第 ${first}–${last} 页：${done?'已完成':working?'阅读中':'未完成'}`}><span>{done?<Check size={13}/>:working?<i/>:null}</span></span>;}):<span className="task-continuous-progress" style={{width:`${percent}%`}}/>}
   </div><div className="task-batch-labels" aria-hidden="true">{pageMode&&count<=12?Array.from({length:count},(_,i)=><span key={i} style={{flex:Math.min(4,total-i*4)}}>{i*4+1}–{Math.min((i+1)*4,total)}</span>):<><span>已完成 {pages} {unitLabel}</span><span>共 {total} {unitLabel}</span></>}</div>
  </div></div>
  <ol className="task-stage-track" aria-label="任务阶段">{stages.map(({label,icon:Icon},i)=><li key={label} className={i<stage?'done':i===stage?'current':''} aria-current={i===stage?'step':undefined}>{i<stage?<Check size={14}/>:<Icon size={14}/>}<span>{label}</span></li>)}</ol>
 </section>;
}
