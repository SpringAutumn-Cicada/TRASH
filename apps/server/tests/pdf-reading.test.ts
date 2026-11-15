import {KnowledgeAgent} from '../src/knowledge-agent.js';
import {MarkdownKnowledge} from '../src/markdown-knowledge.js';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeStore,TrashStore} from '@trash/storage';
import {knowledgeTaskInputSchema,sourceSchema} from '@trash/protocol';
import {PdfReading} from '../src/pdf-reading.js';
import {createWorkbenchServer} from '../src/index.js';

import {samplePdf} from '../../../tests/fixtures/pdf.js';
test('PDF original, blank-text page, image scales, source ownership and reference endpoint',async()=>{
 const root=mkdtempSync(join(tmpdir(),'trash-pdf-test-')),store=new TrashStore(root),app=createWorkbenchServer({store});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();if(!address||typeof address==='string')throw new Error('port');const base=`http://127.0.0.1:${address.port}`;
 try{const project=store.createProject({title:'PDF test',research_question:'Evidence',module:{id:'apt-provenance',version:'0.1.0'}});const original=samplePdf(),artifact=store.saveArtifact(project.project_id,'original.pdf','application/pdf',original);
 const source=sourceSchema.parse({protocol_version:'v1',source_id:'source_pdf-acceptance',project_id:project.project_id,title:'PDF',authors:[],source_type:'pdf',parse_status:'indexed',artifact_id:artifact.artifact_id,imported_at:new Date().toISOString()});store.createSources([source],new Map());const pdf=new PdfReading(store),doc=await pdf.document(project.project_id,source.source_id);
 assert.equal(doc.pageCount,2);assert.match(doc.pages[0].text,/acceptance/);assert.equal(doc.pages[1].text,'');assert.equal(doc.hash.length,64);assert.deepEqual(readFileSync(doc.original),original);
 const [small,big]=await Promise.all([pdf.page(project.project_id,source.source_id,2,400),pdf.page(project.project_id,source.source_id,2,2200)]);for(const [file,size] of [[small.path,400],[big.path,2200]] as const){const bytes=readFileSync(file);assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
 await assert.rejects(()=>pdf.page(project.project_id,source.source_id,0),/PDF_PAGE_OUT_OF_RANGE/);await assert.rejects(()=>pdf.page(project.project_id,source.source_id,3),/PDF_PAGE_OUT_OF_RANGE/);await assert.rejects(()=>pdf.page(project.project_id,source.source_id,1,999),/INVALID_REQUEST/);assert.throws(()=>pdf.original('another-project',source.source_id),/SOURCE_NOT_FOUND/);
 const knowledge=new KnowledgeStore(store.db),agent=new KnowledgeAgent(store,knowledge,{command:process.execPath,prefix:[fileURLToPath(new URL('./fixtures/knowledge-cli.mjs',import.meta.url))]});
 const until=async(id:string)=>{for(let i=0;i<200;i++){const task=knowledge.tasks(project.project_id).find(t=>t.task_id===id)!;if(!['running','queued'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('fixture timeout');};
 try{
  const [task]=agent.enqueue(project.project_id,knowledgeTaskInputSchema.parse({kind:'literature-card',source_ids:[source.source_id],title:'PDF fixture'}));
  const done=await until(task.task_id);assert.equal(done.status,'completed',done.error);
  const documents=new MarkdownKnowledge(store).list(project.project_id).documents;assert.equal(documents.length,2);
  const manifest=JSON.parse(readFileSync(join(root,'projects',project.project_id,'.trash','runtime','tasks',task.task_id,'pdf-reading.json'),'utf8'));assert.equal(manifest.status,'all-batches-noted');assert.deepEqual(manifest.sources[0].batches[0].pages,[1,2]);
  const [bad]=agent.enqueue(project.project_id,knowledgeTaskInputSchema.parse({kind:'literature-card',source_ids:[source.source_id],title:'PDF missing notes',instructions:'FIXTURE_NO_NOTE',regenerate:true}));
  const failed=await until(bad.task_id);assert.equal(failed.status,'failed');assert.match(failed.error!,/未生成阅读笔记/);assert.deepEqual(new MarkdownKnowledge(store).list(project.project_id).documents.map(d=>d.hash),documents.map(d=>d.hash));
 }finally{agent.close();}
 const response=await fetch(`${base}/api/v1/projects/${project.project_id}/sources/${source.source_id}/pdf-view?hash=${doc.hash}`,{redirect:'manual'});assert.equal(response.status,302);assert.match(response.headers.get('location')!,new RegExp(doc.hash));
 const missing=await fetch(`${base}/api/v1/projects/${project.project_id}/sources/${source.source_id}/pdf/pages/3`);assert.equal(missing.status,400);
 }finally{app.closeConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});}
});
