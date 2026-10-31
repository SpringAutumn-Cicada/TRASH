import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, TrashStore } from "@trash/storage";
import { restoreKnowledge } from "../src/knowledge-restore.js";
import { createWorkbenchServer } from "../src/index.js";

test("knowledge API exports and restores versions, files, reviews and source references",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trash-api-")),restoreRoot=mkdtempSync(join(tmpdir(),"trash-restore-"));
  const app=createWorkbenchServer({store:new TrashStore(root)});const restored=new TrashStore(restoreRoot);
  await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));const address=app.server.address();if(!address||typeof address==="string")throw new Error("address");
  const base=`http://127.0.0.1:${address.port}/api/v1`;
  try{
    const project=app.store.createProject({title:"APT",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
    const uploaded=await fetch(`${base}/projects/${project.project_id}/sources/files?filename=notes.md`,{method:"POST",body:"# Source\n\nResearch evidence."});
    assert.equal(uploaded.status,201);const data=await uploaded.json() as {sources:{source_id:string}[]};
    const knowledge=new KnowledgeStore(app.store.db);
    const card=knowledge.write(project.project_id,"literature-card",{base_version:0,content:{source_id:data.sources[0].source_id,title:"Card"}});
    knowledge.review(project.project_id,"literature-card",card.object_id,1,"accepted","Reviewed");
    knowledge.write(project.project_id,"wiki-page",{base_version:0,content:{title:"Wiki",body:"Research",dependencies:[{kind:card.kind,object_id:card.object_id,version:1}]}});
    const exported=await fetch(`${base}/projects/${project.project_id}/knowledge-export`);assert.equal(exported.status,200);
    const bundle=await exported.json();restoreKnowledge(restored,bundle);
    assert.equal(restored.listSources(project.project_id).length,1);assert.equal(new KnowledgeStore(restored.db).get(project.project_id,"literature-card",card.object_id)?.status,"accepted");
    const source=restored.listSources(project.project_id)[0];assert.ok(restored.readArtifact(project.project_id,source.artifact_id!));
    assert.throws(()=>restoreKnowledge(restored,bundle),/PROJECT_ALREADY_EXISTS/);
  }finally{await new Promise<void>(resolve=>app.server.close(()=>resolve()));app.store.close();restored.close();rmSync(root,{recursive:true,force:true});rmSync(restoreRoot,{recursive:true,force:true});}
});
