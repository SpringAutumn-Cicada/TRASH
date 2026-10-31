import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSchema } from "@trash/protocol";
import { KnowledgeStore, TrashStore } from "@trash/storage";
import { projectOverview } from "../src/overview.js";

test("overview counts objects rather than versions and isolates projects",()=>{
  const root=mkdtempSync(join(tmpdir(),"trash-overview-"));const store=new TrashStore(root);const knowledge=new KnowledgeStore(store.db);
  try {
    const project=store.createProject({title:"Project",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
    const other=store.createProject({title:"Other",research_question:"Other",module:{id:"apt-provenance",version:"0.1.0"}});
    const source=sourceSchema.parse({protocol_version:"v1",source_id:"source_overview",project_id:project.project_id,title:"Paper",authors:[],source_type:"markdown",parse_status:"indexed",imported_at:new Date().toISOString()});
    store.createSources([source],new Map());
    const card=knowledge.write(project.project_id,"literature-card",{base_version:0,content:{source_id:source.source_id,title:"Card"}});
    knowledge.review(project.project_id,card.kind,card.object_id,1,"accepted","");
    const wiki=knowledge.write(project.project_id,"wiki-page",{base_version:0,content:{title:"Wiki",body:"Notes",dependencies:[{kind:card.kind,object_id:card.object_id,version:1}]}});
    knowledge.write(project.project_id,card.kind,{object_id:card.object_id,base_version:1,content:card.content},"agent");
    knowledge.write(project.project_id,"experiment-result",{base_version:0,content:{schema_version:1,title:"Run",method:"A",dataset:"D",metrics:[]}});
    const summary=projectOverview(store,project.project_id);
    assert.deepEqual(summary.counts,{sources:1,accepted_cards:1,wiki_pages:1,experiment_results:1});
    assert.equal(summary.pending.cards,1);assert.equal(summary.pending.stale_wiki_pages,1);assert.equal(summary.pending.unorganized_sources,0);
    assert.ok(summary.activities.some(item=>item.object_id===wiki.object_id&&item.page==="wiki"));
    assert.equal(projectOverview(store,other.project_id).activities.length,0);
    assert.ok(summary.activities.length<=10);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
