import { MarkdownKnowledge } from "../src/markdown-knowledge.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { KnowledgeStore, TrashStore } from "@trash/storage";
import { knowledgeTaskInputSchema, sourceSchema } from "@trash/protocol";
import { KnowledgeAgent } from "../src/knowledge-agent.js";

async function until(check:()=>boolean){const deadline=Date.now()+10000;while(!check()){if(Date.now()>deadline)throw new Error("fixture timeout");await new Promise(resolve=>setTimeout(resolve,25));}}
test("stub CLI produces candidates, preserves failed attempts and supports cancellation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trash-agent-"));const store=new TrashStore(root);const knowledge=new KnowledgeStore(store.db);
  const project=store.createProject({title:"APT",research_question:"Research",module:{id:"apt-provenance",version:"0.1.0"}});
  const source=sourceSchema.parse({protocol_version:"v1",source_id:"source_cli",project_id:project.project_id,title:"Paper",authors:[],source_type:"markdown",parse_status:"indexed",imported_at:new Date().toISOString()});
  store.createSources([source],new Map([[source.source_id,[{locator:{kind:"paragraph",paragraph_index:1},text:"fixture text"}]]]));
  const agent=new KnowledgeAgent(store,knowledge,{command:process.execPath,prefix:[fileURLToPath(new URL("./fixtures/knowledge-cli.mjs",import.meta.url))]});
  try{
    const input=knowledgeTaskInputSchema.parse({kind:"literature-card",source_ids:[source.source_id],title:"Paper"});
    const [ok]=agent.enqueue(project.project_id,input);await until(()=>knowledge.tasks(project.project_id).find(t=>t.task_id===ok.task_id)?.status==="completed");
    const markdown=new MarkdownKnowledge(store),before=markdown.list(project.project_id).documents;
    assert.equal(before.length,2);assert.ok(before.every(doc=>doc.status==='pending'));
    const hashes=before.map(doc=>doc.hash);
    assert.equal(knowledge.list(project.project_id,'literature-card').length,0,'Markdown正文不应回写旧JSON知识库');
    const [bad]=agent.enqueue(project.project_id,{...input,instructions:"FIXTURE_BAD"});await until(()=>knowledge.tasks(project.project_id).find(t=>t.task_id===bad.task_id)?.status==="failed");
    assert.deepEqual(markdown.list(project.project_id).documents.map(doc=>doc.hash),hashes);
    const [waiting]=agent.enqueue(project.project_id,{...input,instructions:"FIXTURE_WAIT"});await until(()=>knowledge.tasks(project.project_id).find(t=>t.task_id===waiting.task_id)?.status==="running");
    agent.cancel(project.project_id,waiting.task_id);assert.equal(knowledge.tasks(project.project_id).find(t=>t.task_id===waiting.task_id)?.status,"cancelled");
  }finally{agent.close();await new Promise(resolve=>setTimeout(resolve,100));store.close();rmSync(root,{recursive:true,force:true});}
});
