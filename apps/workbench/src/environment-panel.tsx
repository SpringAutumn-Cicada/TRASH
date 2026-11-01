import { DeploymentProgress, type DeploymentView } from "./deployment-progress.js";
import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, FolderOpen, Cpu, FileSearch, LoaderCircle, RefreshCw, Square } from "lucide-react";
import type { CodeEnvironmentReport, EnvironmentAnalysisTask, HostEnvironmentComparison, SshProfile } from "@trash/protocol";
import { RemoteDirectoryPicker } from "./remote-directory-picker.js";
import { ModalLayer } from "./modal-layer.js";
import { copyText } from "./clipboard.js";
import { useUnsavedChanges } from "./navigation.js";

export const environmentErrors:Record<string,string>={
 DEPLOYMENT_REPAIR_REQUIRES_FAILED:"仅支持修复已停止的失败部署，请先刷新远端状态。",DEPLOYMENT_DIRECTORY_INVALID:"请选择有效的远端代码目录，不能使用根目录或包含上级跳转。",DEPLOYMENT_REPORT_BLOCKED:"此报告为旧格式，请重新分析后再部署。",DEPLOYMENT_REPORT_STALE:"代码已变化，请重新分析部署环境。",DEPLOYMENT_UPLOAD_REQUIRED:"请先将此代码上传到所选主机。",DEPLOYMENT_UPLOAD_STALE:"上传快照与分析代码不一致，请重新上传并分析。",DEPLOYMENT_BUSY:"该主机已有部署任务。",DEPLOYMENT_NOT_FOUND:"部署记录不存在，请刷新列表。",DEPLOYMENT_STATE_UNKNOWN:"此前部署状态未知，请先人工检查远端安装进程和 .venv，不会自动重试。",
 ENVIRONMENT_ANALYSIS_BUSY:"当前项目已有环境分析任务，请等待或取消后重试。",REPRODUCTION_BUSY:"当前项目正在生成快照、上传或检查环境，请稍后再试。",
 ENVIRONMENT_CODEX_UNAVAILABLE:"未找到本机 Codex CLI，请在运行 TRASH 的 WSL 中确认安装和登录状态。",ENVIRONMENT_LOCAL_PYTHON_MISSING:"本机没有可用的 Python 3，无法采集代码输入。",
 ENVIRONMENT_PROCESS_FAILED:"分析进程执行失败，请检查本机 Codex CLI 登录、模型可用性和运行权限。",ENVIRONMENT_ANALYSIS_TIMEOUT:"分析超过十分钟，已停止，请手动重试。",
 ENVIRONMENT_NO_READABLE_INPUT:"没有找到可用于分析的文本文件，请检查代码和文件格式。",ENVIRONMENT_INVALID_REPORT:"Agent 输出不符合报告格式，请重新分析。",ENVIRONMENT_INVALID_EVIDENCE:"报告引用了无效文件或行号，本次报告未保存，请重新分析。",
 ENVIRONMENT_ANALYSIS_FAILED:"分析未完成，可能是 CLI 输出格式、输入采集或本机文件读写异常，请检查后重试。",ENVIRONMENT_REPORT_NOT_FOUND:"报告不存在，请刷新列表。",
 ENVIRONMENT_PYTHON_NOT_FOUND:"未发现可用于检查的 Python 3.8+，可在高级选项中填写自定义解释器路径。",ENVIRONMENT_PYTHON_DISCOVERY_FAILED:"自动识别解释器失败，请确认 SSH 仍连接，或手动填写解释器路径。",ENVIRONMENT_PYTHON_DISCOVERY_TIMEOUT:"识别解释器超时，请重新连接主机后再试。",
 ENVIRONMENT_HOST_PROBE_FAILED:"无法通过所选 Python 读取主机环境，请确认解释器存在、Python 版本支持 importlib.metadata（3.8+）及 SSH 仍连接。",ENVIRONMENT_PYTHON_INVALID:"解释器名称或路径无效。",SSH_NOT_CONNECTED:"请先连接所选 AutoDL 主机。",ENVIRONMENT_TASK_NOT_RUNNING:"任务已经结束，请刷新状态。",
 REPRODUCTION_ARCHIVE_FAILED:"生成代码快照失败，请检查 Python 3、代码大小、符号链接与本机目录权限。",NOT_FOUND:"当前后端尚未加载部署环境分析接口，请重启 TRASH 后再试。"
};
const taskNames:Record<string,string>={preparing:"正在固定快照并采集环境文件",analyzing:"本机 Codex 正在分析部署环境",completed:"报告已生成，尚未运行验证",failed:"分析失败",cancelled:"已取消分析",interrupted:"服务重启或停止，分析已中断"};
const attributionNames={declared:"明确声明",inferred:"源码推断",unknown:"未知"};
const categories:Record<string,string>={system:"系统",python:"Python",framework:"框架",cuda:"CUDA",tool:"工具",dependency:"依赖",other:"其他"};
type Citation={path:string;line_start:number;line_end:number};
function Evidence({items}:{items:Citation[]}){return <span className="environment-evidence">{items.length?items.map((item,index)=><span key={index} title={item.path}>{item.path}:{item.line_start}{item.line_end!==item.line_start?`–${item.line_end}`:""}</span>):"没有可引用依据"}</span>;}
export function EnvironmentPanel({projectId,codeId,profiles,connectedProfiles,profileId,refreshToken}:{projectId:string;codeId:string;profiles:SshProfile[];connectedProfiles:string[];profileId:string;refreshToken:number}){
 const base=`/api/v1/projects/${encodeURIComponent(projectId)}/reproductions/${codeId}/environment`;
 const [tasks,setTasks]=useState<EnvironmentAnalysisTask[]>([]),[reports,setReports]=useState<CodeEnvironmentReport[]>([]),[reportId,setReportId]=useState("");
 const [error,setError]=useState(""),[loading,setLoading]=useState(true),[checking,setChecking]=useState(false),[canceling,setCanceling]=useState(false),[freshness,setFreshness]=useState<"checking"|"current"|"stale"|"unknown">("unknown");
 const [host,setHost]=useState(profileId),[python,setPython]=useState(""),[comparisons,setComparisons]=useState<HostEnvironmentComparison[]>([]),[comparisonId,setComparisonId]=useState("");
 const [interpreters,setInterpreters]=useState<{path:string;version:string}[]>([]),[detecting,setDetecting]=useState(false),[discoveryError,setDiscoveryError]=useState(""),[detectRevision,setDetectRevision]=useState(0);
 const [deployments,setDeployments]=useState<DeploymentView[]>([]),[deploying,setDeploying]=useState(false),[deploymentRefresh,setDeploymentRefresh]=useState(0);
 const [deployDirectory,setDeployDirectory]=useState(""),[defaultDirectory,setDefaultDirectory]=useState(""),[directoryLoading,setDirectoryLoading]=useState(false),[deploymentPicker,setDeploymentPicker]=useState(false);
 const [deploymentWorking,setDeploymentWorking]=useState("");
 const [deploymentConfirm,setDeploymentConfirm]=useState(false),[deploymentError,setDeploymentError]=useState("");
 const deploymentModal=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!deploymentConfirm)return;const previous=document.activeElement;
  deploymentModal.current?.querySelector<HTMLButtonElement>("button")?.focus();
  return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
 },[deploymentConfirm]);
 const hostConnected=connectedProfiles.includes(host);
 const [reload,setReload]=useState(0),[copied,setCopied]=useState("");
 useUnsavedChanges(checking||deploying);
 const active=tasks.find(task=>task.status==="preparing"||task.status==="analyzing"),report=reports.find(item=>item.id===reportId),comparison=comparisons.find(item=>item.id===comparisonId)??comparisons[0];
 const request=async<T,>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>=>{const response=await fetch(base+path,{method:body===undefined?"GET":"POST",signal,cache:"no-store",...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(environmentErrors[value.error]??`操作失败（${value.error??response.status}）`);return value;};
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{
   try{const data=await request<{tasks:EnvironmentAnalysisTask[];reports:CodeEnvironmentReport[]}>("",undefined,controller.signal);if(controller.signal.aborted)return;setTasks(data.tasks);setReports(data.reports);setReportId(old=>data.reports.some(item=>item.id===old)?old:data.reports[0]?.id??"");setLoading(false);
    if(data.tasks.some(task=>task.status==="preparing"||task.status==="analyzing"))timer=setTimeout(()=>void load(),1500);
   }catch(cause){if(!controller.signal.aborted){setLoading(false);setError(cause instanceof Error?cause.message:"读取报告失败。");}}
  };setLoading(true);setError("");void load();return()=>{controller.abort();clearTimeout(timer);};
 },[base,refreshToken,reload]);
 useEffect(()=>{
  if(!reportId||active){setFreshness("unknown");return;}
  const controller=new AbortController();setFreshness("checking");setComparisons([]);setComparisonId("");
  void request<{stale:boolean}>(`/reports/${reportId}/freshness`,undefined,controller.signal).then(data=>{if(!controller.signal.aborted)setFreshness(data.stale?"stale":"current");}).catch(()=>{if(!controller.signal.aborted)setFreshness("unknown");});
  void request<{comparisons:HostEnvironmentComparison[]}>(`/reports/${reportId}/comparisons`,undefined,controller.signal).then(data=>{if(!controller.signal.aborted)setComparisons(data.comparisons);}).catch(()=>{if(!controller.signal.aborted)setError("历史主机对照暂时无法读取，可稍后刷新。");});
  return()=>controller.abort();
 },[base,reportId,Boolean(active)]);
 useEffect(()=>{
  const controller=new AbortController();setPython("");setInterpreters([]);setDiscoveryError("");
  if(!host||!hostConnected){setDetecting(false);return()=>controller.abort();}
  setDetecting(true);
  void request<{interpreters:{path:string;version:string}[];recommended:string}>(`/interpreters?profile_id=${encodeURIComponent(host)}`,undefined,controller.signal).then(data=>{
   if(controller.signal.aborted)return;setInterpreters(data.interpreters);setPython(data.recommended);
  }).catch(cause=>{if(!controller.signal.aborted)setDiscoveryError(cause instanceof Error?cause.message:"识别解释器失败。");}).finally(()=>{if(!controller.signal.aborted)setDetecting(false);});
  return()=>controller.abort();
 },[base,host,hostConnected,detectRevision]);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{try{const data=await request<{deployments:typeof deployments}>("/deployments",undefined,controller.signal);if(controller.signal.aborted)return;setDeployments(data.deployments);if(data.deployments.some(item=>item.status==="planning"||item.status==="installing"||item.status==="cancelling"))timer=setTimeout(()=>void load(),1500);}catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"读取部署记录失败");}};
  void load();return()=>{controller.abort();clearTimeout(timer);};
 },[base,deploymentRefresh]);
 useEffect(()=>{
  const controller=new AbortController();setDeployDirectory("");setDefaultDirectory("");setDeploymentPicker(false);
  if(!host){setDirectoryLoading(false);return()=>controller.abort();}
  setDirectoryLoading(true);
  void request<{directory:string}>(`/deployment-directory?profile_id=${encodeURIComponent(host)}`,undefined,controller.signal).then(data=>{if(!controller.signal.aborted){setDefaultDirectory(data.directory);setDeployDirectory(data.directory);}}).catch(cause=>{if(!controller.signal.aborted)setDeploymentError(cause instanceof Error?cause.message:"读取默认目录失败");}).finally(()=>{if(!controller.signal.aborted)setDirectoryLoading(false);});
  return()=>controller.abort();
 },[base,host,reportId]);
 const deploymentActive=deployments.some(item=>item.status==="planning"||item.status==="installing"||item.status==="cancelling");
 const deploy=async()=>{
  if(!report||deploying||deploymentActive||!hostConnected||!python||!deployDirectory.trim())return;
  setDeploying(true);setError("");setDeploymentError("");try{const data=await request<{deployment:typeof deployments[number]}>(`/reports/${report.id}/deploy`,{profile_id:host,python,directory:deployDirectory.trim(),confirm:true});setDeployments(items=>[data.deployment,...items.filter(item=>item.id!==data.deployment.id)]);setDeploymentConfirm(false);setDeploymentRefresh(value=>value+1);}catch(cause){const message=cause instanceof Error?cause.message:"部署启动失败";setDeploymentError(message);}finally{setDeploying(false);}
 };
 const cancel=async()=>{if(!active||canceling)return;setCanceling(true);setError("");try{await request(`/tasks/${active.id}/cancel`,{confirm:true});setReload(value=>value+1);}catch(cause){setError(cause instanceof Error?cause.message:"取消失败。");}finally{setCanceling(false);}};
 const compare=async()=>{if(checking||detecting||!python.trim()||!report||!hostConnected)return;setChecking(true);setError("");try{const data=await request<{comparison:HostEnvironmentComparison}>(`/reports/${report.id}/compare`,{profile_id:host,python,confirm:true});setComparisons(current=>[data.comparison,...current]);setComparisonId(data.comparison.id);}catch(cause){setError(cause instanceof Error?cause.message:"主机检查失败。");}finally{setChecking(false);}};
 const deploymentCommand=async(task:DeploymentView,action:"cancel"|"refresh")=>{
  if(deploymentWorking)return;setDeploymentWorking(task.id);setDeploymentError("");
  try{const data=await request<{deployment:DeploymentView}>(`/deployments/${task.id}/${action}`,{confirm:true});setDeployments(items=>items.map(item=>item.id===task.id?data.deployment:item));setDeploymentRefresh(value=>value+1);}catch(cause){setDeploymentError(cause instanceof Error?cause.message:"部署操作失败");}finally{setDeploymentWorking("");}
 };
 const resumeDeployment=async(task:DeploymentView,repair=false)=>{
  if(deploymentWorking||deploying||deploymentActive)return;
  setDeploymentWorking(task.id);setDeploymentError("");
  try{const data=await request<{deployment:DeploymentView}>(`/reports/${task.report_id}/deploy`,{profile_id:task.profile_id,python:task.python,directory:task.directory,resume_id:task.id,repair,confirm:true});setDeployments(items=>items.map(item=>item.id===task.id?data.deployment:item));setDeploymentRefresh(value=>value+1);}catch(cause){setDeploymentError(cause instanceof Error?cause.message:"继续部署失败");}finally{setDeploymentWorking("");}
 };
 const deploymentUnavailable=[
  directoryLoading?"正在读取默认目录":!deployDirectory.trim()?"请先选择远端代码目录":"",
  !hostConnected?"请先连接目标主机":"",detecting?"正在识别 Python":!python?"请选择可用 Python 解释器":"",
  freshness!=="current"?"请等待代码时效检查；过期报告需重新分析":"",
  report&&report.content.schema_version!==2?"请重新分析生成新版部署报告":"",
  active?"请等待环境分析完成":"",checking?"正在对照主机环境":""
 ].filter(Boolean);
 const freshnessLabels={checking:"正在检查报告时效",current:"代码内容与报告一致",stale:"代码已变化，报告可能已过期",unknown:"报告时效尚未确认"};
 return <details className="environment-panel" open><summary><span><Cpu size={16}/>部署环境</span><span className="environment-unverified">未运行验证<ChevronDown size={13}/></span></summary><div className="environment-panel-body">
  {error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}
  {loading&&<p role="status"><LoaderCircle size={14} className="spin"/>正在读取分析记录…</p>}
  {tasks[0]&&<div className={`environment-task environment-task-${tasks[0].status}`} role="status"><FileSearch size={19}/><div><strong>{taskNames[tasks[0].status]}</strong><span>{new Date(tasks[0].created_at).toLocaleString("zh-CN")}{tasks[0].error?` · ${environmentErrors[tasks[0].error]??tasks[0].error}`:""}</span></div>{active&&<button type="button" className="secondary-button" disabled={canceling} onClick={()=>void cancel()}><Square size={12}/>{canceling?"正在取消…":"取消分析"}</button>}</div>}
  <div className="environment-report-toolbar"><label>报告历史<select value={reportId} disabled={!reports.length||checking} onChange={event=>setReportId(event.target.value)}><option value="">尚无报告</option>{reports.map(item=><option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString("zh-CN")} · {item.id.slice(-8)}</option>)}</select></label><button type="button" className="icon-button" title="刷新环境报告" aria-label="刷新环境报告" disabled={checking} onClick={()=>setReload(value=>value+1)}><RefreshCw size={14}/></button></div>
  {!report&&!loading&&<div className="environment-empty"><Cpu size={28}/><p>点击上方“分析部署环境”，由本机 Codex 阅读代码并整理依赖与启动方式。</p><span>不运行代码，不安装软件，不修改源文件。</span></div>}
  {report&&<><div className="environment-report-meta"><span className={freshness==="stale"?"stale":""}>{freshnessLabels[freshness]}</span><span>Skill {report.skill_version}</span><span title={report.code_fingerprint}>代码指纹 {report.code_fingerprint.slice(0,12)}</span><span>{report.coverage.selected_files} 个文件 · {(report.coverage.selected_bytes/1024).toFixed(0)} KiB</span></div><p className="environment-summary">{report.content.summary}</p>
  {report.content.schema_version===2?<>
   <div className="environment-image-heading"><h4>AutoDL 镜像选择</h4><span>按这四项选择镜像</span></div>
   <div className="environment-image-grid">{([{key:"framework",label:"框架名称"},{key:"framework_version",label:"框架版本"},{key:"python",label:"Python 版本"},{key:"cuda",label:"CUDA 版本"}] as const).map(({key,label})=>{if(report.content.schema_version!==2)return null;const item=report.content.image_selection[key];return <article key={key}><span>{label}</span><strong>{item.value||"未知"}</strong><small>{attributionNames[item.attribution]}</small><details><summary>来源依据</summary><Evidence items={item.evidence}/></details></article>;})}</div>
   <details className="environment-section"><summary>Agent 部署方案 · 独立 venv · {report.content.agent_deployment.status==="ready"?"方案已整理，尚未执行":"存在待确认项"}</summary><p>在代码根目录创建 .venv，不修改系统 Python 或 Conda base。以下指令可审核和复制；只有点击“一键部署”并确认后才会发起远端安装。</p><button type="button" className="secondary-button" onClick={()=>void copyText(JSON.stringify(report.content.schema_version===2?{image_selection:report.content.image_selection,agent_deployment:report.content.agent_deployment}:report.content,null,2)).then(()=>setCopied("deployment-json")).catch(()=>setError("无法自动复制，请手动选择内容。"))}>{copied==="deployment-json"?"已复制":"复制 Agent 部署 JSON"}</button><h5>执行前提</h5>{report.content.agent_deployment.prerequisites.map((item,index)=><p key={index}>{item}</p>)}{report.content.agent_deployment.blockers.length>0&&<><h5>待解决事项</h5>{report.content.agent_deployment.blockers.map((item,index)=><p key={index}>{item}</p>)}</>}{report.content.agent_deployment.runtime_notes&&report.content.agent_deployment.runtime_notes.length>0&&<><h5>实验运行前提醒</h5>{report.content.agent_deployment.runtime_notes.map((item,index)=><p key={index}>{item}</p>)}</>}{report.content.agent_deployment.steps.map((step,index)=><article className="environment-command" key={index}><div><strong>{index+1}. {step.purpose}</strong><button type="button" className="icon-button" aria-label={`复制部署步骤${index+1}`} onClick={()=>void copyText(step.command).then(()=>setCopied(`deploy-${index}`)).catch(()=>setError("无法自动复制，请手动选择命令。"))}>{copied===`deploy-${index}`?<Check size={14}/>:<Copy size={14}/>}</button></div><pre>{step.command}</pre><Evidence items={step.evidence}/></article>)}</details>
  </>:<p className="notice">这是旧版报告，重新分析后可生成四项镜像建议及 venv 部署方案。</p>}
  <details className="environment-section"><summary>依赖与分析明细</summary>
  <div className="environment-requirements">{report.content.requirements.map((item,index)=><article className="environment-requirement" key={index}><div><span className="environment-category">{categories[item.category]}</span><strong>{item.name}</strong><span className={`environment-attribution ${item.attribution}`}>{attributionNames[item.attribution]}</span></div><p>{item.requirement||"项目未明确说明"}</p><Evidence items={item.evidence}/></article>)}</div>
  <details className="environment-section" open><summary>建议命令 · 仅供查看，不自动执行</summary>{report.content.commands.length?report.content.commands.map((item,index)=><article className="environment-command" key={index}><div><strong>{item.purpose}</strong><span>{attributionNames[item.attribution]}</span><button type="button" className="icon-button" aria-label={`复制${item.purpose}`} title={copied===String(index)?"已复制":"复制命令"} onClick={()=>void copyText(item.command).then(()=>setCopied(String(index))).catch(()=>setError("无法自动复制，请手动选择命令。"))}>{copied===String(index)?<Check size={14}/>:<Copy size={14}/>}</button></div><pre>{item.command}</pre><Evidence items={item.evidence}/></article>):<p>项目材料中没有足够依据确定命令。</p>}</details>
  <details className="environment-section"><summary>外部数据与权重 · {report.content.resources.length}</summary>{report.content.resources.map((item,index)=><article key={index}><strong>{item.name}</strong><span className="environment-attribution">{attributionNames[item.attribution]}</span><p>{item.requirement}</p><Evidence items={item.evidence}/></article>)}</details>
  <details className="environment-section"><summary>冲突与待确认事项 · {report.content.issues.length}</summary>{report.content.issues.map((item,index)=><article key={index}><strong>{item.name}</strong><p>{item.requirement}</p><Evidence items={item.evidence}/></article>)}{report.content.limitations.map((text,index)=><p key={index}><AlertCircle size={13}/> {text}</p>)}</details>
  <details className="environment-section"><summary>采集范围与版本信息</summary><p>CLI：{report.cli_version}；Skill：{report.skill_name} / {report.skill_hash}</p><p>快照：{report.snapshot_id}；代码指纹：{report.code_fingerprint}</p><p>未采集 {report.coverage.skipped.length} 项。报告只基于实际采集文本，不代表完整运行验证。</p><div className="environment-skipped">{report.coverage.skipped.map((item,index)=><p key={index}><code>{item.path}</code> · {item.reason}</p>)}</div></details>
  </details>
  <section className="environment-host"><h4>对照 AutoDL 环境</h4><p>仅检查已连接主机，不安装依赖或执行论文代码。历史结果是当时的环境快照。</p><div className="environment-host-fields"><label>目标主机<select value={host} disabled={checking} onChange={event=>{setPython("");setHost(event.target.value);}}><option value="">选择主机</option>{profiles.map(item=><option key={item.profile_id} value={item.profile_id}>{item.name}{connectedProfiles.includes(item.profile_id)?" · 已连接":" · 未连接"}</option>)}</select></label><label>Python 解释器<div className="repository-path-control"><input list={`environment-python-${codeId}`} value={python} disabled={checking||detecting||!hostConnected} onChange={event=>setPython(event.target.value)} placeholder={detecting?"正在从主机识别…":"自动识别，也可填写自定义路径"}/><button type="button" className="icon-button" title="重新识别 Python 解释器" aria-label="重新识别 Python 解释器" disabled={checking||detecting||!hostConnected} onClick={()=>setDetectRevision(value=>value+1)}><RefreshCw size={14} className={detecting?"spin":""}/></button></div><datalist id={`environment-python-${codeId}`}>{interpreters.map(item=><option key={item.path} value={item.path}>Python {item.version}</option>)}</datalist></label><button type="button" className="primary-button" disabled={checking||detecting||Boolean(active)||!hostConnected||!python.trim()} onClick={()=>void compare()}>{checking?<><LoaderCircle size={14} className="spin"/>正在检查…</>:"检查 AutoDL"}</button></div>{!hostConnected&&<p>请先在 AutoDL 工作区连接目标主机。</p>}{detecting&&<p role="status">正在读取所选主机的 Python 环境…</p>}{discoveryError&&<ErrorNotice >{discoveryError}</ErrorNotice>}{!detecting&&interpreters.length>0&&<p>已识别 {interpreters.length} 个解释器，默认使用主机环境优先找到的可用版本；可从输入框候选列表切换。</p>}
  <div className="environment-deployment-directory"><label htmlFor={`deployment-directory-${codeId}`}>远端部署目录</label><div className="repository-path-control"><input id={`deployment-directory-${codeId}`} value={deployDirectory} disabled={directoryLoading||deploying||deploymentActive} placeholder={directoryLoading?"正在读取最近上传目录…":"选择包含当前报告代码的远端目录"} onChange={event=>setDeployDirectory(event.target.value)}/><button type="button" className="secondary-button" disabled={!hostConnected||directoryLoading||deploying||deploymentActive} onClick={()=>setDeploymentPicker(true)}><FolderOpen size={14}/>浏览目录</button></div><p>原默认逻辑：所选主机最近上传的代码目录。{defaultDirectory?<code>{defaultDirectory}</code>:"该主机暂无上传记录，可自行选择已有代码目录。"}</p>{deployDirectory.trim()&&<p>将创建的虚拟环境：<code>{deployDirectory.trim().replace(/\/+$/,"")}/.venv</code></p>}<small>所选目录须包含与报告一致的代码及相对目录结构，安装前会核对文件哈希。</small></div>
  {deploymentPicker&&hostConnected&&<RemoteDirectoryPicker projectId={projectId} profileId={host} hostName={profiles.find(item=>item.profile_id===host)?.name??host} initialPath={deployDirectory||"/"} onClose={()=>setDeploymentPicker(false)} onSelect={path=>{setDeployDirectory(path);setDeploymentPicker(false);}}/>}
  <div className="environment-deploy-action"><button type="button" className="primary-button" disabled={deploying||deploymentActive||directoryLoading||!deployDirectory.trim()||checking||detecting||Boolean(active)||!hostConnected||!python||freshness!=="current"||report.content.schema_version!==2} onClick={()=>{setDeploymentError("");setDeploymentConfirm(true);}}>{deploying||deploymentActive?<><LoaderCircle size={14} className="spin"/>正在部署…</>:"一键部署"}</button><p>由本机 Agent 整理安装计划，在上方所选远端目录创建 .venv；不修改系统环境。报告中的待确认项由 Agent 重新区分为安装阻塞与运行提醒；只有安装计划可执行才开始安装。</p></div>{deploymentUnavailable.length>0&&<p role="status">暂不可部署：{deploymentUnavailable.join("；")}</p>}
  {deploymentError&&!deploymentConfirm&&<ErrorNotice  className="notice error-notice">{deploymentError}</ErrorNotice>}
  {deploymentConfirm&&report&&<ModalLayer><div className="modal-backdrop"><div ref={deploymentModal} className="modal environment-deployment-confirm" role="dialog" aria-modal="true" aria-labelledby="environment-deploy-title" aria-busy={deploying} onKeyDown={event=>{
   if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!deploying)setDeploymentConfirm(false);}
   if(event.key==="Tab"){const buttons=Array.from(deploymentModal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const first=buttons[0],last=buttons[buttons.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  }}><h2 id="environment-deploy-title">确认部署 venv 环境</h2><p>将在下方目录创建或继续本平台同一计划的 .venv；保留已安装依赖，仅在身份校验通过后恢复断点。</p><dl><dt>目标主机</dt><dd>{profiles.find(item=>item.profile_id===host)?.name??host}</dd><dt>Python 解释器</dt><dd>{python}</dd><dt>远端部署目录</dt><dd>{deployDirectory}</dd><dt>虚拟环境位置</dt><dd>{deployDirectory.trim().replace(/\/+$/,"")}/.venv</dd><dt>部署报告</dt><dd>{report.id}</dd></dl>{deploymentError&&<ErrorNotice  className="notice error-notice">{deploymentError}</ErrorNotice>}{deploying&&<p role="status"><LoaderCircle size={14} className="spin"/>正在核对代码快照并提交部署任务…</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={deploying} onClick={()=>setDeploymentConfirm(false)}>取消</button><button type="button" className="primary-button" disabled={deploying||deploymentActive||!hostConnected||!python} onClick={()=>void deploy()}>{deploying?"正在提交…":"确认部署"}</button></div></div></div></ModalLayer>}
  {deployments.length>0&&<div className="deployment-records"><h4>部署进度与记录</h4>{deployments.map(task=><DeploymentProgress key={task.id} task={task} working={deploymentWorking===task.id} connected={connectedProfiles.includes(task.profile_id)} resumeDisabled={Boolean(deploymentWorking)||deploying||deploymentActive} onResume={()=>void resumeDeployment(task)} onRepair={()=>void resumeDeployment(task,true)} onCancel={()=>void deploymentCommand(task,"cancel")} onRefresh={()=>void deploymentCommand(task,"refresh")}/>)}</div>}
  {comparisons.length>0&&<label>对照历史<select value={comparison?.id??""} disabled={checking} onChange={event=>setComparisonId(event.target.value)}>{comparisons.map(item=><option key={item.id} value={item.id}>{profiles.find(profile=>profile.profile_id===item.profile_id)?.name??item.profile_id} · {new Date(item.created_at).toLocaleString("zh-CN")}</option>)}</select></label>}
  {comparison&&<><p>解释器：{comparison.python} · {new Date(comparison.created_at).toLocaleString("zh-CN")}</p><div className="environment-comparisons">{comparison.items.map((item,index)=><article key={index}><div><strong>{item.name}</strong><span className={`environment-comparison-status ${item.status}`}>{item.status==="satisfied"?"满足":item.status==="unsatisfied"?"不满足":"待确认"}</span></div><p>要求：{item.expected}</p><p>检测：{item.actual}</p><small>{item.reason}</small></article>)}</div><details className="environment-section"><summary>主机实际环境（驱动 / Toolkit / 框架 CUDA）</summary><pre>{JSON.stringify(comparison.environment,null,2)}</pre></details></>}
  </section></>}
 </div></details>;
}
