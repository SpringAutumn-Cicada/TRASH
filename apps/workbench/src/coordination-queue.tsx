import { useState } from "react";
import type { CoordinationView, CoordinationJob, CoordinationPlan, HostComputeResources } from "@trash/protocol";
import { Server } from "lucide-react";
import { api, uiError } from "./api.js";
import { ModalLayer } from "./modal-layer.js";
const statuses:Record<string,string>={pending:"待确认",authorized:"等待调度",blocked:"需处理",skipped:"已跳过",submitted:"已提交",queued:"已排队",running:"运行中",preflight:"预检查",syncing:"正在上传",collecting:"收集产物",cancel_requested:"正在取消",disconnected:"主机断连",unknown_remote_state:"远端状态待核对",completed:"运行结束",failed:"运行失败",cancelled:"已取消"};
type Review={job:CoordinationJob;plan:CoordinationPlan;hash:string;manifest:unknown;script?:unknown};
export function CoordinationQueue({data,project,act,busy,openRun}:{data:CoordinationView;project:string;act:(body:object)=>Promise<boolean>;busy:boolean;openRun:(id:string)=>void}){
  const [review,setReview]=useState<Review>(),[ack,setAck]=useState(false);
  const [loading,setLoading]=useState(false),[error,setError]=useState("");
  const [gpu,setGpu]=useState<Record<string,HostComputeResources>>({});
  const base="/projects/"+encodeURIComponent(project);
  const inspect=async(job:CoordinationJob,p:CoordinationPlan)=>{
    setLoading(true);setError("");setAck(false);
    try{const result=await api<Pick<Review,"hash"|"manifest"|"script">>(base+"/coordination",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"review",id:job.id,ref:p.id})});setReview({job,plan:p,...result});}
    catch(cause){setError(uiError(cause,"读取执行清单失败"));}finally{setLoading(false);}
  };
  const probe=async(id:string)=>{
    setLoading(true);setError("");
    try{const {resources}=await api<{resources:HostComputeResources}>(base+"/ssh-profiles/"+encodeURIComponent(id)+"/compute-resources");
      setGpu(prev=>({...prev,[id]:resources}));}catch(cause){setError(uiError(cause,"读取 GPU 状态失败"));}finally{setLoading(false);}
  };
  const movable=data.jobs.filter(j=>!j.consultation&&!j.finished&&!j.plans?.some(p=>p.run_id));
  return <section className="coord-section"><header><h3><Server size={18}/>AutoDL 排队与运行</h3></header>
    {error&&<p role="alert" className="notice error-notice">{error}</p>}
    {data.hosts.map(h=><div className="coord-row" key={h.id}><div><strong>{h.name}</strong><small>{h.connected?"已连接":"未连接"}</small>
      {gpu[h.id]&&<p>{gpu[h.id].gpus.map(g=>"GPU "+g.index+" · 可用 "+(g.memory_free_mib??"未知")+" / "+(g.memory_total_mib??"未知")+" MiB").join("，")||gpu[h.id].message} · {new Date(gpu[h.id].checked_at).toLocaleTimeString()}</p>}</div>
      <button className="text-button" disabled={!h.connected||loading} onClick={()=>void probe(h.id)}>读取显存</button></div>)}
    {!data.queue.length&&<p>平台当前没有排队或运行中的实验。</p>}
    {data.queue.map(r=><div className="coord-row" key={r.id}><div><strong>{r.title}</strong><small>{r.host} · {statuses[r.status]??r.status}</small></div><button className="text-button" onClick={()=>openRun(r.id)}>查看运行</button></div>)}
    {data.jobs.filter(j=>j.expects_runs||j.plans?.length).map(job=><div className="coord-job" key={job.id}><header><strong>{job.title}</strong>
      {movable.indexOf(job)>0&&<button disabled={busy} className="text-button" onClick={()=>void act({action:"move",id:job.id,before:movable[movable.indexOf(job)-1].id})}>上移</button>}</header>
      {job.after&&<small>前置任务 · {data.jobs.find(j=>j.id===job.after)?.title} · {job.gate==="success"?"需有效结果":"结束后运行"}</small>}
      {!job.plans?.length&&<p>{job.reason||job.report||"等待论文对话准备计划"}</p>}
      {job.plans?.map(p=><div className="coord-row" key={p.id}><div><strong>{p.title} · v{p.version}{p.preparation?" · 环境准备":""}</strong>
        <small>{p.repository} · {p.host} · {statuses[p.run_status??p.status]} {p.info}</small>{p.metrics&&<small>{p.metrics}</small>}
        {p.artifacts?.filter(a=>a.id).map(a=><a key={a.path} href={"/api/v1"+base+"/experiment-artifacts/"+p.run_id+"/"+a.id} download>{a.path} </a>)}</div>
        {p.run_id?<button className="text-button" onClick={()=>openRun(p.run_id!)}>运行记录</button>:
          <div>{p.status==="pending"&&<button className="secondary-button" disabled={busy||loading} onClick={()=>void inspect(job,p)}>核对并授权</button>}
          {p.status!=="skipped"&&<button className="text-button" disabled={busy} onClick={()=>void act({action:"skip",id:job.id,ref:p.id,version:p.version,confirm:true})}>跳过</button>}</div>}</div>)}
    </div>)}
    {review&&<ModalLayer><div className="modal-backdrop"><div className="modal coord-approval" role="dialog" aria-modal="true" aria-label="确认实验排队">
      <h3>{review.plan.preparation?"确认执行准备脚本":"确认实验排队"} · {review.plan.title}</h3>
      <p>将上传固定提交的 Git 历史，并在所选 AutoDL 主机执行。</p><pre>{JSON.stringify(review.manifest,null,2)}</pre>
      {review.script!==undefined&&<pre>{typeof review.script==="string"?review.script:JSON.stringify(review.script,null,2)}</pre>}
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>已核对代码版本、执行内容和主机，授权本次排队执行</label>
      <div className="modal-actions"><button className="secondary-button" autoFocus disabled={busy} onClick={()=>setReview(undefined)}>返回</button>
        <button className="primary-button" disabled={!ack||busy} onClick={async()=>{await act({action:"authorize",id:review.job.id,ref:review.plan.id,version:review.plan.version,hash:review.hash,confirm:true});setReview(undefined);}}>确认授权</button></div>
    </div></div></ModalLayer>}
  </section>;
}
