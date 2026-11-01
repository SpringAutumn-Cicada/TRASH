import React, { useEffect, useState } from 'react';
import type { DatasetRef } from '@trash/protocol';
import { DatasetTransferProgress } from './dataset-transfer-progress.js';
import { workspaceErrors } from './remote-workspace.js';
export interface BackgroundUpload {id:string;projectId:string;name:string;fileName:string;sent:number;total:number;status:'uploading'|'completed'|'failed';error?:string;dataset?:DatasetRef;xhr:XMLHttpRequest}
const uploads=new Map<string,BackgroundUpload>(),listeners=new Set<()=>void>();
const announce=()=>{for(const listener of listeners)listener();};
export const datasetUploadTasks=()=>[...uploads.values()];
export function subscribeDatasetUploads(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function startDatasetUpload(projectId:string,profile:string,name:string,file:File,extract:boolean){
 if(datasetUploadTasks().some(task=>task.projectId===projectId&&task.status==='uploading'))throw new Error('本项目已有后台数据上传');
 const id=crypto.randomUUID(),xhr=new XMLHttpRequest(),task:BackgroundUpload={id,projectId,name,fileName:file.name,sent:0,total:file.size,status:'uploading',xhr};uploads.set(id,task);
 xhr.open('POST',`/api/v1/projects/${encodeURIComponent(projectId)}/datasets/upload?${new URLSearchParams({profile_id:profile,name,filename:file.name,extract:String(extract&&file.name.toLowerCase().endsWith('.zip')),request_id:id})}`);xhr.setRequestHeader('content-type','application/octet-stream');
 xhr.upload.onprogress=event=>{if(event.lengthComputable){task.sent=event.loaded;task.total=event.total;announce();}};
 xhr.onload=()=>{try{const result=JSON.parse(xhr.responseText);if(xhr.status>=200&&xhr.status<300){task.status='completed';task.dataset=result.dataset;}else{task.status='failed';task.error=workspaceErrors[result.error]??`上传失败（${result.error??xhr.status}）`;}}catch{task.status='failed';task.error='无法解析上传响应，请检查数据集实际状态';}announce();};
 xhr.onerror=()=>{task.status='failed';task.error='网络中断，请检查数据集实际状态';announce();};xhr.onabort=()=>{task.status='failed';task.error='上传连接已终止，请检查数据集状态';announce();};xhr.send(file);announce();return id;
}
export function BackgroundDatasetTransfers(){
 const [tasks,setTasks]=useState(datasetUploadTasks),[expanded,setExpanded]=useState(true),[remote,setRemote]=useState<Record<string,DatasetRef>>({}),[error,setError]=useState('');
 useEffect(()=>subscribeDatasetUploads(()=>setTasks(datasetUploadTasks().map(task=>({...task})))),[]);
 useEffect(()=>{const active=tasks.filter(task=>task.status==='uploading');if(!active.length)return;let stopped=false,pending=false;
  const load=async()=>{if(pending)return;pending=true;try{const projects=[...new Set(active.map(task=>task.projectId))];const results=await Promise.allSettled(projects.map(async project=>{const response=await fetch(`/api/v1/projects/${encodeURIComponent(project)}/datasets`,{cache:'no-store'});if(!response.ok)throw new Error('读取后台进度失败');const value=await response.json();return value.datasets as DatasetRef[];}));if(!stopped)setRemote(old=>{const next={...old};for(const result of results)if(result.status==='fulfilled')for(const dataset of result.value)if(dataset.transfer_request_id)next[dataset.transfer_request_id]=dataset;return next;});}finally{pending=false;}};
  void load();const timer=setInterval(()=>void load(),1500);return()=>{stopped=true;clearInterval(timer);};
 },[tasks.map(task=>task.id+task.status).join('|')]);
 useEffect(()=>{const leave=(event:BeforeUnloadEvent)=>{if(datasetUploadTasks().some(task=>task.status==='uploading')){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[]);
 if(!tasks.length)return null;
 const active=tasks.filter(task=>task.status==='uploading');
 const cancel=async(task:BackgroundUpload)=>{const dataset=remote[task.id];try{const response=await fetch(`/api/v1/projects/${encodeURIComponent(task.projectId)}/datasets/${dataset?dataset.dataset_id+'/cancel-upload':'cancel-upload-request/'+task.id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true})});if(!response.ok){const value=await response.json();if(value.error==='DATASET_NOT_UPLOADING'&&!dataset){task.xhr.abort();return;}throw new Error(workspaceErrors[value.error]??'无法终止上传');}setError('');}catch(cause){setError(cause instanceof Error?cause.message:'无法终止上传');}};
 return <aside className="background-dataset-transfers" aria-label="后台数据传输"><header><strong>数据传输 · {active.length?`${active.length} 项进行中`:'已结束'}</strong><button type="button" className="text-button" onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':'展开'}</button>{!active.length&&<button type="button" className="text-button" onClick={()=>{uploads.clear();announce();}}>关闭</button>}</header>{expanded&&<div className="background-dataset-transfer-list">{error&&<p role="alert">{error}</p>}{tasks.map(task=>{const dataset=remote[task.id],stage=dataset?.transfer_stage??'receiving';return task.status==='uploading'?<DatasetTransferProgress key={task.id} stage={stage} sent={stage==='receiving'?task.sent:dataset?.transfer_sent??0} total={stage==='receiving'?task.total:dataset?.transfer_total??0} name={task.fileName} onCancel={()=>void cancel(task)}/>:<div className="background-dataset-finished" key={task.id}><strong>{task.fileName}</strong><p role="status">{task.status==='completed'?'上传完成，数据集已保存':task.error}</p><button type="button" className="text-button" onClick={()=>{uploads.delete(task.id);announce();}}>关闭此记录</button></div>;})}<small>应用内切页不影响上传；请勿刷新或关闭浏览器，接收文件阶段仍依赖当前网页连接。</small></div>}</aside>;
}
