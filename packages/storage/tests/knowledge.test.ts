import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
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
    const tables=["managed_files","source_details","source_attachments","knowledge_versions","knowledge_keys","knowledge_metrics","knowledge_reviews","knowledge_task_events","knowledge_tasks"];
    f.store.db.pragma("foreign_keys = OFF");for(const table of tables)f.store.db.exec(`DROP TABLE ${table}`);f.store.db.pragma("user_version = 1");f.store.close();
    const reopened=new TrashStore(f.root);assert.equal(reopened.getSource(f.source.source_id)?.title,"Paper");assert.equal(reopened.db.pragma("user_version",{simple:true}),2);assert.ok(readdirSync(f.root).some(n=>n.startsWith("workspace-before-v2-")));reopened.close();
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
