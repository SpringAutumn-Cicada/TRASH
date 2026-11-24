import React, { useId, useState } from "react";
import { Check, ChevronRight, LoaderCircle, MessageSquareMore } from "lucide-react";
import type { ChatDecision } from "@trash/protocol";

export function ChatDecisionCard({decision,disabled,continued,choose}:{
  decision:ChatDecision;
  disabled:boolean;
  continued:boolean;
  choose:(optionId:string)=>Promise<void>;
}){
  const titleId=useId();
  const [submitting,setSubmitting]=useState<string>();
  const [error,setError]=useState("");
  const selected=decision.options.find(option=>option.id===decision.option_id);
  const retry=decision.status==="selected"&&!continued&&selected;
  const confirm=async(id:string)=>{
    if(disabled||submitting)return;
    setSubmitting(id);setError("");
    try{await choose(id);}
    catch(cause){setError(cause instanceof Error?cause.message:"选择未能提交，请重试。");}
    finally{setSubmitting(undefined);}
  };
  return <section className="chat-decision" aria-labelledby={titleId}>
    <header className="chat-decision-heading">
      <span className="chat-decision-icon"><MessageSquareMore size={17} aria-hidden="true"/></span>
      <div>
        <h4 id={titleId}>{decision.title}</h4>
        {decision.description&&<p>{decision.description}</p>}
      </div>
    </header>
    {!!decision.details?.length&&<dl className="chat-decision-details">{decision.details.map(({label,value},index)=>
      <div key={index}><dt>{label}</dt><dd>{value}</dd></div>
    )}</dl>}
    {!!decision.files?.length&&<details className="chat-decision-files">
      <summary>待提交文件（{decision.files.length}）</summary>
      <ul>{decision.files.map(file=><li key={file}><code>{file}</code></li>)}</ul>
    </details>}
    {decision.status==="pending"&&<div className="chat-decision-options" aria-busy={Boolean(submitting)}>
      {decision.options.map(option=><button key={option.id} type="button" disabled={disabled||Boolean(submitting)}
        className={option.primary?"primary-button":"secondary-button"} onClick={()=>void confirm(option.id)}>
        <span><strong>{option.label}</strong>{option.detail&&<small>{option.detail}</small>}</span>
        {submitting===option.id?<LoaderCircle className="spin" size={15} aria-hidden="true"/>:<ChevronRight size={15} aria-hidden="true"/>}
      </button>)}
    </div>}
    {decision.status==="selected"&&<div className="chat-decision-result" role="status">
      <Check size={15} aria-hidden="true"/> 已选择 · {selected?.label}
      {retry&&<button className="secondary-button" type="button" disabled={disabled||Boolean(submitting)}
        onClick={()=>void confirm(retry.id)}>{submitting?"正在续接…":"继续已选操作"}</button>}
    </div>}
    {decision.status==="stale"&&<p className="chat-decision-result" role="status">{decision.reason||"此选择需重新确认。"}</p>}
    {error&&decision.status!=="stale"&&<p className="chat-error" role="alert">{error}</p>}
  </section>;
}
