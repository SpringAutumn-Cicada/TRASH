import type { CoordinationJob, CoordinationMember } from "@trash/protocol";
import { ArrowUpRight, MessagesSquare } from "lucide-react";

const outcomes = {answered:"已答复",blocked:"需处理",failed:"未完成",withdrawn:"已撤回"};

export function ConsultationFeedback({jobs,members,busy,select,open}:{
  jobs:CoordinationJob[]; members:CoordinationMember[]; busy:boolean;
  select:(job:string,conversation:string)=>void; open:(conversation:string,turn:string)=>void;
}){
  if(!jobs.length)return null;
  return <section className="consult-feedback" aria-label="对话反馈">
    <header><MessagesSquare size={16}/><strong>对话反馈</strong>
      <small>{jobs.filter(job=>job.feedback==="answered").length} / {jobs.length} 已答复</small>
    </header>
    {jobs.map(job=>{
      const state=job.feedback?outcomes[job.feedback]:job.reason||(job.worker_status==="queued"?"等待资源":"正在答复");
      const reply=job.worker_response||job.report||job.reason;
      return <div key={job.id} className="consult-item">
        <details><summary>
          <strong>{job.title}</strong><span className="consult-state">{state}</span>
          <small>{reply||job.instructions}</small>
        </summary>
        <div className="consult-body"><strong>{job.parent_question?"追问":"提问"}</strong><p>{job.instructions}</p>
          {reply&&<><strong>{job.feedback==="answered"?"答复":"反馈"}</strong><p>{reply}</p></>}
          {job.reply_task_id&&<button type="button" className="text-button" onClick={()=>open(job.conversation,job.reply_task_id!)}>查看原对话 <ArrowUpRight size={13}/></button>}
        </div></details>
        {job.status==="waiting"&&job.candidates&&<div className="consult-choices">
          {members.filter(m=>job.candidates?.includes(m.id)).map(m=><button type="button" key={m.id} disabled={busy}
            className="secondary-button" onClick={()=>select(job.id,m.id)}>
            {m.joined?"询问":"加入并询问"} {m.title} · {m.repository}
          </button>)}
        </div>}
      </div>;
    })}
  </section>;
}
