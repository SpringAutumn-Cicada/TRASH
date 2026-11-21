import { MethodSnapshot } from "./method-snapshot.js";
import { ExperimentMethod } from "./experiment-method.js";
import { ExperimentCatalog, experimentKeyOf } from "./experiment-catalog.js";
import { sshConnectionErrors } from './ssh-errors.js';
import { ExperimentCodeUpload } from "./experiment-code-upload.js";
import { RemoteWorkspaceSettings } from "./remote-workspace.js";
import "./data.css";
import { AutoDlDeleteDialog } from "./autodl-delete-dialog.js";
import { ErrorNotice } from "./error-notice.js";
import React, { useEffect, useRef, useState } from "react";
import { ChartColumn, ClipboardList, Code2, Columns2, Database, Download, FlaskConical, FolderOpen, GitBranch, Pencil, Play, Plus, RefreshCw, Server } from "lucide-react";
import type { ProjectPage, DiscoveredExperiment, ExperimentCatalogEntry, ReproductionCode, ReproductionSnapshot, DatasetRef, ExperimentPlanVersion, ExperimentRun, ProjectRepository, SshProfile } from "@trash/protocol";
import { DatasetsPanel } from "./data.js";
import { ExperimentalDataPanel } from "./experimental-data.js";
import { experimentTabs, type ExperimentTab, type NavigateOptions, useUnsavedChanges } from "./navigation.js";
import "./literature-visual.css";
import "./experiments.css";
import { ModalLayer } from "./modal-layer.js";
import { AutoDlTerminal, type TerminalSession } from "./autodl-terminal.js";
import { ReproductionCodes } from "./reproduction-code.js";
import { AutoDlUpload } from "./autodl-upload.js";
import { AutoDlInstanceDialog } from "./autodl-instance-dialog.js";
import { DirectoryPicker } from "./directory-picker.js";
import { CodeAgentPanel } from "./code-agent.js";
import { RepositoryBrowser } from "./repository-browser.js";

const failures:Record<string,string>={...sshConnectionErrors,DATASET_NOT_READY:"数据集尚未就绪，请先完成上传或选择其他数据集。",SSH_CREDENTIAL_STORE_FAILED:"本机凭据读取或保存失败，请检查数据目录权限及设备密钥是否完整。",REPRODUCTION_ARCHIVE_FAILED:"复现快照生成失败，请检查 Python 3、文件权限、符号链接、敏感文件与大小。",SNAPSHOT_HASH_MISMATCH:"复现代码快照校验失败，请重新创建计划。",SNAPSHOT_NOT_FOUND:"未找到代码快照，请重新创建计划。",NOT_FOUND:"未找到接口或所请求的内容。如果刚更新了连接终端功能，请先重启 TRASH 后端服务再连接。",SSH_PROFILE_NOT_FOUND:"主机配置不存在或已被删除，请刷新实例列表后重新选择。",INTERNAL_ERROR:"服务端处理失败（INTERNAL_ERROR），无法建立此次请求，请保留错误信息以便定位。",SERVER_STOPPING:"服务正在停止，请等待后端重新启动后再连接。",TERMINAL_PROFILE_BUSY:"该主机终端已连接，请先在 AutoDL 工作区断开再编辑或删除。",TERMINAL_CONNECTING:"正在建立终端连接，请稍候。",TERMINAL_LIMIT:"终端会话已达上限，请先断开不用的会话。",SSH_TERMINAL_FAILED:"SSH 认证后无法打开交互终端，请检查远端是否允许 Shell 和 PTY。",REMOTE_DIAGNOSTICS_FAILED:"SSH 已连接，但环境诊断失败，请检查实例的 python3、远端目录权限及磁盘空间。",SSH_COMMAND_TIMEOUT:"远端诊断命令超时，请确认实例是否正常运行后重试。",SSH_LOGIN_COMMAND_INVALID:"SSH 指令格式不正确，请填写 ssh -p 端口 用户名@主机，不要附带其他选项或命令。",CODE_AGENT_BUSY:"该仓库有开发 Agent 正在执行，请先等待或取消。",REPOSITORY_NOT_BOUND:"请先绑定本地 Git 仓库。",REPOSITORY_ROOT_REQUIRED:"请选择 Git 仓库根目录。",REPOSITORY_PATH_INVALID:"文件路径越出绑定仓库，不能访问。",GIT_TREE_DIRTY:"仓库存在未提交或未跟踪文件，请先在本地整理并提交。",GIT_OPERATION_FAILED:"Git 操作失败，请检查仓库、暂存区和提交身份。",GIT_SUBMODULE_UNSUPPORTED:"首版不自动展开子模块，请先整理为可独立运行的仓库。",GIT_LFS_UNSUPPORTED:"首版不自动同步 Git LFS，请改用远端数据引用。",SSH_FINGERPRINT_REQUIRED:"请先探测并核对主机指纹。",SSH_FINGERPRINT_CHANGED:"主机指纹已变化，连接被阻止。请重新核对主机身份。",SSH_FINGERPRINT_NOT_OBSERVED:"请先获取本次连接的指纹，再确认信任。",SSH_CREDENTIAL_REQUIRED:"请重新输入本次会话的 SSH 密码。",SSH_AUTH_FAILED:"SSH 认证失败，请检查用户名和认证信息。",SSH_KEY_REQUIRED:"请填写本地私钥路径。",SSH_AGENT_UNAVAILABLE:"本地服务未检测到 SSH Agent。",SSH_CONNECTION_FAILED:"SSH 连接失败，请检查地址、端口及实例状态。",SSH_NETWORK_FAILED:"无法连接 SSH 主机，请检查网络和实例状态。",EXPERIMENT_ACTIVE:"存在未结束或远端状态未确认的实验，暂不能执行此操作。",EXPERIMENT_BUSY:"当前主机正在处理请求，请稍后重试。",PLAN_NOT_CONFIRMED:"请先检查环境并确认实验计划。",PREPARATION_REQUIRED:"该计划需要先单独授权并成功执行环境准备脚本。",REMOTE_ENVIRONMENT_INCOMPLETE:"远端需要 Linux、Python 3.9+、Git、tmux 和 Bash。",GPU_UNAVAILABLE:"所选 GPU 编号不可用。",DATASET_HASH_MISMATCH:"数据或校验清单的 SHA-256 不匹配。",REMOTE_DISK_INSUFFICIENT:"远端剩余空间不足。",CODE_BUNDLE_TOO_LARGE:"代码包超过 200 MiB，请清理代码历史和大文件。",INVALID_REQUEST:"输入内容不符合格式，请检查必填字段和 JSON。",VERSION_CONFLICT:"计划已有新版本，请重新选择。",EDITOR_NOT_CONFIGURED:"绑定仓库时请先填写编辑器配置。"};
Object.assign(failures, {
  METHOD_UNREADABLE: "无法固定方法版本，请检查实验档案是否为 2 MiB 以内的 UTF-8 Markdown 文件。",
  EXPERIMENT_DISCOVERY_UNAVAILABLE: "目录已变化、已关联论文或实验已回收，请刷新列表后重试。",
  EXPERIMENT_NAME_INVALID: "实验名称不能用作目录名，请去掉路径符号或更换名称。",
  EXPERIMENT_CODE_EXISTS: "code/papers 下已有同名目录或仓库记录，请换一个实验名称。",
  EXPERIMENT_GIT_INIT_FAILED: "初始化 Git 仓库失败，请检查本机 Git 和工作区权限后重试。",
  FILES_NOT_DIRECTORY: "工作区的代码或实验路径不可用，请检查目录结构。",
  FILES_EXISTS: "此创建请求已用于另一个实验，请关闭窗口后重新创建。",
  FILES_CHANGED: "实验档案已变化，请刷新后重试。",
  PROJECT_HAS_ACTIVE_TASKS: "项目还有活动任务或终端，请结束后再移入回收站。",
  SCHEME_NOT_FOUND: "实验档案不可用。如果已移入回收站，请恢复后再运行。",
});
async function request<T>(base:string,path:string,body?:unknown,method=body===undefined?"GET":"POST",signal?:AbortSignal):Promise<T>{
  const response=await fetch(base+path,{method,signal,...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)})});const value=await response.json();if(!response.ok){const code=typeof value.error==="string"&&/^[A-Z][A-Z0-9_]{0,80}$/.test(value.error)?value.error:"UNKNOWN_ERROR";throw new Error(failures[code]??`操作失败（${code}，HTTP ${response.status}），请记录此错误信息以便定位。`);}return value as T;
}
const stateNames:Record<string,string>={queued:"排队",preflight:"预检查",syncing:"同步代码",running:"运行中",collecting:"收集产物",completed:"已完成",failed:"失败",cancel_requested:"取消请求中",cancelled:"已取消",disconnected:"连接中断",unknown_remote_state:"远端状态待确认"};
const terminal=["completed","failed","cancelled"];
const experimentTabIcons = {method:ClipboardList,compute:Server,runs:ClipboardList,catalog:Code2,code:Code2,reproductions:GitBranch,datasets:Database,results:ChartColumn} satisfies Record<ExperimentTab,typeof Server>;
const codeTabs=[{id:"overview",label:"仓库与 Git"},{id:"code",label:"文件浏览"},{id:"agent",label:"代码 Agent"}] as const;
const autoDlTabs=[{id:"hosts",label:"AutoDL 信息"},{id:"settings",label:"工作区设置"},{id:"workspace",label:"AutoDL 工作区"}] as const;
type Navigate=(page:ProjectPage,options?:NavigateOptions)=>void;

export function ExperimentsPage({projectId,section,experimentKey,action,focusId,status,onNavigate,onBrowseArchive}:{
  projectId:string;section:ExperimentTab;experimentKey?:string;action?:string;focusId?:string;status?:string;onNavigate:Navigate;onBrowseArchive?:(path:string)=>void;
}) {
  const autoDlOnly=section==="compute",reproductionOnly=section==="reproductions";
  const snapshotId=section==="runs"&&action==="reproduction-plan"?focusId:undefined;
  const runFocus=section==="runs"&&action!=="reproduction-plan"?focusId:undefined;
  const [codeTab,setCodeTab]=useState<typeof codeTabs[number]["id"]>("overview");
  const [computeTab,setComputeTab]=useState<typeof autoDlTabs[number]["id"]>("hosts");
  const [reproductionVisited,setReproductionVisited]=useState(reproductionOnly);
  const [runDetail,setRunDetail]=useState<"logs"|"artifacts">("logs");
  const [kind,setKind]=useState<"all"|"git"|"reproduction">("all");
  const showScopedResults = section==="runs" && Boolean(experimentKey) && action==="experiment-results";
  const tab=showScopedResults ? undefined : autoDlOnly?computeTab:section==="code"?(codeTab==="agent"&&!experimentKey?"overview":codeTab):section==="runs"
    ?runFocus||action==="runs"?"runs":"plans":undefined;
  const showRuns=tab==="runs",showPlans=tab==="plans";
  const base=`/api/v1/projects/${encodeURIComponent(projectId)}`;
  const [directoryPicker,setDirectoryPicker]=useState(false);
  const [terminalSessions,setTerminalSessions]=useState<TerminalSession[]>([]);
  const terminalConnecting=useRef(false);
  const [connecting,setConnecting]=useState(false);
  const [diagnostic,setDiagnostic]=useState("");
  const [deleteInstance,setDeleteInstance]=useState<SshProfile>();
  const [instanceDialog,setInstanceDialog]=useState<"add"|"edit">();
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const alive=useRef(true);const [repositoryList,setRepositoryList]=useState<ProjectRepository[]>([]),[defaultRepositoryId,setDefaultRepositoryId]=useState<string|null>(null),[selectedRepositoryId,setSelectedRepositoryId]=useState("");
  const [discovered, setDiscovered] = useState<DiscoveredExperiment[]>([]);
  const [catalog, setCatalog] = useState<ExperimentCatalogEntry[]>([]);
  const [reproductions, setReproductions] = useState<ReproductionCode[]>([]);
  const reproductionScope = experimentKey?.startsWith("reproduction:") ? experimentKey.slice(13) : undefined;
  const experiment = catalog.find(item => experimentKeyOf(item) === experimentKey);
  const scopedReproduction = reproductions.find(item => item.id === reproductionScope);
  const repositoryId = experimentKey
    ? experiment?.repository_id ?? repositoryList.find(item => experiment?.paper_id && item.paper_id === experiment.paper_id)?.repository_id
    : selectedRepositoryId || defaultRepositoryId;
  const repo = repositoryList.find(item => item.repository_id === repositoryId);
  const recycleExperiment = async (entry: ExperimentCatalogEntry) => {
    let recycled = false;
    await run(async () => {
      const key = experimentKeyOf(entry);
      const path = "experiments/" + key;
      const inspection = await request<{ fingerprint: string }>(base, "/files/inspect?path=" + encodeURIComponent(path));
      await request(base, "/files/delete", { path, fingerprint: inspection.fingerprint, confirm: true });
      setCatalog(items => items.filter(item => experimentKeyOf(item) !== key));
      setSchemes(items => items.filter(item => item.direction_id !== entry.direction_id || item.scheme_id !== entry.scheme_id));
      setNotice("实验已移入项目文件的回收站。");
      recycled = true;
    });
    return recycled;
  };
  const saveCatalogExperiment = async (path: string, body: object) => {
    let created = false;
    await run(async () => {
      const { experiment, repository, default_id } = await request<{
        experiment: ExperimentCatalogEntry; repository?: ProjectRepository; default_id: string | null;
      }>(base, path, body);
      if (!alive.current) return;
      if (repository) setRepositoryList(items => [...items.filter(item => item.repository_id !== repository.repository_id), repository]);
      if (repository) setDiscovered(items => items.filter(item => item.path !== repository.path));
      setSchemes(items => items.some(item => experimentKeyOf(item) === experimentKeyOf(experiment)) ? items : [...items, experiment]);
      setDefaultRepositoryId(default_id);
      setCodeTab(repository ? "code" : "overview");
      setCatalog(items => [...items.filter(item => experimentKeyOf(item) !== experimentKeyOf(experiment)), experiment]);
      created = true;
      onNavigate("experiments", { tab: "method", experiment: experimentKeyOf(experiment) });
    });
    return created;
  };
  const repositoryQuery=(path:string)=>path+(path.includes("?")?"&":"?")+"repository_id="+encodeURIComponent(repo?.repository_id??"");
  const [repoPath,setRepoPath]=useState(""),[editor,setEditor]=useState(""),[repoInfo,setRepoInfo]=useState<{head:string;clean:boolean;status:string;diff:string;staged_diff:string}>();
  const [history,setHistory]=useState<{sha:string;at:string;title:string}[]>([]),[historyPage,setHistoryPage]=useState(1),[commitMessage,setCommitMessage]=useState("");
  const [loadingContext,setLoadingContext]=useState(true);
  const [schemes,setSchemes]=useState<{direction_id:string;scheme_id:string}[]>([]);
  const [profiles,setProfiles]=useState<(SshProfile&{credential_available?:boolean})[]>([]),[profileId,setProfileId]=useState("");
  const [datasets,setDatasets]=useState<DatasetRef[]>([]),[plans,setPlans]=useState<ExperimentPlanVersion[]>([]),[planJson,setPlanJson]=useState(""),[editingPlan,setEditingPlan]=useState<ExperimentPlanVersion>(),[planId,setPlanId]=useState(""),[planVersion,setPlanVersion]=useState(0),[script,setScript]=useState("");
  const [runs,setRuns]=useState<ExperimentRun[]>([]),[runId,setRunId]=useState(runFocus??""),[details,setDetails]=useState(""),[logs,setLogs]=useState(""),[stream,setStream]=useState("stdout"),[logOffset,setLogOffset]=useState(0);
  const [submission,setSubmission]=useState<{plan:ExperimentPlanVersion;preparation:boolean;key:string}>();const [ack,setAck]=useState(false);
  const dirty=Boolean(showPlans&&planJson||section==="code"&&commitMessage);const clearDirty=useUnsavedChanges(dirty);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");setNotice("");try{await action();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:"操作失败");}finally{if(alive.current)setBusy(false);}};
  const load=async()=>{
    const [repositories, hosts, datasetData, planData, runData, schemeData] = await Promise.all([
      request<{repositories: ProjectRepository[]; default_id: string | null}>(base, "/repositories"),
      request<{profiles: typeof profiles}>(base, "/ssh-profiles"),
      request<{datasets: DatasetRef[]}>(base, "/datasets"),
      request<{plans: ExperimentPlanVersion[]}>(base, "/experiment-plans"),
      request<{runs: ExperimentRun[]}>(base, "/experiment-runs"),
      request<{schemes: typeof schemes}>(base, "/experiment-schemes"),
    ]);
    if (!alive.current) return;
    setRepositoryList(repositories.repositories);
    setDefaultRepositoryId(repositories.default_id);
    setSelectedRepositoryId(old => repositories.repositories.some(item => item.repository_id === old) ? old : "");
    setProfiles(hosts.profiles);
    setProfileId(old => hosts.profiles.some(item => item.profile_id === old) ? old : hosts.profiles[0]?.profile_id ?? "");
    setDatasets(datasetData.datasets);
    setPlans(planData.plans);
    setRuns(runData.runs);
    setSchemes(schemeData.schemes);
    const [experimentData, reproductionData] = await Promise.allSettled([
      request<{experiments: ExperimentCatalogEntry[]; discovered: DiscoveredExperiment[]}>(base, "/experiment-catalog"),
      request<{codes: ReproductionCode[]}>(base, "/reproductions"),
    ]);
    if (!alive.current) return;
    if (experimentData.status === "fulfilled") {
      setCatalog(experimentData.value.experiments);
      setDiscovered(experimentData.value.discovered ?? []);
    }
    if (reproductionData.status === "fulfilled") setReproductions(reproductionData.value.codes);
    if (experimentData.status === "rejected" || reproductionData.status === "rejected") {
      setError("部分实验列表读取失败，请刷新后重试。");
    }
  };
  useEffect(()=>{void run(load).finally(()=>{if(alive.current)setLoadingContext(false);});},[projectId]);
  const previousSection = useRef(section);
  useEffect(() => {
    if (section === "catalog" && previousSection.current !== section) void run(load);
    previousSection.current = section;
  }, [section]);
  useEffect(()=>{
    const controller=new AbortController();
    void request<{terminals:TerminalSession[]}>(base,"/terminals",undefined,"GET",controller.signal).then(data=>{
      if(!controller.signal.aborted){setTerminalSessions(data.terminals);const profile=data.terminals[0]?.profile_id;if(profile)setProfileId(profile);}
    }).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"无法恢复 SSH 会话。");});
    return()=>controller.abort();
  },[projectId]);
  useEffect(()=>{
    const changed=(event:Event)=>{if((event as CustomEvent<{projectId:string}>).detail?.projectId!==projectId)return;
      void Promise.all([load(),request<{terminals:TerminalSession[]}>(base,"/terminals")]).then(([,value])=>{if(alive.current){setTerminalSessions(value.terminals);if(value.terminals[0])setProfileId(value.terminals[0].profile_id);}}).catch(cause=>{if(alive.current)setError(cause instanceof Error?cause.message:"无法刷新 SSH 连接状态");});
    };window.addEventListener("trash-autodl-changed",changed);return()=>window.removeEventListener("trash-autodl-changed",changed);
  },[projectId]);
  useEffect(()=>{if(!showRuns)return;const timer=setInterval(()=>{void request<{runs:ExperimentRun[]}>(base,"/experiment-runs").then(data=>{if(alive.current)setRuns(data.runs);}).catch(()=>{});},5000);return()=>clearInterval(timer);},[tab,base]);
  useEffect(()=>{if(reproductionOnly)setReproductionVisited(true);},[reproductionOnly]);
  useEffect(()=>{
    if(!runFocus)return;
    setRunId(runFocus);
    const focused=runs.find(item=>item.run_id===runFocus);
    if(focused&&kind!=="all"&&(kind==="reproduction")!==Boolean(focused.plan.reproduction))setKind("all");
    setRunDetail("logs");setLogs("");setLogOffset(0);setDetails("");
  },[runFocus]);
  useEffect(()=>{if(!showPlans){setPlanJson("");setEditingPlan(undefined);}},[showPlans]);
  useEffect(() => {
    setCodeTab(experimentKey ? "code" : "overview");
    setKind("all");setPlanJson("");setEditingPlan(undefined);setRepoInfo(undefined);setHistory([]);
    setCommitMessage("");setDiagnostic("");setScript("");setPlanId("");setRunId(runFocus??"");
  }, [experimentKey]);
  const matchesScope = (plan: ExperimentPlanVersion) => {
    if (!experimentKey) return true;
    if (reproductionScope) return plan.reproduction?.reproduction_id === reproductionScope;
    return Boolean(experiment && !plan.reproduction && plan.content.direction_id === experiment.direction_id && plan.content.scheme_id === experiment.scheme_id);
  };
  const matchesKind=(plan:ExperimentPlanVersion)=>matchesScope(plan)&&(kind==="all"||(kind==="reproduction")===Boolean(plan.reproduction));
  const showRun=(id?:string)=>onNavigate("experiments",{tab:"runs",action:"runs",focus:id,experiment:experimentKey});
  const selectedPlan=plans.find(p=>p.plan_id===planId&&p.version===planVersion),selectedRun=runs.find(r=>r.run_id===runId);
  const repositoryDetails=async()=>{const data=await request<NonNullable<typeof repoInfo>>(base,repositoryQuery("/repository/status"));if(alive.current)setRepoInfo(data);};
  const connectTerminal=async(sourceProfile=profileId,source?:TerminalSession,stayOnPage=false)=>{
    if(terminalConnecting.current)return;
    terminalConnecting.current=true;
    setConnecting(true);setError("");setNotice(source?"正在现有 SSH 连接中打开 Shell…":"正在建立 SSH 终端连接，不执行环境诊断…");
    try{const current=await request<{terminals:TerminalSession[]}>(base,"/terminals");
      if(!alive.current)return;
      setTerminalSessions(current.terminals);
      if(!source&&current.terminals.some(session=>session.profile_id===sourceProfile)){if(!stayOnPage&&autoDlOnly)setComputeTab("workspace");setNotice("已复用现有 SSH 连接。");return;}
      if(!source&&current.terminals.length)throw new Error("当前项目已连接其他主机，请在 AutoDL 连接中断开后切换。");
      if(current.terminals.length>=3)throw new Error("最多打开 3 个终端分屏，请先关闭不用的窗口。");
      if(source&&!current.terminals.some(session=>session.id===source.id))throw new Error("原终端已结束，请重新连接主机。");
      const result=source?await (async()=>{const response=await fetch(`${base}/terminals/${source.id}/split`,{method:"POST",headers:{"content-type":"application/json","x-terminal-token":source.token},body:JSON.stringify({confirm:true})});const value=await response.json();if(!response.ok)throw new Error(failures[value.error]??"无法在当前 SSH 连接中打开 Shell，请检查连接状态。");return value as {terminal:TerminalSession};})():await request<{terminal:TerminalSession}>(base,`/ssh-profiles/${sourceProfile}/connect`,{confirm:true});if(alive.current){setTerminalSessions(current=>[...current.filter(item=>item.id!==result.terminal.id),result.terminal]);window.dispatchEvent(new CustomEvent("trash-autodl-changed",{detail:{projectId}}));if(!stayOnPage&&autoDlOnly)setComputeTab("workspace");setNotice("");}}
    catch(cause){if(alive.current){setNotice("");setError(cause instanceof Error?cause.message:"终端连接失败。");if(!source)window.dispatchEvent(new CustomEvent("trash-autodl-open",{detail:{projectId,profileId:sourceProfile}}));}}
    finally{terminalConnecting.current=false;if(alive.current)setConnecting(false);}
  };
  const disconnectTerminals=async()=>{
    for(const session of terminalSessions){
      const response=await fetch(`${base}/terminals/${session.id}`,{method:"DELETE",headers:{"x-terminal-token":session.token}});
      if(!response.ok&&response.status!==404)throw new Error("部分终端未能断开，请检查服务状态后重试。");
      setTerminalSessions(current=>current.filter(item=>item.id!==session.id));
    }
    setNotice("SSH 连接已断开。");
  };
  const newPlan=(snapshot?:ReproductionSnapshot, head?:string)=>{
    if(!snapshot&&planJson&&!window.confirm("放弃当前未保存计划吗？"))return;
    setEditingPlan(undefined);setPlanJson(JSON.stringify({title:snapshot?`${snapshot.name} 复现实验`:experiment?.title??"新实验",...(experiment?{direction_id:experiment.direction_id,scheme_id:experiment.scheme_id}:{}),purpose:"",method:snapshot?.name??"",code_source:snapshot?"reproduction":"git",...(snapshot?{reproduction_id:snapshot.reproduction_id,snapshot_id:snapshot.snapshot_id}:repo?{repository_id:repo.repository_id}:{}),baseline:"",evaluation_protocol:"",commit_sha:snapshot?"":head??repoInfo?.head??"",profile_id:profileId,dataset_ids:datasets.filter(d=>d.profile_id===profileId&&(!d.transfer_status||d.transfer_status==="ready")).map(d=>d.dataset_id),python:"/root/miniconda3/bin/python",command:experiment&&!experiment.entrypoint?[]:["python",experiment?.entrypoint?"./"+experiment.entrypoint:"train.py"],env:{},config:{},seed:42,gpu:"0",timeout_seconds:7200,metrics_path:"outputs/metrics.json",expected_metrics:[{name:"f1",unit:"ratio"}],artifact_paths:[]},null,2));
  };
  const changePlan=async(patch:Record<string,string|undefined>)=>{
    const value=JSON.parse(planJson) as Record<string,unknown>;
    setPlanJson(JSON.stringify({...value,...patch},null,2));
  };
  let edited:Record<string,unknown>={};
  try{if(planJson)edited=JSON.parse(planJson)??{};}catch{/* Keep editing invalid JSON; controls report invalid input. */}
  const restoredSnapshot=useRef("");
  useEffect(()=>{
    if(!snapshotId){restoredSnapshot.current="";return;}
    if(loadingContext||busy||restoredSnapshot.current===snapshotId)return;
    const controller=new AbortController();
    void request<{snapshot:ReproductionSnapshot}>(base,`/reproduction-snapshots/${encodeURIComponent(snapshotId)}`,undefined,"GET",controller.signal).then(data=>{
      if(!controller.signal.aborted){restoredSnapshot.current=snapshotId;newPlan(data.snapshot);}
    }).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"无法读取复现快照。");});
    return()=>controller.abort();
  },[snapshotId,loadingContext,busy]);
  return <section className="experiments-page">
    {deleteInstance&&<AutoDlDeleteDialog projectId={projectId} profile={deleteInstance} onClose={()=>setDeleteInstance(undefined)} onDeleted={()=>{const deletedId=deleteInstance.profile_id;setDeleteInstance(undefined);setProfiles(items=>items.filter(item=>item.profile_id!==deletedId));if(profileId===deletedId){setProfileId("");}setNotice("实例配置与已保存密码已删除，远端实例未受影响。");void run(load);}}/>}
    {instanceDialog&&<AutoDlInstanceDialog projectId={projectId} mode={instanceDialog} profiles={profiles} initialId={profileId} onDelete={profile=>{setInstanceDialog(undefined);setDeleteInstance(profile);}} onClose={()=>setInstanceDialog(undefined)} onSaved={profile=>{setInstanceDialog(undefined);setProfileId(profile.profile_id);void run(async()=>{await load();setNotice("实例已保存。连接信息变化后，请重新核对主机指纹。");});}}/>}
    {directoryPicker&&<DirectoryPicker base={base} initialPath={repoPath} onClose={()=>setDirectoryPicker(false)} onSelect={path=>{setRepoPath(path);setDirectoryPicker(false);}}/>}
    <header className="experiment-section-header">
      <div className="experiment-section-title"><span><FlaskConical size={22} aria-hidden="true"/></span><h2>实验</h2></div>
      <nav className="experiment-tabs" aria-label="实验子页" onKeyDown={event=>{
        if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
        const buttons=Array.from(event.currentTarget.querySelectorAll("button"));
        const index=buttons.findIndex(button=>button===event.target);
        if(index<0)return;
        event.preventDefault();
        const target=event.key==="Home"?0:event.key==="End"?buttons.length-1:
          (index+(event.key==="ArrowRight"?1:buttons.length-1))%buttons.length;
        buttons[target]?.focus();
      }}>{experimentTabs.map(item=>{
        const Icon=experimentTabIcons[item.id];
        return <button type="button" key={item.id} aria-current={(experimentKey || section==="code" ? item.id==="catalog" : section===item.id)?"page":undefined}
          onClick={()=>{if(section!==item.id)onNavigate("experiments",{tab:item.id});}}>
          <Icon size={16} aria-hidden="true"/><span>{item.label}</span>
        </button>;
      })}</nav>
      <button type="button" className="icon-button experiment-section-refresh" disabled={busy} title="刷新实验配置" aria-label="刷新实验配置" onClick={()=>void run(load)}>
        <RefreshCw size={16} aria-hidden="true"/>
      </button>
    </header>
    {section==="catalog" && <ExperimentCatalog experiments={catalog} discovered={discovered} reproductions={reproductions} busy={busy}
      loading={loadingContext} recycle={recycleExperiment}
      create={(title, id) => saveCatalogExperiment("/experiment-catalog", { title, id })}
      register={name => saveCatalogExperiment("/experiment-catalog/register", { name, confirm:true })}
      open={item => onNavigate("experiments", {tab:"method", experiment:experimentKeyOf(item)})}
      openReproduction={id => onNavigate("experiments", {tab:"reproductions", focus:id, experiment:"reproduction:"+id})}/>}
    {experimentKey && <div className="experiment-detail-toolbar">
      <button type="button" className="text-button" onClick={() => onNavigate("experiments", {tab:"catalog"})}>返回实验列表</button>
      <h3>{experiment?.title ?? scopedReproduction?.name ?? (loadingContext ? "正在读取实验…" : "未找到实验")}</h3>
      {(experiment || scopedReproduction) && <div className="experiment-subnav">
        {experiment && <button type="button" className="secondary-button" aria-pressed={section==="method"}
          onClick={() => onNavigate("experiments", {tab:"method", experiment:experimentKey})}>方法设计</button>}
        <button type="button" className="secondary-button" aria-pressed={section==="code"||section==="reproductions"}
          onClick={() => onNavigate("experiments", {tab:experiment?"code":"reproductions", experiment:experimentKey, focus:reproductionScope})}>代码</button>
        <button type="button" className="secondary-button" aria-pressed={section==="runs"&&!showScopedResults}
          onClick={() => onNavigate("experiments", {tab:"runs", experiment:experimentKey})}>计划与运行</button>
        <button type="button" className="secondary-button" aria-pressed={showScopedResults}
          onClick={() => onNavigate("experiments", {tab:"runs", action:"experiment-results", experiment:experimentKey})}>结果</button>
      </div>}
    </div>}
    {section==="method" && experiment && <ExperimentMethod key={projectId+experimentKey} projectId={projectId}
      experimentKey={experimentKeyOf(experiment)} onOpenFile={focus=>onNavigate("files",{focus})}/>}
    {showScopedResults && <div className="experiment-runs">
      {runs.filter(item => matchesScope(item.plan) && item.result_id).map(item =>
        <button type="button" className="experiment-run" key={item.run_id}
          onClick={() => onNavigate("results", {focus:item.result_id})}>
          <strong>{item.plan.content.title}</strong><small>{item.created_at}</small>
        </button>)}
      {!runs.some(item => matchesScope(item.plan) && item.result_id) && <p className="quiet">此实验暂无已登记的运行结果。</p>}
    </div>}
    {section==="code" && experiment && repo && <div className="experiment-repository-location">
      <span>本地代码目录</span>
      <code>{repo.path}</code>
      <button type="button" className="secondary-button"
        onClick={() => void navigator.clipboard.writeText(repo.path).then(() => setNotice("已复制仓库路径。"))
          .catch(() => setError("浏览器不允许复制，请手动选择路径。"))}>复制路径</button>
    </div>}
    {section==="code"&&<nav className="experiment-subnav" aria-label="代码视图">{codeTabs.filter(item=>item.id!=="agent"||Boolean(experiment&&repo)).map(item=>
      <button type="button" className="secondary-button" key={item.id} aria-pressed={tab===item.id} onClick={()=>setCodeTab(item.id)}>{item.label}</button>
    )}</nav>}
    {autoDlOnly&&<nav className="experiment-subnav" aria-label="AutoDL 视图">{autoDlTabs.map(item=>
      <button type="button" className="secondary-button" key={item.id} aria-pressed={computeTab===item.id} onClick={()=>setComputeTab(item.id)}>{item.label}</button>
    )}</nav>}
    {section==="runs"&&!showScopedResults&&<div className="experiment-subnav">
      <button type="button" className="secondary-button" aria-pressed={showPlans} onClick={()=>{if(!showPlans)onNavigate("experiments",{tab:"runs",experiment:experimentKey});}}>计划</button>
      <button type="button" className="secondary-button" aria-pressed={showRuns} onClick={()=>{if(!showRuns)showRun(runId||undefined);}}>运行</button>
      {!experimentKey&&<select aria-label="实验类型" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}>
        <option value="all">全部</option><option value="git">自研</option><option value="reproduction">复现</option>
      </select>}
    </div>}
    {reproductionOnly&&action==="source"&&focusId&&<button type="button" className="text-button" onClick={()=>onNavigate("experiments",{tab:"reproductions"})}>查看全部复现</button>}
    {(reproductionOnly||reproductionVisited)&&<div hidden={!reproductionOnly}>
      <ReproductionCodes projectId={projectId} profiles={profiles} profileId={profileId}
        visible={reproductionOnly} focusId={reproductionOnly?focusId:undefined} bySource={action==="source"}
        connectedProfiles={terminalSessions.filter(session=>!session.ended).map(session=>session.profile_id)}
        connecting={connecting} onConnect={host=>connectTerminal(host,undefined,true)}
        onPlan={snapshot=>onNavigate("experiments",{tab:"runs",action:"reproduction-plan",focus:snapshot.snapshot_id,experiment:experimentKey?"reproduction:"+snapshot.reproduction_id:undefined})}/>
    </div>}
    {section==="datasets"&&<div className="data-page"><DatasetsPanel projectId={projectId}/></div>}
    {section==="results"&&<div className="data-page"><ExperimentalDataPanel projectId={projectId} runs={runs} active onNavigate={onNavigate} action={action} focusId={focusId} status={status}/></div>}
    {error&&<ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}{notice&&<div role="status" className="notice">{notice}</div>}
    {section==="code"&&!experimentKey&&repositoryList.length>0&&<div className="knowledge-toolbar">
      <label>代码仓库 <select aria-label="选择代码仓库" value={repo?.repository_id??""} disabled={busy} onChange={event=>{if(commitMessage&&!window.confirm("放弃未提交的说明并切换仓库吗？"))return;setSelectedRepositoryId(event.target.value);setRepoInfo(undefined);setHistory([]);setHistoryPage(1);setCommitMessage("");}}>{repositoryList.map(item=><option key={item.repository_id} value={item.repository_id}>{item.name??item.path}{item.repository_id===defaultRepositoryId?" · 默认":""}</option>)}</select></label>
      {repo&&repo.repository_id!==defaultRepositoryId&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await request(base,"/repositories",{repository_id:repo.repository_id},"PUT");setDefaultRepositoryId(repo.repository_id);})}>设为默认仓库</button>}
    </div>}
    {section==="code"&&(!experimentKey||experiment)&&<div hidden={tab!=="overview"} className="experiment-overview">
      {!experimentKey&&<form className="experiment-form" onSubmit={event=>{event.preventDefault();void run(async()=>{const value=await request<{repository:ProjectRepository}>(base,"/repositories",{path:repoPath,...(editor?{editor:{executable:editor,args:[]}}:{})},"POST");await load();setSelectedRepositoryId(value.repository.repository_id);setRepoPath("");setRepoInfo(undefined);setHistory([]);setNotice("仓库已绑定。");});}}><h3>添加本地 Git 仓库</h3><label htmlFor="experiment-repository-path">本地 Git 仓库根目录</label><div className="repository-path-control"><input id="experiment-repository-path" required value={repoPath} onChange={e=>setRepoPath(e.target.value)} placeholder="/home/user/research-code"/><button type="button" className="secondary-button" disabled={busy} onClick={()=>setDirectoryPicker(true)}><FolderOpen size={15}/>浏览目录</button></div><label>本地编辑器可执行文件（可选）<input value={editor} onChange={e=>setEditor(e.target.value)} placeholder="code"/></label><button className="primary-button" disabled={busy}>绑定仓库</button></form>}
      {!experimentKey&&repo&&<CodeAgentPanel key={projectId+repo.path} projectId={projectId} repositoryPath={repo.path} repositoryId={repo.repository_id}/>}
      {repo&&<><div className="knowledge-toolbar">{!experiment&&<span>{repo.path}</span>}<button className="secondary-button" disabled={busy} onClick={()=>void run(repositoryDetails)}>Git 状态与差异</button>{!experiment&&<button className="secondary-button" onClick={()=>void navigator.clipboard.writeText(repo.path).then(()=>setNotice("已复制仓库路径")).catch(()=>setError("浏览器不允许复制，请手动选择路径。"))}>复制路径</button>}<button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await request(base,repositoryQuery("/repository/editor"),{});setNotice("已请求打开配置的编辑器。");})}>打开本地编辑器</button></div>
      {repoInfo&&<><p>提交：<code>{repoInfo.head||"尚无提交"}</code> · {repoInfo.clean?"工作树干净":"存在未提交或未跟踪文件"}</p><details open><summary>工作树状态</summary><pre>{repoInfo.status||"无改动"}</pre></details><details><summary>未暂存差异</summary><pre>{repoInfo.diff||"无差异"}</pre></details><details><summary>已暂存差异</summary><pre>{repoInfo.staged_diff||"无差异"}</pre></details></>}
      <form className="experiment-inline" onSubmit={e=>{e.preventDefault();void run(async()=>{await request(base,repositoryQuery("/repository/commit"),{message:commitMessage});setCommitMessage("");await repositoryDetails();setNotice("提交已创建，未推送。");});}}><input aria-label="代码提交说明" required value={commitMessage} onChange={e=>setCommitMessage(e.target.value)} placeholder="提交说明；只提交本地已暂存的内容"/><button className="secondary-button" disabled={busy||!commitMessage.trim()}>确认提交暂存区</button></form>
      <div className="knowledge-toolbar"><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setHistory((await request<{commits:typeof history}>(base,repositoryQuery(`/repository/history?page=${historyPage}`))).commits);})}>读取历史第 {historyPage} 页</button><button disabled={historyPage===1} onClick={()=>setHistoryPage(historyPage-1)}>上一页</button><button onClick={()=>setHistoryPage(historyPage+1)}>下一页</button></div>{history.map(item=><div className="experiment-history" key={item.sha}><code>{item.sha}</code><span>{item.title}</span><small>{item.at}</small></div>)}
      </>}
    </div>}
    {section==="code"&&experiment&&repo&&<div hidden={tab!=="agent"}>
      <CodeAgentPanel key={experimentKey+repo.repository_id} projectId={projectId} repositoryPath={repo.path}
        repositoryId={repo.repository_id} experiment={experiment}/>
    </div>}
    {section==="code"&&tab==="code"&&(repo?<><div className="knowledge-toolbar"><ExperimentCodeUpload projectId={projectId} repositoryId={repo.repository_id} profiles={profiles} profileId={profileId} connectedProfiles={terminalSessions.filter(item=>!item.ended).map(item=>item.profile_id)}/></div><RepositoryBrowser key={projectId+repo.repository_id} projectId={projectId} repositoryPath={repo.path} repositoryId={repo.repository_id}/></>:<div className="repository-unbound"><FolderOpen size={32}/><h3>尚未绑定代码仓库</h3><p>{experimentKey ? "这个旧实验没有可用的默认仓库。新建自研实验时会自动初始化仓库。" : "先绑定本地 Git 仓库，再浏览目录和代码。"}</p>{!experimentKey&&<button type="button" className="primary-button" onClick={()=>setCodeTab("overview")}>管理仓库</button>}</div>)}
    {autoDlOnly&&tab==="hosts"&&<section id="autodl-instance-information"><h3>AutoDL 信息</h3>
      <div className="autodl-instance-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>setInstanceDialog("add")}><Plus size={15}/>添加已有实例</button><button type="button" className="secondary-button" disabled={busy||!profiles.length} onClick={()=>setInstanceDialog("edit")}><Pencil size={14}/>编辑已有实例</button></div>
      <div className="experiment-form autodl-host-main"><h3>项目实例</h3><p>选择主机、SSH 连接与环境诊断已移至内容顶栏的“AutoDL 连接”。</p><button type="button" className="secondary-button" onClick={()=>window.dispatchEvent(new CustomEvent("trash-autodl-open",{detail:{projectId}}))}>打开 AutoDL 连接</button>{profiles.map(profile=><p key={profile.profile_id}><strong>{profile.name}</strong> · {profile.host}:{profile.port}{terminalSessions.some(session=>!session.ended&&session.profile_id===profile.profile_id)?" · 已连接":""}</p>)}</div>

    </section>}

    {autoDlOnly&&tab==="settings"&&<RemoteWorkspaceSettings projectId={projectId} profiles={profiles} profileId={profileId} connectedProfiles={terminalSessions.filter(item=>!item.ended).map(item=>item.profile_id)}/>}
    <div hidden={!autoDlOnly||tab!=="workspace"}><AutoDlUpload projectId={projectId} session={terminalSessions.find(session=>!session.ended)}/></div>
    <div hidden={!autoDlOnly||tab!=="workspace"} className="autodl-workspace">
      {terminalSessions.length>0?<><div className="autodl-workspace-heading"><div><strong>{terminalSessions[0]?.name} · AutoDL 终端</strong><span>{terminalSessions.length} / 3 个独立窗口</span></div><div><span>Shift + Alt + D 分屏 · 右键复制选区</span><button type="button" className="secondary-button" disabled={connecting||terminalSessions.length>=3||!terminalSessions.some(item=>!item.ended)} onClick={()=>{const source=terminalSessions.find(item=>!item.ended);if(source)void connectTerminal(source.profile_id,source);}}><Columns2 size={14}/>分屏</button><button type="button" className="secondary-button" disabled={busy||connecting} onClick={()=>void run(disconnectTerminals)}>断开连接</button></div></div><div className={`autodl-terminal-grid panes-${terminalSessions.length}`}>{terminalSessions.map((session,index)=><AutoDlTerminal key={session.id} projectId={projectId} session={session} number={index+1} splitDisabled={connecting||terminalSessions.length>=3||Boolean(session.ended)} onSplit={()=>void connectTerminal(session.profile_id,session)} onDisconnect={()=>{setTerminalSessions(current=>current.filter(item=>item.id!==session.id));setNotice("终端窗口已关闭。");}} onEnded={()=>setTerminalSessions(current=>current.map(item=>item.id===session.id?{...item,ended:true}:item))}/>)}</div></>:<div className="repository-unbound"><FolderOpen size={32}/><h3>AutoDL 工作区</h3><p>点击内容顶栏“AutoDL 连接”选择主机，连接后即可在这里操作终端。</p><button type="button" className="primary-button" onClick={()=>window.dispatchEvent(new CustomEvent("trash-autodl-open",{detail:{projectId}}))}>AutoDL 连接</button></div>}

    </div>
    {!autoDlOnly&&tab==="plans"&&<>
      <div className="knowledge-toolbar"><button className="primary-button" disabled={busy||!repo||!profileId} onClick={()=>void run(async()=>{const status=await request<{head:string}>(base,repositoryQuery("/repository/status"));newPlan(undefined,status.head);})}>新建计划</button><select aria-label="选择实验主机" value={profileId} onChange={e=>setProfileId(e.target.value)}><option value="">选择主机</option>{profiles.map(p=><option key={p.profile_id} value={p.profile_id}>{p.name}</option>)}</select><span>{reproductionScope?"从此复现的代码工作区发起新计划。":experimentKey&&!repo?"该实验暂无可用的默认仓库。":"选择仓库和主机后可创建计划。"}</span></div>
      {planJson&&<div className="experiment-form"><h3>{editingPlan?`修订 ${editingPlan.content.title} v${editingPlan.version}`:"新计划"}</h3>
      {!experimentKey&&edited.code_source!=="reproduction"&&<label>实验代码仓库<select value={String(edited.repository_id??editingPlan?.repository.repository_id??"")} onChange={event=>{
        const id=event.target.value;void run(async()=>{
          if(!id){await changePlan({repository_id:undefined,commit_sha:""});return;}
          const result=await request<{head:string}>(base,"/repository/status?repository_id="+encodeURIComponent(id));
          await changePlan({repository_id:id,commit_sha:result.head});
        });
      }}><option value="">选择项目仓库</option>{repositoryList.map(item=><option key={item.repository_id} value={item.repository_id}>{item.name??item.path}</option>)}</select></label>}
      {!experimentKey&&<label>实验档案目录<select value={edited.direction_id&&edited.scheme_id?`${edited.direction_id}/${edited.scheme_id}`:""} onChange={event=>{const [direction_id,scheme_id]=event.target.value.split("/");void run(()=>changePlan({direction_id:direction_id||undefined,scheme_id:scheme_id||undefined}));}}>
        <option value="">暂不关联方案目录</option>{schemes.map(item=><option key={item.direction_id+"/"+item.scheme_id} value={item.direction_id+"/"+item.scheme_id}>{item.direction_id}/{item.scheme_id}</option>)}
      </select></label>}<textarea className="experiment-json" aria-label="实验计划 JSON" value={planJson} onChange={e=>setPlanJson(e.target.value)}/><p>命令以数组保存，使用 TRASH_OUTPUT_DIR 写产物。准备脚本使用 preparation_script 相对路径单独授权。{experiment&&" 自研实验的运行命令使用代码 Agent 提供的实际入口。"}</p><button className="primary-button" disabled={busy} onClick={()=>void run(async()=>{await request(base,"/experiment-plans",{...(editingPlan?{plan_id:editingPlan.plan_id,base_version:editingPlan.version}:{base_version:0}),content:{...JSON.parse(planJson),...(experiment?{direction_id:experiment.direction_id,scheme_id:experiment.scheme_id,repository_id:editingPlan?.repository.repository_id??repo?.repository_id,code_source:"git"}:{})}});setPlanJson("");setEditingPlan(undefined);await load();setNotice("计划草稿已保存。");})}>保存新版本</button><button className="secondary-button" onClick={()=>{if(window.confirm("放弃未保存的计划吗？"))setPlanJson("");}}>放弃编辑</button></div>}
      {!plans.some(matchesKind)&&!planJson&&<p className="quiet">此范围暂无计划。</p>}
      {plans.filter(matchesKind).map(plan=><article className="experiment-card" key={`${plan.plan_id}:${plan.version}`}><h3>{plan.content.title} · v{plan.version} · {{draft:"草稿",confirmed:"已确认",superseded:"已替代"}[plan.status]}</h3><p>{plan.content.method} · {plan.profile.host}:{plan.profile.port}</p><code>{plan.content.commit_sha}</code><pre>{JSON.stringify(plan.content.command)}</pre><MethodSnapshot key={plan.method_sha256} plan={plan}/><div className="knowledge-toolbar"><button className="secondary-button" onClick={()=>{if(planJson&&!window.confirm("放弃当前编辑？"))return;setEditingPlan(plan);setPlanJson(JSON.stringify({...plan.content,...(!plan.reproduction?{repository_id:plan.repository.repository_id}:{})},null,2));}}>修订</button><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setDiagnostic(JSON.stringify(await request(base,`/experiment-plans/${plan.plan_id}/preflight`,{version:plan.version}),null,2));setPlanId(plan.plan_id);setPlanVersion(plan.version);})}>环境预检查</button><button className="secondary-button" disabled={busy||plan.status!=="draft"} onClick={()=>void run(async()=>{await request(base,`/experiment-plans/${plan.plan_id}/confirm`,{version:plan.version,confirm:true});await load();setNotice("计划已确认，提交运行前仍会展示完整执行清单。");})}>确认此计划版本</button>{plan.content.preparation_script&&<button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setScript(JSON.stringify(await request(base,`/experiment-plans/${plan.plan_id}/preparation`,{version:plan.version}),null,2));setPlanId(plan.plan_id);setPlanVersion(plan.version);})}>查看准备脚本</button>}<button className="primary-button" disabled={plan.status!=="confirmed"} onClick={()=>{setSubmission({plan,preparation:false,key:crypto.randomUUID()});setAck(false);}}>提交实验</button>{plan.content.preparation_script&&<button className="secondary-button" disabled={plan.status!=="confirmed"||!script||planId!==plan.plan_id||planVersion!==plan.version} onClick={()=>{setSubmission({plan,preparation:true,key:crypto.randomUUID()});setAck(false);}}>单独授权环境准备</button>}</div></article>)}{diagnostic&&<pre>{diagnostic}</pre>}{script&&<details open><summary>准备脚本原文与提交版本</summary><pre>{script}</pre></details>}{selectedPlan&&<p>当前查看：{selectedPlan.content.title} v{selectedPlan.version}</p>}
    </>}
    {!autoDlOnly&&showRuns&&<>
      <div className="experiment-runs">{runs.filter(value=>matchesKind(value.plan)).map(value=><button className={`experiment-run ${runId===value.run_id?"selected":""}`} key={value.run_id} onClick={()=>showRun(value.run_id)}><strong>{value.preparation?"环境准备：":""}{value.plan.content.title}</strong><span>{stateNames[value.status]}</span><small>{value.created_at}</small></button>)}</div>
      {selectedRun&&matchesKind(selectedRun.plan)&&<article className="experiment-card"><h3>{selectedRun.plan.content.title}</h3><p>运行：{selectedRun.run_id}</p>{selectedRun.archive_path&&onBrowseArchive&&<button type="button" className="text-button" onClick={()=>onBrowseArchive(selectedRun.archive_path!)}>打开运行档案</button>}{selectedRun.archive_error&&<p role="status">{selectedRun.archive_error}</p>}<p>进程：{selectedRun.process_status??stateNames[selectedRun.status]} · 退出码：{selectedRun.exit_code??"尚未确认"}</p><p>{selectedRun.collection_status} · {selectedRun.metrics_status}</p>{selectedRun.error&&<ErrorNotice >{selectedRun.error}</ErrorNotice>}<div className="knowledge-toolbar"><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setDetails(JSON.stringify(await request(base,`/experiment-runs/${runId}`),null,2));})}>运行清单与事件</button><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await request(base,`/experiment-runs/${runId}/reconnect`,{});await load();})}>重新连接确认状态</button>{!terminal.includes(selectedRun.status)?<button className="secondary-button" disabled={busy} onClick={()=>{if(window.confirm("请求停止此远端实验？"))void run(async()=>{await request(base,`/experiment-runs/${runId}/cancel`,{});await load();});}}>取消运行</button>:<><button className="secondary-button" disabled={busy} onClick={()=>{if(window.confirm("按原计划创建新的实验运行？将使用远端算力。"))void run(async()=>{await request(base,`/experiment-runs/${runId}/retry`,{confirm:true});await load();});}}>确认重试</button><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{await request(base,`/experiment-runs/${runId}/collect`,{});await load();})}>重新收集</button></>}{selectedRun.result_id&&<button className="primary-button" onClick={()=>onNavigate("results",{focus:selectedRun.result_id})}>查看实验结果</button>}</div>
      <div className="experiment-subnav" aria-label="运行详情">
        <button type="button" className="secondary-button" aria-pressed={runDetail==="logs"} onClick={()=>setRunDetail("logs")}>日志</button>
        <button type="button" className="secondary-button" aria-pressed={runDetail==="artifacts"} onClick={()=>setRunDetail("artifacts")}>产物</button>
      </div>
      {runDetail==="logs"&&<><div className="knowledge-toolbar"><select aria-label="日志类型" value={stream} onChange={e=>{setStream(e.target.value);setLogOffset(0);setLogs("");}}><option value="stdout">标准输出</option><option value="stderr">标准错误</option></select><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{const data=await request<{text:string;offset:number;rotated:boolean}>(base,`/experiment-runs/${runId}/logs?stream=${stream}&offset=${logOffset}`);setLogs(old=>(old+(data.rotated?"\n[日志发生轮转，可能已截断]\n":"")+data.text).slice(-1024*1024));setLogOffset(data.offset);})}>读取增量日志</button></div><pre className="experiment-log">{logs||"选择日志类型后读取。"}</pre><details><summary>任务事件和清单</summary><pre>{details}</pre></details></>}
      {runDetail==="artifacts"&&<><p>远端目录：{selectedRun.remote_dir}</p>{selectedRun.artifacts.map(a=><div className="experiment-artifact" key={a.path}><strong>{a.path}</strong><span>{a.size_bytes} bytes</span><code>{a.sha256}</code>{a.artifact_id&&a.downloaded?<a className="secondary-button" href={`${base}/experiment-artifacts/${runId}/${a.artifact_id}`}><Download size={13}/>下载</a>:<span>远端引用 · {a.reason}</span>}</div>)}</>}
      </article>}{!runs.some(value=>matchesKind(value.plan))&&<p>{runs.length?"当前筛选下没有运行记录。":"暂无实验运行，请先配置仓库、主机和计划。"}</p>}
    </>}
    {submission&&<ModalLayer><div className="modal-backdrop"><div className="modal experiment-submit" role="dialog" aria-modal="true" aria-labelledby="experiment-confirm"><h2 id="experiment-confirm">{submission.preparation?"确认执行环境准备脚本":"确认提交远端实验"}</h2><p>目标：{submission.plan.profile.username}@{submission.plan.profile.host}:{submission.plan.profile.port}</p><p>{submission.plan.reproduction?"本次上传已固定的复现代码 ZIP 快照，通过 SHA-256 校验，不需要 Git。":"代码将包含指定提交的 Git 历史，通过 SFTP 传输，最多 200 MiB。请确认历史中没有敏感资料。"}</p><pre>{JSON.stringify({...(submission.plan.reproduction?{reproduction:submission.plan.reproduction.name,snapshot:submission.plan.reproduction.snapshot_id,sha256:submission.plan.reproduction.sha256}:{commit:submission.plan.content.commit_sha}),remote_root:submission.plan.profile.remote_root,python:submission.plan.content.python,command:submission.plan.content.command,datasets:submission.plan.datasets,env:submission.plan.content.env,config:submission.plan.content.config,gpu:submission.plan.content.gpu,timeout_seconds:submission.plan.content.timeout_seconds,outputs:submission.plan.content.artifact_paths,...(submission.preparation?{preparation_script:submission.plan.content.preparation_script}:{} )},null,2)}</pre>{submission.preparation&&<pre>{script}</pre>}<label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>我已核对目标、命令、代码历史与运行时限，授权本次执行。</label>{error&&<ErrorNotice >{error}</ErrorNotice>}<div className="modal-actions"><button className="secondary-button" autoFocus disabled={busy} onClick={()=>setSubmission(undefined)}>取消</button><button className="primary-button" disabled={!ack||busy} onClick={()=>void run(async()=>{const data=await request<{run:ExperimentRun}>(base,"/experiment-runs",{plan_id:submission.plan.plan_id,version:submission.plan.version,idempotency_key:submission.key,preparation:submission.preparation,confirm:true});setRunId(data.run.run_id);setSubmission(undefined);setPlanJson("");clearDirty();await load();showRun(data.run.run_id);})}><Play size={14}/>确认执行</button></div></div></div></ModalLayer>}
  </section>;
}
