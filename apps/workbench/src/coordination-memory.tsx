import { useEffect,useState } from "react";
import type { CoordinationMemoryKind,CoordinationMemoryPage,CoordinationMemoryHeader,CoordinationMember } from "@trash/protocol";
import { ChatMarkdown } from "./chat-markdown.js";
import { api,uiError } from "./api.js";

type Evidence={entries:{receipt:string;job:string;turn:string;observed:string;note:string}[];next_offset:number|null};
type Detail={evidence:Evidence;page:CoordinationMemoryPage;methods:{direction_id:string;scheme_id:string;title:string}[]};
type Index={pages:CoordinationMemoryHeader[];next_offset:number|null};
export function MemoryPanel({url,members,initialId,openChat,openMethod}:{url:string;members:CoordinationMember[];initialId?:string;openChat:(id:string,turn?:string)=>void;openMethod:(key:string)=>void}){
  const [q,query]=useState(""),[offset,setOffset]=useState(0),[index,setIndex]=useState<Index>();
  const [id,select]=useState(initialId??""),[detail,setDetail]=useState<Detail>(),[rev,setRev]=useState(0);
  const [edit,setEdit]=useState<CoordinationMemoryPage>(),[busy,setBusy]=useState(false),[error,setError]=useState(""),[tick,refresh]=useState(0);
  const [kind,setKind]=useState<CoordinationMemoryKind>("direction");
  const [compare,setCompare]=useState<CoordinationMemoryPage>();
  const names={direction:"方向档案",decision:"决策记录",lesson:"实验经验"};
  const [member,setMember]=useState("");
  const base=url+"/memory",joined=members.filter(m=>m.joined);
  useEffect(()=>{let alive=true;
    api<Index>(base+"?"+new URLSearchParams({q,offset:String(offset)})).then(value=>{if(alive)setIndex(value);}).catch(e=>{if(alive)setError(uiError(e,"读取索引失败"));});
    return()=>{alive=false;};
  },[base,q,offset,tick]);
  useEffect(()=>{let alive=true;setDetail(undefined);setCompare(undefined);
    if(id)api<Detail>(base+"?id="+id+(rev?"&revision="+rev:"")).then(value=>{if(alive)setDetail(value);}).catch(e=>{if(alive)setError(uiError(e,"读取档案失败"));});
    return()=>{alive=false;};
  },[base,id,rev,tick]);
  const page=detail?.page;
  function create(){
    const m=joined.find(m=>m.id===member);
    if(kind==="direction"&&!m)return;
    setEdit({id:crypto.randomUUID(),kind,conversation:m?.id??null,repository:m?.repository_id??null,title:kind==="direction"?m!.title:"",revision:0,archived:false,body:kind!=="direction"?"## 依据与结论\n\n## 适用范围\n\n## 局限与反例":"## 研究问题\n\n## 当前结论与依据\n\n## 待解决问题",source:"",updated:""});
  }
  async function save(p:CoordinationMemoryPage,confirmDecision=false){
    setBusy(true);setError("");
    try{
      const result=await api<{page:CoordinationMemoryPage;conflicts:string[]}>(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"memory-save",kind:p.kind,confirm_decision:confirmDecision,id:p.id,title:p.title,expected:p.revision,archived:p.archived,conversation:p.conversation??undefined,body:p.body})});
      if(result.conflicts.length)setError("版本已保存。以下 Markdown 有独立修改，已保留原文件："+result.conflicts.join("、"));
      setEdit(undefined);select(p.id);setRev(0);refresh(n=>n+1);
    }catch(e){setError(uiError(e,"保存失败，请核对当前版本"));}finally{setBusy(false);}
  }
  return <div className="coordination-panel memory-panel">
    {error&&<p role="alert">{error}</p>}
    <aside className="coord-section"><header><h3>记忆索引</h3></header>
      <input aria-label="搜索项目记忆" placeholder="搜索方向、结论或来源" maxLength={300} value={q} onChange={e=>{query(e.target.value);setOffset(0);}}/>
      {index?.pages.map(p=><button className="memory-entry" key={p.id} disabled={!!edit} aria-current={id===p.id?"page":undefined} onClick={()=>{select(p.id);setRev(0);}}>
        <strong>{p.title}</strong><small>{p.archived?"已归档":names[p.kind]} · v{p.revision}</small></button>)}
      {index&&!index.pages.length&&<p>暂无匹配档案</p>}
      <div><button className="text-button" disabled={!offset} onClick={()=>setOffset(offset-30)}>上一页</button><button className="text-button" disabled={index?.next_offset==null} onClick={()=>setOffset(offset+30)}>下一页</button></div>
      <select aria-label="新建记忆类型" value={kind} onChange={e=>setKind(e.target.value as CoordinationMemoryKind)}>{Object.entries(names).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
      <select aria-label="参与对话" value={member} onChange={e=>setMember(e.target.value)}><option value="">选择参与对话</option>{joined.map(m=><option key={m.id} value={m.id}>{m.title} · {m.repository}</option>)}</select>
      <button className="secondary-button" disabled={kind==="direction"&&!member||!!edit} onClick={create}>建立{names[kind]}</button>
    </aside>
    <section className="coord-section">{edit?<form onSubmit={e=>{e.preventDefault();void save(edit);}}>
      <label>标题<input required maxLength={180} value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})}/></label>
      <label>正文<textarea rows={14} required value={edit.body} maxLength={64000} onChange={e=>setEdit({...edit,body:e.target.value})}/></label>
      <div><button type="button" className="text-button" disabled={busy} onClick={()=>setEdit(undefined)}>取消</button><button className="primary-button" disabled={busy}>保存版本</button></div>
    </form>:page?<><header><h3>{page.title}</h3><span>v{page.revision}{page.archived?" · 已归档":""}</span></header>
      <ChatMarkdown text={page.body}/><small>{page.source} · {new Date(page.updated).toLocaleString()}</small>
      {!rev&&detail.evidence.entries.length>0&&<section><h4>成员回报</h4>{detail.evidence.entries.map(r=><details key={r.receipt}><summary>{new Date(r.observed).toLocaleString()} · {r.note.split("\n")[0]}</summary><ChatMarkdown text={r.note}/>{page.conversation&&<button className="text-button" onClick={()=>openChat(page.conversation!,r.turn)}>查看原回复</button>}</details>)}
      {detail.evidence.next_offset!==null&&<button className="text-button" onClick={()=>{void api<Evidence>(base+"/evidence?id="+id+"&offset="+detail.evidence.next_offset).then(value=>setDetail(current=>current===detail?{...detail,evidence:{...value,entries:[...detail.evidence.entries,...value.entries]}}:current)).catch(e=>setError(uiError(e,"读取回报失败")));}}>更早回报</button>}</section>}
      <div className="memory-actions">{page.conversation&&<button className="text-button" onClick={()=>openChat(page.conversation!)}>来源对话</button>}
      {detail.methods.map(m=><button key={m.direction_id+"/"+m.scheme_id} className="text-button" onClick={()=>openMethod(m.direction_id+"/"+m.scheme_id)}>{m.title} · 方法设计</button>)}
      {page.repository&&<small>仓库 · {members.find(m=>m.repository_id===page.repository)?.repository??page.repository}</small>}</div>
      <div className="memory-actions"><button className="secondary-button" disabled={busy||!!rev} onClick={()=>setEdit(page)}>修订</button>
      <button className="text-button" disabled={busy||!!rev} onClick={()=>void save({...page,archived:!page.archived})}>{page.archived?"恢复档案":"归档"}</button>
      <button className="text-button" disabled={page.revision<2} onClick={()=>setRev(page.revision-1)}>上一版本</button>
      {page.kind==="decision"&&!rev&&!page.archived&&page.source!=="用户在项目记忆确认此版本"&&<button className="text-button" disabled={busy} onClick={()=>void save(page,true)}>确认此决策版本</button>}
      {page.revision>1&&<button className="text-button" onClick={()=>{if(compare)setCompare(undefined);else void api<Detail>(base+"?id="+id+"&revision="+(page.revision-1)).then(r=>setCompare(r.page)).catch(e=>setError(uiError(e,"读取旧版失败")));}}>{compare?"收起对照":"与上一版对照"}</button>}
      {!!rev&&<button className="text-button" onClick={()=>setRev(0)}>返回当前版本</button>}</div>
      {compare&&compare.id===page.id&&compare.revision===page.revision-1&&<details open><summary>v{compare.revision} · {compare.title} · {compare.source}</summary><ChatMarkdown text={compare.body}/></details>}
    </>:<p>选择档案查看正文和来源，或从参与对话建立方向档案。</p>}</section>
  </div>;
}
