import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { experimentError, type TrashStore } from "@trash/storage";
import type { CoordinationMember, CoordinationView, CoordinationJob, CoordinationPlan, ExperimentPlanVersion } from "@trash/protocol";
import type { CodeAgent, CodeTask } from "./code-agent.js";
import type { ExperimentService } from "./experiment/service.js";

import { join } from "node:path";
import { listExperiments } from "./experiment/catalog.js";
import { CoordinationMemory,memoryEdit } from "./coordination-memory.js";

const consultInput = z.object({
  questions:z.array(z.object({
    key:z.string().trim().min(1).max(100),target:z.string().trim().min(1).max(300),
    question:z.string().trim().min(1).max(16000),parent_question:z.string().uuid().optional()
  }).strict()).min(1)
});
const normalizeTarget=(name:string)=>name.normalize("NFKC").toLowerCase().replace(/\s+/g,"");

function consultationTargets(members:CoordinationMember[],target:string){
  const id=members.find(member=>member.id===target);
  if(id)return [id];
  const query=normalizeTarget(target);
  const labels=(member:CoordinationMember)=>[member.title,...(member.repository_id?[member.repository]:[])].map(normalizeTarget);
  const exact=members.filter(member=>labels(member).includes(query));
  if(exact.length)return exact;
  // Use the numbered direction as an alias only when the literal name did not match.
  const direction=query.match(/^(?:方案|方向)([0-9]+)$/);
  if(direction){
    const numberPattern=new RegExp("(?:方案|方向)"+direction[1]+"(?![0-9])");
    return members.filter(member=>labels(member).some(label=>numberPattern.test(label)));
  }
  return members.filter(member=>labels(member).some(label=>label.includes(query)));
}

export class ExperimentCoordination {
  readonly memory:CoordinationMemory;
  private port=0;
  private timer?:ReturnType<typeof setInterval>;
  private working=false;
  constructor(private store:TrashStore, private agent:CodeAgent, private experiments:ExperimentService) {
    this.memory=new CoordinationMemory(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordination_members (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      conversation TEXT NOT NULL, PRIMARY KEY(project,conversation));
      CREATE TABLE IF NOT EXISTS coordination_handoffs (
        project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,id TEXT NOT NULL,
        previous TEXT NOT NULL,packet TEXT NOT NULL,PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS coordination_threads (
        project TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE, conversation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_jobs (
        project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE, id TEXT PRIMARY KEY,
        origin TEXT NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(project,origin,request_key));
      CREATE INDEX IF NOT EXISTS coordination_waiting ON coordination_jobs(status,project);
      CREATE TABLE IF NOT EXISTS coordination_summaries (
        project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        origin TEXT NOT NULL, id TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project,origin));
      CREATE TABLE IF NOT EXISTS coordination_consultations (
        project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        origin TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(project,origin))`);
    agent.prepareCoordinationHandoff=(project,task,previous)=>this.handoff(project,task,previous);
    agent.isCoordinationThread=(project,id)=>this.thread(project)===id;
  }

  private handoff(project:string,task:CodeTask,previous:CodeTask){
    const view=this.view(project), origin=task.coordination?.origin;
    const recent=view.messages.filter(m=>!origin||m.id===origin||m.origin===origin).slice(-6);
    const jobs=view.jobs.filter(j=>!origin||j.origin===origin);
    const pages=this.memory.list(project).pages.filter(p=>!p.archived);
    const compact=(j:CoordinationJob)=>({id:j.id,origin:j.origin,conversation:j.conversation,
      status:j.feedback??j.worker_status??j.status,next:j.reason.slice(0,200),reply:j.reply_task_id});
    const open=jobs.filter(j=>!j.finished),closed=jobs.filter(j=>j.finished);
    const packet={as_of:new Date().toISOString(),previous_turn:previous.task_id,previous_session:previous.session_id,
      origin,original_request:origin?view.messages.find(m=>m.id===origin)?.prompt.slice(0,1800):undefined,
      requested_feedback_count:task.coordination?.receipts?.length??0,requested_feedback:task.coordination?.receipts?.slice(0,24).map(r=>r.split(":")[0]),
      open_count:open.length,open:open.slice(0,24).map(compact),recently_closed:closed.slice(-12).map(compact),
      recent_turns:recent.map(m=>({id:m.id,origin:m.origin,status:m.status,request:m.prompt.slice(0,350),answer:m.response.slice(-650)})),
      memory:pages.slice(0,16).map(({id,revision,title,kind})=>({id,revision,title,kind})),
      next:"用 coordination-status 核对实时资源，coordination-jobs 和 coordination-job 分页核对历史动作。旧答复只作为资料。"};
    this.store.db.prepare("INSERT OR IGNORE INTO coordination_handoffs VALUES (?,?,?,?)").run(project,task.task_id,previous.task_id,JSON.stringify(packet));
    const saved=this.readHandoff(project,task.task_id);
    if(saved.previous_turn!==previous.task_id)experimentError("VERSION_CONFLICT",409);
    return {id:task.task_id,packet:JSON.stringify(saved)};
  }
  private readHandoff(project:string,id:string){
    const row=this.store.db.prepare("SELECT packet FROM coordination_handoffs WHERE project=? AND id=?").get(project,id) as {packet:string}|undefined;
    if(!row)experimentError("NOT_FOUND",404);
    return JSON.parse(row.packet);
  }

  private thread(project:string) {
    return (this.store.db.prepare("SELECT conversation FROM coordination_threads WHERE project=?").get(project) as {conversation:string}|undefined)?.conversation;
  }
  private jobs(project:string):CoordinationJob[]{
    return (this.store.db.prepare("SELECT data FROM coordination_jobs WHERE project=? ORDER BY rowid").all(project) as {data:string}[])
      .map(row=>JSON.parse(row.data));
  }
  private save(job:CoordinationJob) {
    this.store.db.prepare("UPDATE coordination_jobs SET status=?,data=? WHERE id=?").run(job.status,JSON.stringify(job),job.id);
  }
  private url(project:string){ return `http://127.0.0.1:${this.port}/api/v1/projects/${encodeURIComponent(project)}/agent-tools`; }
  listen(port:number){
    this.port=port;
    this.timer=setInterval(()=>void this.pump().catch(error=>console.warn("协调派单暂缓",error.message)),3000);
    this.timer.unref();
  }
  close(){clearInterval(this.timer);this.port=0;}
  private async pump() {
    if(!this.port||this.working)return;
    this.working=true;
    try {
      for(const row of this.store.db.prepare("SELECT DISTINCT project FROM coordination_exports WHERE pending IS NOT NULL").all() as {project:string}[]){
        try{this.memory.flush(row.project);}catch(error){console.warn("协调记忆导出待重试",(error as Error).message);}
      }
      const projects=this.store.db.prepare("SELECT DISTINCT project FROM coordination_jobs WHERE status IN ('waiting','delivered') UNION SELECT project FROM coordination_summaries WHERE sent=0 UNION SELECT project FROM coordination_consultations WHERE state='open'").all() as {project:string}[];
      for(const {project} of projects){
        if(!this.port)return;
        const view=this.view(project);
        this.schedule(project,view);
        for(const snapshot of view.jobs.filter(j=>j.status==="waiting")){
          const job=this.jobs(project).find(j=>j.id===snapshot.id)!;
          if(job.status!=="waiting")continue;
          if(job.candidates){
            if(!view.conversations.some(member=>job.candidates!.includes(member.id))){
              job.status="failed";job.reason="候选对话已删除";this.save(job);
            }
            continue;
          }
          const member=view.conversations.find(m=>m.id===job.conversation);
          const existing=this.agent.coordinationTask(project,job.task_id);
          if(existing){job.status="delivered";job.reason="";this.save(job);continue;}
          if(!member?.joined || member.repository_id!==job.repository_id){
            job.status="withdrawn";job.reason="对话已移出或绑定仓库已变化";this.save(job);continue;
          }
          const last=this.agent.coordinationTurns(project).reverse().find(t=>t.conversation_id===member.id)!;
          let reason="";
          if(["running","queued","cancelling"].includes(last.status))reason="等待对话空闲";
          else if(last.status==="interrupted")reason="等待核对中断的对话";
          else if(last.decision?.status==="pending"||last.decision?.status==="selected")reason="等待处理原对话的确认";
          if(!reason&&job.after&&job.gate==="success")reason=this.dependency(job,view.jobs);
          if(reason){if(job.reason!==reason){job.reason=reason;this.save(job);}continue;}
          try{
            await this.agent.start(project,{conversation_id:member.id,repository_id:job.repository_id,confirm:true,
              instructions:job.instructions,sandbox:job.consultation?"read-only":this.agent.coordinationTurns(project).reverse().find(t=>t.conversation_id===member.id&&!t.coordination?.consultation)?.sandbox??last.sandbox,model:last.model,reasoning_effort:last.reasoning_effort},
              this.url(project),false,undefined,{turn:{kind:"assignment",id:job.id,consultation:job.consultation},taskId:job.task_id});
            job.status="delivered";job.reason="";this.save(job);
          }catch(error){
            if((error as Error).message==="CHAT_NOT_READY")continue;
            job.status="failed";job.reason=(error as Error).message;this.save(job);
          }
        }
        const updated=this.view(project);
        try{this.captureFeedback(project,updated);}catch(error){console.warn("成员回报归档待重试",(error as Error).message);}
        if(!await this.resumeConsultation(project,updated))await this.sendSummary(project,updated);
      }
    }finally{this.working=false;}
  }
  private captureFeedback(project:string,view:CoordinationView){
    for(const job of view.jobs){
      if(job.consultation?!job.feedback:!job.finished&&!["ready","blocked"].includes(job.report_status??""))continue;
      const member=view.conversations.find(m=>m.id===job.conversation);
      this.memory.remember(project,job,(member?.repository_id===job.repository_id?member?.title:undefined)??job.title);
    }
  }
  private consultations(project:string){
    return this.store.db.prepare("SELECT origin,state FROM coordination_consultations WHERE project=?").all(project) as
      {origin:string;state:"open"|"stopped"|"settled"}[];
  }

  private async resumeConsultation(project:string,view:CoordinationView){
    if(!this.port||view.messages.some(m=>["running","queued","cancelling","interrupted"].includes(m.status)))return false;
    const turns=this.agent.coordinationTurns(project);
    for(const request of this.consultations(project).filter(r=>r.state==="open")){
      const jobs=view.jobs.filter(j=>j.origin===request.origin&&j.consultation);
      const receipts=new Set(turns.filter(t=>t.coordination?.origin===request.origin).flatMap(t=>t.coordination?.receipts??[]));
      // Persist consumed replies on the receiving turn itself. A restart cannot deliver them twice.
      const incoming=jobs.flatMap(job=>{
        if(!job.feedback)return [];
        const content=JSON.stringify([job.feedback,job.worker_response,job.reason]);
        const receipt=job.id+":"+createHash("sha256").update(content).digest("hex");
        return receipts.has(receipt)?[]:[receipt];
      });
      if(!incoming.length){
        if(jobs.length&&jobs.every(j=>j.finished))
          this.store.db.prepare("UPDATE coordination_consultations SET state='settled' WHERE project=? AND origin=? AND state='open'").run(project,request.origin);
        continue;
      }
      await this.message(project,randomUUID(),"处理原请求的新反馈，读取 coordination-status 后按来源答复。",true,
        {origin:request.origin,receipts:incoming});
      return true;
    }
    return false;
  }

  private async sendSummary(project:string,view:CoordinationView) {
    if(!this.port||view.messages.some(m=>["running","queued","cancelling","interrupted"].includes(m.status)))return;
    const pending=this.store.db.prepare("SELECT origin,id FROM coordination_summaries WHERE project=? AND sent=0 ORDER BY rowid").all(project) as {origin:string;id:string}[];
    for(const batch of pending){
      const jobs=view.jobs.filter(j=>j.origin===batch.origin&&!j.consultation);
      if(!jobs.length||jobs.some(job=>!job.finished))continue;
      const prompt="汇总此指令下的论文任务 "+jobs.map(j=>j.id).sort().join("、")+"。使用实际回报、指标、产物及运行编号，解释失败或跳过的项；没有证据时写明缺口。";
      await this.message(project,batch.id,prompt,true);
      this.store.db.prepare("UPDATE coordination_summaries SET sent=1 WHERE project=? AND origin=?").run(project,batch.origin);
      break;
    }
  }
  private executionHash(project:string,plan:ExperimentPlanVersion,preparation:boolean){
    const profile=this.experiments.data.profile(project,plan.profile.profile_id);
    const workspace=this.experiments.workspaces.get(project,profile.profile_id);
    if(plan.profile.host!==profile.host||plan.profile.port!==profile.port||plan.profile.username!==profile.username)
      experimentError("COORDINATION_PLAN_CHANGED",409);
    const manifest={plan_id:plan.plan_id,title:plan.content.title,version:plan.version,repository:plan.repository.path,
      host:profile.username+"@"+profile.host+":"+profile.port,fingerprint:profile.fingerprint,
      remote_root:workspace?.root??plan.profile.remote_root,preparation,content:plan.content,
      source_config_sha256:plan.source_config_sha256,
      datasets:plan.datasets.map(d=>({name:d.name,path:d.path,version:d.version}))};
    return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  }
  private dependency(job:CoordinationJob,jobs:CoordinationJob[]){
    if(!job.after)return "";
    const prior=jobs.find(j=>j.id===job.after);
    if(!prior?.finished)return "等待前置任务结束 · "+(prior?.title??"原任务");
    if(job.gate==="success"&&!prior.successful)return "前置任务缺少有效结果 · "+prior.title;
    return "";
  }
  private schedule(project:string,view:CoordinationView){
    const turns=this.agent.coordinationTurns(project).reverse();
    for(const snapshot of view.jobs.filter(j=>j.status==="delivered")){
      const job=this.jobs(project).find(j=>j.id===snapshot.id)!;
      const member=view.conversations.find(m=>m.id===job.conversation);
      if(!member?.joined||member.repository_id!==job.repository_id){
        for(const p of job.plans??[])if(["pending","queued","authorized"].includes(p.status)){
          p.status="blocked";p.info="对话或仓库已变更，请重新派单";
        }
        job.status="withdrawn";job.reason="对话或仓库已变更";this.save(job);continue;
      }
      if(snapshot.finished){
        for(const p of job.plans??[]){
          const run=snapshot.plans?.find(ref=>ref.id===p.id)?.run_id;
          if(run){p.run_id=run;p.status="submitted";}
        }
        job.status="settled";this.save(job);continue;
      }
      const worker=turns.find(t=>t.coordination?.kind==="assignment"&&t.coordination.id===job.id);
      for(const p of job.plans??[]){
        if(p.status!=="queued"&&p.status!=="authorized")continue;
        const priorRun=this.experiments.data.runs(project).find(r=>r.idempotency_key===p.id);
        if(priorRun){p.status="submitted";p.run_id=priorRun.run_id;this.save(job);continue;}
        if(p.status==="queued"){
          if(["pending","selected"].includes(worker?.decision?.status??""))continue;
          if(worker?.status==="failed"||worker?.status==="cancelled"||worker?.status==="completed"&&job.report_status==="blocked"){
            p.status="blocked";p.info=job.report_status==="blocked"?"成员回报缺少运行条件":"成员未完成实验方案准备";this.save(job);continue;
          }
          if(worker?.status!=="completed")continue;
        }
        let wait=this.dependency(job,view.jobs);
        try{
          const plan=this.experiments.data.plan(project,p.plan_id,p.version);
          if(this.executionHash(project,plan,p.preparation)!==(p.execution_hash??p.approval_hash))experimentError("COORDINATION_PLAN_CHANGED",409);
          if(plan.status==="superseded"||p.status==="authorized"&&plan.status!=="confirmed"||
            this.experiments.data.plans(project).some(other=>other.plan_id===p.plan_id&&other.version>p.version))
            experimentError("VERSION_CONFLICT",409);
          if(!p.preparation&&plan.content.preparation_script&&!this.experiments.data.runs(project).some(r=>r.preparation&&r.plan.plan_id===p.plan_id&&r.plan.version===p.version&&r.status==="completed"&&r.exit_code===0)){
            const prep=job.plans?.find(ref=>ref.preparation&&ref.plan_id===p.plan_id&&ref.version===p.version);
            const prepStatus=prep&&snapshot.plans?.find(ref=>ref.id===prep.id)?.run_status;
            if(prep?.status==="blocked"||prep?.status==="skipped"||prepStatus==="failed"||prepStatus==="cancelled")
              experimentError("PREPARATION_REQUIRED",409);
            wait||="等待环境准备成功";
          }
          const occupied=this.experiments.data.runs().find(r=>this.experiments.data.active(r)&&r.plan.profile.host.toLowerCase()===plan.profile.host.toLowerCase()&&r.plan.profile.port===plan.profile.port);
          if(!wait&&occupied)wait=occupied.project_id===project?"等待 "+occupied.plan.content.title+" 释放 AutoDL":"等待其他项目释放 AutoDL";
          if(!wait&&!this.experiments.ssh.hasCredential(plan.profile))wait="等待主机连接凭据";
          if(!wait){
            const run=p.status==="queued"
              ?this.experiments.submitCoordinated(plan,p.id,p.preparation)
              :this.experiments.submit(project,{plan_id:p.plan_id,version:p.version,idempotency_key:p.id,preparation:p.preparation});
            p.status="submitted";p.run_id=run.run_id;delete p.info;this.save(job);continue;
          }
        }catch(cause){
          const error=(cause as Error).message;
          if(error==="CODE_AGENT_BUSY")wait="等待仓库写入结束";
          else{p.status="blocked";p.info=error;this.save(job);continue;}
        }
        if(p.info!==wait){p.info=wait;this.save(job);}
      }
    }
  }
  private attachPlan(project:string,job:CoordinationJob,plan:ExperimentPlanVersion,key:string,preparation=false){
    if(!job.repository_id||plan.repository.repository_id!==job.repository_id||plan.reproduction)experimentError("COORDINATION_TARGET_CHANGED",409);
    const existing=job.plans?.find(p=>p.plan_id===plan.plan_id&&p.version===plan.version&&p.preparation===preparation);
    if(existing)return existing;
    const ref:CoordinationPlan={id:randomUUID(),key,plan_id:plan.plan_id,version:plan.version,title:plan.content.title,
      commit:plan.content.commit_sha,host:plan.profile.name,repository:plan.repository.name??plan.repository.path,
      command:plan.content.command,gpu:plan.content.gpu,datasets:plan.datasets.map(d=>d.name),preparation,status:job.expects_runs?"queued":"draft",
      execution_hash:job.expects_runs?this.executionHash(project,plan,preparation):undefined};
    job.plans=[...(job.plans??[]),ref];this.save(job);
    if(job.expects_runs&&plan.content.preparation_script&&!preparation)this.attachPlan(project,job,plan,key+"-prepare",true);
    return ref;
  }
  private workerTool(project:string,task:CodeTask,body:unknown){
    const job=this.jobs(project).find(j=>j.id===task.coordination?.id);
    if(!job||!["waiting","delivered"].includes(job.status)||job.conversation!==task.conversation_id||job.repository_id!==(task.repository_id??null)||
      !this.store.db.prepare("SELECT 1 FROM coordination_members WHERE project=? AND conversation=?").get(project,job.conversation))
      experimentError("COORDINATION_TARGET_CHANGED",409);
    const op=z.object({operation:z.string()}).parse(body).operation;
    if(op==="coordination-context")return {
      assignment:job.id,instructions:job.instructions,expects_runs:job.expects_runs,report:job.report,after:job.after?this.details(project,this.jobs(project).filter(j=>j.id===job.after))[0]:undefined,
      repository:job.repository_id,
      plans:this.experiments.data.plans(project).filter(p=>p.repository.repository_id===job.repository_id).map(p=>({id:p.plan_id,version:p.version,title:p.content.title,status:p.status})),
      hosts:this.experiments.data.profiles(project).map(p=>({id:p.profile_id,name:p.name})),
      datasets:this.experiments.data.datasets(project).map(d=>({id:d.dataset_id,name:d.name,host:d.profile_id,path:d.path}))};
    if(op==="coordination-report"){
      const input=z.object({status:z.enum(["progress","blocked","ready"]),report:z.string().trim().min(1).max(8000)}).parse(body);
      job.report_status=input.status;job.report=input.report;this.save(job);return {saved:true};
    }
    if(job.consultation)experimentError("AGENT_TOOL_READONLY",403);
    if(op==="coordination-plan"){
      if(job.expects_runs&&task.sandbox==="read-only")experimentError("AGENT_TOOL_READONLY",403);
      const input=z.object({plan_id:z.string(),version:z.number().int().positive()}).parse(body);
      const plan=this.experiments.data.plan(project,input.plan_id,input.version);
      return this.store.db.transaction(()=>this.attachPlan(project,job,plan,plan.plan_id+":"+plan.version)).immediate();
    }
    if(op==="coordination-draft"){
      if(task.sandbox==="read-only"||!job.repository_id)experimentError("AGENT_TOOL_READONLY",403);
      const input=z.object({key:z.string().trim().min(1).max(80),content:z.record(z.unknown())}).parse(body);
      const payloadHash=createHash("sha256").update(JSON.stringify(input.content)).digest("hex");
      const existing=job.plans?.find(p=>p.key===input.key);
      if(existing){
        if(existing.draft_hash&&existing.draft_hash!==payloadHash)experimentError("IDEMPOTENCY_CONFLICT",409);
        return existing;
      }
      return this.store.db.transaction(()=>{
        const plan=this.experiments.createPlan(project,{...input.content,code_source:"git",repository_id:job.repository_id});
        const ref=this.attachPlan(project,job,plan,input.key);
        ref.draft_hash=payloadHash;this.save(job);return ref;
      }).immediate();
    }
    experimentError("COORDINATOR_ONLY",403);
  }
  private details(project:string,jobs:CoordinationJob[]){
    const runs=this.experiments.data.runs(project);
    const turns=this.agent.coordinationTurns(project).reverse();
    return jobs.map(job=>{
      const turn=turns.find(t=>t.coordination?.kind==="assignment"&&t.coordination.id===job.id);
      if(job.consultation){
        const ended=!!turn?.finished_at;
        const failed=turn&&["failed","cancelled","interrupted"].includes(turn.status);
        const finalText=turn?.status==="completed"?turn.response.trim():"";
        let feedback:CoordinationJob["feedback"];
        let answer=job.report??"";
        if(job.status==="withdrawn")feedback="withdrawn";
        else if(job.status==="failed"||failed){feedback="failed";answer=turn?.error??job.reason;}
        else if(job.report_status==="blocked")feedback="blocked";
        else if(job.report_status==="ready")feedback="answered";
        else if(finalText){feedback="answered";answer=finalText;}
        else if(ended){feedback="blocked";answer="成员结束本轮时没有给出答复";}
        else if(job.reason==="等待核对中断的对话"||job.reason==="等待处理原对话的确认")feedback="blocked";
        return {...job,feedback,worker_status:turn?.status,worker_response:answer,reply_task_id:turn?.task_id,
          finished:ended||job.status==="failed"||job.status==="withdrawn",successful:feedback==="answered"};
      }
      const plans=job.plans?.map(p=>{
        const run=runs.find(r=>r.run_id===p.run_id||r.idempotency_key===p.id);
        if(!run)return p;
        const expected=run.plan.content.artifact_paths;
        const result=run.result_id?this.store.db.prepare(
          "SELECT json_extract(data,'$.content.metrics') AS metrics FROM knowledge_versions WHERE project_id=? AND object_id=? AND kind='experiment-result' ORDER BY version DESC LIMIT 1"
        ).get(project,run.result_id) as {metrics:string|null}|undefined:undefined;
        const hasResult=run.exit_code===0&&(p.preparation||!!result||(!run.plan.content.expected_metrics.length&&expected.length>0&&
          expected.every(path=>run.artifacts.some(a=>a.downloaded&&a.artifact_id&&a.path===path))));
        return {...p,run_id:run.run_id,run_status:run.status,result_id:run.result_id,metrics:run.metrics_status,metric_values:result?.metrics?JSON.parse(result.metrics):undefined,has_result:hasResult,exit_code:run.exit_code,
          artifacts:run.artifacts.map(a=>({path:a.path,id:a.downloaded?a.artifact_id:undefined}))};
      });
      const activePlans=plans?.filter(p=>p.status!=="draft"&&p.status!=="skipped"&&(job.status!=="withdrawn"||!!p.run_id))??[];
      const turnDone=!!turn?.finished_at&&!["pending","selected"].includes(turn.decision?.status??"")&&turn.status!=="interrupted";
      const runsDone=activePlans.every(p=>["completed","cancelled","failed"].includes(p.run_status??"")||p.status==="blocked"&&!!p.execution_hash&&!p.run_id);
      const finished=runsDone&&(job.status==="failed"||job.status==="withdrawn"||!!(turnDone&&
        (turn?.status!=="completed"||job.report_status!=="blocked"&&(!job.expects_runs||plans?.length)||
          activePlans.some(p=>p.status==="blocked"&&!!p.execution_hash))));
      const successful=finished&&turn?.status==="completed"&&job.status!=="withdrawn"&&job.report_status!=="blocked"&&
        (!job.expects_runs||activePlans.some(p=>!p.preparation))&&activePlans.every(p=>p.run_status==="completed"&&p.has_result);
      return {...job,plans,finished,successful,worker_status:turn?.status,worker_response:turn?.response.slice(-5000)};
    });
  }
  async tool(project:string,task:CodeTask,body:unknown){
    if(task.coordination?.kind==="assignment")return this.workerTool(project,task,body);
    if(task.coordination?.kind!=="coordinator"&&task.coordination?.kind!=="summary")experimentError("COORDINATOR_ONLY",403);
    const operation=z.object({operation:z.string()}).parse(body).operation;
    if(operation==="coordination-handoff"){
      if(!task.handoff_id)experimentError("NOT_FOUND",404);
      return this.readHandoff(project,task.handoff_id);
    }
    if(operation==="coordination-history"){
      const {id,offset}=z.object({id:z.string(),offset:z.number().int().nonnegative().default(0)}).parse(body);
      const past=this.agent.coordinationTask(project,z.string().regex(/^code_[a-f0-9-]{36}$/).parse(id));
      if(!past||past.conversation_id!==this.thread(project)||!(past.coordination?.kind==="coordinator"||past.coordination?.kind==="summary"))experimentError("NOT_FOUND",404);
      const transcript=JSON.stringify({request:past.instructions,response:past.response,status:past.status});
      return {id,text:transcript.slice(offset,offset+6000),next_offset:offset+6000<transcript.length?offset+6000:null};
    }
    if(operation==="coordination-evidence"){
      const {id,offset}=z.object({id:z.string().uuid(),offset:z.number().int().nonnegative().default(0)}).parse(body);
      return this.memory.evidence(project,id,offset);
    }
    if(operation==="coordination-memory")return this.memory.read(project,body);
    const view=this.view(project);
    const root=task.coordination.origin??task.task_id;
    const scoped=task.coordination.origin?view.jobs.filter(job=>job.origin===root):view.jobs;
    if(operation==="coordination-brief"){
      const {job_id}=z.object({job_id:z.string().uuid()}).parse(body);
      const job=scoped.find(j=>j.id===job_id);
      if(!job)experimentError("NOT_FOUND",404);
      return this.memory.summarize(project,job,body);
    }
    if(operation==="coordination-note"){
      const {job_id}=z.object({job_id:z.string().uuid().optional()}).parse(body);
      const job=job_id?scoped.find(j=>j.id===job_id):undefined;
      if(job_id&&!job||!job&&task.coordination.kind==="summary")experimentError("COORDINATION_SOURCE_REQUIRED",422);
      return this.memory.record(project,root,body,job);
    }
    if(operation==="coordination-status"||operation==="coordination-jobs"){
      const {offset,origin,conversation}=z.object({offset:z.number().int().nonnegative().default(0),origin:z.string().optional(),conversation:z.string().optional()}).parse(body);
      const jobs=scoped.filter(j=>(operation==="coordination-jobs"||!j.finished)&&(!origin||j.origin===origin)&&(!conversation||j.conversation===conversation));
      const members=view.conversations.filter(m=>m.joined);
      return {original_request:task.coordination.origin?view.messages.find(m=>m.id===root)?.prompt:undefined,
        new_feedback:task.coordination.receipts?.slice(offset,offset+25).map(r=>r.split(":")[0]),feedback_count:task.coordination.receipts?.length??0,hosts:view.hosts.slice(offset,offset+25),host_count:view.hosts.length,queue:view.queue.slice(offset,offset+25),queue_count:view.queue.length,
        conversations:members.slice(offset,offset+25).map(({id,title,repository,status})=>({id,title,repository,status})),member_count:members.length,
        jobs:jobs.slice(offset,offset+25).map(({id,origin,conversation,title,status,feedback,finished,reason})=>({id,origin,conversation,title,status,feedback,finished,reason})),
        job_count:jobs.length,next_offset:offset+25<Math.max(jobs.length,members.length,view.hosts.length,view.queue.length,task.coordination.receipts?.length??0)?offset+25:null};
    }
    if(operation==="coordination-job"){
      const {id,offset}=z.object({id:z.string().uuid(),offset:z.number().int().nonnegative().default(0)}).parse(body);
      const job=scoped.find(j=>j.id===id);
      if(!job)experimentError("NOT_FOUND",404);
      const direction=this.memory.direction(project,job.conversation,job.repository_id);
      const detail=JSON.stringify({...job,memory_id:direction?.id});
      return {id,format:"json",text:detail.slice(offset,offset+6000),next_offset:offset+6000<detail.length?offset+6000:null};
    }

    if(operation==="coordination-consult"&&(task.coordination.kind==="coordinator"||task.coordination.origin)){
      return this.consult(project,root,body,view,task);
    }
    if(this.consultations(project).some(r=>r.origin===root&&r.state==="stopped"))experimentError("COORDINATION_TARGET_CHANGED",409);
    if(operation!=="coordination-dispatch"||task.coordination.kind!=="coordinator")experimentError("COORDINATOR_ONLY",403);
    const input=z.object({operation:z.literal("coordination-dispatch"),key:z.string().min(1).max(100),
      conversation:z.string().uuid(),instructions:z.string().trim().min(1).max(16000),expects_runs:z.boolean(),
      after:z.string().uuid().optional(),gate:z.enum(["finish","success"]).default("finish")}).strict().parse(body);
    const existing=view.jobs.find(j=>j.origin===task.task_id&&j.key===input.key);
    if(existing){
      if(existing.conversation!==input.conversation||existing.instructions!==input.instructions||existing.after!==input.after||existing.expects_runs!==input.expects_runs||existing.gate!==input.gate)
        experimentError("IDEMPOTENCY_CONFLICT",409);
      return {id:existing.id};
    }
    const member=view.conversations.find(s=>s.id===input.conversation&&s.joined);
    if(!member||input.after&&!view.jobs.some(j=>j.id===input.after))experimentError("COORDINATION_TARGET_CHANGED",409);
    const id=randomUUID(),job:CoordinationJob={id,conversation:member.id,title:member.title,
      repository_id:member.repository_id,task_id:"code_"+id,instructions:input.instructions,expects_runs:input.expects_runs,
      after:input.after,gate:input.gate,status:"waiting",reason:"等待投递",created_at:new Date().toISOString(),origin:task.task_id,key:input.key};
    this.store.db.transaction(()=>{
      this.store.db.prepare("INSERT INTO coordination_jobs VALUES (?,?,?,?,?,?)").run(project,id,task.task_id,input.key,job.status,JSON.stringify(job));
      this.store.db.prepare("INSERT OR IGNORE INTO coordination_summaries(project,origin,id) VALUES (?,?,?)").run(project,task.task_id,randomUUID());
    }).immediate();
    return {id};
  }
  private consult(project:string,origin:string,body:unknown,view:CoordinationView,task:CodeTask){
    const {questions}=consultInput.parse(body);
    return this.store.db.transaction(()=>{
      const state=this.consultations(project).find(r=>r.origin===origin)?.state;
      if(state==="stopped")experimentError("COORDINATION_TARGET_CHANGED",409);
      this.store.db.prepare("INSERT OR IGNORE INTO coordination_consultations VALUES (?,?,'open')").run(project,origin);
      return questions.map(q=>{
        const key="consult:"+task.task_id+":"+q.key;
        const prior=this.jobs(project).find(j=>j.origin===origin&&j.key===key);
        if(prior){
          if(!prior.consultation||prior.target!==q.target||prior.instructions!==q.question||prior.parent_question!==q.parent_question)
            experimentError("IDEMPOTENCY_CONFLICT",409);
          return {id:prior.id,status:prior.reason||prior.status};
        }
        if(task.coordination?.origin||q.parent_question){
          const parent=view.jobs.find(j=>j.id===q.parent_question&&j.origin===origin&&j.consultation);
          if(!task.coordination?.origin||!parent||parent.feedback!=="answered"||parent.conversation!==q.target||
            !view.conversations.some(m=>m.joined&&m.id===parent.conversation&&m.repository_id===parent.repository_id))
            experimentError("COORDINATION_TARGET_CHANGED",409);
          const earlier=this.jobs(project).filter(j=>j.origin===origin&&j.conversation===q.target);
          const duplicate=earlier.find(j=>normalizeTarget(j.instructions)===normalizeTarget(q.question));
          if(duplicate)return {id:duplicate.id,status:"已有相同问题"};
          if(earlier.some(j=>j.parent_question===parent.id))experimentError("COORDINATION_TARGET_CHANGED",409);
        }
        const candidates=consultationTargets(view.conversations,q.target);
        const member=candidates.length===1&&candidates[0].joined?candidates[0]:undefined;
        const id=randomUUID();
        const job:CoordinationJob={id,key,origin,consultation:true,target:q.target,parent_question:q.parent_question,
          conversation:member?.id??"",title:member?.title??q.target,repository_id:member?.repository_id??null,
          instructions:q.question,task_id:"code_"+id,gate:"finish",expects_runs:false,created_at:new Date().toISOString(),
          status:candidates.length?"waiting":"failed",reason:member?"等待投递":candidates.length?"等待选择参与对话":"未找到对应对话",
          candidates:!member&&candidates.length?candidates.map(m=>m.id):undefined};
        this.store.db.prepare("INSERT INTO coordination_jobs VALUES (?,?,?,?,?,?)").run(project,id,origin,key,job.status,JSON.stringify(job));
        return {id,status:job.reason};
      });
    }).immediate();
  }

  private async message(project:string,id:string,instructions:string,summary=false,feedback?:{origin:string;receipts:string[]}){
    this.store.db.prepare("INSERT OR IGNORE INTO coordination_threads VALUES (?,?)").run(project,randomUUID());
    const conversation=this.thread(project)!;
    const taskId="code_"+id;
    const prior=this.agent.coordinationTask(project,taskId);
    if(prior){
      if(prior.conversation_id!==conversation||prior.instructions!==instructions||prior.coordination?.origin!==feedback?.origin)experimentError("IDEMPOTENCY_CONFLICT",409);
      return {id:taskId};
    }
    await this.agent.start(project,{conversation_id:conversation,instructions,sandbox:"read-only",confirm:true},this.url(project),false,undefined,
      {turn:{kind:summary?"summary":"coordinator",id,...feedback},taskId});
    return {id:taskId};
  }

  view(project:string):CoordinationView {
    const members=this.store.db.prepare("SELECT conversation FROM coordination_members WHERE project=?").all(project) as {conversation:string}[];
    const joined=new Set(members.map(row=>row.conversation));
    const turns=this.agent.coordinationTurns(project);
    const bindings=new Map<string,ReturnType<CodeAgent["coordinationBinding"]>>();
    const repositories=this.experiments.data.repositories(project);
    const sessions=new Map<string,CoordinationMember>();
    for(const turn of turns) {
      const id=turn.conversation_id;
      if(!id||turn.coordination&&turn.coordination.kind!=="assignment")continue;
      if(!bindings.has(id))bindings.set(id,this.agent.coordinationBinding(project,id));
      const binding=bindings.get(id)!;
      if(binding.deleted)continue;
      const repository_id=binding.repository_id;
      const repo=repositories.find(r=>r.repository_id===repository_id);
      const previous=sessions.get(id);
      sessions.set(id,{id,title:previous?.title??binding.title??turn.instructions.slice(0,70),
        repository_id,repository:repo?.name??repo?.path??(repository_id?"仓库不可用":"未绑定仓库"),
        status:turn.status,task_id:turn.task_id,decision:turn.decision,joined:joined.has(id)});
    }
    const core=this.thread(project);
    const requests=new Map(this.consultations(project).map(r=>[r.origin,r.state]));
    const messages=core?turns.filter(t=>t.conversation_id===core).map(t=>({
      id:t.task_id,origin:t.coordination?.origin,consultation_status:requests.get(t.task_id),prompt:t.instructions,response:t.response,status:t.status,created_at:t.created_at,error:t.error,summary:t.coordination?.kind==="summary"
    })):[];
    const queue=this.experiments.data.runs(project).filter(r=>this.experiments.data.active(r)).sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(r=>({
      id:r.run_id,title:r.plan.content.title,host:r.plan.profile.name,status:r.status,created_at:r.created_at}));
    const connected=new Set(this.experiments.terminals.list(project).map(t=>t.profile_id));
    const hosts=this.experiments.data.profiles(project).map(p=>({id:p.profile_id,name:p.name,connected:connected.has(p.profile_id)}));
    return {conversations:[...sessions.values()],jobs:this.details(project,this.jobs(project)).sort((a,b)=>(a.priority??Date.parse(a.created_at))-(b.priority??Date.parse(b.created_at))),messages,hosts,queue};
  }

  memoryDetail(project:string,id:string,revision?:number){
    const page=this.memory.page(project,id,revision);
    const methods=page.repository?listExperiments(join(this.store.root,"projects",project)).filter(e=>e.repository_id===page.repository):[];
    return {page,methods,evidence:this.memory.evidence(project,id)};
  }

  messageProcess(project:string,id:string) {
    const task=this.agent.coordinationTask(project,id);
    if(!task||task.conversation_id!==this.thread(project)||!task.coordination||task.coordination.kind==="assignment")
      experimentError("NOT_FOUND",404);
    return {logs:task.logs};
  }

  async action(project:string,body:unknown) {
    const action=z.object({action:z.string()}).parse(body).action;
    if(action==="memory-import"){
      this.captureFeedback(project,this.view(project));
      return {conflicts:this.memory.flush(project)};
    }
    if(action==="memory-save"){
      const edit=memoryEdit.parse(body);
      const member=edit.conversation?this.view(project).conversations.find(m=>m.id===edit.conversation&&m.joined):undefined;
      const {kind,confirm_decision}=z.object({kind:z.enum(["direction","decision","lesson"]).default("direction"),confirm_decision:z.boolean().default(false)}).parse(body);
      const type=edit.expected?this.memory.page(project,edit.id).kind:kind;
      if(confirm_decision&&type!=="decision")experimentError("INVALID_REQUEST",400);
      if(!edit.expected&&type==="direction"&&!member)experimentError("COORDINATION_TARGET_CHANGED",409);
      const page=this.memory.save(project,edit,type,confirm_decision?"用户在项目记忆确认此版本":"用户编辑",member);
      return {page,conflicts:this.memory.flush(project)};
    }
    if(action==="message"){
      const input=z.object({id:z.string().uuid(),instructions:z.string().trim().min(1).max(30000)}).parse(body);
      return this.message(project,input.id,input.instructions);
    }
    if(action==="retry-feedback"){
      const {id,request_id}=z.object({id:z.string(),request_id:z.string().uuid()}).parse(body);
      const failed=this.agent.coordinationTask(project,id);
      const origin=failed?.coordination?.origin;
      if(!failed||!origin||failed.conversation_id!==this.thread(project)||!["failed","cancelled"].includes(failed.status)||
        this.consultations(project).find(r=>r.origin===origin)?.state==="stopped")experimentError("COORDINATION_TARGET_CHANGED",409);
      const feedback={origin,receipts:failed.coordination?.receipts??[]};
      const prior=this.agent.coordinationTask(project,"code_"+request_id);
      if(!prior){
        const latest=this.agent.coordinationTurns(project).reverse().find(t=>t.coordination?.origin===origin);
        if(latest?.task_id!==id)experimentError("COORDINATION_TARGET_CHANGED",409);
      }
      this.store.db.prepare("UPDATE coordination_consultations SET state='open' WHERE project=? AND origin=?").run(project,origin);
      return this.message(project,request_id,failed.instructions,true,feedback);
    }
    if(action==="stop-consultation"||action==="acknowledge"||action==="stop"){
      const {id,confirm}=z.object({id:z.string(),confirm:z.literal(true)}).parse(body);
      const task=this.agent.coordinationTask(project,id);
      if(!task||task.conversation_id!==this.thread(project)||!task.coordination)experimentError("COORDINATION_TARGET_CHANGED",409);
      if(action!=="acknowledge"){
        const origin=task.coordination.origin??id;
        if(task.coordination.kind==="coordinator"||task.coordination.origin){
          this.store.db.transaction(()=>{
            this.store.db.prepare("INSERT INTO coordination_consultations VALUES (?,?,'stopped') ON CONFLICT(project,origin) DO UPDATE SET state='stopped'").run(project,origin);
            for(const job of this.jobs(project).filter(j=>j.consultation&&j.origin===origin&&j.status==="waiting")){
              job.status="withdrawn";job.reason="用户已停止咨询";this.save(job);
            }
          }).immediate();
        }
        for(const t of this.agent.coordinationTurns(project).filter(t=>(t.task_id===id||t.coordination?.origin===origin)&&["running","queued"].includes(t.status)))
          this.agent.cancel(project,t.task_id);
      }
      else this.agent.acknowledge(project,id);
      return {ok:confirm};
    }
    if(action==="followup"){
      const input=z.object({id:z.string().uuid(),request_id:z.string().uuid(),instructions:z.string().trim().min(1).max(16000)}).parse(body);
      const job=this.jobs(project).find(j=>j.id===input.id);
      const taskId="code_"+input.request_id;
      const existing=this.agent.coordinationTask(project,taskId);
      if(existing&&job&&existing.coordination?.id===job.id&&existing.instructions===input.instructions)return {id:taskId};
      const member=this.view(project).conversations.find(s=>s.id===job?.conversation);
      if(existing||!job||job.consultation||job.status!=="delivered"||!member?.joined||member.repository_id!==job.repository_id||
        ["pending","selected"].includes(member.decision?.status??""))experimentError("COORDINATION_TARGET_CHANGED",409);
      const last=this.agent.coordinationTask(project,member.task_id)!;
      await this.agent.start(project,{conversation_id:member.id,repository_id:job.repository_id,confirm:true,
        instructions:input.instructions,model:last.model,sandbox:last.sandbox,reasoning_effort:last.reasoning_effort},
        this.url(project),false,undefined,{turn:{kind:"assignment",id:job.id},taskId});
      return {id:taskId};
    }
    if(action==="select-consultation"){
      const {id,conversation}=z.object({id:z.string().uuid(),conversation:z.string().uuid()}).parse(body);
      return this.store.db.transaction(()=>{
        const job=this.jobs(project).find(j=>j.id===id);
        if(job?.consultation&&!job.candidates&&job.conversation===conversation)return {ok:true};
        const member=this.view(project).conversations.find(m=>m.id===conversation);
        if(!job?.candidates?.includes(conversation)||job.status!=="waiting"||!member)experimentError("COORDINATION_TARGET_CHANGED",409);
        this.store.db.prepare("INSERT OR IGNORE INTO coordination_members VALUES (?,?)").run(project,conversation);
        Object.assign(job,{conversation,title:member.title,repository_id:member.repository_id,reason:"等待投递"});
        delete job.candidates;this.save(job);return {ok:true};
      }).immediate();
    }
    if(action==="move"){
      const {id,before}=z.object({id:z.string().uuid(),before:z.string().uuid()}).parse(body);
      const queue=this.view(project).jobs.filter(j=>!j.finished&&!j.plans?.some(p=>p.run_id));
      const job=queue.find(j=>j.id===id);
      if(!job||!queue.some(j=>j.id===before)||id===before)experimentError("COORDINATION_TARGET_CHANGED",409);
      const ids=queue.filter(j=>j.id!==id).map(j=>j.id);ids.splice(ids.indexOf(before),0,id);
      if(queue.some(j=>j.after&&ids.includes(j.after)&&ids.indexOf(j.after)>ids.indexOf(j.id)))experimentError("COORDINATION_ORDER_CONFLICT",409);
      this.store.db.transaction(()=>{for(const raw of this.jobs(project)){const i=ids.indexOf(raw.id);if(i>=0){raw.priority=i;this.save(raw);}}}).immediate();
      return {ok:true};
    }
    if(action==="queue-run"||action==="skip"){
      const {id,ref,version}=z.object({id:z.string().uuid(),ref:z.string().uuid(),version:z.number().int()}).parse(body);
      const view=this.view(project);
      const job=this.jobs(project).find(j=>j.id===id);
      const p=job?.plans?.find(p=>p.id===ref);
      const member=view.conversations.find(s=>s.id===job?.conversation);
      if(!job||!p||!member?.joined||member.repository_id!==job.repository_id||job.status!=="delivered"||p.version!==version)
        experimentError("COORDINATION_TARGET_CHANGED",409);
      const snapshot=view.jobs.find(j=>j.id===id);
      if(snapshot?.plans?.some(plan=>plan.id===ref&&plan.run_id)){
        if(action==="queue-run")return {ok:true};
        experimentError("COORDINATION_TARGET_CHANGED",409);
      }
      if(action==="skip"){
        p.status="skipped";this.save(job);return {ok:true};
      }
      if(p.status==="queued"||p.status==="authorized")return {ok:true};
      if(p.status!=="pending")experimentError("COORDINATION_TARGET_CHANGED",409);
      const plan=this.experiments.data.plan(project,p.plan_id,version);
      const related=job.plans!.filter(item=>item.plan_id===p.plan_id&&item.version===version&&item.status==="pending"&&(item.id===p.id||!p.preparation&&item.preparation));
      for(const item of related){
        item.execution_hash=this.executionHash(project,plan,item.preparation);
        item.status="queued";
      }
      this.save(job);
      return {ok:true};
    }
    if(action==="withdraw"){
      const {id}=z.object({id:z.string().uuid()}).parse(body);
      const job=this.jobs(project).find(j=>j.id===id);
      if(!job)experimentError("COORDINATION_TARGET_CHANGED",409);
      if(job.status==="withdrawn")return {ok:true};
      const waiting=job.status==="waiting"&&!this.agent.coordinationTask(project,job.task_id);
      const snapshot=this.details(project,[job])[0];
      const idle=job.status==="delivered"&&["completed","failed","cancelled"].includes(snapshot.worker_status??"")&&
        !snapshot.plans?.some(p=>p.run_id)&&!snapshot.finished;
      if(!waiting&&!idle)experimentError("COORDINATION_TARGET_CHANGED",409);
      for(const p of job.plans??[])p.status="skipped";
      job.status="withdrawn";job.reason="已撤回";this.save(job);return {ok:true};
    }
    const input=z.object({action:z.literal("membership"),conversation:z.string().uuid(),joined:z.boolean()}).strict().parse(body);
    const session=this.view(project).conversations.find(s=>s.id===input.conversation);
    if(!session)experimentError("CHAT_SESSION_NOT_FOUND",404);
    if(input.joined)this.store.db.prepare("INSERT OR IGNORE INTO coordination_members VALUES (?,?)").run(project,session.id);
    else this.store.db.prepare("DELETE FROM coordination_members WHERE project=? AND conversation=?").run(project,session.id);
    return {ok:true};
  }
}
