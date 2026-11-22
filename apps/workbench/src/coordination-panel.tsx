import { useEffect, useRef, useState } from "react";
import { GitBranch, MessagesSquare, Settings2 } from "lucide-react";
import type { CoordinationView, ProjectPage } from "@trash/protocol";
import type { NavigateOptions } from "./navigation.js";
import { CoordinationQueue } from "./coordination-queue.js";
import { ChatDecisionCard } from "./chat-decision-card.js";
import { api, uiError } from "./api.js";
import { chatDraftStore } from "./chat-drafts.js";
import "./coordination.css";

const states:Record<string,string>={queued:"排队中",running:"进行中",cancelling:"正在停止",completed:"已完成",failed:"失败",interrupted:"中断待核对",cancelled:"已取消"};
export function CoordinationPanel({projectId,onNavigate}:{projectId:string;onNavigate:(page:ProjectPage,options?:NavigateOptions)=>void}) {
  const url="/projects/"+encodeURIComponent(projectId)+"/coordination";
  const [data,setData]=useState<CoordinationView>();
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[manage,setManage]=useState(false);
  const [prompt,setPrompt]=useState("");
  const [follow,setFollow]=useState<{job:string;id:string;text:string}>();
  const [loadError,setLoadError]=useState("");
  const requestId=useRef(crypto.randomUUID());
  const revision=useRef(0);
  async function refresh() {
    const version=++revision.current;
    try { const value=await api<CoordinationView>(url,{cache:"no-store"});
      if(version===revision.current){setData(value);setLoadError("");}
    } catch(cause){if(version===revision.current)setLoadError(uiError(cause,"读取协调工作区失败"));}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{clearInterval(timer);revision.current++;};},[url]);
  async function act(body:object) {
    setError("");setBusy(true);
    try{await api(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});await refresh();return true;}
    catch(cause){setError(uiError(cause,cause instanceof Error?cause.message:"操作失败"));return false;}
    finally{setBusy(false);}
  }
  return <section className="coordination-panel">
    {(error||loadError)&&<p className="notice error-notice" role="alert">{error||loadError}</p>}
    <section className="coord-section"><header><h3>协调对话</h3></header>
      <div className="coord-transcript" role="log">{data?.messages.map(m=><article key={m.id}>
        {!m.summary&&<><strong>你</strong><p>{m.prompt}</p></>}
        <strong>{m.summary?"实验汇总":"实验协调"}</strong><p>{m.response||m.error||states[m.status]}</p>
        {["queued","running"].includes(m.status)&&<button className="text-button" disabled={busy} onClick={()=>void act({action:"stop",id:m.id,confirm:true})}>停止本轮协调</button>}
        {m.status==="interrupted"&&<button type="button" className="secondary-button" disabled={busy}
          onClick={()=>{if(window.confirm("已核对本机旧进程确实停止？确认后即可继续使用协调对话。"))void act({action:"acknowledge",id:m.id,confirm:true});}}>核对中断任务</button>}
      </article>)}</div>
      <form onSubmit={async e=>{e.preventDefault();if(!prompt.trim()||busy)return;
        if(await act({action:"message",id:requestId.current,instructions:prompt.trim()})){setPrompt("");requestId.current=crypto.randomUUID();}
      }}><textarea aria-label="协调指令" placeholder="安排论文实验，或询问当前进度…" maxLength={30000} value={prompt}
        onChange={e=>{setPrompt(e.target.value);requestId.current=crypto.randomUUID();}} disabled={busy}/>
        <button className="primary-button" disabled={busy||!data||!prompt.trim()||data.messages.some(m=>["running","queued","cancelling"].includes(m.status))}>发送</button></form>
    </section>
    {!!data?.jobs.length&&<section className="coord-section"><header><h3>协调任务</h3></header>{data.jobs.map(job=><div className="coord-row" key={job.id}>
      <div><strong>{job.title}</strong><p>{job.instructions}</p><small>{job.reason||(job.finished?(job.successful?"任务已完成":"已结束 · 请核对结果"):job.report_status==="blocked"?"需要补充信息":states[job.worker_status??""])||"已投递"}</small>
        {(job.report||job.worker_response)&&<p>{job.report||job.worker_response}</p>}
        {job.plans?.map(p=><small key={p.id}>{p.title} · v{p.version} · {p.host}</small>)}
      </div>
      {job.status==="delivered"&&!job.finished&&<button disabled={busy} className="text-button" onClick={()=>setFollow({job:job.id,id:crypto.randomUUID(),text:""})}>补充要求</button>}
      {follow?.job===job.id&&<form className="coord-follow" onSubmit={async e=>{e.preventDefault();
        if(follow.text.trim()&&await act({action:"followup",id:job.id,request_id:follow.id,instructions:follow.text.trim()}))setFollow(undefined);}}>
        <textarea aria-label="补充任务要求" maxLength={16000} value={follow.text} onChange={e=>setFollow({...follow,id:crypto.randomUUID(),text:e.target.value})}/>
        <div><button type="button" className="text-button" onClick={()=>setFollow(undefined)}>返回</button>
        <button disabled={busy||!follow.text.trim()} className="secondary-button">发送给论文对话</button></div></form>}
      {(job.status==="waiting"||job.status==="delivered"&&!job.finished&&!job.plans?.some(p=>p.run_id)&&["completed","failed","cancelled"].includes(job.worker_status??""))&&<button className="text-button" disabled={busy} onClick={()=>void act({action:"withdraw",id:job.id})}>撤回</button>}
    </div>)}</section>}
    {data&&<CoordinationQueue data={data} project={projectId} busy={busy} act={act} openRun={id=>onNavigate("experiments",{tab:"runs",action:"runs",focus:id})}/>}
    {data?.conversations.some(s=>s.joined&&["pending","selected"].includes(s.decision?.status??""))&&<section className="coord-section"><header><h3>待你处理</h3></header>
      {data.conversations.filter(s=>s.joined&&["pending","selected"].includes(s.decision?.status??"")).map(s=><div key={s.task_id}><small>{s.title} · {s.repository}</small>
        <ChatDecisionCard decision={s.decision!} disabled={busy||["queued","running","cancelling","interrupted"].includes(s.status)} continued={false}
          choose={async option_id=>{await api("/projects/"+encodeURIComponent(projectId)+"/chat/tasks/"+s.task_id+"/choices/"+s.decision!.id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({option_id})});await refresh();}}/></div>)}
    </section>}
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
