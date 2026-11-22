import { useEffect, useRef, useState } from "react";
import { GitBranch, MessagesSquare, Settings2 } from "lucide-react";
import type { CoordinationView, ProjectPage } from "@trash/protocol";
import type { NavigateOptions } from "./navigation.js";
import { api, uiError } from "./api.js";
import { chatDraftStore } from "./chat-drafts.js";
import "./coordination.css";

const states:Record<string,string>={queued:"排队中",running:"进行中",cancelling:"正在停止",completed:"已完成",failed:"失败",interrupted:"中断待核对",cancelled:"已取消"};
export function CoordinationPanel({projectId,onNavigate}:{projectId:string;onNavigate:(page:ProjectPage,options?:NavigateOptions)=>void}) {
  const url="/projects/"+encodeURIComponent(projectId)+"/coordination";
  const [data,setData]=useState<CoordinationView>();
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[manage,setManage]=useState(false);
  const revision=useRef(0);
  async function refresh() {
    const version=++revision.current;
    try { const value=await api<CoordinationView>(url,{cache:"no-store"});
      if(version===revision.current){setData(value);setError("");}
    } catch(cause){if(version===revision.current)setError(uiError(cause,"读取协调工作区失败"));}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{clearInterval(timer);revision.current++;};},[url]);
  async function act(body:object) {
    setError("");setBusy(true);
    try{await api(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});await refresh();return true;}
    catch(cause){setError(uiError(cause,cause instanceof Error?cause.message:"操作失败"));return false;}
    finally{setBusy(false);}
  }
  return <section className="coordination-panel">
    {error&&<p className="notice error-notice" role="alert">{error}</p>}
    <section className="coord-section"><header><h3><MessagesSquare size={18}/>参与对话</h3>
      <button type="button" className="secondary-button" aria-expanded={manage} onClick={()=>setManage(!manage)}><Settings2 size={14}/>{manage?"完成":"管理对话"}</button></header>
      {data?.conversations.filter(s=>manage||s.joined).map(s=><div className="coord-row" key={s.id}>
        <div><strong>{s.title}</strong><small><GitBranch size={13}/>{s.repository} · {states[s.status]??s.status}</small></div>
        {manage?<label><input type="checkbox" checked={s.joined} disabled={busy} onChange={e=>void act({action:"membership",conversation:s.id,joined:e.target.checked})}/>参与</label>:
          <button className="text-button" onClick={()=>{chatDraftStore(projectId).choose(s.id);onNavigate("chat");}}>查看对话</button>}
      </div>)}
      {!data?<p>正在读取…</p>:!data.conversations.some(s=>manage||s.joined)&&<p>{manage?"项目中还没有对话。":"从「管理对话」选择需要协调的论文对话。"}</p>}
    </section>
  </section>;
}
