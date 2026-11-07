import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashStore } from '@trash/storage';
import { uploadChatAttachment, resolveChatAttachments } from '../src/chat-attachments.js';
test('chat attachments retain original bytes, classify actual image signatures and enforce project ownership',()=>{
  const root=mkdtempSync(join(tmpdir(),'trash-chat-attachments-')),store=new TrashStore(root);
  const create=()=>store.createProject({title:'Paper',research_question:'Research',module:{id:'apt-provenance',version:'0.1.0'}});
  try{
    const a=create(),b=create(),bytes=Buffer.from('paper evidence');
    const file=uploadChatAttachment(store,a.project_id,'论文.txt',bytes);
    assert.equal(file.image,false);assert.deepEqual(Buffer.from(store.readArtifact(a.project_id,file.id)!),bytes);
    assert.equal(resolveChatAttachments(store,a.project_id,[file.id])[0].name,'论文.txt');
    assert.throws(()=>resolveChatAttachments(store,b.project_id,[file.id]),/CHAT_ATTACHMENT_NOT_FOUND/);
    assert.throws(()=>uploadChatAttachment(store,a.project_id,'fake.png',bytes),/CHAT_IMAGE_UNSUPPORTED/);
    assert.throws(()=>uploadChatAttachment(store,a.project_id,'empty.txt',Buffer.alloc(0)),/CHAT_ATTACHMENT_SIZE/);
    const image=uploadChatAttachment(store,a.project_id,'clipboard.png',Buffer.from([137,80,78,71,13,10,26,10,0]));
    assert.equal(image.image,true);assert.equal(image.mime,'image/png');
    writeFileSync(store.artifactFile(a.project_id,file.id)!.path,'tampered');
    assert.throws(()=>resolveChatAttachments(store,a.project_id,[file.id]),/CHAT_ATTACHMENT_NOT_FOUND/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
