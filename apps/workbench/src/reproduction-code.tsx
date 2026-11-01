import { ReproductionExperiments } from "./reproduction-experiments.js";
import { SourceAnalysis } from "./source-analysis.js";
import { CodeInformation } from "./code-information.js";
import { remoteDirectoryLabel, workspaceErrors } from "./remote-workspace.js";
import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { EnvironmentPanel, environmentErrors } from "./environment-panel.js";
import { UploadProgress } from "./upload-progress.js";
import { RemoteDirectoryPicker } from "./remote-directory-picker.js";
import { copyText } from "./clipboard.js";
import { ModalLayer } from "./modal-layer.js";
import { FileSearch, Cpu, Search, ChevronDown, X, Archive, FileUp, FolderOpen, Pencil, Plus, Trash2, Upload, Play, LoaderCircle, CheckCircle2 } from "lucide-react";
import type { ReproductionCode, ReproductionSnapshot, SshProfile, RemoteWorkspace } from "@trash/protocol";
import { RepositoryBrowser } from "./repository-browser.js";
import { readPreference, writePreference, useUnsavedChanges } from "./navigation.js";
const messages:Record<string,string>={ENVIRONMENT_SOURCE_NOT_READY:"请先完成本地分析与适配；代码变化后需要重新分析，报告必须与上传代码一致。",...environmentErrors,...workspaceErrors,REPRODUCTION_REMOTE_TARGET_EXISTS:"远端已存在同名 ZIP 或代码目录，请选择其他父目录，或先自行处理原文件后再上传。",REPRODUCTION_RESERVED_FILE:"代码含平台保留的 .trash-snapshot.json 文件，请先改名。",UPLOAD_CANCELLED:"上传已终止；本次创建的远端目录已清理（未创建目录时无需清理）。",UPLOAD_CANCEL_CLEANUP_FAILED:"上传已终止，但远端目录清理失败，请手动检查残留目录。",UPLOAD_NOT_RUNNING:"上传任务尚未就绪或已经结束，请稍后重试或查看结果。",UPLOAD_FINALIZING:"文件已传完，正在校验或归档，已无法终止文件传输，请等待处理结果。",SSH_NOT_CONNECTED:"所选主机尚未连接或连接已断开，请先点击连接。",
 REPRODUCTION_UNZIP_UNAVAILABLE:"远端未找到可用的 unzip，请在实例中安装后重试；平台不会自动安装软件。",
 REPRODUCTION_SNAPSHOT_READ_FAILED:"无法读取本机代码快照，请检查文件和目录权限。",
 REPRODUCTION_REMOTE_DIRECTORY_FAILED:"SFTP 创建远端目录失败，请检查父目录是否存在、写入权限及磁盘空间。",
 REPRODUCTION_TRANSFER_FAILED:"SFTP 上传失败，请检查网络、远端目录写权限及磁盘空间。",
 REPRODUCTION_SHA256SUM_UNAVAILABLE:"远端未找到 sha256sum，请安装后重试；平台不会自动安装。",
 REPRODUCTION_REMOTE_HASH_FAILED:"远端 SHA-256 校验失败，请检查代码包完整性和文件读取权限。",
 REPRODUCTION_REMOTE_EXTRACT_FAILED:"远端 unzip 解压失败，请检查磁盘空间及目录写入权限。",
 REPRODUCTION_REMOTE_MANIFEST_FAILED:"代码已解压，但快照清单写入失败，请检查远端写权限。",
 REPRODUCTION_REMOTE_TIMEOUT:"远端操作超时，请先确认远端文件状态，再决定是否重新上传。",
REPRODUCTION_DIRECTORY_INVALID:"请选择独立代码目录，不要选择包含 TRASH 数据目录的上级文件夹。",REPRODUCTION_BUSY:"该项目正在导入、创建快照或上传代码，请稍候再试。",REPRODUCTION_IMPORT_FAILED:"ZIP 导入失败：请检查格式、路径、重复条目和解压大小；本机需要 Python 3。",REPRODUCTION_ARCHIVE_FAILED:"快照创建失败：请检查 Python 3、文件权限、符号链接、敏感文件及代码大小。",EXPERIMENT_ACTIVE:"该代码仍有活动实验，请先结束实验。",SNAPSHOT_HASH_MISMATCH:"快照校验失败，请重新生成。",SOURCE_NOT_FOUND:"关联文献不存在，请重新选择。",SSH_CREDENTIAL_REQUIRED:"请先在 AutoDL 信息保存认证凭据。",SSH_FINGERPRINT_REQUIRED:"请先在 AutoDL 信息核对主机指纹。"};
export function ReproductionCodes({projectId,profiles,profileId,onPlan,connectedProfiles,connecting,onConnect}:{projectId:string;profiles:SshProfile[];profileId:string;onPlan:(snapshot:ReproductionSnapshot)=>void;connectedProfiles:string[];connecting:boolean;onConnect:(host:string)=>Promise<void>}){
 const base=`/api/v1/projects/${encodeURIComponent(projectId)}`;
 const [activeModule,setActiveModule]=useState<'analysis'|'environment'|'information'|'source'|'runs'|null>(null);
 const analysisOpen=activeModule==='analysis',environmentOpen=activeModule==='environment',codeInformationOpen=activeModule==='information',sourceOpen=activeModule==='source';
 const toggleModule=(module:Exclude<typeof activeModule,null>)=>setActiveModule(value=>value===module?null:module);
 const [analysisReportId,setAnalysisReportId]=useState('');
 const [environmentRefresh,setEnvironmentRefresh]=useState(0);
 const [query,setQuery]=useState(""),[listOpen,setListOpen]=useState(false);
 const [visited,setVisited]=useState<string[]>([]);
 const [codes,setCodes]=useState<ReproductionCode[]>([]),[selected,setSelected]=useState(()=>readPreference(`trash-reproduction-selected:${projectId}`)??"");
 const [progress,setProgress]=useState<{stage:string;sent:number;total:number}>();
 const [progressWarning,setProgressWarning]=useState("");
 const [uploadRequest,setUploadRequest]=useState<{id:string;code:string}>();
 const [uploading,setUploading]=useState(false),[stoppingUpload,setStoppingUpload]=useState(false);
 const uploadPending=useRef(false);
 const [uploadSuccess,setUploadSuccess]=useState<{code:string;host:string;directory:string;path:string;sha256:string;recordSaved:boolean}>();
 const [remotePicker,setRemotePicker]=useState(false);
 const [deleting,setDeleting]=useState<ReproductionCode>();
 const [sources,setSources]=useState<{source_id:string;title:string}[]>([]);
 const [editing,setEditing]=useState(false),[editingId,setEditingId]=useState(""),[name,setName]=useState(""),[sourceId,setSourceId]=useState(""),[sourceUrl,setSourceUrl]=useState(""),[notes,setNotes]=useState("");
 const [zip,setZip]=useState<File>(),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[host,setHost]=useState(profileId),[remoteDir,setRemoteDir]=useState("/root/autodl-tmp"),[uploadOpen,setUploadOpen]=useState(false);
 const [workspace,setWorkspace]=useState<RemoteWorkspace|null>(null),[workspaceLoading,setWorkspaceLoading]=useState(false),[workspaceLayout,setWorkspaceLayout]=useState(true);
 const zipInput=useRef<HTMLInputElement>(null),dialog=useRef<HTMLFormElement>(null),uploadDialog=useRef<HTMLFormElement>(null);
 const alive=useRef(true);useUnsavedChanges(editing||busy);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!host&&profileId)setHost(profileId);},[profileId,host]);
 const call=async<T,>(route:string,body?:unknown,method=body===undefined?"GET":"POST"):Promise<T>=>{const response=await fetch(base+route,{method,...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error((messages[data.error]??`操作失败（${data.error??response.status}），请检查代码目录和主机配置。`)+(data.error==="UPLOAD_CANCEL_CLEANUP_FAILED"&&typeof data.path==="string"?` 残留目录：${data.path}`:""));return data;};
 const load=async()=>{const data=await call<{codes:ReproductionCode[]}>("/reproductions");if(alive.current){setCodes(data.codes);setSelected(old=>data.codes.some(c=>c.id===old)?old:data.codes[0]?.id??"");}};
 const action=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");setNotice("");try{await work();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:"操作失败。");}finally{if(alive.current)setBusy(false);}};
 useEffect(()=>{void action(async()=>{await load();const data=await call<{sources:typeof sources}>("/sources");if(alive.current)setSources(data.sources);});},[projectId]);
 useEffect(()=>{
  if(!editing)return;
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  dialog.current?.querySelector<HTMLInputElement>('input:not([type="file"])')?.focus();
  return()=>{if(previous?.isConnected)previous.focus();};
 },[editing]);
 useEffect(()=>{
  if(!uploadOpen)return;
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  uploadDialog.current?.querySelector<HTMLSelectElement>("select")?.focus();
  return()=>{if(previous?.isConnected)previous.focus();};
 },[uploadOpen]);
 const closeUpload=()=>{if(!busy&&!uploading&&!connecting){setRemotePicker(false);setUploadOpen(false);}};
 const closeDialog=()=>{if(!busy){setEditing(false);setError("");}};
 useEffect(()=>{if(selected){writePreference(`trash-reproduction-selected:${projectId}`,selected);}},[selected,projectId]);
 const selectCode=(id:string)=>{if(busy||editing||uploading||connecting)return;setSelected(id);setActiveModule(null);setAnalysisReportId('');setUploadOpen(false);setNotice("");setError("");setListOpen(false);};
 const visibleCodes=[...codes].sort((a,b)=>b.created_at.localeCompare(a.created_at)).filter(code=>`${code.name} ${sources.find(source=>source.source_id===code.source_id)?.title??""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const current=codes.find(c=>c.id===selected);
 const latestUpload=current?.uploads?.filter(item=>item.profile_id===host&&item.path.split('/').slice(0,-1).join('/')===remoteDir.replace(/\/+$/,'')).at(-1);
 const currentUpload=uploadSuccess?.code===current?.id&&uploadSuccess?.host===host&&uploadSuccess?.directory===remoteDir?uploadSuccess:undefined;
 const completedUpload=currentUpload?{...currentUpload,historical:false}:latestUpload?{path:latestUpload.path,sha256:latestUpload.sha256,recordSaved:true,historical:true}:undefined;
 const successCard=useRef<HTMLElement>(null);
 useEffect(()=>{if(!uploading&&currentUpload&&uploadOpen){const frame=requestAnimationFrame(()=>successCard.current?.scrollIntoView({behavior:'smooth',block:'nearest'}));return()=>cancelAnimationFrame(frame);}},[uploading,currentUpload,uploadOpen]);
 const previouslyUploaded=Boolean(completedUpload||current?.uploads?.some(item=>item.profile_id===host));
 useEffect(()=>{
  if(!uploadOpen||!host||!current)return;
  const controller=new AbortController();setWorkspace(null);setWorkspaceLoading(true);
  void fetch(`${base}/remote-workspace?profile_id=${encodeURIComponent(host)}`,{signal:controller.signal,cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('无法读取工作区设置，请检查后端。');return response.json();}).then((value:{workspace:RemoteWorkspace|null})=>{if(controller.signal.aborted)return;setWorkspace(value.workspace);setWorkspaceLayout(Boolean(value.workspace));const old=current.uploads?.filter(item=>item.profile_id===host).at(-1);setRemoteDir(value.workspace?value.workspace.root+'/reproductions':old?old.path.split('/').slice(0,-1).join('/'):'/root/autodl-tmp');}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);}).finally(()=>{if(!controller.signal.aborted)setWorkspaceLoading(false);});return()=>controller.abort();
 },[base,host,uploadOpen,current?.id]);
 const edit=(value?:ReproductionCode)=>{setError("");setNotice("");setEditingId(value?.id??"");setName(value?.name??"");setSourceId(value?.source_id??"");setSourceUrl(value?.source_url??"");setNotes(value?.notes??"");setZip(undefined);setEditing(true);};
 useEffect(()=>{
  if(!uploading||!uploadRequest)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   try{const response=await fetch(`${base}/reproductions/${uploadRequest.code}/upload-progress?${new URLSearchParams({request_id:uploadRequest.id})}`,{signal:controller.signal,cache:"no-store"});
    if(!response.ok)throw new Error();const data=await response.json();if(!controller.signal.aborted){if(data.progress)setProgress(data.progress);setProgressWarning("");}
   }catch{if(!controller.signal.aborted)setProgressWarning("进度暂时无法更新，上传请求仍在处理中，请勿重复提交。");}
   if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),700);
  };void poll();return()=>{controller.abort();clearTimeout(timer);};
 },[uploading,uploadRequest,base]);

 const stopUpload=async()=>{
  if(!uploadRequest||!uploading||stoppingUpload)return;
  setStoppingUpload(true);setError("");
  try{await call(`/reproductions/${uploadRequest.code}/cancel-upload`,{request_id:uploadRequest.id,confirm:true});if(alive.current)setProgressWarning("正在终止上传并清理本次创建的远端目录，请等待后端确认。");}
  catch(cause){if(alive.current){setError(cause instanceof Error?cause.message:"终止请求失败，请查看上传状态后重试。");setStoppingUpload(false);}}
 };
 const upload=async()=>{
  if(!current||busy||connecting||uploadPending.current)return;
  if(!connectedProfiles.includes(host)){setError("请先连接所选主机，再上传代码。");return;}
  if(workspaceLoading||!workspace&&!current.uploads?.some(item=>item.profile_id===host)){setError("请先在 AutoDL 工作区的工作区设置中保存项目目录。");return;}
  if(!host||!remoteDir.trim()){setError("请填写目标主机和远端目录。");return;}
  const requestId=crypto.randomUUID();setUploadRequest({id:requestId,code:current.id});setProgress({stage:"snapshot",sent:0,total:0});setProgressWarning("");
  uploadPending.current=true;setUploadSuccess(undefined);setStoppingUpload(false);setUploading(true);
  try{await action(async()=>{
    const data=await call<{path:string;snapshot:ReproductionSnapshot;record_saved?:boolean}>(`/reproductions/${current.id}/upload`,{profile_id:host,directory:remoteDir,layout:workspaceLayout?"workspace":"legacy",request_id:requestId,confirm:true});
    if(alive.current){
      setUploadSuccess({code:current.id,host,directory:remoteDir,path:data.path,sha256:data.snapshot.sha256,recordSaved:data.record_saved!==false});
      setNotice(`上传完成：${data.path}；快照 SHA-256：${data.snapshot.sha256}${data.record_saved===false?"；本机上传记录保存失败，请保留远端路径。":""}`);
      try{await load();}catch{if(alive.current)setError("代码已上传成功，但列表刷新失败，请稍后重新进入页面查看记录。");}
    }
  });}finally{uploadPending.current=false;if(alive.current){setUploading(false);setStoppingUpload(false);}}
 };
 const save=async()=>{
  const metadata={name,source_id:sourceId||undefined,source_url:sourceUrl,notes};let code:ReproductionCode;
  if(editingId)({code}=await call<{code:ReproductionCode}>(`/reproductions/${editingId}`,metadata,"PUT"));
  else if(zip){
   if(zip.size>200*1024*1024)throw new Error("ZIP 文件不能超过 200 MiB。");
   const response=await fetch(`${base}/reproductions/import?${new URLSearchParams({name,filename:zip.name})}`,{method:"POST",headers:{"content-type":"application/zip"},body:zip});const data=await response.json();if(!response.ok)throw new Error(messages[data.error]??"ZIP 导入失败。");
   code=data.code;if(alive.current){setEditingId(code.id);setSelected(code.id);}({code}=await call<{code:ReproductionCode}>(`/reproductions/${code.id}`,metadata,"PUT"));
  }else throw new Error("请选择 ZIP 压缩包后保存。");
  if(alive.current){setEditing(false);setSelected(code.id);setActiveModule('analysis');await load();setNotice("复现代码已保存，无需 Git 仓库。");}
 };
 return <div className="reproduction-codes">
  <div className="reproduction-collection-heading"><div><strong>论文代码库</strong><span>{codes.length} 份复现代码</span></div><button type="button" className="primary-button" disabled={busy||editing} onClick={()=>current?setActiveModule('analysis'):edit()}><Plus size={14}/>源代码</button></div>
  <div className="reproduction-layout"><aside className={`reproduction-library ${listOpen?"is-open":""}`} aria-label="论文复现代码列表"><button type="button" className="reproduction-library-toggle" aria-expanded={listOpen} onClick={()=>setListOpen(value=>!value)}><Archive size={15}/>论文代码列表 · {codes.length}<ChevronDown size={15}/></button><div className="reproduction-library-content"><label className="reproduction-library-search"><Search size={14}/><input aria-label="搜索复现代码或论文" placeholder="搜索名称或论文…" value={query} onChange={event=>setQuery(event.target.value)}/></label><nav className="reproduction-library-list" aria-label="已导入的论文代码">{visibleCodes.map(code=>{const latest=code.uploads?.at(-1);return <button type="button" key={code.id} disabled={busy||editing||uploading||connecting} className={`reproduction-library-item ${selected===code.id?"selected":""}`} aria-current={selected===code.id?"true":undefined} onClick={()=>selectCode(code.id)}><span className="reproduction-library-item-title"><Archive size={15}/><strong>{code.name}</strong></span><span className="reproduction-library-paper" title={sources.find(source=>source.source_id===code.source_id)?.title}>{sources.find(source=>source.source_id===code.source_id)?.title??"未关联参考文献"}</span><span className="reproduction-library-status"><span className={latest?"uploaded":""}>{uploading&&uploadRequest?.code===code.id?"正在上传":latest?"已上传":"尚未上传"}</span>{latest&&<time dateTime={latest.at} title={new Date(latest.at).toLocaleString("zh-CN")}>{new Date(latest.at).toLocaleDateString("zh-CN")}</time>}</span></button>;})}{!visibleCodes.length&&<p className="reproduction-library-empty">{query?"没有匹配的论文代码":"还没有导入代码"}</p>}</nav></div></aside><div className="reproduction-workspace"><div className="reproduction-workspace-heading"><div className="reproduction-title-icon" aria-hidden="true"><Archive size={25}/></div><div className="reproduction-title-content"><span className="reproduction-title-eyebrow">{current?"当前复现项目":"论文复现工作区"}</span><h3>{current?.name??"开始论文复现"}</h3><div className="reproduction-paper-title"><FileSearch size={16} aria-hidden="true"/><p>{current?sources.find(source=>source.source_id===current.source_id)?.title??"尚未关联参考文献":"导入论文代码，查看实现并上传运行。"}</p></div></div>{current&&<button className="project-delete-button" title="移除复现代码记录" aria-label="移除复现代码记录" disabled={busy||editing} type="button" onClick={()=>setDeleting(current)}><Trash2 size={13}/></button>}</div>
  {current&&<div className="reproduction-operation-modules">
   <section className="reproduction-operation-card reproduction-deploy-module" aria-label="部署"><div className="reproduction-operation-heading"><span className="reproduction-operation-icon"><Upload size={19}/></span><div><h4>部署</h4><p>整理代码与环境，准备 AutoDL 实例</p></div><span className="reproduction-operation-step">01</span></div><div className="reproduction-module-actions"><button className="secondary-button" disabled={busy||editing} onClick={()=>edit(current)}><Pencil size={14}/>编辑信息</button><button type="button" className="secondary-button" aria-expanded={analysisOpen} disabled={editing} onClick={()=>toggleModule('analysis')}><FileSearch size={14}/>源代码</button><button type="button" className="secondary-button" aria-expanded={environmentOpen} disabled={editing} onClick={()=>toggleModule('environment')}><Cpu size={14}/>部署环境</button><button type="button" className="secondary-button" aria-expanded={codeInformationOpen} disabled={editing} onClick={()=>toggleModule('information')}><FileSearch size={14}/>代码信息</button></div></section>
   <section className="reproduction-operation-card reproduction-run-module" aria-label="复现"><div className="reproduction-operation-heading"><span className="reproduction-operation-icon"><Play size={19}/></span><div><h4>复现</h4><p>固定代码快照，规划复现实验</p></div><span className="reproduction-operation-step">02</span></div><div className="reproduction-module-actions"><button type="button" className="secondary-button" aria-expanded={sourceOpen} aria-controls="reproduction-source-browser" disabled={editing} onClick={()=>{setVisited(items=>items.includes(current.id)?items:[...items,current.id]);toggleModule('source');}}><FolderOpen size={14}/>浏览代码</button><button className="secondary-button" disabled={busy||editing} onClick={()=>void action(async()=>{const data=await call<{snapshot:ReproductionSnapshot}>(`/reproductions/${current.id}/snapshots`,{});if(alive.current)onPlan(data.snapshot);})}><Play size={14}/>创建实验计划</button><button type="button" className="secondary-button" aria-expanded={activeModule==='runs'} disabled={editing} onClick={()=>toggleModule('runs')}><Play size={14}/>跑实验</button></div></section>
  </div>}

  {busy&&!editing&&!uploading&&<p role="status"><LoaderCircle size={14} className="spin"/> 正在处理，请勿离开页面；上传及快照操作可能需要一些时间…</p>}{error&&!editing&&!uploadOpen&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}{notice&&<p role="status" className="notice">{notice}</p>}
  {deleting&&<DeleteReproductionDialog code={deleting} onClose={()=>setDeleting(undefined)} onConfirm={async()=>{
    await call(`/reproductions/${deleting.id}`,undefined,"DELETE");
    if(alive.current){const remaining=codes.filter(code=>code.id!==deleting.id);setCodes(remaining);setSelected(selected=>selected===deleting.id?remaining[0]?.id??"":selected);setUploadOpen(false);setDeleting(undefined);setError("");setNotice("复现代码记录已移除，本地代码及历史快照保留。");}
  }}/>}
  {editing&&<ModalLayer><div className="modal-backdrop reproduction-dialog-backdrop"><form ref={dialog} className="modal experiment-form reproduction-dialog" role="dialog" aria-modal="true" aria-labelledby="reproduction-dialog-title" aria-busy={busy} onSubmit={e=>{e.preventDefault();void action(save);}} onKeyDown={event=>{
   if(event.key==="Escape"){event.stopPropagation();event.preventDefault();closeDialog();}
   if(event.key==="Tab"){
    const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="file"]),select:not(:disabled),textarea:not(:disabled)')??[]);
    const first=items[0],last=items[items.length-1];
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   }
  }}><div className="modal-heading"><div><h2 id="reproduction-dialog-title"><Archive size={18}/>{editingId?"编辑复现代码":"添加复现代码"}</h2><p>上传论文代码 ZIP 压缩包，无需手动解压或创建 Git 仓库。</p></div><button type="button" className="icon-button" aria-label="关闭复现代码弹窗" disabled={busy} onClick={closeDialog}><X size={17}/></button></div><label>名称<input required value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>{!editingId&&<><div className="reproduction-zip-picker"><span className="reproduction-zip-label">导入 ZIP</span><div className="autodl-upload-fields"><input ref={zipInput} type="file" className="sr-only" tabIndex={-1} aria-label="选择复现代码 ZIP 文件" accept=".zip,application/zip" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(!file)return;setZip(file);if(!name)setName(file.name.replace(/\.zip$/i,""));}}/><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(zipInput.current){zipInput.current.value="";zipInput.current.click();}}}><FileUp size={14}/>选择文件</button><span className="autodl-upload-filename" title={zip?.name}>{zip?`${zip.name} · ${(zip.size/1024/1024).toFixed(2)} MiB`:"未选择文件"}</span></div></div></>}<label>关联参考文献<select value={sourceId} disabled={busy} onChange={e=>setSourceId(e.target.value)}><option value="">暂不关联</option>{sources.map(source=><option key={source.source_id} value={source.source_id}>{source.title}</option>)}</select></label><label>代码来源地址<input value={sourceUrl} disabled={busy} onChange={e=>setSourceUrl(e.target.value)}/></label><label>备注<textarea value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)}/></label><div className="modal-actions"><button className="primary-button" disabled={busy||!name.trim()||!editingId&&!zip}>保存</button><button type="button" className="secondary-button" disabled={busy} onClick={closeDialog}>取消</button></div><p>ZIP 和解压后代码均限 200 MiB、最多 20000 个条目；保留原目录结构，拒绝符号链接和越界路径。</p>{busy&&<p role="status" className="reproduction-dialog-status"><LoaderCircle size={14} className="spin"/>正在保存，请稍候…</p>}{error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}</form></div></ModalLayer>}

  {remotePicker&&connectedProfiles.includes(host)&&<RemoteDirectoryPicker projectId={projectId} profileId={host} hostName={profiles.find(profile=>profile.profile_id===host)?.name??host} initialPath={remoteDir} onClose={()=>setRemotePicker(false)} onSelect={path=>{setRemoteDir(path);setRemotePicker(false);}}/>}
  {current&&activeModule==='runs'&&<ReproductionExperiments key={current.id} projectId={projectId} code={current} profiles={profiles} connected={connectedProfiles}/>}
  {current&&analysisOpen&&<SourceAnalysis key={current.id} projectId={projectId} codeId={current.id} selectedReportId={analysisReportId} onSelectReport={setAnalysisReportId} onChanged={()=>setEnvironmentRefresh(value=>value+1)} disabled={busy||editing||uploading} onImport={()=>edit()} onUpload={()=>void action(async()=>{const value=await call<{tasks:unknown[];reports:import("@trash/protocol").CodeEnvironmentReport[]}>(`/reproductions/${current.id}/environment`);const ready=value.reports.find(report=>report.content.schema_version===2&&report.content.adaptation?.status==='ready');if(!ready)throw new Error("请先开始分析并完成本地适配，解决阻塞项后再上传。");const check=await call<{stale:boolean}>(`/reproductions/${current.id}/environment/reports/${ready.id}/freshness`);if(check.stale)throw new Error("代码已变化，请重新分析后上传。");setUploadOpen(true);})}/>}
  {current&&environmentOpen&&<EnvironmentPanel key={current.id} projectId={projectId} codeId={current.id} profiles={profiles} connectedProfiles={connectedProfiles} profileId={host||profileId} refreshToken={environmentRefresh} selectedReportId={analysisReportId}/>}
  {current&&codeInformationOpen&&<CodeInformation key={current.id} projectId={projectId} codeId={current.id} refreshToken={environmentRefresh} selectedReportId={analysisReportId}/>}
  {current&&uploadOpen&&<ModalLayer><div className="modal-backdrop"><form ref={uploadDialog} className="modal experiment-form reproduction-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="reproduction-upload-title" aria-busy={uploading||connecting} onSubmit={e=>{e.preventDefault();void upload();}} onKeyDown={event=>{
   if(remotePicker)return;
   if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeUpload();}
   if(event.key==="Tab"){
    const items=Array.from(uploadDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')??[]);
    const first=items[0],last=items[items.length-1];
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   }
  }}><div className="modal-heading"><div><span className="reproduction-title-eyebrow">代码部署</span><h2 id="reproduction-upload-title"><Upload size={20}/>上传到 AutoDL</h2><p>{current.name}</p></div><button type="button" className="icon-button" aria-label="关闭上传弹窗" disabled={busy||uploading||connecting} onClick={closeUpload}><X size={18}/></button></div>{completedUpload&&!uploading&&<section ref={successCard} className="reproduction-upload-success" role="status" aria-live="polite"><CheckCircle2 size={28}/><div><strong>{completedUpload.historical?'最近一次上传记录':'源代码上传完成'}</strong><p>{completedUpload.historical?'该主机与目录已有成功上传记录。以下为当时的远端路径及文件哈希，未重新检查远端文件现状。':'已完成传输、远端文件校验与解压，可以继续部署环境。'}</p><code>{completedUpload.path}</code><details><summary>查看 SHA-256</summary><code>{completedUpload.sha256}</code></details>{!completedUpload.recordSaved&&<p>本机上传记录保存失败，请保留以上远端路径。</p>}</div></section>}<label>目标主机<select required value={host} disabled={busy||connecting} onChange={e=>setHost(e.target.value)}><option value="">选择主机</option>{profiles.map(p=><option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}</select></label>{workspace?<label><span><input type="checkbox" checked={workspaceLayout} disabled={busy||uploading} onChange={event=>{setWorkspaceLayout(event.target.checked);if(event.target.checked)setRemoteDir(workspace.root+'/reproductions');}}/>使用项目规范目录</span></label>:<p className="quiet">尚未配置项目工作区；旧上传可沿用原父目录，新上传请先前往工作区设置。</p>}{workspaceLoading&&<p role="status">正在读取工作区设置…</p>}<label>远端父目录<div className="repository-path-control"><input required value={remoteDir} disabled={busy||workspaceLayout||workspaceLoading} onChange={e=>setRemoteDir(e.target.value)}/><button type="button" className="secondary-button" disabled={busy||connecting||workspaceLayout||!host||!connectedProfiles.includes(host)} onClick={()=>setRemotePicker(true)}><FolderOpen size={14}/>浏览目录</button></div></label><p>请先连接目标主机；浏览、新建目录和上传均复用该 SSH 连接。规范布局解压至复现名称目录；旧布局解压至 ZIP 同名目录。自动展开压缩包自带的同名外层，不再增加 code 层。无需远端 Python。不会安装依赖、启动实验或覆盖已有代码。</p><div className="knowledge-toolbar"><button type="button" className="secondary-button" disabled={busy||connecting||!host||connectedProfiles.includes(host)} aria-busy={connecting} onClick={()=>void onConnect(host)}>{connecting?<><LoaderCircle size={14} className="spin"/>正在连接…</>:connectedProfiles.includes(host)?"已连接":"连接"}</button><button type="submit" className="primary-button" disabled={busy||connecting||workspaceLoading||!host||!connectedProfiles.includes(host)||!workspace&&!current.uploads?.some(item=>item.profile_id===host)} aria-busy={uploading}>{uploading?<><LoaderCircle size={14} className="spin"/>正在上传…</>:previouslyUploaded?"重新上传":"确认上传"}</button>{uploading&&<button type="button" className="secondary-button reproduction-upload-stop" disabled={stoppingUpload||Boolean(progress&&!["snapshot","preparing","uploading","cancelling"].includes(progress.stage))} onClick={()=>void stopUpload()}>{stoppingUpload?<><LoaderCircle size={14} className="spin"/>正在终止…</>:"终止上传"}</button>}</div>{uploading&&<UploadProgress progress={progress} warning={progressWarning} name={current.archive_name??`${current.name}.zip`}/>}{error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}{notice&&!completedUpload&&<p role="status" className="notice">{notice}</p>}<p className="quiet">代码目录：{workspaceLayout&&workspace?workspace.root+'/reproductions/'+remoteDirectoryLabel(current.name):remoteDir+'/'+(current.archive_name??current.name+'.zip').replace(/\.zip$/i,'')}<br/>venv：上述代码目录下的 .venv</p><div className="reproduction-upload-footer"><span>{uploading?"准备或传输阶段可终止；校验归档阶段请等待结束。":"ZIP 保留原名；规范布局使用复现名称作为代码目录，旧布局沿用 ZIP 同名目录。"}</span><button type="button" className="secondary-button" disabled={busy||uploading||connecting} onClick={closeUpload}>关闭</button></div></form></div></ModalLayer>}
  {current?<><details className="reproduction-summary"><summary>代码信息与上传记录</summary><code>{current.path}</code><button type="button" className="text-button" onClick={()=>void copyText(current.path).then(()=>{setError("");setNotice("已复制本地目录，可在编辑器中打开。");}).catch(()=>{setNotice("");setError("浏览器未允许自动复制，请手动选中上方目录路径并按 Ctrl+C。");})}>复制本地目录路径</button>{current.source_url&&<span>来源：{current.source_url}</span>}{current.notes&&<p>{current.notes}</p>}{current.uploads?.at(-1)&&<span>最近上传：{current.uploads.at(-1)?.path} · {current.uploads.at(-1)?.at}</span>}</details><div id="reproduction-source-browser" hidden={!sourceOpen}>{codes.filter(code=>visited.includes(code.id)).map(code=><div hidden={code.id!==selected} key={code.id}><RepositoryBrowser projectId={projectId} repositoryPath={code.path} endpoint={`${base}/reproductions/${code.id}`}/></div>)}</div></>:!editing&&!busy&&<div className="repository-unbound"><Archive size={32}/><h3>添加第一份论文复现代码</h3><p>上传 ZIP 压缩包即可管理多篇论文的实现，并上传到 AutoDL 运行。</p><button className="primary-button" onClick={()=>edit()}>导入源代码</button></div>}
 </div></div></div>;
}

function DeleteReproductionDialog({code,onClose,onConfirm}:{code:ReproductionCode;onClose:()=>void;onConfirm:()=>Promise<void>}){
 const modal=useRef<HTMLDivElement>(null),pending=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 useUnsavedChanges(busy);
 useEffect(()=>{const previous=document.activeElement;modal.current?.querySelector<HTMLButtonElement>("button")?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 const confirm=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError("");try{await onConfirm();}catch(cause){setError(cause instanceof Error?cause.message:"移除失败，请重试。");}finally{pending.current=false;setBusy(false);}};
 return <ModalLayer><div className="modal-backdrop"><div ref={modal} className="modal reproduction-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="reproduction-delete-title" aria-describedby="reproduction-delete-description" aria-busy={busy} onKeyDown={event=>{
  if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!busy)onClose();}
  if(event.key==="Tab"){const buttons=Array.from(modal.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")??[]),first=buttons[0],last=buttons[buttons.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}><h2 id="reproduction-delete-title">移除复现代码</h2><p className="reproduction-delete-name">{code.name}</p><p id="reproduction-delete-description">仅移除平台记录，本地源代码、历史快照及 AutoDL 文件会保留。存在活动实验时暂不能移除。</p>{error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button project-delete-confirm" disabled={busy} onClick={()=>void confirm()}>{busy?<><LoaderCircle size={14} className="spin"/>正在移除…</>:"确认移除"}</button></div></div></div></ModalLayer>;
}
