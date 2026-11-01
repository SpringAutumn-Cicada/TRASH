import React from "react";
import { Archive, Check, LoaderCircle, Upload, AlertCircle } from "lucide-react";

const steps=[{label:"准备代码",stages:["snapshot","preparing"]},{label:"上传文件",stages:["uploading"]},{label:"完整性校验",stages:["verifying"]},{label:"解压归档",stages:["extracting","saving","completed"]}];
const labels:Record<string,string>={snapshot:"正在生成代码快照",preparing:"正在准备远端目录",uploading:"正在上传代码包",verifying:"正在远端校验 SHA-256",extracting:"正在解压代码",saving:"正在保存快照清单",completed:"远端处理完成",failed:"上传失败",cancelling:"正在终止上传",cancelled:"上传已终止"};
export function UploadProgress({progress,warning,name}:{progress?:{stage:string;sent:number;total:number};warning:string;name:string}){
 const stage=progress?.stage??"snapshot",index=steps.findIndex(step=>step.stages.includes(stage));
 const total=progress?.total??0,sent=progress?.sent??0,percent=total>0?Math.min(100,Math.max(0,sent/total*100)):undefined;
 const bytes=(value:number)=>`${(value/1048576).toFixed(2)} MiB`;
 return <section className="code-upload-progress" aria-label="代码上传进度">
  <header><span className="code-upload-progress-icon"><Archive size={19}/></span><div><strong title={name}>{name}</strong><span role="status">{labels[stage]??"正在处理"}</span></div><span className="code-upload-progress-badge"><Upload size={12}/>文件传输</span></header>
  <ol className="code-upload-steps" aria-label="上传阶段">{steps.map((step,position)=>{const done=stage==="completed"||index>position,active=index===position&&!done;return <li key={step.label} className={done?"done":active?"active":""} aria-current={active?"step":undefined}><span>{done?<Check size={12}/>:active?<LoaderCircle size={12} className="spin"/>:position+1}</span>{step.label}</li>;})}</ol>
  <div className="code-upload-progress-metrics"><span>{percent===undefined?"等待文件传输":`${bytes(Math.min(sent,total))} / ${bytes(total)}`}</span><strong>{percent===undefined?"准备中":`${Math.floor(percent)}%`}</strong></div>
  <progress className="code-upload-progress-bar" max={100} value={percent} aria-label="代码包传输百分比"/>
  <footer className={warning?"has-warning":""}>{warning?<><AlertCircle size={13}/>{warning}</>:"进度条表示文件传输，校验和解压完成后会显示上传结果。"}</footer>
 </section>;
}
