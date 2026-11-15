import {themes,savedTheme,applyTheme,resolveTheme} from './theme.js';
import {KnowledgeBaseWorkspace} from './knowledge-base.js';
import { TaskWorkspace } from './task-workspace.js';
import { PdfReader } from "./pdf-reader.js";
import { MarkdownKnowledgePanel } from "./markdown-knowledge.js";
import { ProjectFilesPage } from "./project-files.js";
import { ProjectWorkspaceDialog } from "./project-workspace.js";
import { BackgroundDatasetTransfers } from "./background-dataset-upload.js";
import { DataPage } from "./data.js";
import { AutoDlConnectionStatus } from "./autodl-connection-status.js";
import { AutoDlConnectionDialog } from "./autodl-connection-dialog.js";
import { ErrorNotice } from "./error-notice.js";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Database, Server, ArrowLeft, ChartColumn, FlaskConical, Layers, LayoutDashboard, ListTodo, MessagesSquare, NotebookText, PanelLeftOpen, BookOpen, ChevronDown, Download, FolderOpen, Menu, MoreHorizontal, Palette, PanelLeftClose, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { ProjectPage, ResearchProject, Source } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { KnowledgePanel, RestoreKnowledge } from "./knowledge.js";
import { LiteraturePage } from "./literature.js";
import { ExperimentsPage } from "./experiments.js";
import { ProjectChat } from "./project-chat.js";
import { OverviewPage } from "./overview.js";
import { CreateProjectDialog, DeleteProjectDialog } from "./project-dialogs.js";
import { DirtyContext, parseProjectRoute, projectPages, projectPath, readPreference, useWorkspaceNavigation, writePreference } from "./navigation.js";
import "./styles.css";
import "./themes.css";
import "./workspace.css";

const pageIcons:Record<ProjectPage,typeof BookOpen>={overview:LayoutDashboard,literature:BookOpen,cards:Layers,wiki:NotebookText,data:Database,reproductions:FolderOpen,experiments:FlaskConical,autodl:FolderOpen,results:ChartColumn,paper:NotebookText,files:FolderOpen,tasks:ListTodo,chat:MessagesSquare};

type NavigateOptions={action?:string;focus?:string;status?:string};
function rememberedPage(id:string):ProjectPage {
  const stored=readPreference(`trash-project-page:${id}`);
  if(stored==="results")return "results";
  return projectPages.find(page=>page.id===stored)?.id??"overview";
}
function ThemeControl() {
  const [theme,setTheme]=useState(savedTheme);
  useEffect(()=>{applyTheme(theme);},[theme]);
  return <label className="theme-control"><Palette size={15}/><span className="sr-only">界面主题</span><select aria-label="界面主题" value={theme} onChange={e=>setTheme(resolveTheme(e.target.value))}>{themes.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>;
}
function KnowledgePage({projectId,page,action,focusId,status,onNavigate}:{projectId:string;page:Exclude<ProjectPage,"overview"|"literature"|"experiments"|"reproductions"|"autodl"|"chat"|"paper"|"data"|"files">;action?:string;focusId?:string;status?:string;onNavigate:(page:ProjectPage,options?:NavigateOptions)=>void}) {
  const [sources,setSources]=useState<Source[]>();const [error,setError]=useState("");
  useEffect(()=>{let active=true;void api<{sources:Source[]}>(`/projects/${encodeURIComponent(projectId)}/sources`).then(data=>{if(active)setSources(data.sources);}).catch(cause=>{if(active)setError(uiError(cause,"无法读取项目文献。"));});return()=>{active=false;};},[projectId]);
  if(error)return <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>;
  if(!sources)return <div className="page-loading">正在加载项目资料…</div>;
  if(page==='tasks')return <TaskWorkspace key={projectId} projectId={projectId} focusId={focusId}/>;
  if(page==='cards'||page==='wiki')return <KnowledgeBaseWorkspace projectId={projectId} sources={sources} focusId={focusId} onNavigate={onNavigate}/>;
  const section={cards:"literature-cards",wiki:"wiki-pages",results:"experiment-results",tasks:"knowledge-tasks"} as const;
  return <KnowledgePanel projectId={projectId} sources={sources} section={section[page]} action={action} focusId={focusId} initialStatus={status} onNavigate={onNavigate}/>;
}
const literatureModules = [
  { id: "literature", label: "文献", icon: BookOpen },
  { id: "search", label: "搜索文献", icon: Search },
  { id: "wiki", label: "知识库", icon: NotebookText }
] as const;
function LiteratureModules({projectId,page,action,focusId,status,onNavigate,onChanged}:{projectId:string;page:"literature"|"cards"|"wiki";action?:string;focusId?:string;status?:string;onNavigate:(page:ProjectPage,options?:NavigateOptions)=>void;onChanged:()=>void}) {
  const id=useId();
  const selected=page==="literature"?(action==="search"?"search":"literature"):"wiki";
  const select=(module:typeof literatureModules[number]['id'])=>onNavigate(module==="search"?"literature":module,module==="search"?{action:"search"}:undefined);
  return <section className="data-page literature-workspace">
    <div className="data-heading"><span className="data-symbol"><BookOpen size={25}/></span><div><h2>文献</h2><p>管理原始文献，沉淀卡片、研究记忆与知识主题。</p></div></div>
    <nav className="data-module-tabs" role="tablist" aria-label="文献子模块">{literatureModules.map((item,index)=><button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel`} aria-selected={selected===item.id} tabIndex={selected===item.id?0:-1} className={selected===item.id?'active':''} onClick={()=>select(item.id)} onKeyDown={event=>{
      let next:number;
      if(event.key==='ArrowRight')next=(index+1)%literatureModules.length;
      else if(event.key==='ArrowLeft')next=(index+literatureModules.length-1)%literatureModules.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=literatureModules.length-1;
      else return;
      event.preventDefault();const target=literatureModules[next];select(target.id);
      document.getElementById(`${id}-tab-${target.id}`)?.focus();
    }}><item.icon size={16}/>{item.label}</button>)}</nav>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${selected}`} tabIndex={0}>
      {page==="literature"?<LiteraturePage projectId={projectId} action={action} focusId={focusId} onChanged={onChanged} searchOnly={selected==="search"} onOpenSource={source=>onNavigate("literature",{focus:source.source_id})}/>:<KnowledgePage projectId={projectId} page={page} action={action} focusId={focusId} status={status} onNavigate={onNavigate}/>}
    </div>
  </section>;
}
function App() {
  const {path,navigate,register,canLeave,leaveDialog}=useWorkspaceNavigation();
  const route=parseProjectRoute(path);
  const [projects,setProjects]=useState<ResearchProject[]>([]);const [loaded,setLoaded]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [notice,setNotice]=useState("");
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const [autoDlOpen,setAutoDlOpen]=useState(false);
  const [autoDlProfile,setAutoDlProfile]=useState<string>();
  const [query,setQuery]=useState("");const [createOpen,setCreateOpen]=useState(false);const [deleteTarget,setDeleteTarget]=useState<ResearchProject>();
  const [sidebarLayer,setSidebarLayer]=useState<"projects"|"project">(()=>route?"project":"projects");
  const [hidden,setHidden]=useState(()=>readPreference("trash-sidebar-hidden")==="true");
  const [narrow,setNarrow]=useState(()=>window.matchMedia("(max-width: 899px)").matches);const [drawer,setDrawer]=useState(false);const [newMenu,setNewMenu]=useState(false);const [projectMenu,setProjectMenu]=useState(false);
  const toggleRef=useRef<HTMLButtonElement>(null);const sidebarRef=useRef<HTMLElement>(null);const requestId=useRef(0);const mounted=useRef(true);
  const project=projects.find(item=>item.project_id===route?.projectId);
  const page=route?.page??"overview";
  useEffect(()=>{setSidebarLayer(project?"project":"projects");setNewMenu(false);},[project?.project_id]);
  const refresh=useCallback(async()=>{
    const current=++requestId.current;setLoading(true);
    try {const data=await api<{projects:ResearchProject[]}>("/projects");if(mounted.current&&current===requestId.current){setProjects(data.projects);setLoaded(true);setError("");}return data.projects;}
    catch(cause){if(mounted.current&&current===requestId.current)setError(uiError(cause,"无法加载项目，请重试。"));return undefined;}
    finally{if(mounted.current&&current===requestId.current)setLoading(false);}
  },[]);
  useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;requestId.current++;};},[refresh]);
  useEffect(()=>{const media=window.matchMedia("(max-width: 899px)");const change=()=>{setNarrow(media.matches);setDrawer(false);};media.addEventListener("change",change);return()=>media.removeEventListener("change",change);},[]);
  useEffect(()=>{writePreference("trash-sidebar-hidden",String(hidden));},[hidden]);
  useEffect(()=>{document.documentElement.dataset.theme=readPreference("trash-theme")==="blue"?"blue":"default";},[]);
  useEffect(()=>{
    if(!loaded)return;
    if(path==="/"){
      const last=parseProjectRoute(readPreference("trash-last-location")??"/");
      const target=projects.find(item=>item.project_id===last?.projectId);
      if(target)navigate(projectPath(target.project_id,last?.projectId===target.project_id?(last.page??rememberedPage(target.project_id)):rememberedPage(target.project_id)),true,true);
    }else if(project&&route&&!route.page)navigate(projectPath(project.project_id,rememberedPage(project.project_id)),true,true);
  },[loaded,projects,path,navigate]);
  useEffect(()=>{
    if(!project||!route?.page)return;
    writePreference("trash-last-location",projectPath(project.project_id,route.page));writePreference(`trash-project-page:${project.project_id}`,route.page);writePreference(`trash-project-visited:${project.project_id}`,String(Date.now()));
  },[project?.project_id,route?.page]);
  const closeDrawer=useCallback(()=>{setDrawer(false);requestAnimationFrame(()=>toggleRef.current?.focus());},[]);
  useEffect(()=>{
    if(!narrow||!drawer)return;
    sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){closeDrawer();return;}
      if(event.key!=="Tab")return;
      const controls=Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]')??[]).filter(el=>el.getClientRects().length);
      const first=controls[0],last=controls[controls.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",trap);return()=>document.removeEventListener("keydown",trap);
  },[narrow,drawer,closeDrawer]);
  const go=(id:string,next:ProjectPage=rememberedPage(id),options?:NavigateOptions)=>{
    const nextPath=projectPath(id,next,options);
    if(navigate(nextPath)){setSidebarLayer("project");void refresh();setProjectMenu(false);setNewMenu(false);if(narrow)closeDrawer();}
  };
  const goPage=(next:ProjectPage,options?:NavigateOptions)=>{if(project)go(project.project_id,next,options);};
  const openCreate=()=>{const proceed=()=>{setCreateOpen(true);setNewMenu(false);if(narrow)setDrawer(false);};if(canLeave(proceed))proceed();};
  const created=(value:ResearchProject)=>{
    setCreateOpen(false);setProjects(old=>[value,...old.filter(item=>item.project_id!==value.project_id)]);setLoaded(true);navigate(projectPath(value.project_id,"overview"),false,true);void refresh();
  };
  const deleted=(cleanupPending:boolean)=>{
    if(!deleteTarget)return;
    const remaining=projects.filter(item=>item.project_id!==deleteTarget.project_id);
    setProjects(remaining);setDeleteTarget(undefined);setProjectMenu(false);
    setNotice(cleanupPending?"项目记录已删除，部分本地文件已保留，请核对原项目工作区及 deleted-projects 目录后手动清理。":"项目及本地资料已删除。");
    const recent=[...remaining].sort((a,b)=>Number(readPreference(`trash-project-visited:${b.project_id}`)??0)-Number(readPreference(`trash-project-visited:${a.project_id}`)??0))[0];
    navigate(recent?projectPath(recent.project_id,rememberedPage(recent.project_id)):"/",true,true);void refresh();
  };
  const exportProject=async()=>{
    if(!project)return;setProjectMenu(false);
    try {const data=await api(`/projects/${encodeURIComponent(project.project_id)}/knowledge-export`);const blob=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=blob;a.download="project-knowledge.json";a.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);}
    catch(cause){setError(uiError(cause,"项目导出失败，请重试。"));}
  };
  const visible=!narrow&&!hidden||narrow&&drawer;
  const compact=!narrow&&hidden;
  const showSidebar=!narrow||drawer;
  const inside=sidebarLayer==="project"&&Boolean(project);
  const filtered=projects.filter(item=>`${item.title}\n${item.research_question}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(()=>{setAutoDlOpen(false);},[route?.projectId]);
  useEffect(()=>{const open=(event:Event)=>{const detail=(event as CustomEvent<{projectId:string;profileId?:string}>).detail;if(detail?.projectId===project?.project_id){setAutoDlProfile(detail.profileId);setAutoDlOpen(true);}};window.addEventListener("trash-autodl-open",open);return()=>window.removeEventListener("trash-autodl-open",open);},[project?.project_id]);
  return <DirtyContext.Provider value={register}><div className={`workspace-shell ${compact?"with-rail":visible?"with-sidebar":"without-sidebar"}`}>
    {narrow&&drawer&&<button className="workspace-shade" aria-label="关闭项目导航" onClick={closeDrawer}/>}
    {showSidebar&&<aside id="project-navigation" ref={sidebarRef} className={`project-sidebar ${narrow?"drawer":""} ${compact?"compact":""}`} role={narrow?"dialog":undefined} aria-modal={narrow?true:undefined} aria-label="项目导航">
      <div className="sidebar-brand">{!compact&&<span className="brand"><span className="brand-mark">t.</span><span>trash</span></span>}<button className="icon-button" title={compact?"展开导航":"隐藏导航"} aria-label={compact?"展开导航":"隐藏导航"} onClick={()=>narrow?closeDrawer():setHidden(!hidden)}>{compact?<PanelLeftOpen size={18}/>:<PanelLeftClose size={17}/>}</button></div>
      {inside&&project?<>
        <button type="button" className="sidebar-back" title="返回项目列表" aria-label="返回项目列表" onClick={()=>{setSidebarLayer("projects");setNewMenu(false);requestAnimationFrame(()=>sidebarRef.current?.querySelector<HTMLElement>('.sidebar-search input,.sidebar-create button')?.focus());}}><ArrowLeft size={16}/><span>返回项目列表</span></button>
        <div className="sidebar-current-project" title={project.title}><span className="sidebar-current-symbol" aria-hidden="true">{project.title.slice(0,1)}</span><div><small>当前项目</small><strong>{project.title}</strong></div></div>
        <nav className="sidebar-page-list" aria-label="项目功能">{projectPages.filter(item=>item.id!=="cards"&&item.id!=="wiki").map(item=>{const Icon=pageIcons[item.id];return <button type="button" key={item.id} className={`sidebar-page-link ${(page===item.id||(item.id==="literature"&&(page==="cards"||page==="wiki")))?"active":""}`} aria-current={(page===item.id||(item.id==="literature"&&(page==="cards"||page==="wiki")))?"page":undefined} aria-label={item.label} title={item.label} onClick={()=>goPage(item.id)}><Icon size={18}/><span>{item.label}</span></button>;})}</nav>
      </>:<>
        <div className="sidebar-create"><button className="primary-button" aria-label="新建项目" title="新建项目" onClick={openCreate}><Plus size={16}/><span>新建项目</span></button>{!compact&&<button className="secondary-button" aria-label="更多项目操作" aria-expanded={newMenu} onClick={()=>{if(!newMenu&&!canLeave(()=>setNewMenu(true)))return;setNewMenu(!newMenu);}}><ChevronDown size={15}/></button>}</div>
        {newMenu&&!compact&&<div className="sidebar-secondary"><RestoreKnowledge onRestored={(restored)=>{void refresh().then(()=>{if(restored)navigate(projectPath(restored.project_id,"overview"),false,true);});setNewMenu(false);}}/></div>}
        {!compact&&<label className="sidebar-search"><Search size={15}/><input aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={event=>setQuery(event.target.value)}/></label>}
        <div className="sidebar-list-heading"><span>研究项目</span><span>{projects.length}</span><button className="icon-button" title="刷新项目" aria-label="刷新项目" disabled={loading} onClick={()=>void refresh()}><RefreshCw size={13} className={loading?"spin":""}/></button></div>
        <nav className="sidebar-project-list" aria-label="研究项目">{(compact?projects:filtered).map(item=><button key={item.project_id} className={`sidebar-project-link ${project?.project_id===item.project_id?"selected":""}`} aria-current={project?.project_id===item.project_id?"page":undefined} aria-label={item.title} title={item.title} onClick={()=>go(item.project_id)}>{compact?<span className="sidebar-project-glyph" aria-hidden="true">{item.title.slice(0,1)}</span>:<FolderOpen size={16}/>}<span className="sidebar-project-name">{item.title}</span></button>)}{!loading&&!(compact?projects:filtered).length&&<p className="sidebar-empty">{query&&!compact?"没有匹配的项目":"还没有研究项目"}</p>}</nav>
      </>}
      <div className="sidebar-footer">{compact?<button type="button" className="icon-button" title="展开导航以设置主题" aria-label="展开导航以设置主题" onClick={()=>setHidden(false)}><Palette size={17}/></button>:<><ThemeControl/><span className="local-indicator"><i/>本地工作区</span></>}</div>
    </aside>}
    <div className="workspace-main">
      <header className="workspace-header"><button ref={toggleRef} className="icon-button" title={visible?"隐藏导航":"展开导航"} aria-label={visible?"隐藏导航":"展开导航"} aria-expanded={visible} aria-controls="project-navigation" onClick={()=>narrow?drawer?closeDrawer():setDrawer(true):setHidden(!hidden)}><Menu size={19}/></button>
        <div className="workspace-title"><h1>{project?.title??"欢迎使用 TRASH"}</h1><p>{(project?.research_question||project?.research_area)??"整理文献、记录思路，逐步推进研究。"}</p></div>
        {project&&<div className="workspace-autodl-control"><AutoDlConnectionStatus key={project.project_id} projectId={project.project_id}/><button type="button" className="secondary-button workspace-autodl-connect" onClick={()=>{setAutoDlProfile(undefined);setAutoDlOpen(true);}}><Server size={16}/><span>AutoDL 连接</span></button></div>}
        {project&&<div className="workspace-project-menu"><button className="icon-button" aria-label="项目操作" aria-expanded={projectMenu} onClick={()=>setProjectMenu(!projectMenu)}><MoreHorizontal size={20}/></button>{projectMenu&&<div className="workspace-menu" onKeyDown={e=>{if(e.key==="Escape")setProjectMenu(false);}}><button onClick={()=>{if(canLeave(()=>{setWorkspaceOpen(true);setProjectMenu(false);})){setWorkspaceOpen(true);setProjectMenu(false);}}}><FolderOpen size={15}/>项目配置</button><button onClick={()=>void exportProject()}><Download size={15}/>导出项目知识包</button><button className="danger-action" onClick={()=>{setDeleteTarget(project);setProjectMenu(false);}}><Trash2 size={15}/>删除项目</button><button onClick={()=>setProjectMenu(false)}><X size={15}/>关闭菜单</button></div>}</div>}
      </header>
      <main className="workspace-content">
        {error&&<ErrorNotice className="notice error-notice" >{error}</ErrorNotice>}{notice&&<div className="notice" role="status">{notice}<button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice("")}><X size={14}/></button></div>}
        {!loaded&&loading?<div className="page-loading">正在加载项目…</div>:project&&route?<React.Fragment key={project.project_id+":"+page+":"+path}>
          {page==="overview"?<OverviewPage projectId={project.project_id} onNavigate={goPage}/>:page==="literature"||page==="cards"||page==="wiki"?<LiteratureModules projectId={project.project_id} page={page} action={route.action} focusId={route.focusId} status={route.status} onNavigate={goPage} onChanged={()=>void refresh()}/>:page==="experiments"||page==="reproductions"||page==="autodl"?<ExperimentsPage projectId={project.project_id} reproductionOnly={page==="reproductions"} autoDlOnly={page==="autodl"} snapshotId={route.action==="reproduction-plan"?route.focusId:undefined} focusId={route.action==="reproduction-plan"?undefined:route.focusId} onReproductionPlan={snapshot=>goPage("experiments",{action:"reproduction-plan",focus:snapshot.snapshot_id})} onResult={id=>goPage("results",{focus:id})}/>:page==="data"?<DataPage projectId={project.project_id} onNavigate={goPage} action={route.action} focusId={route.focusId} status={route.status}/>:page==="files"?<ProjectFilesPage projectId={project.project_id} focusId={route.focusId} onNavigate={goPage}/>:page==="paper"?<section aria-label="论文"><h2>论文</h2></section>:page==="chat"?<ProjectChat projectId={project.project_id}/>:<KnowledgePage projectId={project.project_id} page={page} action={route.action} focusId={route.focusId} status={route.status} onNavigate={goPage}/>}
        </React.Fragment>:<section className="workspace-welcome"><BookOpen size={36}/><h2>{route?"该项目不存在或已被删除":!projects.length?"开始你的第一个研究项目":"选择一个项目继续研究"}</h2><p>{route?"从左侧选择其他项目，或者新建项目。":"从研究问题出发，将参考文献、知识卡片和实验结果组织在一起。"}</p><button className="primary-button" onClick={openCreate}><Plus size={16}/>新建项目</button></section>}
      </main>
    </div>
    <BackgroundDatasetTransfers/>
    {leaveDialog}
    {autoDlOpen&&project&&<AutoDlConnectionDialog key={project.project_id} projectId={project.project_id} initialProfileId={autoDlProfile} onClose={()=>setAutoDlOpen(false)}/>}
    {workspaceOpen&&project&&<ProjectWorkspaceDialog key={project.project_id} projectId={project.project_id} projectTitle={project.title} projectQuestion={project.research_question} projectArea={project.research_area} projectInterests={project.research_interests} projectStage={project.research_stage} projectConstraints={project.research_constraints} onUpdated={updated=>setProjects(previous=>previous.map(item=>item.project_id===updated.project_id?updated:item))} onClose={()=>setWorkspaceOpen(false)} onBrowse={()=>{const proceed=()=>{setWorkspaceOpen(false);goPage("files");};if(canLeave(proceed))proceed();}}/>}
    {createOpen&&<CreateProjectDialog onClose={()=>setCreateOpen(false)} onCreated={created}/>}
    {deleteTarget&&<DeleteProjectDialog project={deleteTarget} onClose={()=>setDeleteTarget(undefined)} onDeleted={deleted}/>}
  </div></DirtyContext.Provider>;
}
const pdfParams=new URLSearchParams(window.location.search);
const pdfPage=Number(new URLSearchParams(window.location.hash.slice(1)).get('page')??1);
createRoot(document.getElementById("root")!).render(window.location.pathname==='/pdf-reader'&&pdfParams.get('project')&&pdfParams.get('source')?<PdfReader projectId={pdfParams.get('project')!} sourceId={pdfParams.get('source')!} page={pdfPage} expectedHash={pdfParams.get('hash')??undefined}/>:<App/>);
