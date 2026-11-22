import { ChatAttachmentButtons, ChatAttachmentList, useChatAttachments, type ChatAttachment } from "./chat-attachments.js";
import { ChatHeightControl, useChatHeight } from "./chat-height-control.js";
import { ModalLayer } from './modal-layer.js';
import { ErrorNotice } from './error-notice.js';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, Bot, Check, ChevronDown, Copy, FolderOpen, List, LoaderCircle, MessageSquare, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Puzzle, Trash2, Search, Play, Send, Settings2, Square, X } from 'lucide-react';
import { chatDraftStore, type ChatWriteScope } from './chat-drafts.js';
import { copyText } from './clipboard.js';
import { ChatMarkdown } from './chat-markdown.js';
import './project-chat.css';

type ChatOutput={id:string;kind:'message'|'tool';status:string;text:string;title?:string;at:string};
type Turn={write_scope?:ChatWriteScope;waiting_for?:string;attachments?:ChatAttachment[];skill_id?:string;skill_origin?:'auto';output?:ChatOutput[];task_id:string;conversation_id:string;session_id?:string;instructions:string;response:string;status:string;sandbox:string;model:string;reasoning_effort?:string;error?:string;created_at:string;logs:string};
type Session={id:string;first:Turn;latest:Turn;count:number};
type History={tasks:Turn[];titles:Record<string,string>};
type ChatSkill={id:string;title:string;group?:'trash'|'claude-scholar'};
type SkillsStatus='loading'|'ready'|'failed';
type ModelConfig={model:string|null;reasoning_effort:string|null;models:{id:string;efforts:string[];default_effort:string}[]};
const effortLabels:Record<string,string>={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'XHigh',max:'Max',ultra:'Ultra'};
const states:Record<string,string>={queued:'等待资源',running:'正在处理',cancelling:'正在停止',completed:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
const errors:Record<string,string>={CHAT_WRITE_SCOPE_INVALID:"请选择项目中已有的普通子目录。",REPOSITORY_NOT_BOUND:"这个会话尚未绑定代码仓库。",CHAT_SESSION_ACTIVE:'请先完成或处理这段对话中的任务，再删除。',CHAT_MODEL_CONFIG_UNAVAILABLE:'暂时无法读取本机 Codex 设置。',CHAT_NOT_READY:'会话正在启动或停止，请稍后再追加指令。',PROJECT_HAS_ACTIVE_TASKS:'当前项目正在处理知识任务或其他操作，请等待完成后再发送。',CODE_AGENT_BUSY:'当前项目或绑定仓库有 Agent 正在执行，请等待或停止后再发送。',CODE_AGENT_RECOVERY_REQUIRED:'请先核对中断任务并确认旧进程停止。',CHAT_SESSION_NOT_FOUND:'未找到可恢复的会话，请新建对话。',EXPERIMENT_ACTIVE:'项目有未结束实验，请先处理实验状态。',INVALID_REQUEST:'请检查消息和对话选项。',WORKSPACE_MIGRATING:'论文工作区正在迁移，请完成后再发送消息。'};
const suggestions=[{title:'梳理研究方向',text:'请根据当前项目的研究问题和已有文献，梳理研究方向、已有证据以及需要补充的材料。'},{title:'比较文献方法',text:'请比较当前项目已有文献的方法、实验条件与局限，标明来源和不确定之处。'},{title:'整理研究 Wiki',text:'请基于现有文献卡片整理研究 Wiki，保留来源与版本引用，生成待审内容。'},{title:'讨论论文结构',text:'请结合当前研究问题和已有证据，和我讨论论文结构，区分已有结论与待验证假设。'}];
const time=(value:string)=>new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const date=(value:string)=>new Date(value).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});

function ChatSkillPicker({skills,status,value,disabled,onChange}:{
  skills:ChatSkill[];status:SkillsStatus;value:string;disabled:boolean;onChange:(value:string)=>void;
}){
  const id=useId();
  const trigger=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLDivElement>(null);
  const [query,setQuery]=useState('');
  const position=useCallback(()=>{
    const menu=panel.current,button=trigger.current;
    if(!menu||!button)return;
    const rect=button.getBoundingClientRect();
    const gap=8, edge=12, width=Math.min(242,window.innerWidth-edge*2);
    const above=rect.top-gap-edge,below=window.innerHeight-rect.bottom-gap-edge;
    const openAbove=above>=420||above>=below;
    menu.style.width=`${width}px`;
    menu.style.left=`${Math.max(edge,Math.min(rect.left,window.innerWidth-width-edge))}px`;
    menu.style.top=openAbove?'auto':`${rect.bottom+gap}px`;
    menu.style.bottom=openAbove?`${window.innerHeight-rect.top+gap}px`:'auto';
    menu.style.maxHeight=`${Math.max(0,openAbove?above:below)}px`;
  },[]);
  useEffect(()=>{
    const reposition=()=>{if(panel.current?.matches(':popover-open'))position();};
    window.addEventListener('resize',reposition);
    window.addEventListener('scroll',reposition,true);
    return()=>{
      window.removeEventListener('resize',reposition);
      window.removeEventListener('scroll',reposition,true);
    };
  },[position]);
  const selected=skills.find(skill=>skill.id===value);
  const label=selected?`选择 Skill，当前为${selected.title}`:'选择 Skill';
  const search=query.trim().toLowerCase();
  const visibleSkills=skills.filter(skill=>`${skill.title} ${skill.id}`.toLowerCase().includes(search));
  const groups=[
    {title:'TRASH Skill',items:visibleSkills.filter(skill=>skill.group!=='claude-scholar')},
    {title:'Claude Scholar',items:visibleSkills.filter(skill=>skill.group==='claude-scholar')}
  ];
  const option=(skill:ChatSkill)=>
    <button type="button" key={skill.id} disabled={disabled} aria-pressed={value===skill.id} onClick={()=>{
      onChange(skill.id);
      setQuery('');
      panel.current?.hidePopover();
      trigger.current?.focus();
    }}>
      <span>{skill.title}</span>
      {value===skill.id&&<Check size={15} aria-hidden="true"/>}
    </button>;
  return <>
    <button ref={trigger} type="button" className={`chat-attachment-icon chat-skill-trigger${selected?' selected':''}`}
      aria-label={label} title={label} disabled={disabled} popoverTarget={id} onClick={position}>
      <Puzzle size={16} aria-hidden="true"/>
    </button>
    <div ref={panel} id={id} popover="auto" className="chat-skill-popover" role="group" aria-label="选择 Skill">
      {status==='ready'?<>
        <label className="chat-skill-search">
          <Search size={14} aria-hidden="true"/>
          <input type="search" aria-label="搜索 Skill" placeholder="搜索 Skill…" value={query}
            onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/>
        </label>
        {!search&&option({id:'',title:'自动选择'})}
        {search&&!visibleSkills.length&&<p role="status">没有匹配的技能</p>}
        {groups.filter(group=>group.items.length).map(group=>
          <div key={group.title} className="chat-skill-group" role="group" aria-label={group.title}>
            <strong className="chat-skill-heading">{group.title}</strong>
            {group.items.map(option)}
          </div>
        )}
      </>:<p role="status">{status==='loading'?'正在读取 Skill…':'暂时无法读取 Skill，请重新打开对话页面。'}</p>}
    </div>
  </>;
}

export function ProjectChat({projectId,onBrowseResearch}:{projectId:string;onBrowseResearch:(path:string)=>void}){
  const {height:chatHeight,change:changeChatHeight}=useChatHeight(projectId);
  const transcriptRef=useRef<HTMLDivElement>(null);
  const base=`/api/v1/projects/${encodeURIComponent(projectId)}`;
  const draftStore=chatDraftStore(projectId);
  const {conversation:savedConversation,messages:drafts,sending:pendingSends,uploading:pendingUploads}=useSyncExternalStore(draftStore.subscribe,draftStore.getSnapshot);
  const conversation=savedConversation??'';
  const sending=Boolean(pendingSends[conversation]),uploading=Boolean(pendingUploads[conversation]);
  const draft=drafts[conversation]?.text??'';
  const selectedSkill=drafts[conversation]?.skill??'';
  const [turns,setTurns]=useState<Turn[]>([]);
  const [titles,setTitles]=useState<Record<string,string>>({});
  const [skills,setSkills]=useState<ChatSkill[]>([]);
  const [skillsStatus,setSkillsStatus]=useState<SkillsStatus>('loading');
  const [config,setConfig]=useState<ModelConfig>(),[configLoading,setConfigLoading]=useState(false),[configError,setConfigError]=useState('');
  const [sessionAction,setSessionAction]=useState<{id:string;type:'rename'|'delete';title:string}>();
  const [model,setModel]=useState(''),[effort,setEffort]=useState(''),[lastSandbox,setLastSandbox]=useState('workspace-write'),[lastWriteScope,setLastWriteScope]=useState<ChatWriteScope>('drafts');
  const sandbox=drafts[conversation]?.sandbox??lastSandbox;
  const writeScope=drafts[conversation]?.writeScope??lastWriteScope;
  const [actingBusy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[connected,setConnected]=useState(true),[query,setQuery]=useState(''),[history,setHistory]=useState(true),[options,setOptions]=useState(false),[indexOpen,setIndexOpen]=useState(false),[away,setAway]=useState(false),[unread,setUnread]=useState(false),[copied,setCopied]=useState('');
  const busy=actingBusy||sending;
  const [logs,setLogs]=useState<Record<string,string>>({}),[openLogs,setOpenLogs]=useState<Record<string,boolean>>({});
  const initial=useRef(false),messagesRef=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),follow=useRef(true),alive=useRef(true),acting=useRef(false),historyRevision=useRef(0);
  const attachments=useChatAttachments(base,conversation,drafts[conversation]?.attachments??[],draftStore,setError);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const call=async<T,>(path:string,body?:unknown):Promise<T>=>{
    const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const appendRequest=/^\/chat\/tasks\/[^/]+\/append$/.test(path);
    if(appendRequest&&response.status===404)throw new Error('追加接口尚未加载，或原任务已经结束。请先刷新对话状态；若仍在运行，请保存未发送内容，待任务结束或手动停止后，点击本分支重启按钮加载新接口。');
    const data=await response.json().catch(()=>{throw new Error('服务返回了非 JSON 响应，请检查本分支服务是否正常运行。');});
    if(!response.ok)throw new Error(errors[data.error]??`对话请求失败（HTTP ${response.status}${typeof data.error==='string'?`，${data.error}`:''}），请保留输入并查看服务日志。`);return data as T;
  };
  const refresh=async()=>{const data=await call<History>('/chat/tasks');if(alive.current){setTurns(data.tasks);setTitles(data.titles??{});setConnected(true);}return data.tasks;};
  useEffect(()=>{
    const controller=new AbortController();
    setSkillsStatus('loading');
    void fetch(base+'/chat/skills',{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error();
      const {skills}: {skills:ChatSkill[]}=await response.json();
      if(!controller.signal.aborted){setSkills(skills);setSkillsStatus('ready');}
    }).catch(()=>{if(!controller.signal.aborted)setSkillsStatus('failed');});
    return()=>controller.abort();
  },[base]);
  useEffect(()=>{
    let mounted=true,polling=false;
    const poll=async()=>{
      if(polling)return;polling=true;const revision=historyRevision.current;
      try{
        const data=await call<History>('/chat/tasks');if(!mounted||revision!==historyRevision.current)return;
        setTurns(data.tasks);setTitles(data.titles??{});setConnected(true);
        const draftState=draftStore.getSnapshot();
        if(!initial.current&&!draftState.sending[draftState.conversation??'']){
          initial.current=true;
          const selected=draftState.conversation;
          const latest=selected===undefined?data.tasks[0]:data.tasks.find(turn=>turn.conversation_id===selected);
          if(latest){
            if(selected===undefined)draftStore.choose(latest.conversation_id);
            setLastSandbox(latest.sandbox);setLastWriteScope(latest.write_scope??'drafts');setModel(latest.model);setEffort(latest.reasoning_effort??'');
          }
        }
      }catch{if(mounted)setConnected(false);}finally{polling=false;if(mounted)setLoading(false);}
    };
    void poll();const timer=setInterval(()=>void poll(),2000);return()=>{mounted=false;clearInterval(timer);};
  },[projectId,draftStore]);
  const sessions=useMemo(()=>{
    const groups=new Map<string,Session>();
    for(const turn of [...turns].sort((a,b)=>a.created_at.localeCompare(b.created_at))){const session=groups.get(turn.conversation_id);if(session){session.latest=turn;session.count++;}else groups.set(turn.conversation_id,{id:turn.conversation_id,first:turn,latest:turn,count:1});}
    return [...groups.values()].sort((a,b)=>b.latest.created_at.localeCompare(a.latest.created_at));
  },[turns]);
  const messages=useMemo(()=>turns.filter(turn=>turn.conversation_id===conversation).sort((a,b)=>a.created_at.localeCompare(b.created_at)),[turns,conversation]);
  const activeByConversation=useMemo(()=>new Map(turns.filter(turn=>['queued','running','cancelling'].includes(turn.status))
    .map(turn=>[turn.conversation_id,turn])),[turns]);
  const active=activeByConversation.get(conversation),session=sessions.find(item=>item.id===conversation),last=messages.at(-1);
  const currentTurn=active??last;
  const sessionTitle=(item:Session)=>titles[item.id]||item.first.instructions.slice(0,70);
  const filtered=sessions.filter(item=>`${sessionTitle(item)}\n${item.first.instructions}\n${item.latest.instructions}`.toLowerCase().includes(query.trim().toLowerCase()));
  const scrollBottom=(smooth=false)=>{const node=messagesRef.current;if(node)node.scrollTo({top:node.scrollHeight,behavior:smooth?'smooth':'auto'});follow.current=true;setAway(false);setUnread(false);};
  useEffect(()=>{follow.current=true;setUnread(false);setAway(false);messagesRef.current?.scrollTo({top:messagesRef.current.scrollHeight});},[conversation]);
  useEffect(()=>{if(follow.current)messagesRef.current?.scrollTo({top:messagesRef.current.scrollHeight});else setUnread(true);},[messages.length,last?.response,last?.status,JSON.stringify(last?.output)]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=Math.min(input.current.scrollHeight,210)+'px';}},[draft]);
  const updateDraft=(value:string)=>{
    if(draftStore.getSnapshot().sending[conversation])return;
    draftStore.update(conversation,message=>({...message,text:value}));
  };
  const choose=(session?:Session)=>{
    if(acting.current)return;
    initial.current=true;
    draftStore.choose(session?.id??'');setOpenLogs({});setError('');setIndexOpen(false);
    setLastSandbox(session?.latest.sandbox??'workspace-write');
    setLastWriteScope(session?.latest.write_scope??'drafts');
    setModel(session?.latest.model??'');setEffort(session?.latest.reasoning_effort??'');
    input.current?.focus();
  };
  const act=async(action:()=>Promise<void>)=>{
    if(acting.current)return;acting.current=true;setBusy(true);setError('');
    try{await action();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'操作失败。');}finally{acting.current=false;if(alive.current)setBusy(false);}
  };
  const configRequest=useRef<AbortController|undefined>(undefined);
  const settingsId=useId(), historyId=useId(), messageIndexId=useId();
  const historyToggle = useRef<HTMLButtonElement>(null);
  const restoreHistoryFocus = useRef(false);
  useEffect(()=>{
    if (!restoreHistoryFocus.current) return;
    restoreHistoryFocus.current = false;
    historyToggle.current?.focus();
  },[history]);
  const toggleHistory = () => {
    restoreHistoryFocus.current = true;
    setHistory(visible=>!visible);
  };
  const readModelConfig=useCallback(()=>{
    if(configRequest.current)return;
    const controller=new AbortController();
    configRequest.current=controller;
    setConfigLoading(true);setConfigError('');
    void fetch(base+'/chat/model-config',{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error(errors.CHAT_MODEL_CONFIG_UNAVAILABLE);
      const next:ModelConfig=await response.json();
      if(!controller.signal.aborted)setConfig(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
    }).catch(()=>{
      if(!controller.signal.aborted)setConfigError(errors.CHAT_MODEL_CONFIG_UNAVAILABLE);
    }).finally(()=>{
      if(configRequest.current===controller){
        configRequest.current=undefined;
        setConfigLoading(false);
      }
    });
  },[base]);
  useEffect(()=>{
    readModelConfig();
    return()=>{configRequest.current?.abort();configRequest.current=undefined;};
  },[readModelConfig]);
  const toggleOptions=()=>{
    if(!options){setIndexOpen(false);readModelConfig();}
    setOptions(!options);
  };
  const inheritedModel=config?.model;
  const shownModel=model||inheritedModel;
  const selectedModel=config?.models.find(item=>item.id===shownModel);
  const defaultEffort=config?.reasoning_effort??selectedModel?.default_effort;
  const shownEffort=effort||defaultEffort;
  const modelSummary = (shownModel ?? '模型设置') + (shownEffort ? ` · ${effortLabels[shownEffort] ?? shownEffort}` : '');
  const permissionLabel = sandbox==='read-only'?'只读交流':sandbox==='danger-full-access'?'完整本机权限':writeScope==='drafts'?'独立草稿':writeScope==='repository'?'绑定仓库':'项目读写';
  const threadTitle = session ? sessionTitle(session) : '新对话';
  const supportedEfforts=selectedModel?.efforts.length?selectedModel.efforts:Object.keys(effortLabels);
  const modelChoices=[...new Set([...(config?.models.map(item=>item.id)??[]),model])]
    .filter(value=>value&&value!==inheritedModel);
  const effortChoices=[...new Set([...supportedEfforts,effort])]
    .filter(value=>value&&value!==defaultEffort);
  const saveSessionAction=()=>{
    const action=sessionAction;
    if(!action||action.type==='rename'&&!action.title.trim())return;
    void act(async()=>{
      await call(`/chat/conversations/${encodeURIComponent(action.id)}/${action.type}`,action.type==='rename'?{title:action.title}:{confirm:true});
      const wasSelected=draftStore.getSnapshot().conversation===action.id;
      if(action.type==='delete')draftStore.discard(action.id,'');
      if(!alive.current)return;
      historyRevision.current++;
      if(action.type==='rename')setTitles(previous=>({...previous,[action.id]:action.title.trim()}));
      else{
        setTurns(previous=>previous.filter(turn=>turn.conversation_id!==action.id));
        if(wasSelected){
          setOpenLogs({});setIndexOpen(false);setModel('');setEffort('');setLastSandbox('workspace-write');setLastWriteScope('drafts');
        }
      }
      setSessionAction(undefined);
    });
  };
  const send=async(event:React.FormEvent)=>{
    event.preventDefault();
    const state=draftStore.getSnapshot();
    if((!draft.trim()&&!attachments.entries.length)||state.uploading[conversation]||state.sending[conversation]||
      (active&&(active.status!=='running'||!active.session_id))||acting.current||loading||
      (sandbox==='workspace-write'&&typeof writeScope==='object'&&!writeScope.directory.trim()))return;
    const instructions=draft.trim()?draft:'请查看并分析本条消息所附的材料。';
    if(state.conversation===undefined)draftStore.choose('');
    draftStore.setPending('sending',conversation,true);
    setError('');
    try{
      const data=await call<{task:Turn}>(active?`/chat/tasks/${active.task_id}/append`:'/chat/tasks',{
        instructions,attachments:attachments.entries.map(item=>item.id),skill_id:selectedSkill||undefined,
        model,reasoning_effort:effort||undefined,sandbox,confirm:true,timeout_seconds:1800,
        ...(sandbox==='workspace-write'?{write_scope:writeScope}:{}),...(conversation?{conversation_id:conversation}:{})
      });
      const stillSelected=draftStore.getSnapshot().conversation===conversation;
      draftStore.discard(conversation,data.task.conversation_id);
      if(!alive.current)return;
      historyRevision.current++;
      setTurns(old=>[data.task,...old.filter(turn=>turn.task_id!==data.task.task_id)]);
      if(stillSelected){setLastSandbox(data.task.sandbox);setLastWriteScope(data.task.write_scope??'drafts');follow.current=true;setIndexOpen(false);input.current?.focus();}
    }catch(cause){
      if(alive.current&&draftStore.getSnapshot().conversation===conversation)setError(cause instanceof Error?cause.message:'发送失败，草稿已保留。');
    }finally{draftStore.setPending('sending',conversation,false);}
  };
  const copy=(id:string,text:string)=>void copyText(text).then(()=>{if(alive.current)setCopied(id);}).catch(()=>setError('复制失败，请手动选择内容复制。'));
  const readLogs=(turn:Turn)=>void act(async()=>{const data=await call<{task:Turn}>(`/code-agent/tasks/${turn.task_id}`);if(alive.current){setLogs(old=>({...old,[turn.task_id]:data.task.logs}));setOpenLogs(old=>({...old,[turn.task_id]:true}));}});
  return <section className="project-chat">
    <header className="chat-page-heading"><div className="chat-page-icon"><Bot size={23}/></div><div><h2>Agent 对话</h2><p>围绕文献、研究思路和论文写作，持续推进当前项目。</p></div><button type="button" className="secondary-button" disabled={busy||uploading} onClick={()=>void act(async()=>{
      const result=await call<{path:string}>('/workspace/research',{});
      if(alive.current)onBrowseResearch(result.path);
    })}><FolderOpen size={15}/>研究笔记</button><button type="button" className="secondary-button" disabled={actingBusy} onClick={()=>choose()}><MessageSquarePlus size={15}/>新建对话</button></header>
    <div className={`chat-layout ${history?'':'chat-history-hidden'} ${chatHeight!==null?'chat-custom-height':''}`} style={chatHeight!==null?{'--chat-message-height':`${chatHeight}px`} as React.CSSProperties:undefined}>
      {history&&<aside id={historyId} className="chat-conversations" aria-label="项目对话记录">
        <div className="chat-history-heading">
          <strong>历史对话 <small>{sessions.length}</small></strong>
          <button type="button" ref={historyToggle} className="chat-header-icon chat-history-toggle"
            aria-label="收起历史对话" title="收起历史对话" aria-expanded={true} aria-controls={historyId} onClick={toggleHistory}>
            <PanelLeftClose size={16} aria-hidden="true"/>
          </button>
        </div><label className="chat-history-search"><Search size={14}/><input aria-label="搜索对话" placeholder="搜索对话…" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="chat-session-list">{loading?<p>正在读取对话…</p>:filtered.map(item=>{
        const title = sessionTitle(item);
        const selected = conversation === item.id;
        const status = activeByConversation.get(item.id)?.status??item.latest.status;
        const inProgress = status === 'running' || status === 'cancelling';
        return <div key={item.id} className={`chat-session-card ${selected?'selected':''}`}>
          <button type="button" className="chat-session-open" aria-current={selected?'true':undefined} disabled={actingBusy} onClick={()=>choose(item)}>
            <span className="chat-session-icon"><MessageSquare size={15} aria-hidden="true"/></span>
            <span className="chat-session-title">
              <strong title={title}>{title}</strong>
              {inProgress&&<span className={`chat-live-dot ${status==='cancelling'?'stopping':''}`}
                role="img" aria-label={states[status]} title={states[status]}/>}
            </span>
            <span className="chat-session-meta">
              <span>{date(item.latest.created_at)} · {item.count} 轮</span>{status==='queued'&&<span className="chat-session-warning">等待资源</span>}
              {['failed','interrupted'].includes(status)&&<span className="chat-session-warning">{states[status]}</span>}
            </span>
          </button>
          <div className="chat-session-actions">
            <button type="button" aria-label={`重命名：${title}`} title="重命名" disabled={busy||uploading} onClick={()=>setSessionAction({id:item.id,type:'rename',title})}><Pencil size={13}/></button>
            <button type="button" className="chat-session-delete" aria-label={`删除：${title}`} title="删除" disabled={actingBusy||Boolean(pendingSends[item.id]||pendingUploads[item.id])||inProgress||status==='queued'||status==='interrupted'} onClick={()=>setSessionAction({id:item.id,type:'delete',title})}><Trash2 size={13}/></button>
          </div>
        </div>;
      })}{!loading&&!filtered.length&&<p>{query?'没有匹配的对话。':'发送第一条消息，开始项目对话。'}</p>}</div><div className="chat-history-note">未发送的草稿会自动保存，返回对话后可继续编辑。</div></aside>}
      <div className="chat-main"><div className="chat-thread-controls">
        <header className="chat-thread-heading">
          <div className="chat-thread-identity">
            {!history && <button type="button" ref={historyToggle} className="chat-header-icon chat-history-toggle"
              aria-label="展开历史对话" title="展开历史对话" aria-expanded={false} onClick={toggleHistory}>
              <PanelLeftOpen size={16} aria-hidden="true"/>
            </button>}
            <div className="chat-thread-avatar"><MessageSquare size={18} aria-hidden="true"/></div>
            <div className="chat-thread-info">
              <strong title={threadTitle}>{threadTitle}</strong>
              <div className="chat-thread-meta">
                <span><i className={`chat-connection-dot ${connected?'':'offline'}`} aria-hidden="true"/>
                  {connected?'项目会话':'连接中断，正在重试'}</span>
                {messages.length>0 && <span className="chat-thread-count">{messages.length} 轮交流</span>}
              </div>
            </div>
          </div>
          <div className="chat-thread-actions">
            <button type="button" className={`chat-options-toggle ${options?'active':''}`}
              aria-label={`模型和权限设置，${modelSummary}，${permissionLabel}`}
              aria-expanded={options} aria-controls={options?settingsId:undefined} onClick={toggleOptions}>
              <Settings2 size={15} aria-hidden="true"/>
              <span className="chat-model-summary">{modelSummary}</span>
              <span className="chat-permission-label">{permissionLabel}</span>
              <ChevronDown size={13} className="chat-options-chevron" aria-hidden="true"/>
            </button>
            <button type="button" className={`chat-header-icon chat-index-toggle ${indexOpen?'active':''}`}
              aria-label="消息目录" title="消息目录" aria-expanded={indexOpen}
              aria-controls={indexOpen?messageIndexId:undefined} disabled={!messages.length}
              onClick={()=>{setOptions(false);setIndexOpen(!indexOpen);}}><List size={17} aria-hidden="true"/></button>
          </div>
        </header>
        {options&&<div id={settingsId} className="chat-options-panel">
          {configError?<p role="status">{configError}</p>:configLoading&&!config?<p role="status">正在读取模型设置…</p>:null}
          <div className="chat-settings">
            <label>对话模型<select value={model} disabled={busy||Boolean(active)} onChange={event=>{setModel(event.target.value);setEffort('');}}>
              <option value={model===inheritedModel?model:''}>{inheritedModel??'自动选择'}</option>
              {modelChoices.map(value=><option key={value} value={value}>{value}</option>)}
            </select></label>
            <label>推理强度<select value={effort} disabled={busy||Boolean(active)} onChange={event=>setEffort(event.target.value)}>
              <option value={effort===defaultEffort?effort:''}>{defaultEffort?effortLabels[defaultEffort]??defaultEffort:'Auto'}</option>
              {effortChoices.map(value=><option value={value} key={value}>{effortLabels[value]??value}</option>)}
            </select></label>
            <label>对话权限<select value={sandbox} disabled={busy||Boolean(active)} onChange={event=>{const sandbox=event.target.value;draftStore.update(conversation,message=>({...message,sandbox}));}}>
              <option value="read-only">只读交流</option><option value="workspace-write">项目资料与代码读写</option><option value="danger-full-access">完整本机权限</option>
            </select></label>
            {sandbox==='workspace-write'&&<label>写入范围<select
              value={typeof writeScope==='object'?'directory':writeScope} disabled={busy||Boolean(active)}
              onChange={event=>{const value=event.target.value;draftStore.update(conversation,message=>({...message,writeScope:value==='directory'?{directory:''}:value as ChatWriteScope}));}}>
              <option value="drafts">独立草稿与知识库发布</option>
              <option value="directory">指定项目子目录</option>
              <option value="repository">绑定代码仓库</option>
              <option value="project">项目资料与绑定仓库</option>
            </select></label>}
            {sandbox==='workspace-write'&&typeof writeScope==='object'&&<label>项目子目录<input
              value={writeScope.directory} placeholder="research 或 code/papers/实验名"
              disabled={busy||Boolean(active)} onChange={event=>{const directory=event.target.value;draftStore.update(conversation,message=>({...message,writeScope:{directory}}));}}/></label>}
          </div>
        </div>}
        {indexOpen&&<nav id={messageIndexId} className="chat-message-index" aria-label="消息目录">{messages.map((turn,index)=><button type="button" key={turn.task_id} onClick={()=>{const target=document.getElementById(`chat-turn-${turn.task_id}`);const container=messagesRef.current;if(target&&container)container.scrollTo({top:container.scrollTop+target.getBoundingClientRect().top-container.getBoundingClientRect().top-18,behavior:'smooth'});follow.current=false;setAway(true);setIndexOpen(false);}}><span>{index+1}</span>{turn.instructions.slice(0,100)}</button>)}</nav>}
      </div>
        <div ref={transcriptRef} className="chat-transcript-wrap"><div ref={messagesRef} className="chat-messages" role="log" aria-label="Agent 对话消息" aria-live="polite" aria-relevant="additions text" onScroll={event=>{const node=event.currentTarget,isAway=node.scrollHeight-node.scrollTop-node.clientHeight>90;follow.current=!isAway;setAway(isAway);if(!isAway)setUnread(false);}}>
          {loading?<div className="chat-loading"><LoaderCircle size={20} className="spin"/>正在读取项目对话</div>:!messages.length?<div className="chat-welcome"><span className="chat-welcome-icon"><Bot size={31}/></span><span className="chat-eyebrow">你的论文研究助手</span><h3>这篇论文，我们从哪里开始？</h3><p>从一个问题、一篇文献，或尚未成形的研究思路开始。</p><div className="chat-suggestions">{suggestions.map(item=><button type="button" key={item.title} disabled={busy} onClick={()=>{updateDraft(draft?draft+'\n\n'+item.text:item.text);input.current?.focus();}}><strong>{item.title}</strong><span>{item.text}</span></button>)}</div><small>生成内容需要审核，文献结论与真实实验结果会分别记录。</small></div>:messages.map((turn,index)=>{
            const isCurrent = turn.task_id === currentTurn?.task_id;
            const status = isCurrent && !connected ? 'offline' : turn.status;
            const statusText = status === 'offline' ? '状态待同步' : states[status] ?? status;
            return <section key={turn.task_id} className="chat-turn" id={`chat-turn-${turn.task_id}`} aria-label={`第 ${index+1} 轮对话`}>
            <article className="chat-message chat-user"><header><span>你</span><time dateTime={turn.created_at}>{time(turn.created_at)}</time></header>{turn.skill_id&&<div className="chat-turn-skill"><Puzzle size={13} aria-hidden="true"/>{turn.skill_origin==='auto'?'自动加载 · ':''}{skills.find(skill=>skill.id===turn.skill_id)?.title??turn.skill_id}</div>}<div className="chat-user-body">{turn.instructions}</div><ChatAttachmentList base={base} entries={turn.attachments??[]}/><footer className="chat-user-actions"><button type="button" onClick={()=>{updateDraft(draft?draft+'\n\n'+turn.instructions:turn.instructions);input.current?.focus();}}>引用</button><button type="button" aria-label="复制用户消息" onClick={()=>copy(turn.task_id+'-user',turn.instructions)}>{copied===turn.task_id+'-user'?<Check size={13}/>:<Copy size={13}/>} {copied===turn.task_id+'-user'?'已复制':'复制'}</button></footer></article>
            <article className="chat-message chat-assistant"><header><span className="chat-agent-avatar"><Bot size={15}/></span><strong>论文助手</strong><time dateTime={turn.created_at}>{time(turn.created_at)}</time></header>{turn.output?.length?<ChatOutputMessages output={turn.output} response={turn.response}/>:turn.response?<ChatMarkdown text={turn.response}/>:<div className={`chat-empty-response ${turn.status==='running'?'working':''}`}>{turn.status==='running'?<><span className="chat-thinking"><i/><i/><i/></span>正在处理，进展消息会陆续显示。</>:turn.status==='queued'?`等待资源${turn.waiting_for?` · ${turn.waiting_for}`:''}`:turn.status==='cancelling'?'正在停止，请稍候。':turn.status==='failed'?'本轮未能完成，可以查看过程后重新发送。':'本轮没有返回文本。'}</div>}{turn.error&&<p className="chat-error">{turn.error}</p>}
              <div className="chat-turn-actions">
                <div className="chat-turn-buttons">{turn.response&&<button type="button" className="text-button" onClick={()=>copy(turn.task_id,turn.response)}>{copied===turn.task_id?<Check size={13}/>:<Copy size={13}/>} {copied===turn.task_id?'已复制':'复制回复'}</button>}<button type="button" className="text-button" disabled={busy} aria-expanded={Boolean(openLogs[turn.task_id])} onClick={()=>openLogs[turn.task_id]?setOpenLogs(old=>({...old,[turn.task_id]:false})):readLogs(turn)}><ChevronDown size={13}/> {openLogs[turn.task_id]?'收起过程':'查看过程'}</button>{['failed','cancelled','interrupted'].includes(turn.status)&&<button type="button" className="text-button" disabled={busy} onClick={()=>{updateDraft(draft?draft+'\n\n'+turn.instructions:turn.instructions);input.current?.focus();}}>将问题填入输入框</button>}{turn.status==='interrupted'&&<button type="button" className="text-button" disabled={busy} onClick={()=>{if(window.confirm('请先确认旧 Agent 进程已经停止，并核对本轮已产生的改动。确认完成？'))void act(async()=>{await call(`/code-agent/tasks/${turn.task_id}/acknowledge`,{confirm:true});await refresh();});}}>确认旧进程已停止</button>}
                </div>
                <span className={`chat-turn-status status-${status}`} role={isCurrent?'status':undefined}>
                  {['running','cancelling'].includes(status) && <LoaderCircle size={12} className="spin" aria-hidden="true"/>}
                  {status === 'completed' && <Check size={12} aria-hidden="true"/>}
                  {statusText}
                </span>
              </div>
              {openLogs[turn.task_id]&&<div className="chat-process-panel"><header><span>执行过程 · {states[turn.status]??turn.status}</span><button type="button" className="text-button" disabled={busy} onClick={()=>readLogs(turn)}>刷新</button></header><pre>{logs[turn.task_id]||'暂无过程记录。'}</pre></div>}
            </article></section>;
          })}
          </div>
          {away&&<button type="button" className="chat-jump-bottom" onClick={()=>scrollBottom(true)}><ArrowDown size={14} aria-hidden="true"/>{unread?'有新进展 · 回到最新':'回到最新消息'}</button>}
        </div>
        <ChatHeightControl height={chatHeight} onChange={changeChatHeight} target={transcriptRef}/>
        {error&&<div className="chat-notice"><ErrorNotice>{error}</ErrorNotice><button type="button" className="icon-button" aria-label="关闭对话错误提示" onClick={()=>setError('')}><X size={13}/></button></div>}
        <form className="chat-composer" onSubmit={event=>void send(event)}><div className={`chat-input-shell ${attachments.dragging?'chat-drop-active':''}`} onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=busy||uploading?'none':'copy';attachments.setDragging(!busy&&!uploading);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))attachments.setDragging(false);}} onDrop={event=>{if(busy||uploading){event.preventDefault();attachments.setDragging(false);return;}attachments.drop(event);}} onPaste={event=>{if(!busy)attachments.paste(event);}}><ChatAttachmentList base={base} entries={attachments.entries} uploading={uploading} onRemove={attachments.remove}/>{attachments.dragging&&<div className="chat-drop-label">松开即可上传图片或文件</div>}<textarea ref={input} aria-label="发送给项目 Agent 的消息" value={draft} maxLength={30000} disabled={busy} onChange={event=>updateDraft(event.target.value)} placeholder="输入研究问题，或交代需要整理的文献与稿件内容…" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/><div className="chat-input-tools"><ChatAttachmentButtons disabled={busy||uploading} onUpload={files=>void attachments.upload(files)}/>
          <ChatSkillPicker key={conversation} skills={skills} status={skillsStatus} value={selectedSkill} disabled={busy}
            onChange={skill=>draftStore.update(conversation,message=>({...message,skill}))}/>
          <span className="chat-char-count">{draft.length>24000?`${draft.length}/30000`:''}</span><div className="chat-run-actions"><button type="button" className="chat-control-button" aria-label={active?.status==='queued'?'取消排队':'停止'} title={active?.status==='queued'?'取消当前等待任务':'停止当前对话'} disabled={busy||!active||active.conversation_id!==conversation||active.status==='cancelling'} onClick={()=>void act(async()=>{if(!active)return;await call(`/code-agent/tasks/${active.task_id}/cancel`,{confirm:true});await refresh();})}><Square size={15}/></button><button type="button" className="chat-control-button" aria-label="恢复" title="恢复当前对话" disabled={busy||Boolean(active)||!last?.session_id||!['cancelled','failed'].includes(last.status)} onClick={()=>void act(async()=>{if(!last)return;const data=await call<{task:Turn}>('/chat/tasks',{instructions:'继续上次被中断的工作，先核对已执行操作，避免重复副作用。',model,reasoning_effort:effort||undefined,sandbox:last.sandbox,...(last.sandbox==='workspace-write'?{write_scope:last.write_scope??'drafts'}:{}),conversation_id:conversation,confirm:true,timeout_seconds:1800});setTurns(old=>[data.task,...old.filter(turn=>turn.task_id!==data.task.task_id)]);follow.current=true;})}><Play size={15}/></button><button className="chat-send-button" aria-label={active?.status==='running'?'追加指令':'发送消息'} title={active?'停止当前轮，并在同一会话中处理追加指令':undefined} disabled={busy||uploading||(!draft.trim()&&!attachments.entries.length)||loading||Boolean(active&&(active.status!=='running'||!active.session_id))||(sandbox==='workspace-write'&&typeof writeScope==='object'&&!writeScope.directory.trim())}>{busy?<LoaderCircle size={15} className="spin"/>:<Send size={15}/>}<span>{active?.status==='running'?'追加指令':'发送'}</span></button></div></div></div>
          <div className="chat-composer-footer"><span>围绕当前论文项目交流 · 按所选权限执行</span><small>Ctrl / ⌘ + Enter 发送</small></div>
        </form>
      </div>
    </div>
    {sessionAction&&<ModalLayer><div className="modal-backdrop" onKeyDown={event=>{if(event.key==='Escape'&&!busy)setSessionAction(undefined);}}>
      <form className="modal chat-session-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-session-dialog-title" onSubmit={event=>{event.preventDefault();saveSessionAction();}}>
        <h3 id="chat-session-dialog-title">{sessionAction.type==='rename'?'重命名对话':'删除对话'}</h3>
        {sessionAction.type==='rename'?<label>对话名称<input autoFocus value={sessionAction.title} maxLength={120} required
          onChange={event=>setSessionAction({...sessionAction,title:event.target.value})}/></label>:<p>将「{sessionAction.title}」从项目的历史对话中移除。</p>}
        {error&&<ErrorNotice>{error}</ErrorNotice>}
        <div className="modal-actions"><button type="button" className="secondary-button" autoFocus={sessionAction.type==='delete'} disabled={busy} onClick={()=>setSessionAction(undefined)}>取消</button>
          <button className="primary-button" disabled={busy||!sessionAction.title.trim()}>{sessionAction.type==='rename'?'保存名称':'删除对话'}</button></div>
      </form>
    </div></ModalLayer>}
  </section>;
}

function ChatOutputMessages({output,response}:{output:ChatOutput[];response:string}){
  const messages=output.filter(item=>item.kind==='message'&&item.text);
  return <div className="chat-output-stream">{output.map(item=>item.kind==='message'?item.text&&<div className="chat-output-message" key={item.id}><ChatMarkdown text={item.text}/>{item.status==='running'&&<span className="chat-output-writing">正在回复…</span>}</div>:<details className="chat-tool-event" key={item.id}><summary><span className="chat-tool-icon">{item.status==='running'?<LoaderCircle size={15} className="spin"/>:item.status==='failed'?<X size={15}/>:<Check size={15}/>}</span><strong>{item.title||'执行操作'}</strong><span>{item.status==='running'?'进行中':item.status==='failed'?'失败':'完成'}</span><small>查看详情</small></summary><pre>{item.text||'此操作没有额外描述，原始事件可在过程日志中查看。'}</pre></details>)}{response&&!messages.some(item=>item.text===response)&&<div className="chat-output-message"><ChatMarkdown text={response}/></div>}</div>;
}
