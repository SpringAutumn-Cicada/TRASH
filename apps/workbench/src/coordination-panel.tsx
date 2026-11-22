import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FormEvent } from "react";
import { ClipboardList, LoaderCircle, MessageSquare, MessagesSquare, PanelLeftClose, PanelLeftOpen, Search, Settings2, Square, Workflow, X } from "lucide-react";
import type { CoordinationView, ProjectPage } from "@trash/protocol";
import type { NavigateOptions } from "./navigation.js";
import { CoordinationQueue } from "./coordination-queue.js";
import { ChatDecisionCard } from "./chat-decision-card.js";
import { ChatAssistantMessage, ChatComposer, ChatSendButton, ChatTranscript, ChatUserMessage, chatStates, useChatScroll } from "./chat-view.js";
import { ChatHeightControl, useChatHeight } from "./chat-height-control.js";
import { ErrorNotice } from "./error-notice.js";
import { api, uiError } from "./api.js";
import { chatDraftStore } from "./chat-drafts.js";
import { copyText } from "./clipboard.js";
import "./coordination.css";

const tabs = [
  {id:"chat",label:"协调对话",Icon:MessagesSquare},
  {id:"queue",label:"任务与队列",Icon:ClipboardList}
] as const;
const activeStatuses = ["queued","running","cancelling"];
const states = {...chatStates,queued:"排队中",interrupted:"中断待核对"};

export function CoordinationPanel({projectId,onNavigate}:{projectId:string;onNavigate:(page:ProjectPage,options?:NavigateOptions)=>void}) {
  const base="/projects/"+encodeURIComponent(projectId);
  const url=base+"/coordination";
  const [data,setData]=useState<CoordinationView>();
  const [error,setError]=useState("");
  const [loadError,setLoadError]=useState("");
  const [busy,setBusy]=useState(false);
  const [tab,setTab]=useState<(typeof tabs)[number]["id"]>("chat");
  const [manage,setManage]=useState(false);
  const [membersOpen,setMembersOpen]=useState(true);
  const [query,setQuery]=useState("");
  const [follow,setFollow]=useState<{job:string;id:string;text:string}>();
  const [copied,setCopied]=useState("");
  const [processes,setProcesses]=useState<Record<string,string>>({});
  const [openProcess,setOpenProcess]=useState<string>();
  const [loadingProcess,setLoadingProcess]=useState(false);
  const revision=useRef(0);
  const actionPending=useRef(false);
  const input=useRef<HTMLTextAreaElement>(null);
  const transcript=useRef<HTMLDivElement>(null);
  const membersToggle=useRef<HTMLButtonElement>(null);
  const ids=useId();
  const draftStore=chatDraftStore(projectId,"coordination");
  const {messages:drafts,sending}=useSyncExternalStore(draftStore.subscribe,draftStore.getSnapshot);
  const prompt=drafts[""]?.text??"";
  const {height,change:changeHeight}=useChatHeight(projectId);
  const messages=data?.messages??[];
  const last=messages.at(-1);
  const active=messages.find(message=>activeStatuses.includes(message.status));
  const interrupted=last?.status==="interrupted";
  const scroll=useChatScroll(projectId+tab,JSON.stringify([messages.length,last?.response,last?.status]));
  const members=data?.conversations??[];
  const decisions=members.filter(s=>s.joined&&["pending","selected"].includes(s.decision?.status??""));
  const pending=decisions.length+(data?.jobs.reduce((count,job)=>count+(job.plans?.filter(plan=>plan.status==="pending").length??0),0)??0);

  async function refresh() {
    const version=++revision.current;
    try {
      const view=await api<CoordinationView>(url,{cache:"no-store"});
      if(version===revision.current){setData(view);setLoadError("");}
    } catch(cause){if(version===revision.current)setLoadError(uiError(cause,"读取协调工作区失败"));}
  }

  useEffect(()=>{
    void refresh();
    const timer=setInterval(()=>void refresh(),5000);
    return()=>{clearInterval(timer);revision.current++;};
  },[url]);

  async function act(body:object) {
    if(actionPending.current)return false;
    actionPending.current=true;
    setError("");
    setBusy(true);
    try {
      await api(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      await refresh();
      return true;
    }catch(cause){
      setError(uiError(cause,cause instanceof Error?cause.message:"操作失败"));
      return false;
    }finally{
      actionPending.current=false;
      setBusy(false);
    }
  }

  const updateDraft=(text:string)=>{
    if(draftStore.getSnapshot().sending[""])return;
    draftStore.update("",draft=>({...draft,text,requestId:crypto.randomUUID()}));
  };
  const quote=(text:string)=>{
    updateDraft((prompt?prompt+"\n\n"+text:text).slice(0,30000));
    input.current?.focus();
  };
  const send=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    if(!data||busy||active||interrupted||!prompt.trim()||draftStore.getSnapshot().sending[""])return;
    const id=drafts[""]?.requestId??crypto.randomUUID();
    draftStore.update("",draft=>({...draft,requestId:id}));
    draftStore.setPending("sending","",true);
    try {
      if(await act({action:"message",id,instructions:prompt.trim()})){
        draftStore.discard("","");
        scroll.scrollBottom();
      }
    }finally{draftStore.setPending("sending","",false);}
  };
  const copy=(id:string,message:string)=>void copyText(message).then(()=>setCopied(id)).catch(()=>setError("复制失败，请手动选择内容复制。"));
  const readProcess=async(id:string)=>{
    setLoadingProcess(true);
    setError("");
    try{
      const {logs}=await api<{logs:string}>(url+"/messages/"+encodeURIComponent(id)+"/process",{cache:"no-store"});
      setProcesses(previous=>({...previous,[id]:logs}));
      setOpenProcess(id);
    }catch(cause){setError(uiError(cause,"读取执行过程失败。"));}
    finally{setLoadingProcess(false);}
  };
  const toggleMembers=()=>{
    setMembersOpen(!membersOpen);
    requestAnimationFrame(()=>membersToggle.current?.focus());
  };
  const visibleMembers=members.filter(member=>(manage||member.joined)&&
    `${member.title}\n${member.repository}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <section className="project-chat">
    <header className="chat-page-heading">
      <div className="chat-page-icon"><Workflow size={23}/></div>
      <div><h2>实验协调</h2><p>安排多个论文对话的实验，查看 AutoDL 排队和运行结果。</p></div>
    </header>
    <div className="coord-tabs" role="tablist" aria-label="实验协调视图">
      {tabs.map(({id,label,Icon},index)=><button key={id} type="button" role="tab" id={ids+"-"+id}
        aria-selected={tab===id} aria-controls={ids+"-panel"} tabIndex={tab===id?0:-1}
        onClick={()=>setTab(id)} onKeyDown={event=>{
          if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
          event.preventDefault();
          const next=tabs[event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+1)%tabs.length].id;
          setTab(next);
          document.getElementById(ids+"-"+next)?.focus();
        }}>
        <Icon size={15}/>{label}
        {id==="queue"&&pending>0&&<span className="coord-tab-count" aria-label={`${pending} 项待确认`}>{pending}</span>}
      </button>)}
    </div>
    {(error||loadError)&&<div className="chat-notice" role="status">
      <ErrorNotice>{error||loadError}</ErrorNotice>
      {error&&<button type="button" className="icon-button" aria-label="关闭错误提示" onClick={()=>setError("")}><X size={13}/></button>}
    </div>}
    <div id={ids+"-panel"} role="tabpanel" aria-labelledby={ids+"-"+tab}>
    {tab==="chat"?<div className={`chat-layout ${membersOpen?"":"chat-history-hidden"} ${height===null?"":"chat-custom-height"}`}
      style={height===null?undefined:{"--chat-message-height":`${height}px`} as CSSProperties}>
      {membersOpen&&<aside id={ids+"-members"} className="chat-conversations" aria-label="参与对话">
        <div className="chat-history-heading">
          <strong>参与对话 <small>{members.filter(member=>member.joined).length}</small></strong>
          <div className="coord-member-tools">
            <button type="button" className="chat-header-icon" aria-label="管理参与对话" title="管理参与对话" aria-pressed={manage}
              onClick={()=>{setManage(!manage);setQuery("");}}><Settings2 size={15}/></button>
            <button type="button" ref={membersToggle} className="chat-header-icon chat-history-toggle"
              title="收起参与对话" aria-label="收起参与对话" aria-expanded={true} aria-controls={ids+"-members"} onClick={toggleMembers}>
              <PanelLeftClose size={16}/>
            </button>
          </div>
        </div>
        <label className="chat-history-search"><Search size={14}/>
          <input aria-label="搜索参与对话" placeholder="搜索对话…" value={query} onChange={event=>setQuery(event.target.value)}/>
        </label>
        <div className="chat-session-list">
          {visibleMembers.map(member=><div key={member.id} className="chat-session-card coord-member-card">
            <button type="button" className="chat-session-open" onClick={()=>{
              chatDraftStore(projectId).choose(member.id);
              onNavigate("chat");
            }}>
              <span className="chat-session-icon"><MessageSquare size={15} aria-hidden="true"/></span>
              <span className="chat-session-title"><strong title={member.title}>{member.title}</strong>
                {["running","cancelling"].includes(member.status)&&<span className={`chat-live-dot ${member.status==="cancelling"?"stopping":""}`}
                  role="img" aria-label={states[member.status]} title={states[member.status]}/>}
              </span>
              <span className="chat-session-meta"><span className="coord-member-repository" title={member.repository}>{member.repository}</span>
                {member.decision?.status==="pending"?<span className="chat-session-warning">等待选择</span>:
                  <span>{states[member.status]??member.status}</span>}
              </span>
            </button>
            {manage&&<label className="chat-session-actions coord-member-check">
              <input type="checkbox" checked={member.joined} disabled={busy} aria-label={`参与协调：${member.title}`}
                onChange={event=>void act({action:"membership",conversation:member.id,joined:event.target.checked})}/>
            </label>}
          </div>)}
          {!visibleMembers.length&&<p>{!data?"正在读取对话…":query?"没有匹配的对话。":manage?"项目中还没有对话。":"从「管理参与对话」选择论文对话。"}</p>}
        </div>
      </aside>}
      <div className="chat-main">
        <div className="chat-thread-controls"><header className="chat-thread-heading">
          <div className="chat-thread-identity">
            {!membersOpen&&<button type="button" ref={membersToggle} className="chat-header-icon chat-history-toggle"
              title="展开参与对话" aria-label="展开参与对话" aria-expanded={false} onClick={toggleMembers}><PanelLeftOpen size={16}/></button>}
            <div className="chat-thread-avatar"><MessageSquare size={18} aria-hidden="true"/></div>
            <div className="chat-thread-info"><strong>协调对话</strong>
              <div className="chat-thread-meta"><span><i className={`chat-connection-dot ${loadError?"offline":""}`} aria-hidden="true"/>
                {loadError?"连接中断，正在重试":"项目会话"}</span>
                {messages.length>0&&<span className="chat-thread-count">{messages.length} 轮交流</span>}
              </div>
            </div>
          </div>
        </header></div>
        <ChatTranscript scroll={scroll} target={transcript} label="协调对话消息">
          {!data?<div className="chat-loading">{!loadError&&<><LoaderCircle size={20} className="spin"/>正在读取协调对话</>}</div>:
            !messages.length?<div className="chat-welcome">
              <span className="chat-welcome-icon"><Workflow size={31}/></span>
              <h3>安排接下来的实验</h3>
              <p>指定参与对话、运行顺序，或询问当前进度。</p>
            </div>:messages.map((message,index)=>{
              const current=message.id===(active??last)?.id;
              return <section key={message.id} className="chat-turn" aria-label={`第 ${index+1} 轮协调`}>
                {!message.summary&&<ChatUserMessage author="你" at={message.created_at} text={message.prompt}
                  copied={copied===message.id+"-user"} onCopy={()=>copy(message.id+"-user",message.prompt)} onQuote={()=>quote(message.prompt)}/>}
                <ChatAssistantMessage author={message.summary?"实验汇总":"协调 Agent"} at={message.created_at} response={message.response}
                  error={message.error} status={current&&loadError?"offline":message.status} turnStatus={message.status}
                  current={current} copied={copied===message.id} onCopy={()=>copy(message.id,message.response)}
                  process={{open:openProcess===message.id,disabled:loadingProcess,log:processes[message.id],
                    toggle:()=>openProcess===message.id?setOpenProcess(undefined):void readProcess(message.id),
                    refresh:()=>void readProcess(message.id)}}
                  actions={<>
                    {!message.summary&&["failed","cancelled","interrupted"].includes(message.status)&&
                      <button type="button" className="text-button" disabled={busy} onClick={()=>quote(message.prompt)}>将问题填入输入框</button>}
                    {message.status==="interrupted"&&<button type="button" className="text-button" disabled={busy}
                      onClick={()=>{if(window.confirm("已核对本机旧进程确实停止？确认后即可继续使用协调对话。"))
                        void act({action:"acknowledge",id:message.id,confirm:true});}}>确认旧进程已停止</button>}
                  </>}/>
              </section>;
            })}
        </ChatTranscript>
        <ChatHeightControl height={height} onChange={changeHeight} target={transcript}/>
        <ChatComposer input={input} label="协调指令" placeholder="安排论文实验，或询问当前进度…" draft={prompt}
          disabled={busy||Boolean(sending[""])} onChange={updateDraft} onSubmit={event=>void send(event)}
          controls={<>
            <button type="button" className="chat-control-button" aria-label="停止本轮协调" title="停止本轮协调"
              disabled={busy||!active||active.status==="cancelling"} onClick={()=>active&&void act({action:"stop",id:active.id,confirm:true})}><Square size={15}/></button>
            <ChatSendButton busy={Boolean(sending[""])} disabled={busy||Boolean(sending[""])||!data||!prompt.trim()||Boolean(active)||interrupted}/>
          </>}
          summary={<span className="chat-write-summary">{interrupted?"请先确认旧进程已停止":"协调权限 · 只读与派单"}</span>}/>
      </div>
    </div>:<div className="coordination-panel">
      {decisions.length>0&&<section className="coord-section"><header><h3>待你处理</h3></header>
        {decisions.map(s=><div key={s.task_id}><small>{s.title} · {s.repository}</small>
          <ChatDecisionCard decision={s.decision!} disabled={busy||["queued","running","cancelling","interrupted"].includes(s.status)} continued={false}
            choose={async option_id=>{await api(base+"/chat/tasks/"+s.task_id+"/choices/"+s.decision!.id,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({option_id})});await refresh();}}/></div>)}
      </section>}
      {data&&<CoordinationQueue data={data} project={projectId} busy={busy} act={act} openRun={id=>onNavigate("experiments",{tab:"runs",action:"runs",focus:id})}/>}
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
      {!data&&<p className="quiet" role="status">正在读取任务与队列…</p>}
    </div>}
    </div>
  </section>;
}
