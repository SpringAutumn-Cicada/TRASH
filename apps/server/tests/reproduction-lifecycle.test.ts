import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, copyFile, writeFile } from "node:fs/promises";
import type { RemoteConnection } from "../src/experiment/ssh.js";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { TrashStore } from "@trash/storage";
import { ReproductionService } from "../src/experiment/reproduction.js";
import { EnvironmentAnalysisService } from "../src/experiment/environment-analysis.js";
import { browseDirectories, createDirectory, selectDirectory } from "../src/experiment/directories.js";
import { parseSshLogin } from "../src/experiment/ssh-login.js";

function fixture() {
 const root=mkdtempSync(join(tmpdir(),"trash-repro-lifecycle-"));
 const store=new TrashStore(join(root,"workspace"));
 const project=store.createProject({title:"Fixture",research_question:"Environment",module:{id:"apt-provenance",version:"0.1.0"}}).project_id;
 const reproductions=new ReproductionService(store);
 const zip=join(root,"paper.zip");
 execFileSync("python3",["-c","import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('README.md','Python 3.10\\n')\n z.writestr('train.py','print(1)\\n')",zip]);
 const input=()=>Readable.from([readFileSync(zip)]) as IncomingMessage;
 return {root,store,project,reproductions,input,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test("reproduction ZIPs preserve names, migrate readable directories, enforce boundaries and verify snapshots",async()=>{
 const f=fixture();
 try {
  const first=await f.reproductions.importZip(f.project,f.input(),"论文代码","original paper.zip");
  const second=await f.reproductions.importZip(f.project,f.input(),"论文代码","second.zip");
  assert.equal(first.archive_name,"original paper.zip");
  assert.ok(first.path.endsWith("repro_论文代码/code"));assert.notEqual(first.path,second.path);
  assert.equal((await f.reproductions.file(f.project,first.id,"train.py")).text,"print(1)\n");
  await assert.rejects(f.reproductions.file(f.project,first.id,"../source.zip"),/REPOSITORY_PATH_INVALID/);
  const legacy=join(dirname(dirname(first.path)),first.id);
  renameSync(dirname(first.path),legacy);
  const record=join(dirname(legacy),first.id+".json");
  writeFileSync(record,JSON.stringify({...first,path:join(legacy,"code")}));
  const migrated=f.reproductions.list(f.project).find(item=>item.id===first.id)!;
  assert.ok(migrated.path.endsWith("repro_论文代码/code"));assert.ok(existsSync(migrated.path));
  const renamed=f.reproductions.update(f.project,first.id,{name:"renamed",source_url:"",notes:""});
  assert.ok(renamed.path.endsWith("repro_renamed/code"));
  const snapshot=await f.reproductions.snapshot(f.project,first.id);
  assert.equal(snapshot.archive_name,"original paper.zip");
  const bundle=await f.reproductions.bundle(f.project,snapshot);
  writeFileSync(bundle.path,"damaged");
  await assert.rejects(f.reproductions.bundle(f.project,snapshot),/SNAPSHOT_HASH_MISMATCH/);
  writeFileSync(join(renamed.path,".env"),"TOKEN=fixture");
  const analysis=await f.reproductions.snapshot(f.project,first.id,true);
  assert.ok(analysis.analysis_excluded?.some(file=>file.path===".env"));
  const release=f.reproductions.acquire(f.project);assert.throws(()=>f.reproductions.acquire(f.project),/REPRODUCTION_BUSY/);release();
  f.reproductions.remove(f.project,second.id);assert.throws(()=>f.reproductions.get(f.project,second.id),/REPRODUCTION_NOT_FOUND/);
  assert.ok(existsSync(renamed.path));
 } finally {f.close();}
});

test("local directory selection initializes Git only when requested and SSH login remains data",async()=>{
 const root=mkdtempSync(join(tmpdir(),"trash-directory-"));
 try {
  const {path}=await createDirectory({parent:root,name:"paper"});
  assert.equal((await browseDirectories(root)).directories[0].path,path);
  assert.equal((await selectDirectory({path,initialize_git:false})).initialized,false);assert.equal(existsSync(join(path,".git")),false);
  assert.equal((await selectDirectory({path,initialize_git:true})).initialized,true);
  assert.equal((await selectDirectory({path,initialize_git:true})).initialized,false);
  assert.equal(execFileSync("git",["-C",path,"branch","--show-current"],{encoding:"utf8"}).trim(),"main");
  await assert.rejects(createDirectory({parent:root,name:"../escape"}));
  await assert.rejects(createDirectory({parent:root,name:"paper"}),/LOCAL_DIRECTORY_EXISTS/);
  const profile=parseSshLogin("ssh -p 14325 root@connect.example.com");assert.equal(profile.port,14325);assert.equal(profile.username,"root");
  assert.throws(()=>parseSshLogin("ssh root@example.com ; touch unwanted"),/SSH_LOGIN_COMMAND_INVALID/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

async function settle(service:EnvironmentAnalysisService,project:string,_code:string) {
 for(let i=0;i<300;i++){if(!service.busy(project))return;await delay(20);}
 throw new Error("Fixture task did not settle");
}

test("environment task records valid reports, stale code, invalid output, cancellation and restart interruption",async()=>{
 const f=fixture(),previous=process.env.TRASH_CODEX_COMMAND;
 const cli=join(f.root,"fixture-cli"),mode=join(f.root,"mode");
 const unknown={value:"未知",attribution:"unknown",evidence:[]};
 const content={schema_version:2,summary:"fixture",requirements:[],commands:[],resources:[],issues:[],limitations:["fixture only"],image_selection:{framework:unknown,framework_version:unknown,python:unknown,cuda:unknown},agent_deployment:{status:"blocked",venv_path:".venv",prerequisites:[],blockers:["fixture only"],steps:[{purpose:"确认解释器",command:'test -n "$TRASH_PYTHON"',attribution:"unknown",evidence:[]}]}};
 writeFileSync(mode,"valid");
 writeFileSync(cli,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('fixture 1');process.exit(0);}const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');if(mode==='wait'){setInterval(()=>{},1000);}else{fs.writeFileSync(args[args.indexOf('-o')+1],mode==='invalid'?'broken-json':JSON.stringify(${JSON.stringify(content)}));}\n`,{mode:0o700});
 process.env.TRASH_CODEX_COMMAND=cli;
 let service=new EnvironmentAnalysisService(f.store,f.reproductions);
 try {
  const code=await f.reproductions.importZip(f.project,f.input(),"environment","paper.zip");
  const task=service.start(f.project,code.id);
  assert.throws(()=>service.start(f.project,code.id),/ENVIRONMENT_ANALYSIS_BUSY/);
  await settle(service,f.project,code.id);
  assert.equal(service.tasks(f.project,code.id)[0].status,"completed");
  const report=service.report(f.project,code.id,task.id);assert.equal(report.verified,false);assert.equal(report.skill_name,"trash_analyze_code_environment");
  assert.equal((await service.freshness(f.project,code.id,report.id)).stale,false);
  writeFileSync(join(code.path,"train.py"),"print(2)\n");
  assert.equal((await service.freshness(f.project,code.id,report.id)).stale,true);
  writeFileSync(mode,"invalid");const failed=service.start(f.project,code.id);await settle(service,f.project,code.id);
  assert.equal(failed.status,"failed");assert.equal(failed.error,"ENVIRONMENT_INVALID_REPORT");assert.equal(service.reports(f.project,code.id).length,1);
  writeFileSync(mode,"wait");const cancelled=service.start(f.project,code.id);
  for(let i=0;i<200&&cancelled.status!=="analyzing";i++)await delay(20);
  assert.equal(cancelled.status,"analyzing");service.cancel(f.project,code.id,cancelled.id);await settle(service,f.project,code.id);assert.equal(cancelled.status,"cancelled");
  const interrupted=service.start(f.project,code.id);service.close();await settle(service,f.project,code.id);
  const taskPath=join(f.store.root,"projects",f.project,"environment-analysis",code.id,interrupted.id,"task.json");
  writeFileSync(taskPath,JSON.stringify({...interrupted,status:"analyzing"}));
  service=new EnvironmentAnalysisService(f.store,f.reproductions);
  assert.equal(service.tasks(f.project,code.id).find(item=>item.id===interrupted.id)?.status,"interrupted");
  assert.equal(f.reproductions.busy(f.project),false);
 } finally {service.close();await settle(service,f.project,"");if(previous===undefined)delete process.env.TRASH_CODEX_COMMAND;else process.env.TRASH_CODEX_COMMAND=previous;f.close();}
});


test("reproduction deploy preserves ZIP names, avoids remote Python and reports hash failures and progress",async()=>{
 const f=fixture();
 try {
  const code=await f.reproductions.importZip(f.project,f.input(),"paper","Original Paper.zip");
  const snapshot=await f.reproductions.snapshot(f.project,code.id);
  const remoteRoot=join(f.root,"remote");await mkdir(remoteRoot);
  const commands:string[][]=[],stages:string[]=[];let damaged=false;
  const remote={
   sftp:async()=>({lstat:(path:string,callback:(error:unknown)=>void)=>{void lstat(path).then(()=>callback(null),error=>callback({code:error.code==="ENOENT"?2:4}));},mkdir:(path:string,options:{mode:number},callback:(error?:unknown)=>void)=>{void mkdir(path,options).then(()=>callback(),callback);},end:()=>{}}),
   upload:async(source:string,target:string,progress:(sent:number,total:number)=>void)=>{const bytes=readFileSync(source).length;progress(0,bytes);await copyFile(source,target);progress(bytes,bytes);},
   exec:async(args:string[])=>{commands.push(args);if(damaged&&args[0]==="sha256sum")return "0".repeat(64)+"  fixture";return execFileSync(args[0],args.slice(1),{encoding:"utf8"});},
   write:async(path:string,text:string)=>{await writeFile(path,text);}
  } as unknown as RemoteConnection;
  const deployed=await f.reproductions.deploy(remote,f.project,snapshot,remoteRoot,(stage)=>stages.push(stage));
  assert.ok(existsSync(join(dirname(deployed.path),"Original Paper.zip")));
  assert.equal(readFileSync(join(deployed.path,"train.py"),"utf8"),"print(1)\n");
  assert.deepEqual([...new Set(stages)],["preparing","uploading","verifying","extracting","saving","completed"]);
  assert.ok(!commands.some(args=>args[0].includes("python")));
  const again=await f.reproductions.deploy(remote,f.project,snapshot,remoteRoot);assert.notEqual(again.path,deployed.path);
  damaged=true;await assert.rejects(f.reproductions.deploy(remote,f.project,snapshot,remoteRoot),/REPRODUCTION_REMOTE_HASH_FAILED/);
 } finally {f.close();}
});
