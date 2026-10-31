import React, { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, Cpu, FileSearch, LoaderCircle, RefreshCw, Square } from "lucide-react";
import type { CodeEnvironmentReport, EnvironmentAnalysisTask, HostEnvironmentComparison, SshProfile } from "@trash/protocol";
import { copyText } from "./clipboard.js";
import { useUnsavedChanges } from "./navigation.js";

export const environmentErrors:Record<string,string>={
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
 const hostConnected=connectedProfiles.includes(host);
 const [reload,setReload]=useState(0),[copied,setCopied]=useState("");
 useUnsavedChanges(checking);
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
 const cancel=async()=>{if(!active||canceling)return;setCanceling(true);setError("");try{await request(`/tasks/${active.id}/cancel`,{confirm:true});setReload(value=>value+1);}catch(cause){setError(cause instanceof Error?cause.message:"取消失败。");}finally{setCanceling(false);}};
 const compare=async()=>{if(checking||detecting||!python.trim()||!report||!hostConnected)return;setChecking(true);setError("");try{const data=await request<{comparison:HostEnvironmentComparison}>(`/reports/${report.id}/compare`,{profile_id:host,python,confirm:true});setComparisons(current=>[data.comparison,...current]);setComparisonId(data.comparison.id);}catch(cause){setError(cause instanceof Error?cause.message:"主机检查失败。");}finally{setChecking(false);}};
 const freshnessLabels={checking:"正在检查报告时效",current:"代码内容与报告一致",stale:"代码已变化，报告可能已过期",unknown:"报告时效尚未确认"};
 return <details className="environment-panel" open><summary><span><Cpu size={16}/>部署环境</span><span className="environment-unverified">未运行验证<ChevronDown size={13}/></span></summary><div className="environment-panel-body">
  {error&&<p role="alert" className="notice error-notice">{error}</p>}
  {loading&&<p role="status"><LoaderCircle size={14} className="spin"/>正在读取分析记录…</p>}
  {tasks[0]&&<div className={`environment-task environment-task-${tasks[0].status}`} role="status"><FileSearch size={19}/><div><strong>{taskNames[tasks[0].status]}</strong><span>{new Date(tasks[0].created_at).toLocaleString("zh-CN")}{tasks[0].error?` · ${environmentErrors[tasks[0].error]??tasks[0].error}`:""}</span></div>{active&&<button type="button" className="secondary-button" disabled={canceling} onClick={()=>void cancel()}><Square size={12}/>{canceling?"正在取消…":"取消分析"}</button>}</div>}
  <div className="environment-report-toolbar"><label>报告历史<select value={reportId} disabled={!reports.length||checking} onChange={event=>setReportId(event.target.value)}><option value="">尚无报告</option>{reports.map(item=><option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString("zh-CN")} · {item.id.slice(-8)}</option>)}</select></label><button type="button" className="icon-button" title="刷新环境报告" aria-label="刷新环境报告" disabled={checking} onClick={()=>setReload(value=>value+1)}><RefreshCw size={14}/></button></div>
  {!report&&!loading&&<div className="environment-empty"><Cpu size={28}/><p>点击上方“分析部署环境”，由本机 Codex 阅读代码并整理依赖与启动方式。</p><span>不运行代码，不安装软件，不修改源文件。</span></div>}
  {report&&<><div className="environment-report-meta"><span className={freshness==="stale"?"stale":""}>{freshnessLabels[freshness]}</span><span>Skill {report.skill_version}</span><span title={report.code_fingerprint}>代码指纹 {report.code_fingerprint.slice(0,12)}</span><span>{report.coverage.selected_files} 个文件 · {(report.coverage.selected_bytes/1024).toFixed(0)} KiB</span></div><p className="environment-summary">{report.content.summary}</p>
  <div className="environment-requirements">{report.content.requirements.map((item,index)=><article className="environment-requirement" key={index}><div><span className="environment-category">{categories[item.category]}</span><strong>{item.name}</strong><span className={`environment-attribution ${item.attribution}`}>{attributionNames[item.attribution]}</span></div><p>{item.requirement||"项目未明确说明"}</p><Evidence items={item.evidence}/></article>)}</div>
  <details className="environment-section" open><summary>建议命令 · 仅供查看，不自动执行</summary>{report.content.commands.length?report.content.commands.map((item,index)=><article className="environment-command" key={index}><div><strong>{item.purpose}</strong><span>{attributionNames[item.attribution]}</span><button type="button" className="icon-button" aria-label={`复制${item.purpose}`} title={copied===String(index)?"已复制":"复制命令"} onClick={()=>void copyText(item.command).then(()=>setCopied(String(index))).catch(()=>setError("无法自动复制，请手动选择命令。"))}>{copied===String(index)?<Check size={14}/>:<Copy size={14}/>}</button></div><pre>{item.command}</pre><Evidence items={item.evidence}/></article>):<p>项目材料中没有足够依据确定命令。</p>}</details>
  <details className="environment-section"><summary>外部数据与权重 · {report.content.resources.length}</summary>{report.content.resources.map((item,index)=><article key={index}><strong>{item.name}</strong><span className="environment-attribution">{attributionNames[item.attribution]}</span><p>{item.requirement}</p><Evidence items={item.evidence}/></article>)}</details>
  <details className="environment-section"><summary>冲突与待确认事项 · {report.content.issues.length}</summary>{report.content.issues.map((item,index)=><article key={index}><strong>{item.name}</strong><p>{item.requirement}</p><Evidence items={item.evidence}/></article>)}{report.content.limitations.map((text,index)=><p key={index}><AlertCircle size={13}/> {text}</p>)}</details>
  <details className="environment-section"><summary>采集范围与版本信息</summary><p>CLI：{report.cli_version}；Skill：{report.skill_name} / {report.skill_hash}</p><p>快照：{report.snapshot_id}；代码指纹：{report.code_fingerprint}</p><p>未采集 {report.coverage.skipped.length} 项。报告只基于实际采集文本，不代表完整运行验证。</p><div className="environment-skipped">{report.coverage.skipped.map((item,index)=><p key={index}><code>{item.path}</code> · {item.reason}</p>)}</div></details>
  <section className="environment-host"><h4>对照 AutoDL 环境</h4><p>仅检查已连接主机，不安装依赖或执行论文代码。历史结果是当时的环境快照。</p><div className="environment-host-fields"><label>目标主机<select value={host} disabled={checking} onChange={event=>{setPython("");setHost(event.target.value);}}><option value="">选择主机</option>{profiles.map(item=><option key={item.profile_id} value={item.profile_id}>{item.name}{connectedProfiles.includes(item.profile_id)?" · 已连接":" · 未连接"}</option>)}</select></label><label>Python 解释器<div className="repository-path-control"><input list={`environment-python-${codeId}`} value={python} disabled={checking||detecting||!hostConnected} onChange={event=>setPython(event.target.value)} placeholder={detecting?"正在从主机识别…":"自动识别，也可填写自定义路径"}/><button type="button" className="icon-button" title="重新识别 Python 解释器" aria-label="重新识别 Python 解释器" disabled={checking||detecting||!hostConnected} onClick={()=>setDetectRevision(value=>value+1)}><RefreshCw size={14} className={detecting?"spin":""}/></button></div><datalist id={`environment-python-${codeId}`}>{interpreters.map(item=><option key={item.path} value={item.path}>Python {item.version}</option>)}</datalist></label><button type="button" className="primary-button" disabled={checking||detecting||Boolean(active)||!hostConnected||!python.trim()} onClick={()=>void compare()}>{checking?<><LoaderCircle size={14} className="spin"/>正在检查…</>:"检查 AutoDL"}</button></div>{!hostConnected&&<p>请先在 AutoDL 工作区连接目标主机。</p>}{detecting&&<p role="status">正在读取所选主机的 Python 环境…</p>}{discoveryError&&<p role="alert">{discoveryError}</p>}{!detecting&&interpreters.length>0&&<p>已识别 {interpreters.length} 个解释器，默认使用主机环境优先找到的可用版本；可从输入框候选列表切换。</p>}
  {comparisons.length>0&&<label>对照历史<select value={comparison?.id??""} disabled={checking} onChange={event=>setComparisonId(event.target.value)}>{comparisons.map(item=><option key={item.id} value={item.id}>{profiles.find(profile=>profile.profile_id===item.profile_id)?.name??item.profile_id} · {new Date(item.created_at).toLocaleString("zh-CN")}</option>)}</select></label>}
  {comparison&&<><p>解释器：{comparison.python} · {new Date(comparison.created_at).toLocaleString("zh-CN")}</p><div className="environment-comparisons">{comparison.items.map((item,index)=><article key={index}><div><strong>{item.name}</strong><span className={`environment-comparison-status ${item.status}`}>{item.status==="satisfied"?"满足":item.status==="unsatisfied"?"不满足":"待确认"}</span></div><p>要求：{item.expected}</p><p>检测：{item.actual}</p><small>{item.reason}</small></article>)}</div><details className="environment-section"><summary>主机实际环境（驱动 / Toolkit / 框架 CUDA）</summary><pre>{JSON.stringify(comparison.environment,null,2)}</pre></details></>}
  </section></>}
 </div></details>;
}
