import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, Bot, Check, ChevronDown, Copy, LoaderCircle, Pencil, Send } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown.js";
import type { ChatDraftStore } from "./chat-drafts.js";
import "./project-chat.css";

export const chatStates: Record<string, string> = {
  decision:"等待选择", queued:"等待资源", running:"正在处理", resuming:"正在恢复", cancelling:"正在停止",
  completed:"已完成", failed:"失败", cancelled:"已停止", interrupted:"中断待核对", offline:"状态待同步"
};

export function groupChatAttempts<T extends {resume_root?:string}>(items: T[], identify: (item:T)=>string) {
  const groups=new Map<string,T[]>();
  for(const item of items){
    const id=item.resume_root??identify(item);
    const group=groups.get(id);
    if(group)group.push(item);
    else groups.set(id,[item]);
  }
  return [...groups.values()];
}

function MessageTime({at}:{at?:string}) {
  return at ? <time dateTime={at}>{new Date(at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time> : null;
}

export function ChatUserMessage({author,at,text,details,children,copied,onCopy,onQuote,resend}:{
  author:string; at?:string; text:string; details?:React.ReactNode; children?:React.ReactNode;
  copied:boolean; onCopy:()=>void; onQuote:()=>void;
  resend?:{disabled:boolean;send:(text:string)=>Promise<void>};
}) {
  const [editing,setEditing]=useState(false);
  const editButton=useRef<HTMLButtonElement>(null);
  const cancelEdit=()=>{
    setEditing(false);
    requestAnimationFrame(()=>editButton.current?.focus());
  };
  return <article className={`chat-message chat-user${editing?" chat-user-editing":""}`}>
    <header><span>{author}</span><MessageTime at={at}/></header>
    {details}
    {editing?<ChatMessageEditor text={text} disabled={!resend||resend.disabled} onCancel={cancelEdit}
      onSend={async value=>{
        if(!resend)throw new Error("这轮对话已有后续消息。");
        await resend.send(value);
        setEditing(false);
      }}/>:
      <div className="chat-user-body">{text}</div>}
    {children}
    {!editing&&<footer className="chat-user-actions">
      <button type="button" onClick={onQuote}>引用</button>
      <button type="button" aria-label="复制用户消息" onClick={onCopy}>
        {copied?<Check size={13}/>:<Copy size={13}/>} {copied?"已复制":"复制"}
      </button>
      {resend&&<button ref={editButton} type="button" disabled={resend.disabled} onClick={()=>setEditing(true)}>
        <Pencil size={13} aria-hidden="true"/> 编辑并重发
      </button>}
    </footer>}
  </article>;
}

function ChatMessageEditor({text,disabled,onCancel,onSend}:{
  text:string;disabled:boolean;onCancel:()=>void;onSend:(value:string)=>Promise<void>;
}) {
  const [value,setValue]=useState(text);
  const [error,setError]=useState("");
  const [sending,setSending]=useState(false);
  const pending=useRef(false);
  const composing=useRef(false);
  return <form className="chat-message-editor" onSubmit={async event=>{
    event.preventDefault();
    if(disabled||pending.current||composing.current||!value.trim()||value.length>30000)return;
    pending.current=true;
    setSending(true);
    setError("");
    try{await onSend(value);}
    catch(cause){setError(cause instanceof Error?cause.message:"发送失败，已保留编辑内容。");}
    finally{pending.current=false;setSending(false);}
  }}>
    <textarea autoFocus aria-label="编辑已停止的消息" rows={4} maxLength={30000} value={value} readOnly={sending}
      onChange={event=>setValue(event.target.value)}
      onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onBlur={()=>{composing.current=false;}}
      onKeyDown={event=>{
        if(composing.current||event.nativeEvent.isComposing||event.keyCode===229)return;
        if(event.key==="Escape"&&!pending.current){event.preventDefault();onCancel();}
        if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();event.currentTarget.form?.requestSubmit();}
      }}/>
    {error&&<p className="chat-error" role="alert">{error}</p>}
    <div className="chat-message-editor-actions">
      <button type="button" className="secondary-button" disabled={sending} onClick={onCancel}>取消</button>
      <button type="submit" className="chat-send-button" disabled={disabled||sending||!value.trim()||value.length>30000}>
        {sending?<LoaderCircle size={15} className="spin"/>:<Send size={15}/>} 发送新消息
      </button>
    </div>
  </form>;
}

export function ChatAssistantMessage({author,at,response,error,status,turnStatus,current,copied,onCopy,process,actions,output,children}:{
  author:string; at?:string; response:string; error?:string; status:string; turnStatus:string; current:boolean;
  copied:boolean; onCopy:()=>void;
  process:{open:boolean; disabled:boolean; log?:string; toggle:()=>void; refresh:()=>void;
    previous?:{id:string;at?:string;status:string;response:string;error?:string;log?:string;load:()=>void;output?:React.ReactNode}[]};
  actions?:React.ReactNode; output?:React.ReactNode; children?:React.ReactNode;
}) {
  return <article className="chat-message chat-assistant">
    <header><span className="chat-agent-avatar"><Bot size={15}/></span><strong>{author}</strong><MessageTime at={at}/></header>
    {output ?? (response ? <ChatMarkdown text={response}/> :
      <div className={`chat-empty-response ${turnStatus==="running"?"working":""}`}>
        {turnStatus==="running"?<><span className="chat-thinking"><i/><i/><i/></span>正在处理，进展消息会陆续显示。</>:
          turnStatus==="queued"?"资源可用后自动开始。":turnStatus==="cancelling"?"正在停止，请稍候。":
          turnStatus==="failed"?"本轮未能完成，可以查看过程后重新发送。":"本轮没有返回文本。"}
      </div>)}
    {error&&<p className="chat-error">{error}</p>}
    {children}
    <div className="chat-turn-actions">
      <div className="chat-turn-buttons">
        {response&&<button type="button" className="text-button" onClick={onCopy}>
          {copied?<Check size={13}/>:<Copy size={13}/>} {copied?"已复制":"复制回复"}
        </button>}
        <button type="button" className="text-button" disabled={process.disabled} aria-expanded={process.open} onClick={process.toggle}>
          <ChevronDown size={13}/> {process.open?"收起过程":"查看过程"}
        </button>
        {actions}
      </div>
      <span className={`chat-turn-status status-${status}`} role={current?"status":undefined}>
        {["running","resuming","cancelling"].includes(status)&&<LoaderCircle size={12} className="spin" aria-hidden="true"/>}
        {status==="completed"&&<Check size={12} aria-hidden="true"/>}
        {chatStates[status]??status}
      </span>
    </div>
    {process.open&&<div className="chat-process-panel">
      <header><span>{process.previous?.length?`第 ${process.previous.length+1} 次执行`:"执行过程"} · {chatStates[status]??chatStates[turnStatus]??turnStatus}</span>
        <button type="button" className="text-button" disabled={process.disabled} onClick={process.refresh}>刷新</button>
      </header>
      <pre>{process.log||"暂无过程记录。"}</pre>
      {process.previous?.map((attempt,index)=><details className="chat-previous-attempt" key={attempt.id}>
        <summary>第 {index+1} 次执行 · {chatStates[attempt.status]??attempt.status} <MessageTime at={attempt.at}/></summary>
        <div>
          {attempt.output??(attempt.response&&<ChatMarkdown text={attempt.response}/>)}
          {attempt.error&&<p className="chat-error">{attempt.error}</p>}
          <button type="button" className="text-button" disabled={process.disabled} onClick={attempt.load}>
            {attempt.log===undefined?"读取执行日志":"刷新执行日志"}
          </button>
          {attempt.log!==undefined&&<pre>{attempt.log||"暂无过程记录。"}</pre>}
        </div>
      </details>)}
    </div>}
  </article>;
}

export function useChatScroll(thread:string,revision:unknown) {
  const messagesRef=useRef<HTMLDivElement>(null);
  const follow=useRef(true);
  const [away,setAway]=useState(false);
  const [unread,setUnread]=useState(false);
  const scrollBottom=(smooth=false)=>{
    const node=messagesRef.current;
    node?.scrollTo({top:node.scrollHeight,behavior:smooth?"smooth":"auto"});
    follow.current=true;
    setAway(false);
    setUnread(false);
  };
  useEffect(()=>{scrollBottom();},[thread]);
  useEffect(()=>{
    const node=messagesRef.current;
    if(follow.current)node?.scrollTo({top:node.scrollHeight});
    else setUnread(true);
  },[revision]);
  const onScroll=(event:React.UIEvent<HTMLDivElement>)=>{
    const node=event.currentTarget;
    const isAway=node.scrollHeight-node.scrollTop-node.clientHeight>90;
    follow.current=!isAway;
    setAway(isAway);
    if(!isAway)setUnread(false);
  };
  return {messagesRef,follow,setAway,away,unread,scrollBottom,onScroll};
}

export function ChatTranscript({scroll,target,label,children}:{
  scroll:ReturnType<typeof useChatScroll>; target:React.RefObject<HTMLDivElement|null>; label:string; children:React.ReactNode;
}) {
  return <div ref={target} className="chat-transcript-wrap">
    <div ref={scroll.messagesRef} className="chat-messages" role="log" aria-label={label}
      aria-live="polite" aria-relevant="additions text" onScroll={scroll.onScroll}>{children}</div>
    {scroll.away&&<button type="button" className="chat-jump-bottom" onClick={()=>scroll.scrollBottom(true)}>
      <ArrowDown size={14} aria-hidden="true"/>{scroll.unread?"有新进展 · 回到最新":"回到最新消息"}
    </button>}
  </div>;
}

export function ChatComposer({input,label,placeholder,store,conversation,disabled,onSubmit,shellProps,attachments,tools,controls,send,canSendAttachments=false,summary}:{
  input:React.RefObject<HTMLTextAreaElement|null>; label:string; placeholder:string;
  store:ChatDraftStore; conversation:string; disabled:boolean;
  onSubmit:React.FormEventHandler<HTMLFormElement>;
  shellProps?:React.HTMLAttributes<HTMLDivElement>; attachments?:React.ReactNode; tools?:React.ReactNode;
  controls:React.ReactNode; send:React.ComponentProps<typeof ChatSendButton>; canSendAttachments?:boolean; summary?:React.ReactNode;
}) {
  const draft=useSyncExternalStore(store.subscribe,()=>store.getSnapshot().messages[conversation]?.text??"");
  const composing=useRef(false);
  const cannotSend=disabled||send.disabled||(!draft.trim()&&!canSendAttachments);
  const scheduleResize=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const node=input.current;
    if(!node||window.CSS?.supports("field-sizing","content"))return;
    let frame:number|undefined;
    const schedule=()=>{
      if(frame!==undefined)return;
      frame=requestAnimationFrame(()=>{
        frame=undefined;
        // Measure against the CSS minimum so the field can shrink after deletion.
        node.style.height="auto";
        node.style.height=Math.min(node.scrollHeight,210)+"px";
      });
    };
    scheduleResize.current=schedule;
    let width=node.clientWidth;
    const observer=typeof ResizeObserver==="undefined"?undefined:new ResizeObserver(()=>{
      if(width===node.clientWidth)return;
      width=node.clientWidth;
      schedule();
    });
    observer?.observe(node);
    schedule();
    return()=>{
      observer?.disconnect();
      if(frame!==undefined)cancelAnimationFrame(frame);
      scheduleResize.current=()=>{};
    };
  },[input]);
  useEffect(()=>scheduleResize.current(),[draft,conversation]);
  useEffect(()=>{
    const flushWhenHidden=()=>{if(document.hidden)store.flush();};
    window.addEventListener("pagehide",store.flush);
    document.addEventListener("visibilitychange",flushWhenHidden);
    return()=>{
      window.removeEventListener("pagehide",store.flush);
      document.removeEventListener("visibilitychange",flushWhenHidden);
      store.flush();
    };
  },[store]);
  return <form className="chat-composer" onSubmit={event=>{
    if(composing.current||cannotSend){event.preventDefault();return;}
    onSubmit(event);
  }}>
    <div {...shellProps} className={`chat-input-shell ${shellProps?.className??""}`}>
      {attachments}
      <textarea ref={input} aria-label={label} value={draft} maxLength={30000} disabled={disabled}
        placeholder={placeholder} onChange={event=>store.updateText(conversation,event.target.value)}
        onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
        onBlur={()=>{composing.current=false;}} onKeyDown={event=>{
          if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&!composing.current&&!event.nativeEvent.isComposing&&event.keyCode!==229){
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}/>
      <div className="chat-input-tools">
        {tools}
        <span className="chat-char-count">{draft.length>24000?`${draft.length}/30000`:""}</span>
        <div className="chat-run-actions">{controls}<ChatSendButton {...send} disabled={cannotSend}/></div>
      </div>
    </div>
    <div className="chat-composer-footer">{summary}<small>Ctrl / ⌘ + Enter 发送</small></div>
  </form>;
}

function ChatSendButton({busy,disabled,append,title}:{busy:boolean;disabled:boolean;append?:boolean;title?:string}) {
  return <button className="chat-send-button" aria-label={append?"追加指令":"发送消息"} title={title} disabled={disabled}>
    {busy?<LoaderCircle size={15} className="spin"/>:<Send size={15}/>}<span>{append?"追加指令":"发送"}</span>
  </button>;
}
