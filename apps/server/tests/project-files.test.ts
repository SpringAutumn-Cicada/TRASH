import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, TrashStore } from '@trash/storage';
import { ProjectFiles } from '../src/project-files.js';
import { ProjectWorkspaces } from '../src/project-workspace.js';
import { createWorkbenchServer } from '../src/index.js';

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'trash-project-files-')),store=new TrashStore(join(root,'platform'));
  const project=store.createProject({title:'Files',research_question:'Research',module:{id:'apt-provenance',version:'0.1.0'}});
  const knowledge=new KnowledgeStore(store.db),workspaces=new ProjectWorkspaces(store,knowledge);
  const papers=join(root,'papers');mkdirSync(papers);await workspaces.initialize(project.project_id,{root:papers,name:'paper'});
  let blocked=false;
  const files=new ProjectFiles(store,()=>blocked),id=project.project_id,path=workspaces.state(id).path;
  return {root,store,knowledge,workspaces,files,id,path,block(){blocked=true;},close(){workspaces.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('ordinary file management preserves stale edits, refuses overwrite and restores recycled content',async()=>{
  const f=await fixture();try{
    f.files.create(f.id,{path:'research/notes.md',kind:'file'});
    const initial=f.files.preview(f.id,'research/notes.md');
    f.files.save(f.id,{path:initial.path,etag:initial.etag,content:'# Notes\nFirst version'});
    const before=f.files.preview(f.id,initial.path);
    writeFileSync(join(f.path,initial.path),'external edit');
    assert.throws(()=>f.files.save(f.id,{path:before.path,etag:before.etag,content:'stale UI'}),/FILES_CHANGED/);
    assert.equal(readFileSync(join(f.path,initial.path),'utf8'),'external edit');
    assert.throws(()=>f.files.upload(f.id,initial.path,Buffer.from('overwrite')),/EEXIST/);
    const fingerprint=f.files.inspect(f.id,initial.path).fingerprint;
    f.files.move(f.id,{path:initial.path,target:'research/renamed.md',fingerprint});
    const path='research/renamed.md';
    const deleted=f.files.recycle(f.id,{path,fingerprint:f.files.inspect(f.id,path).fingerprint,confirm:true});
    assert.equal(existsSync(join(f.path,path)),false);assert.equal(f.files.recycled(f.id).entries.length,1);
    f.files.create(f.id,{path,kind:'file'});assert.throws(()=>f.files.restore(f.id,{id:deleted.entry.id}),/FILES_EXISTS/);
    const occupant=f.files.recycle(f.id,{path,fingerprint:f.files.inspect(f.id,path).fingerprint,confirm:true});
    f.files.restore(f.id,{id:deleted.entry.id});assert.equal(readFileSync(join(f.path,path),'utf8'),'external edit');assert.ok(occupant.entry.id);
  }finally{f.close();}
});

test('files API refuses traversal, symbolic links and managed original mutations',async()=>{
  const f=await fixture();try{
    const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'secret.txt'),'external');symlinkSync(outside,join(f.path,'external'),'dir');
    assert.throws(()=>f.files.list(f.id,'../outside',true));
    assert.throws(()=>f.files.preview(f.id,'external/secret.txt'),/FILES_SYMLINK/);
    assert.throws(()=>f.files.create(f.id,{path:'.trash/rewrite.json',kind:'file'}),/FILES_MANAGED_READONLY/);
    const artifact=f.store.saveArtifact(f.id,'paper.pdf','application/pdf',Buffer.from('%PDF-original'));
    assert.ok(f.store.readArtifact(f.id,artifact.artifact_id));
    const entry=f.files.list(f.id,'literature/originals',false).entries[0];
    assert.throws(()=>f.files.recycle(f.id,{path:entry.path,fingerprint:f.files.inspect(f.id,entry.path).fingerprint,confirm:true}),/FILES_MANAGED_READONLY/);
    f.block();assert.throws(()=>f.files.create(f.id,{path:'research/new.md',kind:'file'}),/PROJECT_HAS_ACTIVE_TASKS/);
    assert.equal(readFileSync(join(outside,'secret.txt'),'utf8'),'external');
  }finally{f.close();}
});

test('Markdown file editor creates versioned Wiki drafts and retains accepted history',async()=>{
  const f=await fixture();try{
    const wiki=f.knowledge.write(f.id,'wiki-page',{base_version:0,content:{title:'Wiki',body:'original',dependencies:[]}});
    f.knowledge.review(f.id,'wiki-page',wiki.object_id,1,'accepted','verified');
    const path=`wiki/${wiki.object_id}.md`,preview=f.files.preview(f.id,path);
    assert.equal(preview.editable,true);
    f.files.save(f.id,{path,etag:preview.etag,version:1,content:preview.content!.replace('\noriginal\n','\nnew content\n')});
    const current=f.knowledge.get(f.id,'wiki-page',wiki.object_id)!;
    assert.equal(current.version,2);assert.equal(current.status,'draft');assert.equal(f.knowledge.get(f.id,'wiki-page',wiki.object_id,1)?.status,'accepted');
    assert.throws(()=>f.files.move(f.id,{path,target:'wiki/renamed.md',fingerprint:f.files.inspect(f.id,path).fingerprint}),/FILES_MANAGED_READONLY/);
    assert.throws(()=>f.files.save(f.id,{path,etag:preview.etag,version:1,content:preview.content}),/VERSION_CONFLICT/);
  }finally{f.close();}
});

test('PDF inline content supports byte ranges and download disposition',async()=>{
  const f=await fixture(),app=createWorkbenchServer({store:f.store});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const address=app.server.address();assert.ok(address&&typeof address!=='string');
  try{
    f.files.upload(f.id,'research/paper.pdf',Buffer.from('%PDF-123456789'));
    const url=`http://127.0.0.1:${address.port}/api/v1/projects/${f.id}/files/content?path=research%2Fpaper.pdf`;
    const response=await fetch(url,{headers:{range:'bytes=0-4'}});
    assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(await response.text(),'%PDF-');
    const download=await fetch(url+'&download=true');assert.match(download.headers.get('content-disposition')!,/^attachment;/);await download.arrayBuffer();
    const invalid=await fetch(url,{headers:{range:'bytes=999-1000'}});assert.equal(invalid.status,416);await invalid.arrayBuffer();
  }finally{app.closeConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));f.close();}
});
