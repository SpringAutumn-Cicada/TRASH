import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { datasetInputSchema, runSubmitSchema, sshProfileInputSchema, sessionCredentialSchema, type ExperimentRun } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { ExperimentService } from "./service.js";
import { browseDirectories, createDirectory, selectDirectory } from "./directories.js";
import { parseSshLogin, sshLoginInputSchema } from "./ssh-login.js";
export function publicRun(run:ExperimentRun):unknown {const {token:_token,...safe}=run;return safe;}
export async function experimentRoute(request:IncomingMessage,response:ServerResponse,url:URL,projectId:string,subpath:string,service:ExperimentService,readJson:(r:IncomingMessage)=>Promise<unknown>,send:(r:ServerResponse,status:number,value:unknown)=>void):Promise<boolean>{
  const method=request.method??"GET",parts=subpath.split("/");
  if(parts[0]==="terminals"&&parts[1]){
    const token=typeof request.headers["x-terminal-token"]==="string"?request.headers["x-terminal-token"]:"";
    if(parts.length===3&&parts[2]==="split"&&method==="POST"){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));send(response,201,{terminal:await service.terminals.split(projectId,parts[1],token)});return true;}
    if(parts.length===2&&method==="DELETE"){service.terminals.remove(projectId,parts[1],token);send(response,200,{closed:true});return true;}
    if(parts.length===3&&parts[2]==="events"&&method==="GET"){service.terminals.attach(projectId,parts[1],token,response,z.coerce.number().int().nonnegative().parse(url.searchParams.get("after")??0));return true;}
    if(parts.length===3&&parts[2]==="input"&&method==="POST"){const input=z.object({text:z.string().min(1).max(32768)}).strict().parse(await readJson(request));service.terminals.input(projectId,parts[1],token,input.text);send(response,200,{accepted:true});return true;}
    if(parts.length===3&&parts[2]==="resize"&&method==="POST"){const input=z.object({cols:z.number().int().min(2).max(500),rows:z.number().int().min(1).max(200)}).strict().parse(await readJson(request));service.terminals.resize(projectId,parts[1],token,input.cols,input.rows);send(response,200,{accepted:true});return true;}
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
      if(parts.length===2&&method==="DELETE"){if(service.terminals.hasProject(projectId))experimentError("TERMINAL_PROFILE_BUSY",409);service.data.deleteProfile(projectId,profile.profile_id);service.ssh.forget(profile.profile_id);send(response,200,{deleted:true});return true;}
      if(parts[2]==="credentials"&&method==="PUT"){service.ssh.setCredential(profile.profile_id,sessionCredentialSchema.parse(await readJson(request)));send(response,200,{credential_available:service.ssh.hasCredential(profile)});return true;}
      if(parts[2]==="credentials"&&method==="DELETE"){service.ssh.forget(profile.profile_id);send(response,200,{forgotten:true});return true;}
      if(parts[2]==="fingerprint"&&method==="POST"){send(response,200,{fingerprint:await service.ssh.probe(profile),trusted:profile.fingerprint??null});return true;}
      if(parts[2]==="trust"&&method==="POST"){if(service.terminals.hasProfile(profile.profile_id))experimentError("TERMINAL_PROFILE_BUSY",409);const input=z.object({fingerprint:z.string().min(1),confirm:z.literal(true)}).strict().parse(await readJson(request));service.ssh.confirm(profile,input.fingerprint);send(response,200,{trusted:true});return true;}
      if(parts[2]==="diagnostics"&&method==="POST"){send(response,200,{environment:await service.diagnostics(projectId,profile.profile_id)});return true;}
    }
  }
  if(parts[0]==="datasets"){
    if(parts.length===1&&method==="GET"){send(response,200,{datasets:service.data.datasets(projectId)});return true;}
    if(parts.length===1&&method==="POST"){const value=datasetInputSchema.parse(await readJson(request));service.data.profile(projectId,value.profile_id);const dataset={...value,dataset_id:`dataset_${randomUUID()}`,project_id:projectId,verification_status:"unverified" as const};service.data.saveDataset(dataset);send(response,201,{dataset});return true;}
    if(parts[2]==="check"&&method==="POST"){send(response,200,{dataset:await service.checkDataset(projectId,parts[1])});return true;}
  }
  if(parts[0]==="experiment-plans"){
    if(parts.length===1&&method==="GET"){send(response,200,{plans:service.data.plans(projectId)});return true;}
    if(parts.length===1&&method==="POST"){const input=z.object({plan_id:z.string().optional(),base_version:z.number().int().nonnegative().default(0),content:z.record(z.unknown())}).strict().parse(await readJson(request));send(response,201,{plan:service.createPlan(projectId,input.content,input.plan_id,input.base_version)});return true;}
    if(parts[1]&&method==="POST"){
      const input=z.object({version:z.number().int().positive(),confirm:z.literal(true).optional()}).strict().parse(await readJson(request));const plan=service.data.plan(projectId,parts[1],input.version);
      if(parts[2]==="preflight"){send(response,200,{environment:await service.preflight(plan)});return true;}
      if(parts[2]==="confirm"){if(!input.confirm)experimentError("CONFIRM_REQUIRED");send(response,200,{plan:await service.confirmPlan(projectId,parts[1],input.version)});return true;}
      if(parts[2]==="preparation"){if(!plan.content.preparation_script)experimentError("PREPARATION_SCRIPT_REQUIRED");send(response,200,{script:await service.repository.preparation(projectId,plan.content.commit_sha,plan.content.preparation_script),commit:plan.content.commit_sha});return true;}
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
