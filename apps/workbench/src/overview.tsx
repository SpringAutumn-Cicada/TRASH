import { ErrorNotice } from "./error-notice.js";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, FileText, FlaskConical, RefreshCw, Sparkles } from "lucide-react";
import type { ProjectOverview, ProjectPage } from "@trash/protocol";
import { api, uiError } from "./api.js";

export function OverviewPage({projectId,onNavigate}:{projectId:string;onNavigate:(page:ProjectPage,options?:{action?:string;focus?:string;status?:string})=>void}) {
  const [data,setData]=useState<ProjectOverview>();const [error,setError]=useState("");const [loading,setLoading]=useState(true);const [refreshKey,setRefreshKey]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError("");
    void api<ProjectOverview>(`/projects/${encodeURIComponent(projectId)}/overview`).then(value=>{if(active)setData(value);}).catch(cause=>{if(active)setError(uiError(cause,"无法加载项目概览，请重试。"));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[projectId,refreshKey]);
  const refresh=useCallback(()=>setRefreshKey(key=>key+1),[]);
  if(!data&&loading)return <div className="page-loading">正在加载概览…</div>;
  return <section className="overview-page">
    <div className="section-heading"><div><h2>项目概览</h2><p>从当前材料出发，接着推进你的研究。</p></div><button className="icon-button" title="刷新概览" aria-label="刷新概览" disabled={loading} onClick={refresh}><RefreshCw size={16} className={loading?"spin":""}/></button></div>
    {error&&<ErrorNotice className="notice error-notice" >{error}</ErrorNotice>}
    {data&&<>
      <div className="overview-counts">{[
        {label:"参考文献",value:data.counts.sources,page:"literature" as const,icon:BookOpen},
        {label:"已采纳卡片",value:data.counts.accepted_cards,page:"cards" as const,icon:FileText},
        {label:"Wiki 页面",value:data.counts.wiki_pages,page:"wiki" as const,icon:Sparkles},
        {label:"实验记录",value:data.counts.experiment_results,page:"results" as const,icon:FlaskConical}
      ].map(item=><button className="overview-count" key={item.page} onClick={()=>onNavigate(item.page)}><item.icon size={18}/><span>{item.label}</span><strong>{item.value}</strong><ArrowUpRight size={14}/></button>)}</div>
      {!data.counts.sources&&<div className="overview-start"><h3>从第一篇参考文献开始</h3><p>导入论文，整理方法与启发，再逐步建立研究 Wiki 和实验记录。</p><button className="primary-button" onClick={()=>onNavigate("literature",{action:"import"})}>导入文献</button></div>}
      <div className="overview-columns"><section className="overview-box"><h3>待处理事项</h3>{[
        {count:data.pending.unorganized_sources,label:"篇文献尚未建立卡片",page:"cards" as const},
        {count:data.pending.cards,label:"张卡片等待审阅",page:"cards" as const,status:"pending"},
        {count:data.pending.wiki_pages,label:"个 Wiki 页面等待审阅",page:"wiki" as const,status:"pending"},
        {count:data.pending.stale_wiki_pages,label:"个 Wiki 页面资料有更新",page:"wiki" as const},
        {count:data.pending.unsuccessful_tasks,label:"个任务失败或中断",page:"tasks" as const},
        {count:data.pending.active_experiments,label:"个实验正在运行或等待确认",page:"experiments" as const},
        {count:data.pending.failed_experiments,label:"个实验运行失败",page:"experiments" as const},
        {count:data.pending.pending_collection,label:"个实验结果待收集或补充",page:"experiments" as const}
      ].filter(item=>item.count>0).map(item=><button className="overview-todo" key={item.label} onClick={()=>onNavigate(item.page,{status:item.status})}><span><strong>{item.count}</strong> {item.label}</span><ArrowUpRight size={14}/></button>)}{Object.values(data.pending).every(count=>count===0)&&<p className="quiet">暂无待处理事项。</p>}
      </section><section className="overview-box"><h3>快捷操作</h3><div className="overview-shortcuts">{[{label:"导入文献",page:"literature" as const,action:"import"},{label:"新建卡片",page:"cards" as const,action:"new"},{label:"新建 Wiki",page:"wiki" as const,action:"new"},{label:"录入结果",page:"results" as const,action:"new"}].map(item=><button className="secondary-button" key={item.page} onClick={()=>onNavigate(item.page,{action:item.action})}>{item.label}</button>)}</div></section></div>
      <section className="overview-box"><h3>近期活动</h3>{data.activities.length?data.activities.map(item=><button className="overview-activity" key={item.id} onClick={()=>onNavigate(item.page,{focus:item.object_id})}><span><strong>{item.title}</strong><small>{item.description}</small></span><time dateTime={item.at}>{new Date(item.at).toLocaleString("zh-CN")}</time><ArrowUpRight size={14}/></button>):<p className="quiet">暂无活动，先导入一些资料。</p>}</section>
    </>}
  </section>;
}
