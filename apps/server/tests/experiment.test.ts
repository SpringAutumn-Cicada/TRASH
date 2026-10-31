import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ExperimentStore, TrashStore } from "@trash/storage";
import { experimentPlanInputSchema, remotePathSchema, outputPathSchema, type SshProfile } from "@trash/protocol";
import { RepositoryService } from "../src/experiment/repository.js";
import { ExperimentService } from "../src/experiment/service.js";
import { publicRun } from "../src/experiment/routes.js";

test("experiment protocol rejects unsafe paths and credential environment variables",()=>{
  assert.equal(remotePathSchema.safeParse("/tmp/../etc").success,false);
  assert.equal(outputPathSchema.safeParse("../../secret").success,false);
  assert.equal(outputPathSchema.safeParse("outputs/metrics.json").success,true);
  const content={title:"Run",purpose:"Research",method:"A",evaluation_protocol:"fixed",commit_sha:"a".repeat(40),profile_id:"ssh_fixture",dataset_ids:[],python:"/usr/bin/python3",command:["python","run.py"],env:{API_KEY:"secret"},gpu:"cpu",expected_metrics:[{name:"f1",unit:"ratio"}]};
  assert.equal(experimentPlanInputSchema.safeParse(content).success,false);
  assert.equal(experimentPlanInputSchema.safeParse({...content,env:{}}).success,true);
});

test("repository binding enforces file boundaries, commits and dirty-tree checks",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trash-repo-test-"));const workspace=join(root,"workspace");const repo=join(root,"code");
  const store=new TrashStore(workspace);const experiments=new ExperimentStore(store.db);const service=new RepositoryService(experiments);
  const project=store.createProject({title:"Project",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
  try{
    execFileSync("git",["init",repo]);writeFileSync(join(repo,"run.py"),"print('hello')\n");
    execFileSync("git",["-C",repo,"add","run.py"]);execFileSync("git",["-C",repo,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
    await service.bind(project.project_id,{path:repo});const state=await service.status(project.project_id);assert.equal(state.clean,true);
    await assert.rejects(service.file(project.project_id,"../secret"),/REPOSITORY_PATH_INVALID/);
    await service.preflight(project.project_id,state.head);
    const bundle=await service.bundle(project.project_id,state.head);assert.ok(bundle.size>0);await bundle.cleanup();
    writeFileSync(join(repo,"untracked.txt"),"dirty");await assert.rejects(service.preflight(project.project_id,state.head),/GIT_TREE_DIRTY/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test("experiment submissions are idempotent, credentials stay out of storage, and active runs block deletion",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trash-experiment-test-"));const store=new TrashStore(root);const service=new ExperimentService(store);
  try{
    const project=store.createProject({title:"Project",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
    const repository={repository_id:"repo_fixture",project_id:project.project_id,path:"/not/executed",bound_at:new Date().toISOString()};service.data.saveRepository(repository);
    const profile:SshProfile={profile_id:"ssh_fixture",project_id:project.project_id,name:"Fixture",host:"example.invalid",port:22,username:"root",remote_root:"/tmp/trash",auth:"password",created_at:new Date().toISOString()};service.data.saveProfile(profile);
    const content={title:"Run",purpose:"Research",method:"A",evaluation_protocol:"fixed",commit_sha:"a".repeat(40),profile_id:profile.profile_id,dataset_ids:[],python:"/usr/bin/python3",command:["python","run.py"],gpu:"cpu",expected_metrics:[{name:"f1",unit:"ratio"}]};
    const plan=service.createPlan(project.project_id,content);service.data.savePlan({...plan,status:"confirmed"});
    const input={plan_id:plan.plan_id,version:plan.version,idempotency_key:randomUUID(),preparation:false};
    // No password is provided, so queue polling must not attempt any network connection.
    const run=service.submit(project.project_id,input);assert.equal(service.submit(project.project_id,input).run_id,run.run_id);
    assert.throws(()=>store.deleteProject(project.project_id),/EXPERIMENT_ACTIVE/);
    assert.throws(()=>service.data.deleteProfile(project.project_id,profile.profile_id),/EXPERIMENT_ACTIVE/);
    assert.equal("token" in (publicRun(run) as object),false);
    service.ssh.setCredential(profile.profile_id,{password:"fixture-password"});
    const raw=store.db.prepare("SELECT data FROM experiment_profiles WHERE profile_id=?").get(profile.profile_id) as {data:string};assert.equal(raw.data.includes("fixture-password"),false);service.ssh.forget(profile.profile_id);
    await service.cancel(project.project_id,run.run_id);assert.equal(service.data.run(project.project_id,run.run_id).status,"cancelled");
    assert.deepEqual(store.deleteProject(project.project_id),{deleted:true,cleanup_pending:false});
  }finally{service.close();store.close();rmSync(root,{recursive:true,force:true});}
});
