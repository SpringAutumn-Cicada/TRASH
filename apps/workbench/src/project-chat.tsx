import { ChatAttachmentButtons, ChatAttachmentList, useChatAttachments, type ChatAttachment } from "./chat-attachments.js";
import { ChatHeightControl, useChatHeight } from "./chat-height-control.js";
import { ErrorNotice } from './error-notice.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Bot, Check, ChevronDown, Copy, List, LoaderCircle, MessageSquare, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Search, Send, Settings2, Square, X } from 'lucide-react';
import { useUnsavedChanges } from './navigation.js';
import { copyText } from './clipboard.js';
import { ChatMarkdown } from './chat-markdown.js';
import './project-chat.css';

type ChatOutput={id:string;kind:'message'|'tool';status:string;text:string;title?:string;at:string};
type Turn={attachments?:ChatAttachment[];output?:ChatOutput[];task_id:string;conversation_id:string;session_id?:string;instructions:string;response:string;status:string;sandbox:string;model:string;error?:string;created_at:string;logs:string};
type Session={id:string;first:Turn;latest:Turn;count:number};
const states:Record<string,string>={running:'正在处理',cancelling:'正在停止',completed:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
const errors:Record<string,string>={PROJECT_HAS_ACTIVE_TASKS:'当前项目正在处理知识任务或其他操作，请等待完成后再发送。',CODE_AGENT_BUSY:'当前项目或绑定仓库有 Agent 正在执行，请等待或停止后再发送。',CODE_AGENT_RECOVERY_REQUIRED:'请先核对中断任务并确认旧进程停止。',CHAT_SESSION_NOT_FOUND:'未找到可恢复的会话，请新建对话。',EXPERIMENT_ACTIVE:'项目有未结束实验，请先处理实验状态。',INVALID_REQUEST:'请检查消息和对话选项。',WORKSPACE_MIGRATING:'论文工作区正在迁移，请完成后再发送消息。'};
const suggestions=[{title:'梳理研究方向',text:'请根据当前项目的研究问题和已有文献，梳理研究方向、已有证据以及需要补充的材料。'},{title:'比较文献方法',text:'请比较当前项目已有文献的方法、实验条件与局限，标明来源和不确定之处。'},{title:'整理研究 Wiki',text:'请基于现有文献卡片整理研究 Wiki，保留来源与版本引用，生成待审内容。'},{title:'讨论论文结构',text:'请结合当前研究问题和已有证据，和我讨论论文结构，区分已有结论与待验证假设。'}];
const time=(value:string)=>new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const date=(value:string)=>new Date(value).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
export function ProjectChat({projectId}:{projectId:string}){
  const {height:chatHeight,change:changeChatHeight}=useChatHeight(projectId);
  const transcriptRef=useRef<HTMLDivElement>(null);
  const base=`/api/v1/projects/${encodeURIComponent(projectId)}`;
  const [turns,setTurns]=useState<Turn[]>([]),[conversation,setConversation]=useState(''),[draft,setDraft]=useState('');
  const [model,setModel]=useState(''),[sandbox,setSandbox]=useState('workspace-write');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[connected,setConnected]=useState(true),[query,setQuery]=useState(''),[history,setHistory]=useState(true),[options,setOptions]=useState(false),[indexOpen,setIndexOpen]=useState(false),[away,setAway]=useState(false),[unread,setUnread]=useState(false),[copied,setCopied]=useState('');
  const [logs,setLogs]=useState<Record<string,string>>({}),[openLogs,setOpenLogs]=useState<Record<string,boolean>>({});
  const initial=useRef(false),messagesRef=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),follow=useRef(true),alive=useRef(true),acting=useRef(false),current=useRef('');
  const drafts=useRef<Record<string,string>>({});
  const attachments=useChatAttachments(base,conversation,setError);
  useUnsavedChanges(Boolean(draft)||Object.values(drafts.current).some(Boolean)||attachments.hasDrafts);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const call=async<T,>(path:string,body?:unknown):Promise<T>=>{
    const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw new Error(errors[data.error]??'对话操作失败，请检查本机 Agent 配置或查看过程日志。');return data as T;
  };
  const refresh=async()=>{const data=await call<{tasks:Turn[]}>('/chat/tasks');if(alive.current){setTurns(data.tasks);setConnected(true);}return data.tasks;};
  useEffect(()=>{
    let mounted=true,polling=false;
    const poll=async()=>{
      if(polling)return;polling=true;
      try{
        const data=await call<{tasks:Turn[]}>('/chat/tasks');if(!mounted)return;
        setTurns(data.tasks);setConnected(true);
        if(!initial.current){initial.current=true;const latest=data.tasks[0];if(latest){setConversation(latest.conversation_id);current.current=latest.conversation_id;setSandbox(latest.sandbox);setModel(latest.model);}}
      }catch{if(mounted)setConnected(false);}finally{polling=false;if(mounted)setLoading(false);}
    };
    void poll();const timer=setInterval(()=>void poll(),2000);return()=>{mounted=false;clearInterval(timer);};
  },[projectId]);
  const sessions=useMemo(()=>{
    const groups=new Map<string,Session>();
    for(const turn of [...turns].sort((a,b)=>a.created_at.localeCompare(b.created_at))){const session=groups.get(turn.conversation_id);if(session){session.latest=turn;session.count++;}else groups.set(turn.conversation_id,{id:turn.conversation_id,first:turn,latest:turn,count:1});}
    return [...groups.values()].sort((a,b)=>b.latest.created_at.localeCompare(a.latest.created_at));
  },[turns]);
  const messages=useMemo(()=>turns.filter(turn=>turn.conversation_id===conversation).sort((a,b)=>a.created_at.localeCompare(b.created_at)),[turns,conversation]);
  const active=turns.find(turn=>['running','cancelling'].includes(turn.status)),session=sessions.find(item=>item.id===conversation),last=messages.at(-1);
  const filtered=sessions.filter(item=>`${item.first.instructions}\n${item.latest.instructions}`.toLowerCase().includes(query.trim().toLowerCase()));
  const scrollBottom=(smooth=false)=>{const node=messagesRef.current;if(node)node.scrollTo({top:node.scrollHeight,behavior:smooth?'smooth':'auto'});follow.current=true;setAway(false);setUnread(false);};
  useEffect(()=>{follow.current=true;setUnread(false);setAway(false);messagesRef.current?.scrollTo({top:messagesRef.current.scrollHeight});},[conversation]);
  useEffect(()=>{if(follow.current)messagesRef.current?.scrollTo({top:messagesRef.current.scrollHeight});else setUnread(true);},[messages.length,last?.response,last?.status,JSON.stringify(last?.output)]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=Math.min(input.current.scrollHeight,210)+'px';}},[draft]);
  const updateDraft=(value:string)=>{setDraft(value);drafts.current[current.current]=value;};
  const choose=(session?:Session)=>{
    if(acting.current||attachments.uploading)return;initial.current=true;
    drafts.current[current.current]=draft;
    const next=session?.id??'';current.current=next;setConversation(next);setDraft(drafts.current[next]??'');setOpenLogs({});setError('');setIndexOpen(false);
    if(session){setSandbox(session.latest.sandbox);setModel(session.latest.model);}
    input.current?.focus();
  };
  const act=async(action:()=>Promise<void>)=>{
    if(acting.current)return;acting.current=true;setBusy(true);setError('');
    try{await action();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'操作失败。');}finally{acting.current=false;if(alive.current)setBusy(false);}
  };
  const send=async(event:React.FormEvent)=>{
    event.preventDefault();if((!draft.trim()&&!attachments.entries.length)||attachments.uploading||active||acting.current||loading)return;
    const instructions=draft.trim()?draft:'请查看并分析本条消息所附的材料。';
    await act(async()=>{
      const data=await call<{task:Turn}>('/chat/tasks',{instructions,attachments:attachments.entries.map(item=>item.id),model,sandbox,confirm:true,timeout_seconds:1800,...(conversation?{conversation_id:conversation}:{})});
      if(!alive.current)return;
      drafts.current[current.current]='';drafts.current[data.task.conversation_id]='';current.current=data.task.conversation_id;
      setConversation(data.task.conversation_id);setTurns(old=>[data.task,...old.filter(turn=>turn.task_id!==data.task.task_id)]);setDraft('');attachments.clear();follow.current=true;setIndexOpen(false);input.current?.focus();
    });
  };
  const copy=(id:string,text:string)=>void copyText(text).then(()=>{if(alive.current)setCopied(id);}).catch(()=>setError('复制失败，请手动选择内容复制。'));
  const readLogs=(turn:Turn)=>void act(async()=>{const data=await call<{task:Turn}>(`/code-agent/tasks/${turn.task_id}`);if(alive.current){setLogs(old=>({...old,[turn.task_id]:data.task.logs}));setOpenLogs(old=>({...old,[turn.task_id]:true}));}});
  return <section className="project-chat">
    <header className="chat-page-heading"><div className="chat-page-icon"><Bot size={23}/></div><div><h2>Agent 对话</h2><p>围绕文献、研究思路和论文写作，持续推进当前项目。</p></div><button type="button" className="secondary-button" disabled={busy||attachments.uploading} onClick={()=>choose()}><MessageSquarePlus size={15}/>新建对话</button></header>
    <div className={`chat-layout ${history?'':'chat-history-hidden'} ${chatHeight!==null?'chat-custom-height':''}`} style={chatHeight!==null?{'--chat-message-height':`${chatHeight}px`} as React.CSSProperties:undefined}>
      {history&&<aside className="chat-conversations" aria-label="项目对话记录"><div className="chat-history-heading"><strong>历史对话 <small>{sessions.length}</small></strong><button type="button" className="icon-button" aria-label="收起历史对话" onClick={()=>setHistory(false)}><PanelLeftClose size={15}/></button></div><label className="chat-history-search"><Search size={14}/><input aria-label="搜索对话" placeholder="搜索对话…" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="chat-session-list">{loading?<p>正在读取对话…</p>:filtered.map(item=><button type="button" key={item.id} className={conversation===item.id?'selected':''} disabled={busy||attachments.uploading} onClick={()=>choose(item)}><span className="chat-session-title"><MessageSquare size={14}/><strong>{item.first.instructions.slice(0,70)}</strong></span><span className="chat-session-meta"><span>{date(item.latest.created_at)} · {item.count} 轮</span>{['running','cancelling'].includes(item.latest.status)&&<i className="chat-live-dot"/>}{['failed','interrupted'].includes(item.latest.status)&&<span>{states[item.latest.status]}</span>}</span></button>)}{!loading&&!filtered.length&&<p>{query?'没有匹配的对话。':'发送第一条消息，开始项目对话。'}</p>}</div><div className="chat-history-note">切换对话会暂存未发送内容；离开本页前请保存需要保留的草稿。</div></aside>}
      <div className="chat-main"><header className="chat-thread-heading"><button type="button" className="icon-button" aria-label={history?'收起历史对话':'展开历史对话'} onClick={()=>setHistory(!history)}>{history?<PanelLeftClose size={16}/>:<PanelLeftOpen size={16}/>}</button><div><strong>{session?.first.instructions.slice(0,60)||'新对话'}</strong><span><i className={`chat-connection-dot ${connected?'':'offline'}`}/>{connected?'项目会话':'连接暂时中断，正在重试'}{messages.length>0?` · ${messages.length} 轮交流`:''}</span></div><button type="button" className={`icon-button ${indexOpen?'active':''}`} aria-label="消息目录" aria-expanded={indexOpen} disabled={!messages.length} onClick={()=>setIndexOpen(!indexOpen)}><List size={17}/></button></header>
        {indexOpen&&<nav className="chat-message-index" aria-label="消息目录">{messages.map((turn,index)=><button type="button" key={turn.task_id} onClick={()=>{const target=document.getElementById(`chat-turn-${turn.task_id}`);const container=messagesRef.current;if(target&&container)container.scrollTo({top:container.scrollTop+target.getBoundingClientRect().top-container.getBoundingClientRect().top-18,behavior:'smooth'});follow.current=false;setAway(true);setIndexOpen(false);}}><span>{index+1}</span>{turn.instructions.slice(0,100)}</button>)}</nav>}
        <div ref={transcriptRef} className="chat-transcript-wrap"><div ref={messagesRef} className="chat-messages" role="log" aria-label="Agent 对话消息" aria-live="polite" aria-relevant="additions text" onScroll={event=>{const node=event.currentTarget,isAway=node.scrollHeight-node.scrollTop-node.clientHeight>90;follow.current=!isAway;setAway(isAway);if(!isAway)setUnread(false);}}>
          {loading?<div className="chat-loading"><LoaderCircle size={20} className="spin"/>正在读取项目对话</div>:!messages.length?<div className="chat-welcome"><span className="chat-welcome-icon"><Bot size={31}/></span><span className="chat-eyebrow">你的论文研究助手</span><h3>这篇论文，我们从哪里开始？</h3><p>从一个问题、一篇文献，或尚未成形的研究思路开始。</p><div className="chat-suggestions">{suggestions.map(item=><button type="button" key={item.title} disabled={busy} onClick={()=>{updateDraft(draft?draft+'\n\n'+item.text:item.text);input.current?.focus();}}><strong>{item.title}</strong><span>{item.text}</span></button>)}</div><small>生成内容需要审核，文献结论与真实实验结果会分别记录。</small></div>:messages.map((turn,index)=><section key={turn.task_id} className="chat-turn" id={`chat-turn-${turn.task_id}`} aria-label={`第 ${index+1} 轮对话`}>
            <article className="chat-message chat-user"><header><span>你</span><time dateTime={turn.created_at}>{time(turn.created_at)}</time></header><div className="chat-user-body">{turn.instructions}</div><ChatAttachmentList base={base} entries={turn.attachments??[]}/><footer className="chat-user-actions"><button type="button" onClick={()=>{updateDraft(draft?draft+'\n\n'+turn.instructions:turn.instructions);input.current?.focus();}}>引用</button><button type="button" aria-label="复制用户消息" onClick={()=>copy(turn.task_id+'-user',turn.instructions)}>{copied===turn.task_id+'-user'?<Check size={13}/>:<Copy size={13}/>} {copied===turn.task_id+'-user'?'已复制':'复制'}</button></footer></article>
            <article className="chat-message chat-assistant"><header><span className="chat-agent-avatar"><Bot size={15}/></span><strong>论文助手</strong><time dateTime={turn.created_at}>{time(turn.created_at)}</time><span className={`chat-turn-status status-${turn.status}`}>{['running','cancelling'].includes(turn.status)&&<LoaderCircle size={12} className="spin"/>}{states[turn.status]??turn.status}</span></header>{turn.output?.length?<ChatOutputMessages output={turn.output} response={turn.response}/>:turn.response?<ChatMarkdown text={turn.response}/>:<div className={`chat-empty-response ${turn.status==='running'?'working':''}`}>{turn.status==='running'?<><span className="chat-thinking"><i/><i/><i/></span>正在处理，进展消息会陆续显示。</>:turn.status==='cancelling'?'正在停止，请稍候。':turn.status==='failed'?'本轮未能完成，可以查看过程后重新发送。':'本轮没有返回文本。'}</div>}{turn.error&&<p className="chat-error">{turn.error}</p>}
              <div className="chat-turn-actions">{turn.response&&<button type="button" className="text-button" onClick={()=>copy(turn.task_id,turn.response)}>{copied===turn.task_id?<Check size={13}/>:<Copy size={13}/>} {copied===turn.task_id?'已复制':'复制回复'}</button>}<button type="button" className="text-button" disabled={busy} aria-expanded={Boolean(openLogs[turn.task_id])} onClick={()=>openLogs[turn.task_id]?setOpenLogs(old=>({...old,[turn.task_id]:false})):readLogs(turn)}><ChevronDown size={13}/> {openLogs[turn.task_id]?'收起过程':'查看过程'}</button>{['failed','cancelled','interrupted'].includes(turn.status)&&<button type="button" className="text-button" disabled={busy} onClick={()=>{updateDraft(draft?draft+'\n\n'+turn.instructions:turn.instructions);input.current?.focus();}}>将问题填入输入框</button>}{turn.status==='interrupted'&&<button type="button" className="text-button" disabled={busy} onClick={()=>{if(window.confirm('请先确认旧 Agent 进程已经停止，并核对本轮已产生的改动。确认完成？'))void act(async()=>{await call(`/code-agent/tasks/${turn.task_id}/acknowledge`,{confirm:true});await refresh();});}}>确认旧进程已停止</button>}</div>
              {openLogs[turn.task_id]&&<div className="chat-process-panel"><header><span>执行过程 · {states[turn.status]??turn.status}</span><button type="button" className="text-button" disabled={busy} onClick={()=>readLogs(turn)}>刷新</button></header><pre>{logs[turn.task_id]||'暂无过程记录。'}</pre></div>}
            </article></section>)}
        </div>{away&&<button type="button" className="chat-jump-bottom" onClick={()=>scrollBottom(true)}><ArrowDown size={14}/>{unread?'有新进展 · 回到最新':'回到最新消息'}</button>}</div>
        <ChatHeightControl height={chatHeight} onChange={changeChatHeight} target={transcriptRef}/>
        {error&&<div className="chat-notice"><ErrorNotice>{error}</ErrorNotice><button type="button" className="icon-button" aria-label="关闭对话错误提示" onClick={()=>setError('')}><X size={13}/></button></div>}
        {active&&active.conversation_id!==conversation&&<div className="chat-other-active">另一个对话正在处理消息。<button type="button" className="text-button" onClick={()=>choose(sessions.find(item=>item.id===active.conversation_id))}>前往该对话</button></div>}
        <form className="chat-composer" onSubmit={event=>void send(event)}><div className={`chat-input-shell ${attachments.dragging?'chat-drop-active':''}`} onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=busy||attachments.uploading?'none':'copy';attachments.setDragging(!busy&&!attachments.uploading);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))attachments.setDragging(false);}} onDrop={event=>{if(busy||attachments.uploading){event.preventDefault();attachments.setDragging(false);return;}attachments.drop(event);}} onPaste={event=>{if(!busy)attachments.paste(event);}}><ChatAttachmentList base={base} entries={attachments.entries} uploading={attachments.uploading} onRemove={attachments.remove}/>{attachments.dragging&&<div className="chat-drop-label">松开即可上传图片或文件</div>}<textarea ref={input} aria-label="发送给项目 Agent 的消息" value={draft} maxLength={30000} disabled={busy} onChange={event=>updateDraft(event.target.value)} placeholder="输入研究问题，或交代需要整理的文献与稿件内容…" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/><div className="chat-input-tools"><ChatAttachmentButtons disabled={busy||attachments.uploading} onUpload={files=>void attachments.upload(files)}/><button type="button" className={`chat-options-toggle ${options?'active':''}`} aria-expanded={options} onClick={()=>setOptions(!options)}><Settings2 size={14}/>{model||'本机默认模型'}<ChevronDown size={12}/></button><span className="chat-permission-label">{sandbox==='read-only'?'只读交流':sandbox==='danger-full-access'?'完整本机权限':'项目读写'}</span><span className="chat-char-count">{draft.length>24000?`${draft.length}/30000`:''}</span>{active?<button type="button" className="chat-stop-button" disabled={busy||active.status==='cancelling'} onClick={()=>void act(async()=>{await call(`/code-agent/tasks/${active.task_id}/cancel`,{confirm:true});await refresh();})}><Square size={13}/>{active.status==='cancelling'?'正在停止':active.conversation_id!==conversation?'停止另一对话':'停止生成'}</button>:<button className="chat-send-button" aria-label="发送消息" disabled={busy||attachments.uploading||(!draft.trim()&&!attachments.entries.length)||loading}>{busy?<LoaderCircle size={15} className="spin"/>:<Send size={15}/>}<span>发送</span></button>}</div></div>
          {options&&<div className="chat-options-panel"><div className="chat-settings"><label>模型<input value={model} maxLength={200} disabled={busy||Boolean(active)} placeholder="沿用本机配置" onChange={event=>{setModel(event.target.value);}}/></label><label>对话权限<select value={sandbox} disabled={busy||Boolean(active)} onChange={event=>{setSandbox(event.target.value);}}><option value="read-only">只读交流</option><option value="workspace-write">项目资料与代码读写</option><option value="danger-full-access">完整本机权限</option></select></label></div><p>项目读写模式可调用平台工具与网络。完整本机权限还可操作项目外文件。</p></div>}
          <div className="chat-composer-footer"><span>围绕当前论文项目交流 · 按所选权限执行</span><small>Ctrl / ⌘ + Enter 发送</small></div>
        </form>
      </div>
    </div>
  </section>;
}

function ChatOutputMessages({output,response}:{output:ChatOutput[];response:string}){
  const messages=output.filter(item=>item.kind==='message'&&item.text);
  return <div className="chat-output-stream">{output.map(item=>item.kind==='message'?item.text&&<div className="chat-output-message" key={item.id}><ChatMarkdown text={item.text}/>{item.status==='running'&&<span className="chat-output-writing">正在回复…</span>}</div>:<details className="chat-tool-event" key={item.id}><summary><span className="chat-tool-icon">{item.status==='running'?<LoaderCircle size={15} className="spin"/>:item.status==='failed'?<X size={15}/>:<Check size={15}/>}</span><strong>{item.title||'执行操作'}</strong><span>{item.status==='running'?'进行中':item.status==='failed'?'失败':'完成'}</span><small>查看详情</small></summary><pre>{item.text||'此操作没有额外描述，原始事件可在过程日志中查看。'}</pre></details>)}{response&&!messages.some(item=>item.text===response)&&<div className="chat-output-message"><ChatMarkdown text={response}/></div>}</div>;
}
