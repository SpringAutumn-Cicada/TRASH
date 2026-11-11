import type { KnowledgeVersion } from "@trash/protocol";
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrashStore } from '@trash/storage';

export type MarkdownDocument={id:string;kind:'literature-card'|'wiki-page';source_id?:string;card_type?:'detail'|'key';title:string;path:string;text:string;hash:string;modified:string;status:string;stale?:boolean;level?:string;summary?:string;characters?:number;dependencies?:{path:string;hash:string}[]};
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
    return {id:meta.id,kind,source_id:meta.source_id,card_type:meta.card_type as 'detail'|'key'|undefined,title,path,text,hash,modified:new Date().toISOString(),status:review?.hash===hash?review.status:'pending',level:meta.level??(meta.source_id?'single':'topic'),summary:match[2].replace(/^#+[^\n]*$/gm,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/\s+/g,' ').trim().slice(0,180),characters:text.length};
  }
  // Version 2 is opt-in: pre-existing Markdown remains on disk and is never indexed.
  private isCurrent(text:string){return /^knowledge_version:\s*2\s*$/m.test(text.split(/---\r?\n/)[1]??'');}
  private writeIndex(project:string,value:unknown){const file=this.internal(project,'.trash/knowledge-index-v2.json');mkdirSync(dirname(file),{recursive:true});const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,file);}
  index(project:string,force=false){
    this.recover(project);
    this.store.db.exec("CREATE TABLE IF NOT EXISTS knowledge_search_v2(project TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(project,path))");
    type Entry={signature:string;document?:Omit<MarkdownDocument,'text'>;error?:string};
    let old:Record<string,Entry>={};try{old=JSON.parse(readFileSync(this.internal(project,'.trash/knowledge-index-v2.json'),'utf8')).entries??{};}catch{/* Rebuildable index. */}
    const entries:Record<string,Entry>={},errors:{path:string;error:string}[]=[];
    for(const dir of ['literature/cards','wiki']){const root=this.internal(project,dir);if(!existsSync(root))continue;for(const name of readdirSync(root).filter(n=>n.endsWith('.md'))){const path=dir+'/'+name;try{const physical=this.locate(project,path),info=lstatSync(physical),signature=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      if(!force&&old[path]?.signature===signature)entries[path]=old[path];
      else{if(info.size>1024*1024)fail('KNOWLEDGE_FILE_INVALID',422);const text=readFileSync(physical,'utf8');if(!this.isCurrent(text)){entries[path]={signature};continue;}const {text:body,...document}=this.parse(project,path,text);void body;document.modified=info.mtime.toISOString();entries[path]={signature,document};}
      if(entries[path].error)errors.push({path,error:entries[path].error!});
    }catch(error){entries[path]={signature:'error',error:error instanceof Error?error.message:'KNOWLEDGE_FILE_INVALID'};errors.push({path,error:entries[path].error!});}}}
    this.store.db.transaction(()=>{for(const [path,entry] of Object.entries(entries)){if(!entry.document){this.store.db.prepare('DELETE FROM knowledge_search_v2 WHERE project=? AND path=?').run(project,path);continue;}const cached=this.store.db.prepare('SELECT hash FROM knowledge_search_v2 WHERE project=? AND path=?').get(project,path) as {hash:string}|undefined;if(force||cached?.hash!==entry.document.hash)this.store.db.prepare('INSERT OR REPLACE INTO knowledge_search_v2(project,path,hash,text) VALUES(?,?,?,?)').run(project,path,entry.document.hash,readFileSync(this.locate(project,path),'utf8'));}for(const row of this.store.db.prepare('SELECT path FROM knowledge_search_v2 WHERE project=?').all(project) as {path:string}[])if(!entries[row.path]?.document)this.store.db.prepare('DELETE FROM knowledge_search_v2 WHERE project=? AND path=?').run(project,row.path);})();
    if(force||JSON.stringify(entries)!==JSON.stringify(old))this.writeIndex(project,{version:2,entries});
    const documents=Object.values(entries).flatMap(e=>e.document?[{...e.document}]:[]);
    for(const doc of documents){
      try{const review=JSON.parse(readFileSync(this.internal(project,`.trash/markdown-reviews/${doc.id}.json`),'utf8'));doc.status=review.hash===doc.hash?review.status:'pending';}catch{doc.status='pending';}
      if(doc.source_id){try{const stamp=JSON.parse(readFileSync(this.internal(project,`.trash/knowledge-sources/${doc.id}.json`),'utf8'));doc.stale=stamp.hash!==digest(JSON.stringify(this.store.getSource(doc.source_id)));}catch{doc.stale=true;}}
      if(doc.card_type==='key'){const detail=documents.find(d=>d.source_id===doc.source_id&&d.card_type==='detail');try{const pair=JSON.parse(readFileSync(this.internal(project,`.trash/markdown-pairs/${doc.id}.json`),'utf8'));doc.stale=Boolean(doc.stale)||!detail||pair.detail!==detail.hash||pair.key!==doc.hash;}catch{doc.stale=true;}}
      if(doc.kind==='wiki-page'){try{const stamp=JSON.parse(readFileSync(this.internal(project,`.trash/markdown-dependencies/${doc.id}.json`),'utf8')) as {path:string;hash:string}[];doc.dependencies=stamp;doc.stale=Boolean(doc.stale)||stamp.some(ref=>documents.find(d=>d.path===ref.path)?.hash!==ref.hash);}catch{doc.dependencies=[];doc.stale=true;}}
    }
    // Propagate invalidation through the actual dependency graph, including missing files.
    for(let i=0;i<documents.length;i++){let changed=false;for(const doc of documents)if(!doc.stale&&doc.dependencies?.some(ref=>documents.find(d=>d.path===ref.path)?.stale)){doc.stale=true;changed=true;}if(!changed)break;}
    return {documents:documents.sort((a,b)=>b.modified.localeCompare(a.modified)),errors};
  }
  read(project:string,id:string){const entry=this.index(project).documents.find(d=>d.id===id);if(!entry)fail('NOT_FOUND',404);const text=readFileSync(this.locate(project,entry.path),'utf8');if(digest(text)!==entry.hash)fail('VERSION_CONFLICT');return {...entry,text};}
  list(project:string){const indexed=this.index(project);return {...indexed,documents:indexed.documents.map(d=>this.read(project,d.id))};}
  query(project:string,options:{page?:number;limit?:number;kind?:string;level?:string;q?:string;rescan?:boolean}={}){
    const indexed=this.index(project,options.rescan),q=options.q?.trim().toLowerCase();let docs=indexed.documents.filter(d=>(!options.kind||d.kind===options.kind)&&(!options.level||d.level===options.level));
    const matches:Record<string,string>={};if(q)docs=docs.filter(doc=>{if((doc.title+' '+doc.summary).toLowerCase().includes(q))return true;const hit=this.store.db.prepare('SELECT substr(text,max(1,instr(lower(text),?)-70),220) AS snippet FROM knowledge_search_v2 WHERE project=? AND path=? AND instr(lower(text),?)>0').get(q,project,doc.path,q) as {snippet:string}|undefined;if(!hit)return false;matches[doc.id]=hit.snippet;return true;});
    const limit=Math.min(100,Math.max(1,options.limit??30)),page=Math.max(1,options.page??1);return {documents:docs.slice((page-1)*limit,page*limit).map(d=>({...d,...(matches[d.id]?{snippet:matches[d.id]}:{})})),total:docs.length,page,limit,errors:indexed.errors};
  }
  stamp(project:string,id:string,refs:{path:string;hash:string}[]){const file=this.internal(project,`.trash/markdown-dependencies/${id}.json`);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(refs),{mode:0o600});}
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
    const targets=files.map(original=>{const normalized=original.text.replace(/\r\n/g,'\n');const text=normalized.replace(/^---\n([\s\S]*?)\n---\n/,(_all,front:string)=>'---\nknowledge_version: 2\n'+front.replace(/^knowledge_version:.*\n?/gm,'')+'\n---\n');const file={...original,text};const target=this.locate(project,file.path),before=existsSync(target)?readFileSync(target,'utf8'):null;if((before===null?null:digest(before))!==file.expected)fail('VERSION_CONFLICT');return {...file,target,before,doc:this.parse(project,file.path,file.text)};});
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
    for(const file of staged.filter(f=>f.doc.source_id)){const stamp=this.internal(project,`.trash/knowledge-sources/${file.doc.id}.json`);mkdirSync(dirname(stamp),{recursive:true});writeFileSync(stamp,JSON.stringify({hash:digest(JSON.stringify(this.store.getSource(file.doc.source_id!)))}),{mode:0o600});}
    return staged.map(f=>f.doc);
  }
  review(project:string,path:string,hash:string,status:'accepted'|'rejected') {const target=this.locate(project,path),doc=this.parse(project,path,readFileSync(target,'utf8'));if(doc.hash!==hash)fail('VERSION_CONFLICT');const file=this.internal(project,`.trash/markdown-reviews/${doc.id}.json`);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({hash,status,at:new Date().toISOString()}),{mode:0o600});return {...doc,status};}
  history(project:string,id:string){if(!/^[A-Za-z0-9_-]+$/.test(id))fail('INVALID_REQUEST',400);const dir=this.internal(project,`.trash/markdown-history/${id}`);return existsSync(dir)?readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.md$/.test(n)).map(n=>({hash:n.slice(0,-3),text:readFileSync(join(dir,n),'utf8')})):[];}
}

/** Adapter for workflow counters and dependency selection; Markdown remains the source. */
export function markdownVersions(store:TrashStore,project:string,kind:'literature-card'|'wiki-page'):(KnowledgeVersion & {stale?:boolean})[] {
  return new MarkdownKnowledge(store).list(project).documents.filter(d=>d.kind===kind&&d.card_type!=='key').map(doc=>({object_id:doc.id,stale:doc.stale,project_id:project,kind:doc.kind,version:1,status:doc.status as 'pending'|'accepted'|'rejected',title:doc.title,content:doc.kind==='wiki-page'?{title:doc.title,tags:[],body:doc.text,dependencies:[]}:{source_id:doc.source_id!,title:doc.title,tags:[],question:doc.text,method:'',contributions:'',limitations:'',datasets:[],baselines:[],metrics:[],reported_results:'',experimental_conditions:'',ideas:'',relevance:'',open_questions:'',evidence:[]},created_by:'agent' as const,created_at:doc.modified}));
}
