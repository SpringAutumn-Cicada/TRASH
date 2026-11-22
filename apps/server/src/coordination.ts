import { randomUUID } from "node:crypto";
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
      const projects=this.store.db.prepare("SELECT DISTINCT project FROM coordination_jobs WHERE status='waiting'").all() as {project:string}[];
      for(const {project} of projects){
        if(!this.port)return;
        const view=this.view(project);
        for(const job of view.jobs.filter(j=>j.status==="waiting")){
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
  private attachPlan(project:string,job:CoordinationJob,plan:ExperimentPlanVersion,key:string,preparation=false){
    if(!job.repository_id||plan.repository.repository_id!==job.repository_id||plan.reproduction)experimentError("COORDINATION_TARGET_CHANGED",409);
    const existing=job.plans?.find(p=>p.plan_id===plan.plan_id&&p.version===plan.version&&p.preparation===preparation);
    if(existing)return existing;
    const ref:CoordinationPlan={id:randomUUID(),key,plan_id:plan.plan_id,version:plan.version,title:plan.content.title,
      commit:plan.content.commit_sha,host:plan.profile.name,repository:plan.repository.name??plan.repository.path,
      command:plan.content.command,gpu:plan.content.gpu,datasets:plan.datasets.map(d=>d.name),preparation,status:"pending"};
    job.plans=[...(job.plans??[]),ref];this.save(job);return ref;
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
    return jobs.map(job=>{
      let turn=this.agent.coordinationTask(project,job.task_id);
      const visited=new Set<string>();
      while(turn?.decision?.continuation_task_id&&!visited.has(turn.task_id)){
        visited.add(turn.task_id);
        const next=this.agent.coordinationTask(project,turn.decision.continuation_task_id);
        if(!next)break;turn=next;
      }
      return {...job,worker_status:turn?.status,worker_response:turn?.response.slice(-5000)};
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
    return {conversations:[...sessions.values()],jobs:this.details(project,this.jobs(project)),messages};
  }

  async action(project:string,body:unknown) {
    const action=z.object({action:z.string()}).parse(body).action;
    if(action==="message"){
      const input=z.object({id:z.string().uuid(),instructions:z.string().trim().min(1).max(30000)}).parse(body);
      return this.message(project,input.id,input.instructions);
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
