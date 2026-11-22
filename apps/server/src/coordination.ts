import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { experimentError, type TrashStore } from "@trash/storage";
import type { CoordinationMember, CoordinationView, CoordinationJob, CoordinationPlan, ExperimentPlanVersion } from "@trash/protocol";
import type { CodeAgent, CodeTask } from "./code-agent.js";
import type { ExperimentService } from "./experiment/service.js";

export class ExperimentCoordination {
  private port=0;
  private timer?:ReturnType<typeof setInterval>;
  private working=false;
  constructor(private store:TrashStore, private agent:CodeAgent, private experiments:ExperimentService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordination_members (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      conversation TEXT NOT NULL, PRIMARY KEY(project,conversation));
      CREATE TABLE IF NOT EXISTS coordination_threads (
        project TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE, conversation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_jobs (
        project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE, id TEXT PRIMARY KEY,
        origin TEXT NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(project,origin,request_key));
      CREATE INDEX IF NOT EXISTS coordination_waiting ON coordination_jobs(status,project)`);
    agent.isCoordinationThread=(project,id)=>this.thread(project)===id;
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
      const projects=this.store.db.prepare("SELECT DISTINCT project FROM coordination_jobs WHERE status IN ('waiting','delivered')").all() as {project:string}[];
      for(const {project} of projects){
        if(!this.port)return;
        const view=this.view(project);
        this.schedule(project,view);
        for(const snapshot of view.jobs.filter(j=>j.status==="waiting")){
          const job=this.jobs(project).find(j=>j.id===snapshot.id)!;
          if(job.status!=="waiting")continue;
          const member=view.conversations.find(m=>m.id===job.conversation);
          const existing=this.agent.coordinationTask(project,job.task_id);
          if(existing){job.status="delivered";job.reason="";this.save(job);continue;}
          if(!member?.joined || member.repository_id!==job.repository_id){
            job.status="withdrawn";job.reason="对话已移出或绑定仓库已变化";this.save(job);continue;
          }
          const last=this.agent.coordinationTask(project,member.task_id)!;
          let reason="";
          if(["running","queued","cancelling"].includes(last.status))reason="等待对话空闲";
          else if(last.status==="interrupted")reason="等待核对中断的对话";
          else if(last.decision?.status==="pending"||last.decision?.status==="selected"&&!last.decision.continuation_task_id)reason="等待处理原对话的确认";
          if(!reason&&job.after&&job.gate==="success")reason=this.dependency(job,view.jobs);
          if(reason){if(job.reason!==reason){job.reason=reason;this.save(job);}continue;}
          try{
            await this.agent.start(project,{conversation_id:member.id,repository_id:job.repository_id,confirm:true,
              instructions:job.instructions,sandbox:last.sandbox,model:last.model,reasoning_effort:last.reasoning_effort},
              this.url(project),false,undefined,{turn:{kind:"assignment",id:job.id},taskId:job.task_id});
            job.status="delivered";job.reason="";this.save(job);
          }catch(error){
            if((error as Error).message==="CHAT_NOT_READY")continue;
            job.status="failed";job.reason=(error as Error).message;this.save(job);
          }
        }
      }
    }finally{this.working=false;}
  }
  private manifest(project:string,plan:ExperimentPlanVersion,preparation:boolean){
    const profile=this.experiments.data.profile(project,plan.profile.profile_id);
    const workspace=this.experiments.workspaces.get(project,profile.profile_id);
    const manifest={title:plan.content.title,version:plan.version,repository:plan.repository.path,
      host:profile.username+"@"+profile.host+":"+profile.port,fingerprint:profile.fingerprint,
      remote_root:workspace?.root??profile.remote_root,preparation,content:plan.content,
      datasets:plan.datasets.map(d=>({name:d.name,path:d.path,version:d.version}))};
    return {manifest,hash:createHash("sha256").update(JSON.stringify(manifest)).digest("hex")};
  }
  private dependency(job:CoordinationJob,jobs:CoordinationJob[]){
    if(!job.after)return "";
    const prior=jobs.find(j=>j.id===job.after);
    if(!prior?.finished)return "等待前置任务结束 · "+(prior?.title??"原任务");
    if(job.gate==="success"&&!prior.successful)return "前置任务缺少有效结果 · "+prior.title;
    return "";
  }
  private schedule(project:string,view:CoordinationView){
    for(const snapshot of view.jobs.filter(j=>j.status==="delivered")){
      const job=this.jobs(project).find(j=>j.id===snapshot.id)!;
      const member=view.conversations.find(m=>m.id===job.conversation);
      if(!member?.joined||member.repository_id!==job.repository_id){
        for(const p of job.plans??[])if(p.status==="authorized"||p.status==="pending"){
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
      for(const p of job.plans??[]){
        if(p.status!=="authorized")continue;
        const priorRun=this.experiments.data.runs(project).find(r=>r.idempotency_key===p.id);
        if(priorRun){p.status="submitted";p.run_id=priorRun.run_id;this.save(job);continue;}
        let wait=this.dependency(job,view.jobs);
        try{
          const plan=this.experiments.data.plan(project,p.plan_id,p.version);
          if(this.manifest(project,plan,p.preparation).hash!==p.approval_hash)experimentError("COORDINATION_APPROVAL_CHANGED",409);
          if(plan.status!=="confirmed"||this.experiments.data.plans(project).some(other=>other.plan_id===p.plan_id&&other.version>p.version))
            experimentError("VERSION_CONFLICT",409);
          if(!p.preparation&&plan.content.preparation_script&&!this.experiments.data.runs(project).some(r=>r.preparation&&r.plan.plan_id===p.plan_id&&r.plan.version===p.version&&r.status==="completed"&&r.exit_code===0))
            wait="等待环境准备成功";
          const occupied=this.experiments.data.runs().find(r=>this.experiments.data.active(r)&&r.plan.profile.host.toLowerCase()===plan.profile.host.toLowerCase()&&r.plan.profile.port===plan.profile.port);
          if(!wait&&occupied)wait=occupied.project_id===project?"等待 "+occupied.plan.content.title+" 释放 AutoDL":"等待其他项目释放 AutoDL";
          if(!wait&&!this.experiments.ssh.hasCredential(plan.profile))wait="等待主机连接凭据";
          if(!wait){
            const run=this.experiments.submit(project,{plan_id:p.plan_id,version:p.version,idempotency_key:p.id,preparation:p.preparation});
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
      command:plan.content.command,gpu:plan.content.gpu,datasets:plan.datasets.map(d=>d.name),preparation,status:"pending"};
    job.plans=[...(job.plans??[]),ref];this.save(job);
    if(plan.content.preparation_script&&!preparation)this.attachPlan(project,job,plan,key+"-prepare",true);
    return ref;
  }
  private workerTool(project:string,task:CodeTask,body:unknown){
    const job=this.jobs(project).find(j=>j.id===task.coordination?.id);
    if(!job||job.conversation!==task.conversation_id||job.repository_id!==(task.repository_id??null)||
      !this.store.db.prepare("SELECT 1 FROM coordination_members WHERE project=? AND conversation=?").get(project,job.conversation))
      experimentError("COORDINATION_TARGET_CHANGED",409);
    const op=z.object({operation:z.string()}).parse(body).operation;
    if(op==="coordination-context")return {
      assignment:job.id,after:job.after?this.details(project,this.jobs(project).filter(j=>j.id===job.after))[0]:undefined,
      repository:job.repository_id,
      plans:this.experiments.data.plans(project).filter(p=>p.repository.repository_id===job.repository_id).map(p=>({id:p.plan_id,version:p.version,title:p.content.title,status:p.status})),
      hosts:this.experiments.data.profiles(project).map(p=>({id:p.profile_id,name:p.name})),
      datasets:this.experiments.data.datasets(project).map(d=>({id:d.dataset_id,name:d.name,host:d.profile_id,path:d.path}))};
    if(op==="coordination-report"){
      const input=z.object({status:z.enum(["progress","blocked","ready"]),report:z.string().trim().min(1).max(8000)}).parse(body);
      job.report_status=input.status;job.report=input.report;this.save(job);return {saved:true};
    }
    if(op==="coordination-plan"){
      const input=z.object({plan_id:z.string(),version:z.number().int().positive()}).parse(body);
      const plan=this.experiments.data.plan(project,input.plan_id,input.version);
      return this.attachPlan(project,job,plan,plan.plan_id+":"+plan.version);
    }
    if(op==="coordination-draft"){
      if(task.sandbox==="read-only"||!job.repository_id)experimentError("AGENT_TOOL_READONLY",403);
      const input=z.object({key:z.string().trim().min(1).max(80),content:z.record(z.unknown())}).parse(body);
      const existing=job.plans?.find(p=>p.key===input.key);
      if(existing)return existing;
      return this.store.db.transaction(()=>{
        const plan=this.experiments.createPlan(project,{...input.content,code_source:"git",repository_id:job.repository_id});
        return this.attachPlan(project,job,plan,input.key);
      }).immediate();
    }
    experimentError("COORDINATOR_ONLY",403);
  }
  private details(project:string,jobs:CoordinationJob[]){
    const runs=this.experiments.data.runs(project);
    return jobs.map(job=>{
      let turn=this.agent.coordinationTask(project,job.task_id);
      const visited=new Set<string>();
      while(turn?.decision?.continuation_task_id&&!visited.has(turn.task_id)){
        visited.add(turn.task_id);
        const next=this.agent.coordinationTask(project,turn.decision.continuation_task_id);
        if(!next)break;turn=next;
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
      const activePlans=plans?.filter(p=>p.status!=="skipped"&&(job.status!=="withdrawn"||!!p.run_id))??[];
      const turnDone=!!turn?.finished_at&&turn.decision?.status!=="pending"&&turn.status!=="interrupted";
      const runsDone=activePlans.every(p=>["completed","cancelled","failed"].includes(p.run_status??""));
      const finished=runsDone&&(job.status==="failed"||job.status==="withdrawn"||!!(turnDone&&
        (turn?.status!=="completed"||job.report_status!=="blocked"&&(!job.expects_runs||plans?.length))));
      const successful=finished&&turn?.status==="completed"&&job.status!=="withdrawn"&&job.report_status!=="blocked"&&
        (!job.expects_runs||activePlans.some(p=>!p.preparation))&&activePlans.every(p=>p.run_status==="completed"&&p.has_result);
      return {...job,plans,finished,successful,worker_status:turn?.status,worker_response:turn?.response.slice(-5000)};
    });
  }
  async tool(project:string,task:CodeTask,body:unknown){
    if(task.coordination?.kind==="assignment")return this.workerTool(project,task,body);
    if(task.coordination?.kind!=="coordinator"&&task.coordination?.kind!=="summary")experimentError("COORDINATOR_ONLY",403);
    const operation=z.object({operation:z.string()}).parse(body).operation;
    const view=this.view(project);
    if(operation==="coordination-status")return {...view,messages:undefined,conversations:view.conversations.filter(m=>m.joined)};
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
    this.store.db.prepare("INSERT INTO coordination_jobs VALUES (?,?,?,?,?,?)").run(project,id,task.task_id,input.key,job.status,JSON.stringify(job));
    return {id};
  }
  private async message(project:string,id:string,instructions:string,summary=false){
    this.store.db.prepare("INSERT OR IGNORE INTO coordination_threads VALUES (?,?)").run(project,randomUUID());
    const conversation=this.thread(project)!;
    const taskId="code_"+id;
    const prior=this.agent.coordinationTask(project,taskId);
    if(prior){
      if(prior.conversation_id!==conversation||prior.instructions!==instructions)experimentError("IDEMPOTENCY_CONFLICT",409);
      return {id:taskId};
    }
    await this.agent.start(project,{conversation_id:conversation,instructions,sandbox:"read-only",confirm:true},this.url(project),false,undefined,
      {turn:{kind:summary?"summary":"coordinator",id},taskId});
    return {id:taskId};
  }

  view(project:string):CoordinationView {
    const members=this.store.db.prepare("SELECT conversation FROM coordination_members WHERE project=?").all(project) as {conversation:string}[];
    const joined=new Set(members.map(row=>row.conversation));
    const history=this.agent.chatHistory(project);
    const repositories=this.experiments.data.repositories(project);
    const sessions=new Map<string,CoordinationMember>();
    for(const turn of [...history.tasks].reverse()) {
      const id=turn.conversation_id!;
      const repository_id=history.repository_bindings[id]??null;
      const repo=repositories.find(r=>r.repository_id===repository_id);
      const previous=sessions.get(id);
      sessions.set(id,{id,title:previous?.title??history.titles[id]??turn.instructions.slice(0,70),
        repository_id,repository:repo?.name??repo?.path??(repository_id?"仓库不可用":"未绑定仓库"),
        status:turn.status,task_id:turn.task_id,decision:turn.decision,joined:joined.has(id)});
    }
    const core=this.thread(project);
    const messages=core?this.agent.list(project).filter(t=>t.conversation_id===core).reverse().map(t=>({
      id:t.task_id,prompt:t.instructions,response:t.response,status:t.status,error:t.error,summary:t.coordination?.kind==="summary"
    })):[];
    const queue=this.experiments.data.runs(project).filter(r=>this.experiments.data.active(r)).sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(r=>({
      id:r.run_id,title:r.plan.content.title,host:r.plan.profile.name,status:r.status,created_at:r.created_at}));
    const connected=new Set(this.experiments.terminals.list(project).map(t=>t.profile_id));
    const hosts=this.experiments.data.profiles(project).map(p=>({id:p.profile_id,name:p.name,connected:connected.has(p.profile_id)}));
    return {conversations:[...sessions.values()],jobs:this.details(project,this.jobs(project)).sort((a,b)=>(a.priority??Date.parse(a.created_at))-(b.priority??Date.parse(b.created_at))),messages,hosts,queue};
  }

  async action(project:string,body:unknown) {
    const action=z.object({action:z.string()}).parse(body).action;
    if(action==="message"){
      const input=z.object({id:z.string().uuid(),instructions:z.string().trim().min(1).max(30000)}).parse(body);
      return this.message(project,input.id,input.instructions);
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
    if(action==="review"){
      const input=z.object({id:z.string().uuid(),ref:z.string().uuid()}).parse(body);
      const ref=this.jobs(project).find(j=>j.id===input.id)?.plans?.find(p=>p.id===input.ref);
      if(!ref)experimentError("COORDINATION_TARGET_CHANGED",409);
      const plan=this.experiments.data.plan(project,ref.plan_id,ref.version);
      const script=ref.preparation?await this.experiments.repository.preparation(project,plan.content.commit_sha,plan.content.preparation_script!,plan.repository.repository_id):undefined;
      return {...this.manifest(project,plan,ref.preparation),script};
    }
    if(action==="authorize"||action==="skip"){
      const {id,ref,version}=z.object({id:z.string().uuid(),ref:z.string().uuid(),version:z.number().int(),confirm:z.literal(true)}).parse(body);
      const read=()=>{
        const job=this.jobs(project).find(j=>j.id===id);
        const p=job?.plans?.find(p=>p.id===ref);
        const member=this.view(project).conversations.find(s=>s.id===job?.conversation);
        if(!job||!p||!member?.joined||member.repository_id!==job.repository_id||job.status!=="delivered"||p.version!==version)
          experimentError("COORDINATION_TARGET_CHANGED",409);
        return {job,p};
      };
      let {job,p}=read();
      if(action==="skip"){
        if(p.run_id)experimentError("COORDINATION_TARGET_CHANGED",409);
        p.status="skipped";this.save(job);return {ok:true};
      }
      if(p.status==="submitted"||p.status==="authorized")return {ok:true};
      if(p.status!=="pending")experimentError("COORDINATION_TARGET_CHANGED",409);
      const {hash}=z.object({hash:z.string().length(64)}).parse(body);
      if(this.manifest(project,this.experiments.data.plan(project,p.plan_id,version),p.preparation).hash!==hash)experimentError("COORDINATION_APPROVAL_CHANGED",409);
      const plan=await this.experiments.confirmPlan(project,p.plan_id,version);
      if(this.manifest(project,plan,p.preparation).hash!==hash)experimentError("COORDINATION_APPROVAL_CHANGED",409);
      ({job,p}=read());
      if(p.status==="pending"){p.status="authorized";p.approval_hash=hash;this.save(job);}
      return {ok:true};
    }
    if(action==="withdraw"){
      const {id}=z.object({id:z.string().uuid()}).parse(body);
      const job=this.jobs(project).find(j=>j.id===id);
      if(!job||job.status!=="waiting"||this.agent.coordinationTask(project,job.task_id))experimentError("COORDINATION_TARGET_CHANGED",409);
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
