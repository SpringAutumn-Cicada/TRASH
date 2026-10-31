import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrashStore, KnowledgeStore } from "../src/index.js";
import { sourceSchema } from "@trash/protocol";

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"trash-knowledge-"));const store=new TrashStore(root);const knowledge=new KnowledgeStore(store.db);
  const project=store.createProject({title:"APT",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
  const source=sourceSchema.parse({protocol_version:"v1",source_id:"source_fixture",project_id:project.project_id,title:"Paper",authors:[],source_type:"markdown",parse_status:"indexed",imported_at:new Date().toISOString()});
  store.createSources([source],new Map([[source.source_id,[{locator:{kind:"paragraph",paragraph_index:1},text:"A reproducible method."}]]]));
  return {root,store,knowledge,project,source,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test("card versions preserve accepted content and reject stale writes",()=>{
  const f=fixture();try{
    const first=f.knowledge.write(f.project.project_id,"literature-card",{base_version:0,content:{source_id:f.source.source_id,title:"Paper",method:"old"}});
    f.knowledge.review(f.project.project_id,"literature-card",first.object_id,1,"accepted","");
    const next=f.knowledge.write(f.project.project_id,"literature-card",{object_id:first.object_id,base_version:1,content:{...first.content,method:"new"}},"agent");
    assert.equal(next.status,"pending");assert.equal(f.knowledge.get(f.project.project_id,"literature-card",first.object_id,1)?.status,"accepted");
    assert.throws(()=>f.knowledge.write(f.project.project_id,"literature-card",{object_id:first.object_id,base_version:1,content:first.content}),/VERSION_CONFLICT/);
  }finally{f.close();}
});
test("project isolation and evidence location checks reject invalid references",()=>{
  const f=fixture();try{
    const other=f.store.createProject({title:"Other",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
    assert.throws(()=>f.knowledge.write(other.project_id,"literature-card",{base_version:0,content:{source_id:f.source.source_id,title:"Leak"}}),/SOURCE_NOT_FOUND/);
    assert.throws(()=>f.knowledge.write(f.project.project_id,"literature-card",{base_version:0,content:{source_id:f.source.source_id,title:"Bad",evidence:[{source_id:f.source.source_id,paragraph:99,attribution:"agent"}]}}),/EVIDENCE_LOCATION_INVALID/);
  }finally{f.close();}
});
test("wiki records fixed dependencies and detects later revisions",()=>{
  const f=fixture();try{
    const card=f.knowledge.write(f.project.project_id,"literature-card",{base_version:0,content:{source_id:f.source.source_id,title:"Paper"}});
    const wiki=f.knowledge.write(f.project.project_id,"wiki-page",{base_version:0,content:{title:"Methods",body:"Notes",dependencies:[{kind:card.kind,object_id:card.object_id,version:1}]}});
    assert.equal(f.knowledge.stale(wiki),false);
    f.knowledge.write(f.project.project_id,"literature-card",{object_id:card.object_id,base_version:1,content:{...card.content,method:"Revised"}});
    assert.equal(f.knowledge.stale(wiki),true);assert.equal(f.knowledge.get(f.project.project_id,"wiki-page",wiki.object_id)?.version,1);
  }finally{f.close();}
});
test("invalid metric values and duplicate external runs do not create partial versions",()=>{
  const f=fixture();try{
    const content={schema_version:1,title:"Run",method:"A",dataset:"D",external_run_id:"run-1",metrics:[{name:"f1",value:0.9,unit:"ratio",condition:"test"}]};
    f.knowledge.write(f.project.project_id,"experiment-result",{base_version:0,content});
    assert.throws(()=>f.knowledge.write(f.project.project_id,"experiment-result",{base_version:0,content}),/DUPLICATE_RECORD/);
    assert.throws(()=>f.knowledge.write(f.project.project_id,"experiment-result",{base_version:0,content:{...content,external_run_id:"run-2",metrics:[{name:"f1",value:null,unit:"ratio",condition:"test"}]}}));
    assert.equal(f.knowledge.list(f.project.project_id,"experiment-result").length,1);
  }finally{f.close();}
});
test("v1 migration backs up existing database and preserves sources",()=>{
  const f=fixture();try{
    const tables=["experiment_events","experiment_runs","experiment_plans","experiment_datasets","experiment_profiles","experiment_environments","experiment_repositories","managed_files","source_details","source_attachments","knowledge_versions","knowledge_keys","knowledge_metrics","knowledge_reviews","knowledge_task_events","knowledge_tasks"];
    f.store.db.pragma("foreign_keys = OFF");for(const table of tables)f.store.db.exec(`DROP TABLE ${table}`);f.store.db.pragma("user_version = 1");f.store.close();
    const reopened=new TrashStore(f.root);assert.equal(reopened.getSource(f.source.source_id)?.title,"Paper");assert.equal(reopened.db.pragma("user_version",{simple:true}),3);assert.ok(readdirSync(f.root).some(n=>n.startsWith("workspace-before-v2-")));reopened.close();
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("project deletion removes dependent data and files without affecting other projects",()=>{
  const f=fixture();try{
    const other=f.store.createProject({title:"Keep",research_question:"Other",module:{id:"apt-provenance",version:"0.1.0"}});
    const artifact=f.store.saveArtifact(f.project.project_id,"notes.md","text/markdown",Buffer.from("Research"));
    const path=f.store.artifactFile(f.project.project_id,artifact.artifact_id)!.path;
    f.store.db.prepare("INSERT INTO source_attachments VALUES (?,?,?)").run(f.source.source_id,artifact.artifact_id,new Date().toISOString());
    f.store.db.prepare("INSERT INTO source_details VALUES (?,?)").run(f.source.source_id,"{}");
    const card=f.knowledge.write(f.project.project_id,"literature-card",{base_version:0,content:{source_id:f.source.source_id,title:"Card"}});
    f.knowledge.review(f.project.project_id,"literature-card",card.object_id,1,"accepted","");
    f.knowledge.write(f.project.project_id,"experiment-result",{base_version:0,content:{schema_version:1,title:"Run",method:"A",dataset:"D",external_run_id:"run",metrics:[{name:"f1",value:0.9,unit:"ratio",condition:"test"}]}});
    const input={kind:"literature-card" as const,source_ids:[f.source.source_id],dependencies:[],title:"Card",instructions:"",timeout_seconds:900,regenerate:false};
    f.knowledge.saveTask({task_id:"task_delete",project_id:f.project.project_id,input,snapshot:{},fingerprint:"fixture",status:"completed",created_at:new Date().toISOString()});
    f.knowledge.event("task_delete","done");
    assert.deepEqual(f.store.deleteProject(f.project.project_id),{deleted:true,cleanup_pending:false});
    assert.equal(f.store.getProject(f.project.project_id),undefined);
    assert.equal(f.store.getProject(other.project_id)?.title,"Keep");
    assert.equal(f.store.getSource(f.source.source_id),undefined);
    assert.equal(f.knowledge.tasks(f.project.project_id).length,0);
    assert.equal(f.knowledge.list(f.project.project_id,"literature-card").length,0);
    assert.equal(f.store.search(f.project.project_id,"reproducible").length,0);
    assert.equal(existsSync(path),false);
    for(const table of ["knowledge_task_events","knowledge_reviews","knowledge_metrics","knowledge_keys","source_details","source_attachments","managed_files"]){
      const row=f.store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {count:number};assert.equal(row.count,0);
    }
    assert.deepEqual(f.store.deleteProject(f.project.project_id),{deleted:false,cleanup_pending:false});
  }finally{f.close();}
});

test("project deletion blocks active tasks and restores files after database rollback",()=>{
  const f=fixture();try{
    const artifact=f.store.saveArtifact(f.project.project_id,"notes.md","text/markdown",Buffer.from("Keep me"));
    const path=f.store.artifactFile(f.project.project_id,artifact.artifact_id)!.path;
    const input={kind:"literature-card" as const,source_ids:[f.source.source_id],dependencies:[],title:"Card",instructions:"",timeout_seconds:900,regenerate:false};
    const task={task_id:"task_block",project_id:f.project.project_id,input,snapshot:{},fingerprint:"fixture",status:"queued",created_at:new Date().toISOString()};
    f.knowledge.saveTask(task);
    assert.throws(()=>f.store.deleteProject(f.project.project_id),/PROJECT_HAS_ACTIVE_TASKS/);
    assert.equal(existsSync(path),true);
    f.knowledge.saveTask({...task,status:"cancelled"});
    f.store.db.exec("CREATE TRIGGER prevent_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    assert.throws(()=>f.store.deleteProject(f.project.project_id),/fixture rollback/);
    assert.equal(existsSync(path),true);
    assert.ok(f.store.getProject(f.project.project_id));
    assert.ok(f.store.getSource(f.source.source_id));
    assert.equal(f.knowledge.tasks(f.project.project_id).length,1);
  }finally{f.close();}
});
