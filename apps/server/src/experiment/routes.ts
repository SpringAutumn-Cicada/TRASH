import { deleteDatasetFiles } from "./delete-dataset.js";
import { recognizeWorkspace, adoptWorkspace } from "./workspace-migration.js";
import { directoryLabel, ensureRemoteDirectory } from "./workspace.js";
import { posix } from "node:path";
/* eslint-disable no-control-regex -- Reject control characters in filesystem paths and interpreter names. */
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { datasetInputSchema, runSubmitSchema, sshProfileInputSchema, sessionCredentialSchema, type ExperimentRun } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { ExperimentService } from "./service.js";
import { browseDirectories, createDirectory, selectDirectory } from "./directories.js";
import { parseSshLogin, sshLoginInputSchema } from "./ssh-login.js";
import { discoverPythonInterpreters } from "./environment-host.js";
export function publicRun(run:ExperimentRun):unknown {const {token:_token,...safe}=run;return safe;}
export async function experimentRoute(request:IncomingMessage,response:ServerResponse,url:URL,projectId:string,subpath:string,service:ExperimentService,readJson:(r:IncomingMessage)=>Promise<unknown>,send:(r:ServerResponse,status:number,value:unknown)=>void):Promise<boolean>{
  const method=request.method??"GET",parts=subpath.split("/");
  if(parts[0]==='reproduction-queues'){
    if(parts.length===2&&parts[1]==='mapping-preview'&&method==='POST'){
      const input=z.object({profile_id:z.string(),directory:z.string().startsWith('/'),path:z.string().min(1),dataset_ids:z.array(z.string()).min(1).max(50)}).strict().parse(await readJson(request));
      if(input.path.startsWith('/')||input.path.split('/').some(part=>!part||part==='..'||part==='.'||part==='.venv'||part==='.git')||/[\x00-\x1f]/.test(input.path+input.directory))experimentError('INVALID_REQUEST',400);
      const targets=input.dataset_ids.map(id=>service.data.datasets(projectId).find(dataset=>dataset.dataset_id===id&&dataset.profile_id===input.profile_id)??experimentError('DATASET_NOT_FOUND',404));
      const remote=service.terminals.connection(projectId,input.profile_id);
      const result=await remote.exec(['python3','-c',"import pathlib,sys,json; r=pathlib.Path(sys.argv[1]).resolve(); p=r/sys.argv[2]; targets=json.loads(sys.argv[3]); assert r.is_dir() and p.parent.is_dir() and p.parent.resolve().is_relative_to(r),'MAPPING_PARENT_INVALID'; assert not p.exists() and not p.is_symlink(),'DATA_MAPPING_CONFLICT'; assert all(pathlib.Path(t).exists() for t in targets),'DATASET_NOT_FOUND'; print(json.dumps({'available':True}))",input.directory,input.path,JSON.stringify(targets.map(dataset=>dataset.path))]);
      send(response,200,JSON.parse(result));return true;
    }
    if(parts.length===1&&method==='GET'){send(response,200,{queues:service.reproductionQueues.list(projectId)});return true;}
    if(parts.length===1&&method==='POST'){send(response,201,{queue:await service.reproductionQueues.create(projectId,await readJson(request))});return true;}
    if(parts.length===3&&method==='POST'&&['resume','skip','cancel'].includes(parts[2])){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,200,{queue:await service.reproductionQueues.action(projectId,parts[1],parts[2] as 'resume'|'skip'|'cancel')});return true;}
  }
  if(parts[0]==="remote-workspace"){
    const profileId=z.string().min(1).parse(url.searchParams.get("profile_id"));service.data.profile(projectId,profileId);
    if(parts.length===1&&method==="GET"){response.setHeader("cache-control","no-store");send(response,200,{workspace:service.workspaces.get(projectId,profileId)??null,suggested_root:service.workspaces.suggested(projectId),sources:service.data.profiles(projectId).filter(item=>item.profile_id!==profileId).flatMap(item=>{const workspace=service.workspaces.get(projectId,item.profile_id);return workspace?[{profile_id:item.profile_id,root:workspace.root}]:[]})});return true;}
    if(parts.length===1&&method==="PUT"){const input=z.object({root:z.string().trim().min(1).max(2048)}).strict().parse(await readJson(request));if(service.reproductions.busy(projectId)||service.datasetUploads.busy(projectId)||service.deployments.busyProject(projectId)||service.data.runs(projectId).some(run=>service.data.active(run)))experimentError('WORKSPACE_BUSY',409);send(response,200,{workspace:service.workspaces.save(projectId,profileId,input.root)});return true;}
    if(parts.length===2&&['recognize','adopt'].includes(parts[1])&&method==='POST'){const input=z.object({root:z.string().trim().min(1).max(2048),source_profile_id:z.string().min(1).optional(),confirm:z.literal(true)}).strict().parse(await readJson(request));if(input.source_profile_id)service.data.profile(projectId,input.source_profile_id);if(parts[1]==='recognize')send(response,200,{recognition:await recognizeWorkspace(service,projectId,profileId,input.root,input.source_profile_id)});else send(response,200,await adoptWorkspace(service,projectId,profileId,input.root,input.source_profile_id));return true;}
    if(parts.length===2&&parts[1]==="initialize"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,200,{workspace:await service.workspaces.initialize(projectId,profileId,service.terminals.connection(projectId,profileId))});return true;}
  }
  if(parts.length===1&&parts[0]==="terminals"&&method==="GET"){response.setHeader("cache-control","no-store");send(response,200,{terminals:service.terminals.list(projectId)});return true;}
  if(parts[0]==="terminals"&&parts[1]){
    const token=typeof request.headers["x-terminal-token"]==="string"?request.headers["x-terminal-token"]:"";
    if(parts.length===3&&parts[2]==="upload"&&method==="POST"){
      const directory=z.string().min(1).max(4096).parse(url.searchParams.get("directory"));
      const name=z.string().min(1).max(255).parse(url.searchParams.get("name"));
      send(response,201,await service.terminals.upload(projectId,parts[1],token,request,directory,name));return true;
    }
    if(parts.length===3&&parts[2]==="split"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,201,{terminal:await service.terminals.split(projectId,parts[1],token)});return true;}
    if(parts.length===2&&method==="DELETE"){service.terminals.remove(projectId,parts[1],token);send(response,200,{closed:true});return true;}
    if(parts.length===3&&parts[2]==="events"&&method==="GET"){service.terminals.attach(projectId,parts[1],token,response,z.coerce.number().int().nonnegative().parse(url.searchParams.get("after")??0));return true;}
    if(parts.length===3&&parts[2]==="input"&&method==="POST"){const input=z.object({text:z.string().min(1).max(32768)}).strict().parse(await readJson(request));service.terminals.input(projectId,parts[1],token,input.text);send(response,200,{accepted:true});return true;}
    if(parts.length===3&&parts[2]==="resize"&&method==="POST"){const input=z.object({cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(200)}).strict().parse(await readJson(request));service.terminals.resize(projectId,parts[1],token,input.cols,input.rows);send(response,200,{accepted:true});return true;}
  }
  if(parts[0]==="reproduction-snapshots"&&parts.length===2&&method==="GET"){send(response,200,{snapshot:service.reproductions.snapshotInfo(projectId,parts[1])});return true;}
  if(parts[0]==="experiment-code"){
    if(parts.length===2&&parts[1]==="upload-progress"&&method==="GET"){const id=z.string().uuid().parse(url.searchParams.get('request_id'));send(response,200,{progress:service.reproductions.progress(projectId,'experiment-code',id)});return true;}
    if(parts.length===2&&parts[1]==="cancel-upload"&&method==="POST"){const input=z.object({request_id:z.string().uuid(),confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,202,service.reproductions.cancelUpload(projectId,'experiment-code',input.request_id));return true;}
    if(parts.length===2&&parts[1]==="upload"&&method==="POST"){
      const input=z.object({profile_id:z.string(),name:z.string().trim().min(1).max(100),request_id:z.string().uuid(),confirm:z.literal(true)}).strict().parse(await readJson(request));service.data.profile(projectId,input.profile_id);
      const workspace=service.workspaces.get(projectId,input.profile_id)??experimentError('WORKSPACE_REQUIRED',409),remote=service.terminals.connection(projectId,input.profile_id),release=service.reproductions.acquire(projectId),operation=service.reproductions.beginUpload(projectId,'experiment-code',input.request_id);
      const report=(stage:string,sent=0,total=0)=>{if(operation.signal.aborted)experimentError('UPLOAD_CANCELLED',409);service.reproductions.report(projectId,'experiment-code',input.request_id,stage,sent,total);};
      try{report('snapshot');const status=await service.repository.status(projectId);await service.repository.preflight(projectId,status.head);const name=directoryLabel(input.name);const snapshot=await service.reproductions.sourceSnapshot(projectId,service.repository.bound(projectId).path,name);await service.repository.preflight(projectId,status.head);if((await service.repository.status(projectId)).head!==status.head)experimentError('GIT_TREE_DIRTY',409);const parent=posix.join(workspace.root,'experiments');await ensureRemoteDirectory(remote,parent);const deployed=await service.reproductions.deploy(remote,projectId,snapshot,parent,report,operation.signal,name);service.workspaces.recordExperimentUpload(projectId,input.profile_id,workspace.root,{name,path:deployed.path,commit:status.head,snapshot_id:snapshot.snapshot_id,at:new Date().toISOString()});send(response,201,{...deployed,commit:status.head});}
      catch(error){service.reproductions.report(projectId,'experiment-code',input.request_id,operation.signal.aborted?'cancelled':'failed');throw error;}
      finally{operation.finish();release();}return true;
    }
  }
  if(parts[0]==="reproductions"){
    if(parts[1]&&parts[2]==="environment"){
      service.reproductions.get(projectId,parts[1]);
      if(parts.length===4&&parts[3]==="interpreters"&&method==="GET"){
        const profileId=z.string().min(1).parse(url.searchParams.get("profile_id"));
        service.data.profile(projectId,profileId);response.setHeader("cache-control","no-store");
        send(response,200,await discoverPythonInterpreters(service.terminals.connection(projectId,profileId)));return true;
      }
      if(parts.length===4&&parts[3]==="deployment-directory"&&method==="GET"){
        const profileId=z.string().min(1).parse(url.searchParams.get("profile_id"));service.data.profile(projectId,profileId);
        const code=service.reproductions.get(projectId,parts[1]),upload=code.uploads?.filter(item=>item.profile_id===profileId).at(-1);
        response.setHeader("cache-control","no-store");send(response,200,{directory:upload?.path??"",source:upload?"latest-upload":"none"});return true;
      }
      if(parts.length===5&&parts[3]==="deployments"&&method==="DELETE"){
        z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));service.deployments.remove(projectId,parts[1],parts[4]);send(response,200,{deleted:true});return true;
      }
      if(parts.length===6&&parts[3]==="deployments"&&["cancel","refresh"].includes(parts[5])&&method==="POST"){
        z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));
        const task=service.deployments.list(projectId).find(item=>item.id===parts[4]&&item.code_id===parts[1])??experimentError("DEPLOYMENT_NOT_FOUND",404);
        const remote=task.remote_job?service.terminals.connection(projectId,task.profile_id):undefined;
        if(parts[5]==="cancel")send(response,200,{deployment:await service.deployments.cancel(projectId,parts[1],task.id,remote)});
        else{if(!remote)experimentError("DEPLOYMENT_STATE_UNKNOWN",409);send(response,200,{deployment:await service.deployments.refresh(projectId,parts[1],task.id,remote)});}
        return true;
      }
      if(parts.length===4&&parts[3]==="deployments"&&method==="GET"){
        for(const task of service.deployments.list(projectId).filter(task=>task.code_id===parts[1]&&task.remote_job&&["installing","cancelling","unknown"].includes(task.status)&&!service.deployments.isLocal(task.id))){try{await service.deployments.refresh(projectId,parts[1],task.id,service.terminals.connection(projectId,task.profile_id));}catch{/* Keep unknown status until the original host is connected. */}}
        response.setHeader("cache-control","no-store");send(response,200,{deployments:service.deployments.list(projectId).filter(task=>task.code_id===parts[1])});return true;
      }
      if(parts.length===6&&parts[3]==="reports"&&parts[5]==="deploy"&&method==="POST"){
        const input=z.object({profile_id:z.string(),python:z.string().min(1).max(4096),directory:z.string().trim().min(1).max(4096).optional(),resume_id:z.string().regex(/^deploy_[a-f0-9-]+$/).optional(),repair:z.boolean().default(false),confirm:z.literal(true)}).strict().parse(await readJson(request));
        service.data.profile(projectId,input.profile_id);
        const report=service.environmentAnalysis.report(projectId,parts[1],parts[4]);
        service.deployments.assertAvailable(projectId);
        if((await service.environmentAnalysis.freshness(projectId,parts[1],report.id)).stale)experimentError("DEPLOYMENT_REPORT_STALE",409);
        const code=service.reproductions.get(projectId,parts[1]),upload=code.uploads?.filter(item=>item.profile_id===input.profile_id).at(-1);
        const directory=input.directory??upload?.path;
        if(!directory)experimentError("DEPLOYMENT_UPLOAD_REQUIRED",409);
        if(!directory.startsWith("/")||directory==="/"||directory.split("/").includes("..")||Array.from(directory).some(char=>char.charCodeAt(0)<32))experimentError("DEPLOYMENT_DIRECTORY_INVALID",400);
        if(upload&&directory===upload.path){
          const snapshot=service.reproductions.snapshotInfo(projectId,upload.snapshot_id),analyzed=service.reproductions.snapshotInfo(projectId,report.snapshot_id);
          const uploaded=new Map(snapshot.files.map(file=>[file.path,file]));
          const analyzedPaths=new Set(analyzed.files.map(file=>file.path));
          const exclusions=analyzed.analysis_excluded??[];
          const mismatched=analyzed.files.some(file=>{const other=uploaded.get(file.path);return !other||other.sha256!==file.sha256||other.size_bytes!==file.size_bytes;});
          const unexpected=snapshot.files.some(file=>!analyzedPaths.has(file.path)&&!exclusions.some(excluded=>excluded.path===file.path||excluded.reason==="excluded_directory"&&file.path.startsWith(excluded.path+"/")));
          if(mismatched||unexpected)experimentError("DEPLOYMENT_UPLOAD_STALE",409);
        }
        send(response,202,{deployment:await service.deployments.start(report,input.profile_id,input.python,directory,service.terminals.connection(projectId,input.profile_id),input.resume_id,input.repair)});return true;
      }
      if(parts.length===3&&method==="GET"){send(response,200,{tasks:service.environmentAnalysis.tasks(projectId,parts[1]),reports:service.environmentAnalysis.reports(projectId,parts[1])});return true;}
      if(parts.length===3&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,202,{task:service.environmentAnalysis.start(projectId,parts[1])});return true;}
      if(parts.length===5&&parts[3]==="tasks"&&method==="GET"){const task=service.environmentAnalysis.tasks(projectId,parts[1]).find(task=>task.id===parts[4])??experimentError("ENVIRONMENT_TASK_NOT_FOUND",404);send(response,200,{task});return true;}
      if(parts.length===6&&parts[3]==="tasks"&&parts[5]==="dismiss"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,200,{task:service.environmentAnalysis.dismiss(projectId,parts[1],parts[4])});return true;}
      if(parts.length===6&&parts[3]==="tasks"&&parts[5]==="cancel"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,200,{task:service.environmentAnalysis.cancel(projectId,parts[1],parts[4])});return true;}
      if(parts.length===5&&parts[3]==="reports"&&method==="GET"){send(response,200,{report:service.environmentAnalysis.report(projectId,parts[1],parts[4])});return true;}
      if(parts.length===6&&parts[3]==="reports"&&parts[5]==="comparisons"&&method==="GET"){service.environmentAnalysis.report(projectId,parts[1],parts[4]);send(response,200,{comparisons:service.environmentAnalysis.comparisons(projectId,parts[1],parts[4])});return true;}
      if(parts.length===6&&parts[3]==="reports"&&parts[5]==="compare"&&method==="POST"){
        const input=z.object({profile_id:z.string(),python:z.string().min(1).max(4096).default("python3"),confirm:z.literal(true)}).strict().parse(await readJson(request));
        service.data.profile(projectId,input.profile_id);send(response,200,{comparison:await service.environmentAnalysis.compare(projectId,parts[1],parts[4],input.profile_id,input.python,service.terminals)});return true;
      }
      if(parts.length===6&&parts[3]==="reports"&&parts[5]==="freshness"&&method==="GET"){send(response,200,await service.environmentAnalysis.freshness(projectId,parts[1],parts[4]));return true;}
      return false;
    }
    // Cancellation must bypass the upload's project lock.
    if(parts.length===3&&parts[1]&&parts[2]==="cancel-upload"&&method==="POST"){
      const input=z.object({request_id:z.string().uuid(),confirm:z.literal(true)}).strict().parse(await readJson(request));
      send(response,202,service.reproductions.cancelUpload(projectId,parts[1],input.request_id));return true;
    }
    const release=method!=="GET"?service.reproductions.acquire(projectId):()=>{};
    try{
    if(parts.length===1&&method==="GET"){send(response,200,{codes:service.reproductions.list(projectId)});return true;}
    if(parts.length===1&&method==="POST"){experimentError("REPRODUCTION_ZIP_REQUIRED",400);}
    if(parts[1]==="import"&&method==="POST"){if(Number(request.headers["content-length"]??0)>200*1024*1024)experimentError("REQUEST_TOO_LARGE",413);send(response,201,{code:await service.reproductions.importZip(projectId,request,z.string().min(1).max(200).parse(url.searchParams.get("name")),z.string().max(255).optional().parse(url.searchParams.get("filename")??undefined))});return true;}
    if(parts[1]){
      service.reproductions.get(projectId,parts[1]);
      if(parts.length===2&&method==="PUT"){send(response,200,{code:service.reproductions.update(projectId,parts[1],await readJson(request))});return true;}
      if(parts.length===2&&method==="DELETE"){if(service.data.runs(projectId).some(r=>r.plan.reproduction?.reproduction_id===parts[1]&&service.data.active(r)))experimentError("EXPERIMENT_ACTIVE",409);service.reproductions.remove(projectId,parts[1]);send(response,200,{deleted:true});return true;}
      if(parts[2]==="tree"&&method==="GET"){send(response,200,{entries:await service.reproductions.tree(projectId,parts[1],url.searchParams.get("path")??"")});return true;}
      if(parts[2]==="file"&&method==="GET"){send(response,200,await service.reproductions.file(projectId,parts[1],url.searchParams.get("path")??""));return true;}
      if(parts[2]==="snapshots"&&method==="POST"){send(response,201,{snapshot:await service.reproductions.snapshot(projectId,parts[1])});return true;}
      if(parts[2]==="upload-progress"&&method==="GET"){const requestId=z.string().uuid().parse(url.searchParams.get("request_id"));response.setHeader("cache-control","no-store");send(response,200,{progress:service.reproductions.progress(projectId,parts[1],requestId)});return true;}
      if(parts[2]==="upload"&&method==="POST"){
        const input=z.object({profile_id:z.string(),directory:z.string().min(1).max(2000),layout:z.enum(["workspace","legacy"]).default("legacy"),python:z.string().max(2000).optional(),request_id:z.string().uuid().optional(),confirm:z.literal(true)}).strict().parse(await readJson(request));
        if(!input.directory.startsWith("/")||input.directory.split("/").includes("..")||/[\x00-\x1f]/.test(input.directory))experimentError("UPLOAD_PATH_INVALID");
        const profile=service.data.profile(projectId,input.profile_id);
        const remote=service.terminals.connection(projectId,profile.profile_id);
        const requestId=input.request_id??randomUUID();
        const operation=service.reproductions.beginUpload(projectId,parts[1],requestId);
        const report=(stage:string,sent=0,total=0)=>{if(operation.signal.aborted)experimentError("UPLOAD_CANCELLED",409);service.reproductions.report(projectId,parts[1],requestId,stage,sent,total);};
        report("snapshot");
        try{
          const snapshot=await service.reproductions.snapshot(projectId,parts[1]);
          service.terminals.connection(projectId,profile.profile_id);
          const workspace=service.workspaces.get(projectId,profile.profile_id);
          if(input.layout==='workspace'&&!workspace)experimentError('WORKSPACE_REQUIRED',409);
          const parent=input.layout==='workspace'?posix.join(workspace!.root,'reproductions'):input.directory;
          if(input.layout==='workspace')await ensureRemoteDirectory(remote,parent);
          const deployed=await service.reproductions.deploy(remote,projectId,snapshot,parent,report,operation.signal,input.layout==='workspace'?directoryLabel(service.reproductions.get(projectId,parts[1]).name):undefined);
          let record_saved=true;try{service.reproductions.recordUpload(projectId,parts[1],profile.profile_id,deployed);}catch{record_saved=false;}
          send(response,201,{...deployed,record_saved});
        }catch(error){
          if(error instanceof Error&&error.message==="UPLOAD_CANCEL_CLEANUP_FAILED"&&"residual_path" in error){
            service.reproductions.report(projectId,parts[1],requestId,"cleanup_failed");
            send(response,409,{error:"UPLOAD_CANCEL_CLEANUP_FAILED",path:error.residual_path});return true;
          }
          service.reproductions.report(projectId,parts[1],requestId,operation.signal.aborted?"cancelled":"failed");if(operation.signal.aborted)experimentError("UPLOAD_CANCELLED",409);throw error;
        }finally{operation.finish();}return true;
      }
    }
    }finally{release();}
  }
  if(parts[0]==="repository"){
    if(parts.length===3&&parts[1]==="directories"&&parts[2]==="select"&&method==="POST"){send(response,200,await selectDirectory(await readJson(request)));return true;}
    if(parts.length===2&&parts[1]==="directories"&&method==="GET"){send(response,200,await browseDirectories(url.searchParams.get("path")??undefined));return true;}
    if(parts.length===2&&parts[1]==="directories"&&method==="POST"){send(response,201,await createDirectory(await readJson(request)));return true;}
    if(parts.length===1&&method==="GET"){send(response,200,{repository:service.data.repository(projectId)??null});return true;}
    if(parts.length===1&&method==="PUT"){send(response,200,{repository:await service.repository.bind(projectId,await readJson(request))});return true;}
    if(parts[1]==="status"&&method==="GET"){send(response,200,await service.repository.status(projectId));return true;}
    if(parts[1]==="tree"&&method==="GET"){send(response,200,{entries:await service.repository.tree(projectId,url.searchParams.get("path")??"")});return true;}
    if(parts[1]==="file"&&method==="GET"){send(response,200,await service.repository.file(projectId,url.searchParams.get("path")??""));return true;}
    if(parts[1]==="history"&&method==="GET"){send(response,200,{commits:await service.repository.history(projectId,z.coerce.number().int().min(1).parse(url.searchParams.get("page")??1))});return true;}
    if(parts[1]==="commit"&&method==="POST"){const input=z.object({message:z.string().trim().min(1).max(2000)}).strict().parse(await readJson(request));send(response,200,await service.repository.commit(projectId,input.message));return true;}
    if(parts[1]==="editor"&&method==="POST"){await service.repository.editor(projectId);send(response,200,{started:true});return true;}
  }
  if(parts[0]==="ssh-profiles"){
    if(parts.length===2&&parts[1]==="from-command"&&method==="POST"){
      const input=sshLoginInputSchema.parse(await readJson(request));
      const fields=parseSshLogin(input.command);
      const existing=service.data.profiles(projectId).find(profile=>profile.host===fields.host&&profile.port===fields.port&&profile.username===fields.username&&profile.auth==="password");
      const renamed=Boolean(existing&&input.name&&input.name!==existing.name);
      if(renamed&&existing&&service.terminals.hasProfile(existing.profile_id))experimentError("TERMINAL_PROFILE_BUSY",409);
      if(renamed&&service.data.runs().some(run=>run.profile_id===existing!.profile_id&&service.data.active(run)))experimentError("EXPERIMENT_ACTIVE",409);
      const profile=existing?{...existing,...(input.name?{name:input.name}:{})}:{...fields,...(input.name?{name:input.name}:{}),profile_id:`ssh_${randomUUID()}`,project_id:projectId,created_at:new Date().toISOString()};
      if(!existing||renamed)service.data.saveProfile(profile);
      service.ssh.setCredential(profile.profile_id,{password:input.password});
      send(response,existing?200:201,{profile,credential_available:true});return true;
    }
    if(parts.length===1&&method==="GET"){send(response,200,{profiles:service.data.profiles(projectId).map(p=>({...p,credential_available:service.ssh.hasCredential(p)}))});return true;}
    if(parts.length===1&&method==="POST"){const value=sshProfileInputSchema.parse(await readJson(request));const profile={...value,profile_id:`ssh_${randomUUID()}`,project_id:projectId,created_at:new Date().toISOString()};service.data.saveProfile(profile);send(response,201,{profile});return true;}
    if(parts[1]){
      const profile=service.data.profile(projectId,parts[1]);
      if(parts.length===3&&parts[2]==="directories"&&method==="POST"){
        const input=z.object({parent:z.string().min(1).max(4096),name:z.string().min(1).max(255)}).strict().parse(await readJson(request));
        send(response,201,await service.terminals.createDirectory(projectId,profile.profile_id,input.parent,input.name));return true;
      }
      if(parts.length===3&&parts[2]==="directories"&&method==="GET"){
        const path=z.string().min(1).max(4096).parse(url.searchParams.get("path")??"/");
        send(response,200,await service.terminals.directories(projectId,profile.profile_id,path));return true;
      }
      if(parts.length===3&&parts[2]==="connect"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,201,{terminal:await service.terminals.connect(projectId,profile)});return true;}
      if(parts.length===3&&parts[2]==="credentials"&&method==="GET"){send(response,200,{password:service.ssh.passwordForEditing(profile)});return true;}
      if(parts.length===2&&method==="PUT"){
        const input=sshLoginInputSchema.extend({password:z.string().max(10000).default("")}).parse(await readJson(request));
        const fields=parseSshLogin(input.command);
        const connectionChanged=profile.host!==fields.host||profile.port!==fields.port||profile.username!==fields.username;
        const auth=input.password?"password" as const:profile.auth;
        const changed=connectionChanged||auth!==profile.auth||Boolean(input.name&&input.name!==profile.name);
        if(changed&&service.terminals.hasProfile(profile.profile_id))experimentError("TERMINAL_PROFILE_BUSY",409);
        if(changed&&service.data.runs().some(run=>run.profile_id===profile.profile_id&&service.data.active(run)))experimentError("EXPERIMENT_ACTIVE",409);
        if(connectionChanged&&auth==="password"&&!input.password)experimentError("SSH_NEW_CONNECTION_PASSWORD_REQUIRED");
        if(service.data.profiles(projectId).some(other=>other.profile_id!==profile.profile_id&&other.host===fields.host&&other.port===fields.port&&other.username===fields.username&&other.auth===auth))experimentError("SSH_PROFILE_DUPLICATE",409);
        const updated={...profile,name:input.name||profile.name,host:fields.host,port:fields.port,username:fields.username,auth};
        if(profile.host!==fields.host||profile.port!==fields.port)delete updated.fingerprint;
        if(auth==="password")delete updated.key_path;
        if(changed)service.data.saveProfile(updated);
        if(connectionChanged||auth!==profile.auth)service.ssh.forget(profile.profile_id);
        if(input.password)service.ssh.setCredential(profile.profile_id,{password:input.password});
        send(response,200,{profile:updated,credential_available:service.ssh.hasCredential(updated)});return true;
      }
      if(parts.length===2&&method==="DELETE"){if(service.terminals.hasProfile(profile.profile_id))experimentError("TERMINAL_PROFILE_BUSY",409);if(service.reproductions.busy(projectId))experimentError("REPRODUCTION_BUSY",409);if(service.datasetUploads.busy(projectId))experimentError("DATASET_BUSY",409);service.data.deleteProfile(projectId,profile.profile_id);service.ssh.forget(profile.profile_id);send(response,200,{deleted:true});return true;}
      if(parts[2]==="credentials"&&method==="PUT"){service.ssh.setCredential(profile.profile_id,sessionCredentialSchema.parse(await readJson(request)));send(response,200,{credential_available:service.ssh.hasCredential(profile)});return true;}
      if(parts[2]==="credentials"&&method==="DELETE"){service.ssh.forget(profile.profile_id);send(response,200,{forgotten:true});return true;}
      if(parts[2]==="fingerprint"&&method==="POST"){send(response,200,{fingerprint:await service.ssh.probe(profile),trusted:profile.fingerprint??null});return true;}
      if(parts[2]==="trust"&&method==="POST"){if(service.terminals.hasProfile(profile.profile_id))experimentError("TERMINAL_PROFILE_BUSY",409);const input=z.object({fingerprint:z.string().min(1),confirm:z.literal(true)}).strict().parse(await readJson(request));service.ssh.confirm(profile,input.fingerprint);send(response,200,{trusted:true});return true;}
      if(parts[2]==="diagnostics"&&method==="POST"){send(response,200,{environment:await service.diagnostics(projectId,profile.profile_id)});return true;}
    }
  }
  if(parts[0]==='dataset-upload-sessions'){
    if(parts.length===1&&method==='POST'){send(response,201,{session:service.datasetUploadSessions.create(projectId,await readJson(request))});return true;}
    if(parts.length===2&&method==='GET'){send(response,200,{session:await service.datasetUploadSessions.state(projectId,parts[1])});return true;}
    if(parts.length===3&&parts[2]==='chunk'&&method==='PUT'){send(response,200,{session:await service.datasetUploadSessions.chunk(projectId,parts[1],z.coerce.number().int().nonnegative().parse(url.searchParams.get('offset')),request)});return true;}
    if(parts.length===3&&method==='POST'){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));if(parts[2]==='finish'){send(response,202,{session:service.datasetUploadSessions.finish(projectId,parts[1])});return true;}if(parts[2]==='cancel'){send(response,200,{session:await service.datasetUploadSessions.cancel(projectId,parts[1])});return true;}}
  }
  if(parts[0]==="datasets"){
    if(parts.length===2&&parts[1]==="upload"&&method==="POST"){
      const profile=z.string().min(1).parse(url.searchParams.get("profile_id")),name=z.string().trim().min(1).max(200).parse(url.searchParams.get("name")),filename=z.string().min(1).max(255).parse(url.searchParams.get("filename")),requestId=z.string().uuid().parse(url.searchParams.get("request_id"));
      service.data.profile(projectId,profile);const workspace=service.workspaces.get(projectId,profile)??experimentError("WORKSPACE_REQUIRED",409);
      send(response,201,{dataset:await service.datasetUploads.upload(projectId,profile,workspace.root,service.terminals.connection(projectId,profile),request,name,filename,url.searchParams.get("extract")==="true",requestId)});return true;
    }
    if(parts.length===3&&parts[1]==='cancel-upload-request'&&method==='POST'){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,202,service.datasetUploads.cancelRequest(projectId,z.string().uuid().parse(parts[2])));return true;}
    if(parts.length===3&&parts[2]==="cancel-upload"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,202,service.datasetUploads.cancel(projectId,parts[1]));return true;}
    if(parts.length===3&&parts[2]==='delete-files'&&method==='POST'){const input=z.object({confirm:z.literal(true),path:z.string().min(1)}).strict().parse(await readJson(request));send(response,200,await deleteDatasetFiles(service,projectId,parts[1],input.path));return true;}
    if(parts.length===2&&["PUT","DELETE"].includes(method)){
      const dataset=service.data.datasets(projectId).find(item=>item.dataset_id===parts[1])??experimentError("DATASET_NOT_FOUND",404);
      if(dataset.transfer_status==="uploading"||dataset.verification_progress?.status==="running")experimentError("DATASET_BUSY",409);
      if(service.data.runs(projectId).some(run=>service.data.active(run)&&run.plan.datasets.some(item=>item.dataset_id===dataset.dataset_id)))experimentError("EXPERIMENT_ACTIVE",409);
      if(method==="DELETE"){service.store.db.prepare("DELETE FROM experiment_datasets WHERE project_id=? AND dataset_id=?").run(projectId,dataset.dataset_id);send(response,200,{deleted:true});}
      else{const value=datasetInputSchema.parse(await readJson(request));service.data.profile(projectId,value.profile_id);const updated={...value,dataset_id:dataset.dataset_id,project_id:projectId,verification_status:"unverified" as const};service.data.saveDataset(updated);send(response,200,{dataset:updated});}return true;
    }

    if(parts.length===1&&method==="GET"){send(response,200,{datasets:service.data.datasets(projectId)});return true;}
    if(parts.length===1&&method==="POST"){const value=datasetInputSchema.parse(await readJson(request));service.data.profile(projectId,value.profile_id);const dataset={...value,dataset_id:`dataset_${randomUUID()}`,project_id:projectId,verification_status:"unverified" as const};service.data.saveDataset(dataset);send(response,201,{dataset});return true;}
    if(parts[2]==="check"&&method==="POST"){send(response,202,{dataset:await service.checkDataset(projectId,parts[1])});return true;}
  }
  if(parts[0]==="experiment-plans"){
    if(parts.length===1&&method==="GET"){send(response,200,{plans:service.data.plans(projectId)});return true;}
    if(parts.length===1&&method==="POST"){const input=z.object({plan_id:z.string().optional(),base_version:z.number().int().nonnegative().default(0),content:z.record(z.unknown())}).strict().parse(await readJson(request));send(response,201,{plan:service.createPlan(projectId,input.content,input.plan_id,input.base_version)});return true;}
    if(parts[1]&&method==="POST"){
      const input=z.object({version:z.number().int().positive(),confirm:z.literal(true).optional()}).strict().parse(await readJson(request));const plan=service.data.plan(projectId,parts[1],input.version);
      if(parts[2]==="preflight"){send(response,200,{environment:await service.preflight(plan)});return true;}
      if(parts[2]==="confirm"){if(!input.confirm)experimentError("CONFIRM_REQUIRED");send(response,200,{plan:await service.confirmPlan(projectId,parts[1],input.version)});return true;}
      if(parts[2]==="preparation"){if(!plan.content.preparation_script)experimentError("PREPARATION_SCRIPT_REQUIRED");send(response,200,{script:await (plan.reproduction?service.reproductions.preparation(projectId,plan.reproduction,plan.content.preparation_script):service.repository.preparation(projectId,plan.content.commit_sha,plan.content.preparation_script)),commit:plan.content.commit_sha});return true;}
    }
  }
  if(parts[0]==="experiment-runs"){
    if(parts.length===1&&method==="GET"){send(response,200,{runs:service.data.runs(projectId).map(publicRun)});return true;}
    if(parts.length===1&&method==="POST"){send(response,201,{run:publicRun(service.submit(projectId,runSubmitSchema.parse(await readJson(request))))});return true;}
    if(parts[1]){
      const run=service.data.run(projectId,parts[1]);
      if(parts.length===2&&method==="GET"){send(response,200,{run:publicRun(run),events:service.data.events(projectId,run.run_id)});return true;}
      if(parts[2]==="logs"&&method==="GET"){send(response,200,await service.logs(projectId,run.run_id,url.searchParams.get("stream")??"stdout",z.coerce.number().int().min(0).parse(url.searchParams.get("offset")??0)));return true;}
      if(parts[2]==="cancel"&&method==="POST"){send(response,200,{run:publicRun(await service.cancel(projectId,run.run_id))});return true;}
      if(parts[2]==="reconnect"&&method==="POST"){send(response,200,{run:publicRun(await service.reconnect(projectId,run.run_id))});return true;}
      if(parts[2]==="retry"&&method==="POST"){const input=z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));if(input.confirm)send(response,201,{run:publicRun(service.retry(projectId,run.run_id))});return true;}
      if(parts[2]==="collect"&&method==="POST"){send(response,200,{run:publicRun(await service.collectAgain(projectId,run.run_id))});return true;}
    }
  }
  if(parts[0]==="experiment-artifacts"&&parts[1]&&parts[2]&&method==="GET"){
    const run=service.data.run(projectId,parts[1]);if(!run.artifacts.some(a=>a.artifact_id===parts[2]&&a.downloaded))experimentError("NOT_FOUND",404);
    const file=service.store.artifactFile(projectId,parts[2]);if(!file)experimentError("NOT_FOUND",404);
    response.writeHead(200,{"content-type":"application/octet-stream","content-disposition":`attachment; filename*=UTF-8''${encodeURIComponent(file.artifact.name)}`,"x-content-type-options":"nosniff","cache-control":"no-store"});const stream=createReadStream(file.path);stream.on("error",()=>response.destroy());stream.pipe(response);return true;
  }
  return false;
}
