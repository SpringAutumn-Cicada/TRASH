import { DiscardChangesDialog } from "./discard-changes-dialog.js";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ProjectPage } from "@trash/protocol";

export const projectPages: { id: ProjectPage; label: string }[] = [
  { id: "overview", label: "概览" }, { id: "literature", label: "文献" }, { id: "cards", label: "卡片" },
  { id: "wiki", label: "Wiki" }, { id: "data", label: "数据" }, { id: "reproductions", label: "文献复现" }, { id: "experiments", label: "实验" }, { id: "autodl", label: "AutoDL 工作区" }, { id: "files", label: "项目文件" }, { id: "paper", label: "论文" }, { id: "tasks", label: "任务" }, { id: "chat", label: "Agent 对话" }, { id: "coordination", label: "实验协调" }
];
export const projectSidebarPages = ["overview","literature","experiments","paper","chat","coordination","files"] as const;
export const experimentTabs = [
  {id:"compute",label:"AutoDL"},{id:"catalog",label:"实验列表"},{id:"runs",label:"计划与运行"},
  {id:"reproductions",label:"文献复现"},{id:"datasets",label:"数据集"},{id:"results",label:"实验结果"}
] as const;
export type ExperimentTab=typeof experimentTabs[number]["id"] | "code" | "method";
const experimentViews = {
  compute: ["hosts", "settings", "workspace"],
  code: ["overview", "code", "agent"],
  runs: ["logs", "artifacts"],
} as const;
export type ExperimentView=typeof experimentViews[keyof typeof experimentViews][number];
export type NavigateOptions={tab?:ExperimentTab;view?:ExperimentView;action?:string;focus?:string;status?:string;experiment?:string};
export function projectSidebarPage(page:ProjectPage){
  return page==="wiki"||page==="cards"?"literature":page;
}
function experimentLocation(page:ProjectPage|undefined,options:NavigateOptions){
  const {action,focus}=options;
  if(page==="reproductions")return {page:"experiments" as const,options:{...options,tab:"reproductions" as const}};
  if(page==="autodl")return {page:"experiments" as const,options:{...options,tab:"compute" as const}};
  if(page==="data"||page==="results"){
    const tab=page==="results"||focus||action==="experimental-data"||action==="new-experiment-record"?"results":"datasets";
    return {page:"experiments" as const,options:{...options,tab:tab as ExperimentTab,
      action:page==="results"?(action==="new"?"new-experiment-record":"experimental-data"):action}};
  }
  return {page,options};
}
export const DirtyContext = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useUnsavedChanges(dirty: boolean): () => void {
  const id = useId(), register = useContext(DirtyContext);
  useEffect(() => { register(id, dirty); return () => register(id, false); }, [id, dirty, register]);
  return useCallback(() => register(id, false), [id, register]);
}
export function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Browser storage may be disabled. */ }
}
export function parseProjectRoute(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    const match = url.pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (!match) return undefined;
    const legacyCoordination=match[2]==="experiments"&&url.searchParams.get("tab")==="coordination";
    const page=legacyCoordination?"coordination":match[2]==="results"?"results":projectPages.find(p => p.id === match[2])?.id;
    if (match[2] && !page) return undefined;
    const tabParam=url.searchParams.get("tab");
    const tab=tabParam==="method"?(url.searchParams.get("experiment")?"method":"catalog"):tabParam==="code"?"code":experimentTabs.find(item=>item.id===tabParam)?.id;
    const {page:normalized,options}=experimentLocation(page,{
      tab,action:url.searchParams.get("action")??undefined,focus:url.searchParams.get("focus")??undefined,
      status:url.searchParams.get("status")??undefined,experiment:url.searchParams.get("experiment")??undefined
    });
    const views: Partial<Record<ExperimentTab, readonly ExperimentView[]>> = experimentViews;
    const view=normalized==="experiments"&&options.tab
      ? views[options.tab]?.find(item=>item===url.searchParams.get("view")) : undefined;
    return {projectId:decodeURIComponent(match[1]),legacyCoordination,page:normalized,tab:options.tab,view,action:options.action,focusId:options.focus,status:options.status,experiment:options.experiment};
  } catch { return undefined; }
}
export function projectPath(id: string, page: ProjectPage, options:NavigateOptions={}) {
  const location=experimentLocation(page,options);
  const params = new URLSearchParams();
  for(const key of ["tab","view","action","focus","status","experiment"] as const){
    const value=location.options[key];
    if(value)params.set(key,value);
  }
  return `/projects/${encodeURIComponent(id)}/${location.page}${params.size ? `?${params}` : ""}`;
}
export function useWorkspaceNavigation() {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  const current = useRef(path), index = useRef(0), undoing = useRef(false);
  const dirty = useRef(new Set<string>());
  const register = useCallback((id: string, changed: boolean) => { if (changed) dirty.current.add(id); else dirty.current.delete(id); }, []);
  const [pendingLeave,setPendingLeave]=useState<(()=>void)|null>(null);
  const canLeave = useCallback((continuation?:()=>void) => {if(!dirty.current.size)return true;setPendingLeave(()=>continuation??(()=>{}));return false;}, []);
  const navigate = useCallback((next: string, replace = false, force = false): boolean => {
    if (next === current.current) return true;
    const commit=()=>{if(!replace)index.current+=1;window.history[replace?'replaceState':'pushState']({trashIndex:index.current},'',next);current.current=next;setPath(next);};
    if(!force&&!canLeave(commit))return false;
    commit();return true;
  }, [canLeave]);
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, trashIndex: 0 }, "");
    const pop = (event: PopStateEvent) => {
      if (undoing.current) { undoing.current = false; return; }
      const target = typeof event.state?.trashIndex === "number" ? event.state.trashIndex : undefined;
      const destination=window.location.pathname+window.location.search;
      if (!canLeave(()=>{if(target!==undefined&&target!==index.current)window.history.go(target-index.current);else{window.history.replaceState({trashIndex:index.current},'',destination);current.current=destination;setPath(destination);}})) {
        if (target !== undefined && target !== index.current) { undoing.current = true; window.history.go(index.current - target); }
        else window.history.replaceState({ trashIndex: index.current }, "", current.current);
        return;
      }
      index.current = target ?? 0;
      current.current = window.location.pathname + window.location.search; setPath(current.current);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current.size) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("popstate", pop); window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("popstate", pop); window.removeEventListener("beforeunload", beforeUnload); };
  }, [canLeave]);
  const leaveDialog=pendingLeave?<DiscardChangesDialog onCancel={()=>setPendingLeave(null)} onConfirm={()=>{const proceed=pendingLeave;setPendingLeave(null);dirty.current.clear();proceed();}}/>:null;
  return { path, navigate, register, canLeave, leaveDialog };
}
