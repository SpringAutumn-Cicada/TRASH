import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { KnowledgeStore, TrashStore } from '@trash/storage';
import { ProjectWorkspaces } from '../src/project-workspace.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'trash-paper-workspace-'));
  const store=new TrashStore(join(root,'platform')),knowledge=new KnowledgeStore(store.db);
  const project=store.createProject({title:'论文',research_question:'Research question',module:{id:'apt-provenance',version:'0.1.0'}});
  const papers=join(root,'papers');mkdirSync(papers);
  const workspaces=new ProjectWorkspaces(store,knowledge);
  return {root,store,knowledge,project,papers,workspaces,close(){workspaces.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
async function settled(workspaces:ProjectWorkspaces,id:string){
  const deadline=Date.now()+10000;
  while(workspaces.busy(id)&&Date.now()<deadline)await delay(10);
  assert.equal(workspaces.busy(id),false,'migration should settle');
  return workspaces.state(id).migration!;
}

test('custom project directory stores editable Wiki and stale UI writes preserve external changes',async()=>{
  const f=fixture();try{
    await f.workspaces.initialize(f.project.project_id,{root:f.papers,name:'中文论文'});
    const root=f.workspaces.state(f.project.project_id).path;
    assert.equal(root,join(f.papers,'中文论文'));
    const first=f.knowledge.write(f.project.project_id,'wiki-page',{base_version:0,content:{title:'方法',body:'original',dependencies:[]}});
    f.knowledge.review(f.project.project_id,'wiki-page',first.object_id,1,'accepted','confirmed');
    f.knowledge.get(f.project.project_id,'wiki-page',first.object_id);
    const file=join(root,'wiki',first.object_id+'.md');
    writeFileSync(file,readFileSync(file,'utf8').replace('\noriginal\n','\nexternal edit\n'));
    assert.throws(()=>f.knowledge.write(f.project.project_id,'wiki-page',{object_id:first.object_id,base_version:1,content:{title:'方法',body:'stale UI',dependencies:[]}}),/VERSION_CONFLICT/);
    const current=f.knowledge.get(f.project.project_id,'wiki-page',first.object_id)!;
    assert.equal(current.version,2);assert.equal(current.status,'draft');
    assert.equal('body' in current.content&&current.content.body,'external edit');
    assert.equal(f.knowledge.get(f.project.project_id,'wiki-page',first.object_id,1)?.status,'accepted');
  }finally{f.close();}
});

test('legacy project migration preserves original bytes, materializes knowledge and retains recoverable backup',async()=>{
  const f=fixture();try{
    const artifact=f.store.saveArtifact(f.project.project_id,'paper.pdf','application/pdf',Buffer.from('original-pdf-bytes'));
    const wiki=f.knowledge.write(f.project.project_id,'wiki-page',{base_version:0,content:{title:'Existing',body:'Preserve me',dependencies:[]}});
    await f.workspaces.start(f.project.project_id,{root:f.papers,name:'migrated'});
    const job=await settled(f.workspaces,f.project.project_id);assert.equal(job.status,'completed',job.error);
    assert.ok(job.backup&&existsSync(job.backup));
    assert.equal(Buffer.from(f.store.readArtifact(f.project.project_id,artifact.artifact_id)!).toString(),'original-pdf-bytes');
    assert.ok(realpathSync(f.store.artifactFile(f.project.project_id,artifact.artifact_id)!.path).startsWith(join(f.papers,'migrated','literature','originals')));
    assert.match(readFileSync(join(job.target,'wiki',wiki.object_id+'.md'),'utf8'),/Preserve me/);
    f.workspaces.cleanup(f.project.project_id,job.id);assert.equal(existsSync(job.backup!),false);
    assert.equal(f.workspaces.state(f.project.project_id).path,job.target);
  }finally{f.close();}
});

test('failed migration keeps original binding and does not write through external reserved-directory symlinks',async()=>{
  const f=fixture();try{
    const source=join(f.store.root,'projects',f.project.project_id),outside=join(f.root,'outside');
    mkdirSync(source);mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'unchanged');symlinkSync(outside,join(source,'wiki'),'dir');
    await f.workspaces.start(f.project.project_id,{root:f.papers,name:'must-fail'});
    const job=await settled(f.workspaces,f.project.project_id);assert.equal(job.status,'failed');
    assert.equal(realpathSync(source),source);assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'unchanged');
    assert.equal(existsSync(join(outside,'project.yaml')),false);assert.equal(existsSync(job.target),false);
  }finally{f.close();}
});

test('database rollback restores the previous Markdown publication on the next read',async()=>{
  const f=fixture();try{
    await f.workspaces.initialize(f.project.project_id,{root:f.papers,name:'rollback'});
    const first=f.knowledge.write(f.project.project_id,'wiki-page',{base_version:0,content:{title:'Wiki',body:'before',dependencies:[]}});
    f.knowledge.get(f.project.project_id,'wiki-page',first.object_id);
    assert.throws(()=>f.store.db.transaction(()=>{
      f.knowledge.write(f.project.project_id,'wiki-page',{object_id:first.object_id,base_version:1,content:{title:'Wiki',body:'rolled back',dependencies:[]}});
      throw new Error('rollback');
    })(),/rollback/);
    const restored=f.knowledge.get(f.project.project_id,'wiki-page',first.object_id)!;
    assert.equal(restored.version,1);assert.equal('body' in restored.content&&restored.content.body,'before');
    assert.match(readFileSync(join(f.workspaces.state(f.project.project_id).path,'wiki',first.object_id+'.md'),'utf8'),/\nbefore\n$/);
    await assert.rejects(f.workspaces.start(f.project.project_id,{root:f.workspaces.state(f.project.project_id).path,name:'nested'}),/WORKSPACE_NESTED/);
  }finally{f.close();}
});

test('local card edits retain structured evidence and an accepted historical version',async()=>{
  const f=fixture();try{
    await f.workspaces.initialize(f.project.project_id,{root:f.papers,name:'cards'});
    const source={protocol_version:'v1' as const,source_id:'source_card_fixture',project_id:f.project.project_id,title:'Paper',authors:[],source_type:'markdown' as const,parse_status:'indexed' as const,imported_at:new Date().toISOString()};
    f.store.createSources([source],new Map([[source.source_id,[{locator:{kind:'paragraph' as const,paragraph_index:1},text:'A real method.'}]]]));
    const first=f.knowledge.write(f.project.project_id,'literature-card',{base_version:0,content:{source_id:source.source_id,title:'Paper',method:'old method',datasets:['Trace'],evidence:[{source_id:source.source_id,paragraph:1,quote:'A real method.',attribution:'author'}]}});
    f.knowledge.review(f.project.project_id,'literature-card',first.object_id,1,'accepted','checked');
    f.knowledge.get(f.project.project_id,'literature-card',first.object_id);
    const file=join(f.workspaces.state(f.project.project_id).path,'literature','cards',first.object_id+'.md');
    writeFileSync(file,readFileSync(file,'utf8').replace('old method','new method'));
    const updated=f.knowledge.get(f.project.project_id,'literature-card',first.object_id)!;
    assert.equal(updated.version,2);assert.equal(updated.status,'draft');
    assert.ok('source_id' in updated.content);
    assert.equal(updated.content.method,'new method');assert.deepEqual(updated.content.datasets,['Trace']);assert.equal(updated.content.evidence[0].quote,'A real method.');
    assert.equal(f.knowledge.get(f.project.project_id,'literature-card',first.object_id,1)?.status,'accepted');
  }finally{f.close();}
});
