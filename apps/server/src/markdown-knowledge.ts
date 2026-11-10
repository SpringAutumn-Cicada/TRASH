import type { KnowledgeVersion } from "@trash/protocol";
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrashStore } from '@trash/storage';

export type MarkdownDocument={id:string;kind:'literature-card'|'wiki-page';source_id?:string;card_type?:'detail'|'key';title:string;path:string;text:string;hash:string;modified:string;status:string;stale?:boolean};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{statusCode});}
function rejectSymlink(path:string){try{if(lstatSync(path).isSymbolicLink())fail('KNOWLEDGE_PATH_INVALID',403);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
export const skillRoot=fileURLToPath(new URL('../../../.agents/skills/trash-literature-knowledge/',import.meta.url));
export function skillText(){return ['SKILL.md','references/cards.md','references/wiki.md'].map(name=>readFileSync(join(skillRoot,name),'utf8')).join('\n\n');}
export function stageKnowledgeSkill(directory:string){
  for(const name of ['SKILL.md','references/cards.md','references/wiki.md']){const target=join(directory,'literature-skill',name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(skillRoot,name),'utf8'),{mode:0o600});}
}
export class MarkdownKnowledge {
  constructor(private store:TrashStore){}
  root(project:string){if(!this.store.getProject(project))fail('PROJECT_NOT_FOUND',404);const root=join(this.store.root,'projects',project);mkdirSync(root,{recursive:true});return realpathSync(root);}
  locate(project:string,path:string){
    if(!/^(literature\/cards|wiki)\/[A-Za-z0-9_-]+\.md$/.test(path))fail('KNOWLEDGE_PATH_INVALID',400);
    const root=this.root(project),target=resolve(root,path);let current=root;
    for(const part of path.split('/')){current=join(current,part);rejectSymlink(current);}
    if(!target.startsWith(root+sep))fail('KNOWLEDGE_PATH_INVALID',403);return target;
  }
  private internal(project:string,path:string){const root=this.root(project);let current=root;for(const part of path.split('/')){current=join(current,part);rejectSymlink(current);}return current;}
  parse(project:string,path:string,text:string):MarkdownDocument{
    if(Buffer.byteLength(text)>1024*1024||text.includes('\0'))fail('KNOWLEDGE_FILE_INVALID',422);
    const match=text.replace(/\r\n/g,'\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);if(!match)fail('KNOWLEDGE_FILE_INVALID',422);
    const meta:Record<string,string>={};for(const line of match[1].split('\n')){const m=line.match(/^([a-z_]+):\s*([A-Za-z0-9_-]+)\s*$/);if(m){if(meta[m[1]])fail('KNOWLEDGE_FILE_INVALID',422);meta[m[1]]=m[2];}}
    const kind=path.startsWith('wiki/')?'wiki-page':'literature-card';
    if(meta.kind!==kind||!meta.id||meta.id.length>180||path.split('/').at(-1)!==meta.id+'.md')fail('KNOWLEDGE_FILE_INVALID',422);
    if(kind==='literature-card'&&(!meta.source_id||!['detail','key'].includes(meta.card_type)))fail('KNOWLEDGE_FILE_INVALID',422);
    if(kind==='literature-card'&&meta.id!==`card-${meta.source_id}-${meta.card_type}`)fail('KNOWLEDGE_FILE_INVALID',422);
    if(kind==='wiki-page'&&!meta.id.startsWith('wiki-'))fail('KNOWLEDGE_FILE_INVALID',422);
    if(meta.source_id&&this.store.getSource(meta.source_id)?.project_id!==project)fail('SOURCE_NOT_FOUND',404);
    const title=match[2].match(/^#\s+(.+)$/m)?.[1]?.trim();if(!title)fail('KNOWLEDGE_FILE_INVALID',422);
    const hash=digest(text);const reviewPath=this.internal(project,`.trash/markdown-reviews/${meta.id}.json`);
    let review:{hash:string;status:string}|undefined;try{review=JSON.parse(readFileSync(reviewPath,'utf8'));}catch{/* Unreviewed file. */}
    return {id:meta.id,kind,source_id:meta.source_id,card_type:meta.card_type as 'detail'|'key'|undefined,title,path,text,hash,modified:new Date().toISOString(),status:review?.hash===hash?review.status:'pending'};
  }
  list(project:string){this.recover(project);const documents:MarkdownDocument[]=[],errors:{path:string;error:string}[]=[];
    for(const dir of ['literature/cards','wiki']){const root=this.internal(project,dir);if(!existsSync(root))continue;for(const name of readdirSync(root).filter(name=>name.endsWith('.md'))){const path=dir+'/'+name;try{const physical=this.locate(project,path);if(lstatSync(physical).size>1024*1024)fail('KNOWLEDGE_FILE_INVALID',422);const doc=this.parse(project,path,readFileSync(physical,'utf8'));doc.modified=lstatSync(physical).mtime.toISOString();documents.push(doc);}catch(error){errors.push({path,error:error instanceof Error?error.message:'KNOWLEDGE_FILE_INVALID'});}}}
    for(const doc of documents.filter(d=>d.card_type==='key')){const detail=documents.find(d=>d.source_id===doc.source_id&&d.card_type==='detail');const stamp=this.internal(project,`.trash/markdown-pairs/${doc.id}.json`);try{const value=JSON.parse(readFileSync(stamp,'utf8')) as {detail:string;key:string};doc.stale=!detail||value.detail!==detail.hash||value.key!==doc.hash;}catch{doc.stale=true;}}
    for(const doc of documents.filter(d=>d.kind==='wiki-page')){const stamp=this.internal(project,`.trash/markdown-dependencies/${doc.id}.json`);try{const refs=JSON.parse(readFileSync(stamp,'utf8')) as {path:string;hash:string}[];doc.stale=refs.some(ref=>documents.find(d=>d.path===ref.path)?.hash!==ref.hash);}catch{doc.stale=false;}}
    return {documents:documents.sort((a,b)=>b.modified.localeCompare(a.modified)),errors};
  }
  private recover(project:string){
    const journal=this.internal(project,'.trash/markdown-transaction.json');if(!existsSync(journal))return;
    const batch=JSON.parse(readFileSync(journal,'utf8')) as {committed:boolean;files:{path:string;text:string;before:string|null}[]};
    for(const file of batch.files){const target=this.locate(project,file.path);const current=existsSync(target)?readFileSync(target,'utf8'):null;if(current!==file.text&&current!==file.before)fail('VERSION_CONFLICT');const wanted=batch.committed?file.text:file.before;if(wanted===null){if(existsSync(target))unlinkSync(target);}else{mkdirSync(dirname(target),{recursive:true});const temp=target+'.recovery.tmp';writeFileSync(temp,wanted,{mode:0o600});renameSync(temp,target);}}
    unlinkSync(journal);
  }
  save(project:string,path:string,text:string,expected:string|null){return this.commit(project,[{path,text,expected}])[0];}
  commit(project:string,files:{path:string;text:string;expected:string|null}[]){
    this.recover(project);
    if(!files.length||files.length>3||new Set(files.map(f=>f.path)).size!==files.length)fail('INVALID_REQUEST',400);
    const targets=files.map(file=>{const target=this.locate(project,file.path),before=existsSync(target)?readFileSync(target,'utf8'):null;if((before===null?null:digest(before))!==file.expected)fail('VERSION_CONFLICT');return {...file,target,before,doc:this.parse(project,file.path,file.text)};});
    if(targets.length===2&&(!targets.every(t=>t.doc.kind==='literature-card')||targets[0].doc.source_id!==targets[1].doc.source_id||new Set(targets.map(t=>t.doc.card_type)).size!==2))fail('INVALID_REQUEST',400);
    if(targets.length===3){const cards=targets.filter(t=>t.doc.kind==='literature-card'),wiki=targets.find(t=>t.doc.kind==='wiki-page');if(cards.length!==2||new Set(cards.map(t=>t.doc.card_type)).size!==2||!wiki||!wiki.doc.source_id||targets.some(t=>t.doc.source_id!==wiki.doc.source_id)||wiki.doc.id!==`wiki-${wiki.doc.source_id}`)fail('INVALID_REQUEST',400);}
    // All checks and writes are synchronous: no other server request can interleave this commit.
    const staged=targets.map(file=>{mkdirSync(dirname(file.target),{recursive:true});const temp=file.target+'.'+randomUUID()+'.tmp';writeFileSync(temp,file.text,{mode:0o600,flag:'wx'});return {...file,temp};});
    const journal=this.internal(project,'.trash/markdown-transaction.json');mkdirSync(dirname(journal),{recursive:true});
    const transaction={committed:false,files:targets.map(({path,text,before})=>({path,text,before}))};
    writeFileSync(journal,JSON.stringify(transaction),{mode:0o600,flag:'wx'});
    try{
      for(const file of staged){const history=this.internal(project,`.trash/markdown-history/${file.doc.id}`);mkdirSync(history,{recursive:true});if(file.before!==null)writeFileSync(join(history,digest(file.before)+'.md'),file.before,{mode:0o600});renameSync(file.temp,file.target);writeFileSync(join(history,file.doc.hash+'.md'),file.text,{mode:0o600});}
      const complete=journal+'.tmp';writeFileSync(complete,JSON.stringify({...transaction,committed:true}),{mode:0o600});renameSync(complete,journal);unlinkSync(journal);
    }catch(error){this.recover(project);throw error;}
    const detail=staged.find(f=>f.doc.card_type==='detail'),key=staged.find(f=>f.doc.card_type==='key');if(detail&&key&&detail.doc.source_id===key.doc.source_id){const stamp=this.internal(project,`.trash/markdown-pairs/${key.doc.id}.json`);mkdirSync(dirname(stamp),{recursive:true});writeFileSync(stamp,JSON.stringify({detail:detail.doc.hash,key:key.doc.hash}),{mode:0o600});}
    for(const file of staged.filter(file=>file.doc.kind==='wiki-page')){const refs:{path:string;hash:string}[]=[];for(const match of file.text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)){try{const path=new URL(match[1],'https://knowledge.local/'+file.path).pathname.slice(1);const target=this.locate(project,path);if(existsSync(target))refs.push({path,hash:digest(readFileSync(target,'utf8'))});}catch{/* External or non-knowledge link. */}}const stamp=this.internal(project,`.trash/markdown-dependencies/${file.doc.id}.json`);mkdirSync(dirname(stamp),{recursive:true});writeFileSync(stamp,JSON.stringify(refs),{mode:0o600});}
    return staged.map(f=>f.doc);
  }
  review(project:string,path:string,hash:string,status:'accepted'|'rejected') {const target=this.locate(project,path),doc=this.parse(project,path,readFileSync(target,'utf8'));if(doc.hash!==hash)fail('VERSION_CONFLICT');const file=this.internal(project,`.trash/markdown-reviews/${doc.id}.json`);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({hash,status,at:new Date().toISOString()}),{mode:0o600});return {...doc,status};}
  history(project:string,id:string){if(!/^[A-Za-z0-9_-]+$/.test(id))fail('INVALID_REQUEST',400);const dir=this.internal(project,`.trash/markdown-history/${id}`);return existsSync(dir)?readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.md$/.test(n)).map(n=>({hash:n.slice(0,-3),text:readFileSync(join(dir,n),'utf8')})):[];}
}

/** Adapter for workflow counters and dependency selection; Markdown remains the source. */
export function markdownVersions(store:TrashStore,project:string,kind:'literature-card'|'wiki-page'):(KnowledgeVersion & {stale?:boolean})[] {
  return new MarkdownKnowledge(store).list(project).documents.filter(d=>d.kind===kind&&d.card_type!=='key').map(doc=>({object_id:doc.id,stale:doc.stale,project_id:project,kind:doc.kind,version:1,status:doc.status as 'pending'|'accepted'|'rejected',title:doc.title,content:doc.kind==='wiki-page'?{title:doc.title,tags:[],body:doc.text,dependencies:[]}:{source_id:doc.source_id!,title:doc.title,tags:[],question:doc.text,method:'',contributions:'',limitations:'',datasets:[],baselines:[],metrics:[],reported_results:'',experimental_conditions:'',ideas:'',relevance:'',open_questions:'',evidence:[]},created_by:'agent' as const,created_at:doc.modified}));
}
