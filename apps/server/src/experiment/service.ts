import { ProjectFiles } from "../project-files.js";
import { assertExperimentScheme, saveRunArchive } from './run-archive.js';
import { projectRuntime } from "../project-layout.js";
import { discoverComputeResources, assertComputeSelection } from './compute-resources.js';
import { ExperimentFailureAnalysis } from './experiment-failure-analysis.js';
import { DatasetUploadSessions } from "./dataset-upload-sessions.js";
import { ReproductionQueueService } from "./reproduction-queue.js";
import { DatasetUploadService } from "./dataset-upload.js";
import { WorkspaceService, ensureRemoteDirectory } from "./workspace.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import { ExperimentStore, KnowledgeStore, experimentError, type TrashStore } from "@trash/storage";
import { autoDLDirectories, autoDLPaperDirectory, autoDLReproductionDirectory, experimentPlanInputSchema, experimentResultSchema, metricSchema, evaluationMetrics, type DatasetRef, type ExperimentPlanVersion, type ExperimentRun, type ExperimentRunState, type SshProfile } from "@trash/protocol";
import { RepositoryService } from "./repository.js";
import { GitIdentitySettings } from "../git-identity.js";
import { SshService, RemoteConnection, redact } from "./ssh.js";
import { DIAGNOSTICS, REMOTE_RUNNER, RUNNER_VERSION } from "./runner.js";
import { ReproductionService } from "./reproduction.js";
import { EnvironmentAnalysisService } from "./environment-analysis.js";
import { EnvironmentDeploymentService } from "./environment-deployment.js";
import { TerminalService } from "./terminal.js";
const terminal=["completed","failed","cancelled"];
const artifactListSchema=z.array(z.object({path:z.string(),size_bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).max(200);
const remoteStatusSchema=z.object({run_id:z.string(),token:z.string(),state:z.string(),at:z.number(),exit_code:z.number().int().nullable().optional(),reason:z.string().nullable().optional(),started_at:z.number().optional(),finished_at:z.number().optional()}).passthrough();
export class ExperimentService {
  readonly datasetUploads:DatasetUploadService;readonly workspaces:WorkspaceService;readonly deployments:EnvironmentDeploymentService;readonly environmentAnalysis:EnvironmentAnalysisService;readonly reproductions:ReproductionService;readonly data:ExperimentStore;readonly repository:RepositoryService;readonly ssh:SshService;readonly terminals:TerminalService;
  readonly failureAnalyses:ExperimentFailureAnalysis;
  readonly datasetUploadSessions:DatasetUploadSessions;
  readonly reproductionQueues:ReproductionQueueService;
  private inFlight=new Set<string>();private closed=false;private timer:ReturnType<typeof setInterval>;
  private readonly files: ProjectFiles;
  constructor(readonly store:TrashStore){
    this.files = new ProjectFiles(store, id => this.busyProject(id));
    this.workspaces=new WorkspaceService(store);this.reproductions=new ReproductionService(store);this.data=new ExperimentStore(store.db);this.datasetUploads=new DatasetUploadService(this.data,store.listProjects().map(item=>item.project_id),store.root);this.repository=new RepositoryService(this.data,new GitIdentitySettings(store.root));this.ssh=new SshService(this.data,store.root);this.terminals=new TerminalService(this.ssh);this.environmentAnalysis=new EnvironmentAnalysisService(store,this.reproductions);this.deployments=new EnvironmentDeploymentService(store,this.reproductions,this.workspaces);
    for(const run of this.data.runs())if(["preflight","syncing"].includes(run.status)){run.status="disconnected";run.error="本地服务已重启，请重新连接确认远端状态。";this.data.saveRun(run);}
    this.failureAnalyses=new ExperimentFailureAnalysis(this);
    this.datasetUploadSessions=new DatasetUploadSessions(this);
    this.reproductionQueues=new ReproductionQueueService(this);
    this.timer=setInterval(()=>{void this.tick();},5000);this.timer.unref();
  }
  close():void{this.closed=true;this.failureAnalyses.close();this.reproductionQueues.close();this.datasetUploads.close();clearInterval(this.timer);this.deployments.close();this.environmentAnalysis.close();this.terminals.close();this.ssh.close();}
  busyProject(projectId:string):boolean{return this.failureAnalyses.busy(projectId)||this.datasetUploadSessions.busy(projectId)||this.reproductionQueues.list(projectId).some(queue=>queue.status==='running'||queue.status==='paused')||this.datasetUploads.busy(projectId)||this.deployments.busyProject(projectId)||this.environmentAnalysis.busy(projectId)||this.reproductions.busy(projectId)||this.terminals.hasProject(projectId)||this.data.runs(projectId).some(run=>this.data.active(run));}
  runWriteConflict?:(path:string)=>boolean;
  private hostKey(profile:SshProfile):string{return `${profile.host.toLowerCase()}:${profile.port}:${profile.username}`;}
  private mark(run:ExperimentRun,state:ExperimentRunState,error?:string):void{
    if(this.closed)return;
    const current=this.data.run(run.project_id,run.run_id);
    if(current.status==="cancel_requested"&&!terminal.includes(state))state="cancel_requested";
    if(current.status!==state||current.error!==error)this.data.event(run.run_id,state,error??state);
    run.status=state;run.error=error;this.saveRun(run);
  }
  private saveRun(run:ExperimentRun){
    run.updated_at=new Date().toISOString();
    try{
      run.archive_path=saveRunArchive(join(this.store.root,'projects',run.project_id),run);
      run.archive_error=undefined;
    }catch(error){run.archive_error=error instanceof Error&&error.message==='RUN_ARCHIVE_CONFLICT'?'运行档案路径冲突。':'无法更新运行档案，请检查实验目录。';}
    this.data.saveRun(run);
  }
  async diagnostics(projectId:string,profileId:string):Promise<Record<string,unknown>>{
    const profile=this.data.profile(projectId,profileId),remote=await this.ssh.connect(profile);
    try{const environment=JSON.parse(await remote.exec(["python3","-c",DIAGNOSTICS,profile.remote_root])) as Record<string,unknown>;this.store.db.prepare("INSERT INTO experiment_environments VALUES (?,?,?,?)").run(`environment_${randomUUID()}`,projectId,profileId,JSON.stringify({at:new Date().toISOString(),environment}));return environment;}
    catch(error){if(error instanceof Error&&error.message==="SSH_COMMAND_TIMEOUT")experimentError("SSH_COMMAND_TIMEOUT",422);experimentError("REMOTE_DIAGNOSTICS_FAILED",422);}
    finally{remote.close();}
  }
  async checkDataset(projectId:string,id:string):Promise<DatasetRef>{
    const dataset=this.data.datasets(projectId).find(d=>d.dataset_id===id)??experimentError("DATASET_NOT_FOUND",404);
    if(this.datasetUploads.busy(projectId)||dataset.transfer_status==='uploading'||['failed','cancelled','interrupted'].includes(dataset.transfer_status??''))experimentError('DATASET_BUSY',409);
    const remote=this.terminals.connection(projectId,dataset.profile_id);
    const pending=this.datasetUploads.verify(projectId,id,remote);
    void pending.catch(()=>{});
    return this.data.datasets(projectId).find(item=>item.dataset_id===id)!;
  }

  createPlan(projectId:string,input:unknown,id?:string,baseVersion=0):ExperimentPlanVersion{
    const content=experimentPlanInputSchema.parse(input),profile=this.data.profile(projectId,content.profile_id);
    const reproduction=content.code_source==="reproduction"?this.reproductions.snapshotInfo(projectId,content.snapshot_id!):undefined;
    if(reproduction&&reproduction.reproduction_id!==content.reproduction_id)experimentError("SNAPSHOT_MISMATCH",409);

    const previous=id?this.data.plans(projectId).filter(p=>p.plan_id===id).sort((a,b)=>b.version-a.version)[0]:undefined;
    if(id&&!previous)experimentError("EXPERIMENT_PLAN_NOT_FOUND",404);
    if((previous?.version??0)!==baseVersion)experimentError("VERSION_CONFLICT",409);
    if(content.direction_id&&content.scheme_id)assertExperimentScheme(join(this.store.root,'projects',projectId),content.direction_id,content.scheme_id);
    const repo=reproduction
      ? {repository_id:reproduction.reproduction_id,project_id:projectId,path:"",bound_at:reproduction.created_at}
      : this.repository.bound(projectId,content.repository_id??(previous&&!previous.reproduction?previous.repository.repository_id:undefined));
    if(!reproduction)content.repository_id=repo.repository_id;

    const datasets=content.dataset_ids.map(key=>this.data.datasets(projectId).find(d=>d.dataset_id===key)??experimentError("DATASET_NOT_FOUND",404));
    if(datasets.some(d=>d.transfer_status&&d.transfer_status!=="ready"))experimentError("DATASET_NOT_READY",409);
    if(content.data_mappings?.some(mapping=>!datasets.some(dataset=>dataset.dataset_id===mapping.dataset_id)))experimentError('DATASET_MAPPING_INVALID',400);
    if(datasets.some(d=>d.profile_id!==profile.profile_id))experimentError("DATASET_HOST_MISMATCH");
    const plan:ExperimentPlanVersion={plan_id:id??`plan_${randomUUID()}`,project_id:projectId,version:(previous?.version??0)+1,status:"draft",repository:repo,...(reproduction?{reproduction}:{}),profile,datasets,content,created_at:new Date().toISOString()};this.data.savePlan(plan);return plan;
  }
  async preflight(plan:ExperimentPlanVersion):Promise<Record<string,unknown>>{
    if(plan.reproduction)await this.reproductions.bundle(plan.project_id,plan.reproduction);
    else await this.repository.preflight(plan.project_id,plan.content.commit_sha,plan.repository.repository_id);
    const profile=this.data.profile(plan.project_id,plan.profile.profile_id);
    if(JSON.stringify(profile)!==JSON.stringify(plan.profile))experimentError("SSH_PROFILE_CHANGED",409);
    const remote=await this.ssh.connect(profile);
    try{
      const environment=JSON.parse(await remote.exec([plan.content.python,"-c",DIAGNOSTICS,profile.remote_root]));
      if(plan.content.execution_mode)assertComputeSelection(await discoverComputeResources(remote),plan.content.gpu,plan.content.resource_policy);
      if(environment.platform!=="Linux"||!environment.python_ok||(!plan.reproduction&&!environment.tools.git)||!environment.tools.tmux||!environment.tools.bash)experimentError("REMOTE_ENVIRONMENT_INCOMPLETE",422);
      if(environment.root!==profile.remote_root)experimentError("REMOTE_ROOT_SYMLINK",422);
      if(environment.disk_free<512*1024*1024)experimentError("REMOTE_DISK_INSUFFICIENT",422);
      if(plan.content.gpu!=="cpu"){
        const indices=String(environment.gpu).split("\n").map(row=>row.split(",")[0].trim());if(plan.content.gpu.split(",").some(id=>!indices.includes(id)))experimentError("GPU_UNAVAILABLE",422);
      }
      for(const dataset of plan.datasets){await remote.exec([plan.content.python,"-c","import os,sys; assert os.path.exists(sys.argv[1]),'DATASET_NOT_FOUND'",dataset.path]);
        if(dataset.sha256)await remote.exec([plan.content.python,'-c',"import sys,hashlib,pathlib; p=pathlib.Path(sys.argv[1]); assert p.is_file(),'DATASET_CHECKSUM_FILE_REQUIRED'; h=hashlib.sha256(); f=p.open('rb'); [h.update(b) for b in iter(lambda:f.read(1048576),b'')]; assert h.hexdigest()==sys.argv[2],'DATASET_HASH_MISMATCH'",dataset.checksum_manifest??dataset.path,dataset.sha256],undefined,600000);
      }
      return environment;
    }finally{remote.close();}
  }
  async confirmPlan(projectId:string,id:string,version:number):Promise<ExperimentPlanVersion>{
    const plan=this.data.plan(projectId,id,version);
    if(plan.status==="superseded" || this.data.plans(projectId).some(p=>p.plan_id===id&&p.version>version))experimentError("VERSION_CONFLICT",409);
    if (plan.status === "confirmed") return plan;
    await this.preflight(plan);
    return this.store.db.transaction(()=>{
      const latest = this.data.plans(projectId).find(item => item.plan_id === id);
      if (!latest || latest.version !== version || latest.status === "superseded") experimentError("VERSION_CONFLICT",409);
      if (latest.status === "confirmed") return latest;
      const { direction_id, scheme_id } = plan.content;
      let method_sha256: string | undefined;
      if (!plan.reproduction && direction_id && scheme_id) {
        assertExperimentScheme(join(this.store.root, "projects", projectId), direction_id, scheme_id);
        const path = `experiments/${direction_id}/${scheme_id}/README.md`;
        const document = this.files.preview(projectId, path);
        if (document.content === undefined || !document.etag) experimentError("METHOD_UNREADABLE",422);
        method_sha256 = createHash("sha256").update(document.content).digest("hex");
        this.store.db.prepare("INSERT INTO experiment_method_snapshots(project_id,sha256,content) VALUES (?,?,?) ON CONFLICT DO NOTHING")
          .run(projectId, method_sha256, document.content);
      }
      for(const old of this.data.plans(projectId).filter(p=>p.plan_id===id&&p.status==="confirmed"&&p.version!==version))this.data.savePlan({...old,status:"superseded"});
      const confirmed={...plan,method_sha256,status:"confirmed" as const,confirmed_at:new Date().toISOString()};this.data.savePlan(confirmed);return confirmed;
    }).immediate();
  }
  submit(projectId:string,input:{plan_id:string;version:number;idempotency_key:string;preparation:boolean},retryOf?:string):ExperimentRun{
    const duplicate=this.data.runs(projectId).find(run=>run.idempotency_key===input.idempotency_key);if(duplicate){if(duplicate.plan.plan_id!==input.plan_id||duplicate.plan.version!==input.version||duplicate.preparation!==input.preparation)experimentError("IDEMPOTENCY_CONFLICT",409);return duplicate;}
    const plan=this.data.plan(projectId,input.plan_id,input.version);if(plan.status!=="confirmed"&&!(retryOf&&plan.status==="superseded"))experimentError("PLAN_NOT_CONFIRMED",409);
    if(this.runWriteConflict?.(plan.repository.path))experimentError("CODE_AGENT_BUSY",409);
    const {direction_id,scheme_id}=plan.content;
    if(direction_id&&scheme_id)assertExperimentScheme(join(this.store.root,'projects',projectId),direction_id,scheme_id);
    if(input.preparation&&!plan.content.preparation_script)experimentError("PREPARATION_SCRIPT_REQUIRED");
    if(!input.preparation&&plan.content.preparation_script&&!this.data.runs(projectId).some(r=>r.preparation&&r.status==="completed"&&r.exit_code===0&&r.plan.plan_id===plan.plan_id&&r.plan.version===plan.version))experimentError("PREPARATION_REQUIRED",409);
    const id=`run_${randomUUID()}`,at=new Date().toISOString();
    const workspace=this.workspaces.get(projectId,plan.profile.profile_id);
    let remoteDir=posix.join(plan.profile.remote_root,projectId,id);
    if(workspace){
      const snapshot=plan.reproduction;
      if(snapshot){
        const code=snapshot.remote_directory?undefined:this.reproductions.list(projectId).find(item=>item.id===snapshot.reproduction_id);
        const label=snapshot.remote_directory??code?.remote_directory??autoDLReproductionDirectory(code?.name??snapshot.name,snapshot.reproduction_id);
        remoteDir=posix.join(workspace.root,autoDLDirectories.reproductionOutputs,label,id);
      }else{
        const repository=this.data.repository(projectId,plan.repository.repository_id)??plan.repository;
        remoteDir=posix.join(workspace.root,autoDLDirectories.paperOutputs,autoDLPaperDirectory(repository),id);
      }
    }
    const run:ExperimentRun={run_id:id,project_id:projectId,profile_id:plan.profile.profile_id,host_key:this.hostKey(plan.profile),plan,idempotency_key:input.idempotency_key,status:"queued",remote_dir:remoteDir,token:randomUUID(),created_at:at,updated_at:at,artifacts:[],preparation:input.preparation,...(retryOf?{retry_of:retryOf}:{})};
    this.saveRun(run);this.data.event(id,"queued",input.preparation?"已单独授权环境准备脚本":"已确认代码版本、命令、时限与同步范围");void this.tick();return run;
  }
  private async tick():Promise<void>{
    if(this.closed)return;
    const all=this.data.runs().sort((a,b)=>a.created_at.localeCompare(b.created_at));const hosts=new Set(all.filter(r=>this.data.active(r)).map(r=>r.host_key));
    for(const key of hosts){
      if(this.inFlight.has(key))continue;
      const active=all.find(r=>r.host_key===key&&this.data.active(r)&&r.status!=="queued");
      const next=active??all.find(r=>r.host_key===key&&r.status==="queued");if(!next)continue;
      if(!this.ssh.hasCredential(next.plan.profile))continue;
      this.inFlight.add(key);
      void (next.status==="queued"?this.start(next):this.poll(next)).catch(()=>{}).finally(()=>this.inFlight.delete(key));
    }
  }
  private async start(run:ExperimentRun):Promise<void>{
    let remote:RemoteConnection|undefined;let bundle:Awaited<ReturnType<RepositoryService["bundle"]>>|undefined;let launchAttempted=false;
    try{
      this.mark(run,"preflight");const environment=await this.preflight(run.plan);
      bundle=run.plan.reproduction?await this.reproductions.bundle(run.project_id,run.plan.reproduction):await this.repository.bundle(run.project_id,run.plan.content.commit_sha,run.plan.repository.repository_id);
      if(this.closed)return;
      remote=await this.ssh.connect(run.plan.profile);
      if(this.workspaces.get(run.project_id,run.profile_id))await ensureRemoteDirectory(remote,run.remote_dir);
      await remote.exec([run.plan.content.python,"-c","import os,sys; os.makedirs(sys.argv[1],mode=0o700,exist_ok=True); os.makedirs(sys.argv[1]+'/runner',exist_ok=True)",run.remote_dir]);
      this.mark(run,"syncing");await remote.upload(bundle.path,posix.join(run.remote_dir,"code.bundle.part"));
      await remote.exec([run.plan.content.python,"-c","import os,sys,hashlib; p=sys.argv[1]; h=hashlib.sha256(); f=open(p,'rb'); [h.update(b) for b in iter(lambda:f.read(1048576),b'')]; assert h.hexdigest()==sys.argv[2],'BUNDLE_HASH_MISMATCH'; os.replace(p,sys.argv[3])",posix.join(run.remote_dir,"code.bundle.part"),bundle.sha256,posix.join(run.remote_dir,"code.bundle")]);
      const manifest={run_id:run.run_id,token:run.token,runner_version:RUNNER_VERSION,bundle_sha256:bundle.sha256,...run.plan.content,...(run.plan.reproduction?{code_snapshot:run.plan.reproduction}:{}),preparation:run.preparation,datasets:run.plan.datasets};
      await remote.write(posix.join(run.remote_dir,"manifest.json"),JSON.stringify(manifest));await remote.write(posix.join(run.remote_dir,"environment.json"),JSON.stringify(environment));await remote.write(posix.join(run.remote_dir,"runner","runner.py"),REMOTE_RUNNER);
      const local=projectRuntime(this.store.root,run.project_id,'experiment-runs',run.run_id);await mkdir(local,{recursive:true});await writeFile(join(local,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600});
      if(this.data.run(run.project_id,run.run_id).status==="cancel_requested"){run.status="cancelled";this.saveRun(run);return;}
      if(this.closed)return;
      // Persist before launching: a lost acknowledgement must never cause another launch.
      this.mark(run,"running");launchAttempted=true;
      await remote.exec([run.plan.content.python,posix.join(run.remote_dir,"runner","runner.py"),"launch",run.remote_dir]);
    }catch(error){if(!this.closed)this.mark(run,launchAttempted?"unknown_remote_state":"failed",redact(error instanceof Error?error.message:"实验启动失败"));}
    finally{remote?.close();await bundle?.cleanup();if(!this.closed&&run.plan.content.execution_steps&&this.data.run(run.project_id,run.run_id).status==='failed')this.failureAnalyses.start(run.project_id,run.run_id);}
  }
  async poll(run:ExperimentRun):Promise<void>{
    if(this.closed)return;let remote:RemoteConnection|undefined;
    try{
      remote=await this.ssh.connect(run.plan.profile);
      const inspection=JSON.parse(await remote.exec([run.plan.content.python,"-c","import os,subprocess,sys,json; p=sys.argv[1]; s=subprocess.run(['tmux','has-session','-t',sys.argv[2]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(json.dumps({'status_exists':os.path.isfile(p+'/status.json'),'session_alive':s.returncode==0}))",run.remote_dir,`trash-${run.run_id}`]));
      if(!inspection.status_exists){
        if(this.data.run(run.project_id,run.run_id).status==="cancel_requested"&&!inspection.session_alive){this.mark(run,"cancelled");return;}
        this.mark(run,"unknown_remote_state",inspection.session_alive?"远端会话已存在，等待状态文件":"远端没有状态文件；未自动重新启动，请核对原运行。");return;
      }
      const raw=await remote.read(posix.join(run.remote_dir,"status.json"),1024*1024);const status=remoteStatusSchema.parse(JSON.parse(raw.toString()));
      if(status.run_id!==run.run_id||status.token!==run.token)experimentError("RUN_IDENTITY_MISMATCH",409);
      if(!terminal.includes(status.state)&&!inspection.session_alive&&Date.now()/1000-status.at>30){this.mark(run,"unknown_remote_state","远端状态已过期且会话不存在，不能认定实验仍在运行。");return;}
      run.remote_status={...status,token:undefined};run.process_status=status.state;
      if(status.exit_code!==undefined&&status.exit_code!==null)run.exit_code=status.exit_code;
      if(status.started_at)run.started_at=new Date(status.started_at*1000).toISOString();if(status.finished_at)run.finished_at=new Date(status.finished_at*1000).toISOString();
      const current=this.data.run(run.project_id,run.run_id);
      if(current.status==="cancel_requested"&&!terminal.includes(status.state))await remote.exec([run.plan.content.python,posix.join(run.remote_dir,"runner","runner.py"),"cancel",run.remote_dir,run.token]);
      if(terminal.includes(status.state)){
        this.mark(run,"collecting");await this.collect(run,remote);
        // Remote completion is authoritative, including a natural completion racing cancellation.
        run.status=status.state as ExperimentRunState;run.failure_analysis=this.data.run(run.project_id,run.run_id).failure_analysis;run.error=status.reason??undefined;this.saveRun(run);
        this.data.event(run.run_id,run.status,run.collection_status??"运行结束");
        if(run.plan.content.execution_steps&&(run.status==='failed'||(run.status==='completed'&&!run.result_id&&run.plan.content.result_collection?.mode!=='none')))this.failureAnalyses.start(run.project_id,run.run_id);
      }else this.mark(run,current.status==="cancel_requested"?"cancel_requested":"running");
    }catch(error){if(!this.closed)this.mark(run,"disconnected",redact(error instanceof Error?error.message:"远程状态无法确认"));}finally{remote?.close();}
  }
  async reconnect(projectId:string,id:string):Promise<ExperimentRun>{const run=this.data.run(projectId,id);if(run.status==="queued")return run;if(this.inFlight.has(run.host_key))experimentError("EXPERIMENT_BUSY",409);this.inFlight.add(run.host_key);try{await this.poll(run);return this.data.run(projectId,id);}finally{this.inFlight.delete(run.host_key);}}
  async cancel(projectId:string,id:string):Promise<ExperimentRun>{
    const run=this.data.run(projectId,id);if(!this.data.active(run))experimentError("EXPERIMENT_FINISHED",409);
    if(run.status==="queued"){this.mark(run,"cancelled");return run;}
    this.mark(run,"cancel_requested");
    if(!this.inFlight.has(run.host_key))await this.reconnect(projectId,id);
    return this.data.run(projectId,id);
  }
  retry(projectId:string,id:string):ExperimentRun{const run=this.data.run(projectId,id);if(this.data.active(run))experimentError("EXPERIMENT_ACTIVE",409);return this.submit(projectId,{plan_id:run.plan.plan_id,version:run.plan.version,idempotency_key:randomUUID(),preparation:run.preparation},id);}
  async logs(projectId:string,id:string,stream:string,offset:number):Promise<unknown>{
    const run=this.data.run(projectId,id),remote=await this.ssh.connect(run.plan.profile);const name=stream==="stderr"?"stderr.log":"stdout.log";
    try{
      const script="import os,json,sys; p=sys.argv[1]; print(json.dumps({'size':os.path.getsize(p) if os.path.exists(p) else 0,'rotated':os.path.exists(p+'.1')}))";
      const info=JSON.parse(await remote.exec([run.plan.content.python,"-c",script,posix.join(run.remote_dir,"logs",name)]));
      const start=offset>info.size?0:offset;if(info.size===0)return {text:"",offset:0,rotated:info.rotated};
      const bytes=await remote.read(posix.join(run.remote_dir,"logs",name),Math.min(256*1024,info.size-start),start);
      return {text:redact(bytes.toString()),offset:start+bytes.length,rotated:info.rotated||start!==offset};
    }finally{remote.close();}
  }
  async collectAgain(projectId:string,id:string):Promise<ExperimentRun>{const run=this.data.run(projectId,id);if(this.data.active(run))experimentError("EXPERIMENT_ACTIVE",409);const remote=await this.ssh.connect(run.plan.profile);try{await this.collect(run,remote);run.failure_analysis=this.data.run(projectId,id).failure_analysis;this.saveRun(run);return run;}finally{remote.close();}}
  private async collect(run:ExperimentRun,remote:RemoteConnection):Promise<void>{
    const output=await remote.exec([run.plan.content.python,posix.join(run.remote_dir,"runner","runner.py"),"collect",run.remote_dir]);const items=artifactListSchema.parse(JSON.parse(output));let total=0;const previous=new Map(run.artifacts.map(a=>[a.path,a]));const collected:ExperimentRun["artifacts"]=[];
    for(const item of items){
      if(item.path.startsWith("/")||item.path.split("/").includes(".."))experimentError("ARTIFACT_PATH_INVALID",422);
      const existing=previous.get(item.path);if(existing?.downloaded&&existing.sha256===item.sha256){collected.push(existing);continue;}
      if(item.size_bytes>20*1024*1024||total+item.size_bytes>100*1024*1024){collected.push({...item,downloaded:false,reason:"超过回传大小限制"});continue;}
      await remote.exec([run.plan.content.python,"-c","import pathlib,sys; r=pathlib.Path(sys.argv[1]).resolve(); p=(r/sys.argv[2]).resolve(); assert p.is_relative_to(r) and p.is_file(),'ARTIFACT_PATH_INVALID'",run.remote_dir,item.path]);
      const bytes=await remote.read(posix.join(run.remote_dir,item.path),Math.max(1,item.size_bytes));
      if(bytes.length!==item.size_bytes||createHash("sha256").update(bytes).digest("hex")!==item.sha256)experimentError("ARTIFACT_HASH_MISMATCH",409);
      const artifact=this.store.saveArtifact(run.project_id,item.path.replace(/\//g,"-"),item.path.endsWith(".json")?"application/json":"application/octet-stream",bytes);total+=bytes.length;const saved={...item,downloaded:true,artifact_id:artifact.artifact_id};collected.push(saved);previous.set(item.path,saved);run.artifacts=[...previous.values()];
      this.saveRun(run);
    }
    run.artifacts=collected;
    run.collection_status=run.artifacts.some(a=>!a.downloaded)?"部分大文件仅保留远端引用":"产物已收集";
    if(run.plan.content.result_collection?.mode==='none'){run.metrics_status='方案未识别可靠指标，仅保存日志与产物，结果待补充';return;}
    if(run.preparation){run.metrics_status="环境准备不产生实验结果";return;}
    const metricFile=run.artifacts.find(a=>(a.path===(run.plan.content.metrics_path.toLowerCase().endsWith('.csv')?'outputs/collected-metrics.json':run.plan.content.metrics_path))&&a.downloaded&&a.artifact_id);
    if(!metricFile){run.metrics_status="执行结束，结果待补充：指标文件缺失或未下载";const source=run.artifacts.find(item=>item.path==='collection.json'&&item.artifact_id);if(source?.artifact_id){try{const info=JSON.parse(Buffer.from(this.store.readArtifact(run.project_id,source.artifact_id)!).toString());if(info.reason)run.metrics_status='指标采集未完成：'+redact(String(info.reason));}catch{/* Keep the missing-source explanation. */}}return;}
    let metrics:z.infer<typeof metricSchema>[];let evaluationExtras:Record<string,unknown>={};
    try{
      const bytes=this.store.readArtifact(run.project_id,metricFile.artifact_id!)!;const payload=z.object({metrics:z.array(metricSchema).default([]),confusion_matrix:z.unknown().optional(),evaluation:z.unknown().optional()}).strict().parse(JSON.parse(Buffer.from(bytes).toString()));
      const normalized=experimentResultSchema.parse({schema_version:1,title:'collected',method:run.plan.content.method,dataset:run.plan.datasets.map(d=>d.name).join(', '),metrics:payload.metrics,...(payload.confusion_matrix?{confusion_matrix:payload.confusion_matrix}:{}),...(payload.evaluation?{evaluation:payload.evaluation}:{})});metrics=normalized.metrics;
      evaluationExtras={...(normalized.confusion_matrix?{confusion_matrix:normalized.confusion_matrix}:{}),...(normalized.evaluation?{evaluation:normalized.evaluation}:{})};
      const expected=run.plan.content.expected_metrics.map(item=>({...item,unit:evaluationMetrics.some(spec=>spec.name===item.name)&&item.unit==='%'?(item.name==='MCC'?'':'ratio'):item.name==='MCC'&&item.unit==='ratio'?'':item.unit}));
      for(const item of expected)if(metrics.filter(m=>m.source!=='confusion_matrix'&&m.name===item.name&&m.unit===item.unit).length!==1&&metrics.filter(m=>m.source==='confusion_matrix'&&m.name===item.name&&m.unit===item.unit).length!==1)throw new Error("指标缺失或单位不符");
      if(metrics.some(m=>m.source!=='confusion_matrix'&&!expected.some(e=>e.name===m.name&&e.unit===m.unit)))throw new Error("包含未声明指标");
    }catch{run.metrics_status="指标无效，需人工核对";return;}
    if(run.exit_code!==0){run.metrics_status="进程未成功，不自动登记有效结果";return;}
    const environmentFile=run.artifacts.find(a=>a.path==="environment.json"&&a.artifact_id);
    let environment:Record<string,unknown>={};
    if(environmentFile?.artifact_id){try{environment=JSON.parse(Buffer.from(this.store.readArtifact(run.project_id,environmentFile.artifact_id)!).toString());}catch{/* Environment remains explicitly missing. */}}
    if(run.plan.reproduction)environment={...environment,code_snapshot:run.plan.reproduction};
    this.store.db.transaction(()=>{
      const knowledge=new KnowledgeStore(this.store.db);const existing=knowledge.list(run.project_id,"experiment-result").find(v=>"external_run_id" in v.content&&v.content.external_run_id===run.run_id);
      if(existing){run.result_id=existing.object_id;run.metrics_status="已登记结果";this.saveRun(run);return;}
      const result=knowledge.write(run.project_id,"experiment-result",{base_version:0,content:{schema_version:1,title:run.plan.content.title,method:run.plan.content.method,dataset:run.plan.datasets.map(d=>d.name).join(", "),dataset_version:run.plan.datasets.map(d=>d.version).join(", "),evaluation_protocol:run.plan.content.evaluation_protocol,config:{...run.plan.content.config,...(run.plan.content.execution_mode?{_trash_execution:{processing_method:run.plan.content.processing_method,mode:run.plan.content.execution_mode,model_source:run.plan.content.model_source,model_input_kind:run.plan.content.model_input_kind}}:{})},environment,...(run.started_at?{run_at:run.started_at}:{}),seed:run.plan.content.seed,...(!run.plan.reproduction?{git_commit:run.plan.content.commit_sha}:{}),plan_version:`${run.plan.plan_id}:${run.plan.version}`,external_run_id:run.run_id,metrics,...evaluationExtras,attachments:run.artifacts.map(a=>({name:a.path,uri:a.artifact_id?`/api/v1/projects/${run.project_id}/experiment-artifacts/${run.run_id}/${a.artifact_id}`:`ssh://${run.plan.profile.host}:${run.plan.profile.port}${run.remote_dir}/${a.path}`,sha256:a.sha256})),notes:"由远程实验收集，待研究者审阅"}},"agent");run.result_id=result.object_id;run.metrics_status="已登记待审结果";this.saveRun(run);
    })();
  }
}
