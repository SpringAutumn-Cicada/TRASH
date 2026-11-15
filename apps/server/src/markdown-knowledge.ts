import {paperCompatibility} from './paper-wiki.js';
import {markdownReferences,knowledgeBasePath,legacyKnowledgePath,knowledgePath,knowledgeDocumentId} from '@trash/protocol';
import {knowledgeFiles,migrationManifest,resolveBasePath,rewriteKnowledgeText} from './knowledge-base-migration.js';
import {knowledgeLinks,knowledgeAliases,type KnowledgeLink} from './knowledge-links.js';
import {parseBasicCard,applyBasicCard,sourceContentHash,legacySourceContentHash} from './source-bibliography.js';
import type { KnowledgeVersion } from "@trash/protocol";
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, realpathSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrashStore } from '@trash/storage';

export type MarkdownDocument={id:string;kind:'literature-card'|'wiki-page';source_id?:string;card_type?:'basic'|'detail'|'key';title:string;document_title?:string;path:string;text:string;hash:string;modified:string;status:string;stale?:boolean;level?:string;summary?:string;characters?:number;dependencies?:{path:string;hash:string}[];links?:KnowledgeLink[];aliases?:string[];material_scope?:'fulltext'|'abstract';coverage?:string;directions?:string;batch_label?:string;page_role?:string;pdf_hash?:string};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{statusCode});}
function rejectSymlink(path:string){try{if(lstatSync(path).isSymbolicLink())fail('KNOWLEDGE_PATH_INVALID',403);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
export const skillRoot=fileURLToPath(new URL('../../../.agents/skills/trash-literature-knowledge/',import.meta.url));
const knowledgeSkillFiles=['SKILL.md','references/wiki.md','references/paper-wiki.md','references/research-exploration.md'];
export function skillText(){return knowledgeSkillFiles.map(name=>readFileSync(join(skillRoot,name),'utf8')).join('\n\n');}
export function stageKnowledgeSkill(directory:string){
  // Remove obsolete staged rules when continuing a previously created task.
  for(const name of ['basic.md','cards.md']){const path=join(directory,'literature-skill','references',name);if(existsSync(path)){rejectSymlink(path);unlinkSync(path);}}
  for(const name of knowledgeSkillFiles){const target=join(directory,'literature-skill',name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(skillRoot,name),'utf8'),{mode:0o600});}
}
export class MarkdownKnowledge {
  constructor(private store:TrashStore){}
  root(project:string){if(!this.store.getProject(project))fail('PROJECT_NOT_FOUND',404);const root=join(this.store.root,'projects',project);mkdirSync(root,{recursive:true});return realpathSync(root);}
  locate(project:string,path:string){
    if(!legacyKnowledgePath.test(path)&&!knowledgeBasePath.test(path)&&!/^abstract-library\/(notes|wiki)\/source_[A-Za-z0-9_-]+\.md$/.test(path))fail('KNOWLEDGE_PATH_INVALID',400);
    const root=this.root(project);path=resolveBasePath(root,path);const target=resolve(root,path);let current=root;
    for(const part of path.split('/')){current=join(current,part);rejectSymlink(current);}
    if(!target.startsWith(root+sep))fail('KNOWLEDGE_PATH_INVALID',403);return target;
  }
  private internal(project:string,path:string){const root=this.root(project);let current=root;for(const part of path.split('/')){current=join(current,part);rejectSymlink(current);}return current;}
  parse(project:string,path:string,text:string):MarkdownDocument{
    if(Buffer.byteLength(text)>1024*1024||text.includes('\0'))fail('KNOWLEDGE_FILE_INVALID',422);
    const references=markdownReferences(text);if(references.unresolved.length)fail('KNOWLEDGE_REFERENCE_UNDEFINED',422);
    const match=text.replace(/\r\n/g,'\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);if(!match)fail('KNOWLEDGE_FILE_INVALID',422);
    const meta:Record<string,string>={};for(const line of match[1].split('\n')){const m=line.match(/^([a-z_]+):\s*([A-Za-z0-9_-]+)\s*$/);if(m){if(meta[m[1]])fail('KNOWLEDGE_FILE_INVALID',422);meta[m[1]]=m[2];}}
    const kind=meta.kind==='wiki-page'?'wiki-page':'literature-card';
    if(kind==='literature-card'||(path.includes('/papers/')&&paperCompatibility(path.split('/papers/')[1]?.split('/').slice(1).join('/')??'')))fail('LEGACY_CARD_REMOVED',410);
    if(meta.kind!==kind||!meta.id||meta.id.length>180||knowledgeDocumentId(path)!==meta.id)fail('KNOWLEDGE_FILE_INVALID',422);
    if(kind==='wiki-page'&&!meta.id.startsWith('wiki-'))fail('KNOWLEDGE_FILE_INVALID',422);
    if(path.includes('/papers/')&&meta.id.includes('--')&&(kind!=='wiki-page'||meta.level!=='single'||!meta.source_id||!path.startsWith(`knowledge_base/papers/${meta.source_id}/`)))fail('KNOWLEDGE_FILE_INVALID',422);
    if(meta.source_id&&this.store.getSource(meta.source_id)?.project_id!==project)fail('SOURCE_NOT_FOUND',404);
    if(/\/evidence\/ev-[a-z0-9][a-z0-9_-]*\.md$/.test(path)&&(meta.page_role!=='evidence'||!(/^(?:[a-f0-9]{64}|unknown)$/.test(meta.pdf_hash??''))))fail('EVIDENCE_METADATA_REQUIRED',422);
    const title=match[2].match(/^#\s+(.+)$/m)?.[1]?.trim();if(!title)fail('KNOWLEDGE_FILE_INVALID',422);
    if(meta.card_type==='basic')parseBasicCard(text);
    const hash=digest(text);
    const section=(heading:string)=>match[2].split(/^##\s+/m).slice(1).find(part=>part.split('\n')[0].trim()===heading)?.split('\n').slice(1).join('\n').trim();
    return {page_role:meta.page_role,pdf_hash:meta.pdf_hash,material_scope:'fulltext',coverage:section('材料范围'),directions:section('覆盖方向'),batch_label:section('批次标识')??(/^文献知识第\d+层分组\d+$/.test(title)?title:undefined),links:knowledgeLinks(path,text),aliases:knowledgeAliases(text),id:meta.id,kind,source_id:meta.source_id,card_type:meta.card_type as 'basic'|'detail'|'key'|undefined,title,path,text,hash,modified:new Date().toISOString(),status:'accepted',level:/^文献知识第\d+层分组\d+$/.test(title)?'summary':meta.level??(meta.source_id?'single':'topic'),summary:(markdownReferences(match[2]).text.match(/^## (?:概览|一句话认识|何时读取|适用问题)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]??match[2]).replace(/^#+[^\n]*$/gm,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/\s+/g,' ').trim().slice(0,180),characters:text.length};
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
    const migrated=migrationManifest(this.root(project));
    const scan=migrated?knowledgeFiles(this.root(project),'knowledge_base').filter(path=>knowledgeBasePath.test(path)&&!path.includes('/abstracts/')):['literature/cards','wiki'].flatMap(dir=>knowledgeFiles(this.root(project),dir));
    for(const path of scan.filter(path=>!path.startsWith('literature/cards/')&&!(path.includes('/papers/')&&paperCompatibility(path.split('/papers/')[1].split('/').slice(1).join('/'))))){try{const physical=this.locate(project,path),info=lstatSync(physical),signature=`knowledge-evidence-split-7:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      if(!force&&old[path]?.signature===signature)entries[path]=old[path];
      else{if(info.size>1024*1024)fail('KNOWLEDGE_FILE_INVALID',422);const text=readFileSync(physical,'utf8');if(!this.isCurrent(text)){entries[path]={signature};continue;}const {text:body,...document}=this.parse(project,path,text);void body;document.modified=info.mtime.toISOString();entries[path]={signature,document};}
      if(entries[path].error)errors.push({path,error:entries[path].error!});
    }catch(error){entries[path]={signature:'error',error:error instanceof Error?error.message:'KNOWLEDGE_FILE_INVALID'};errors.push({path,error:entries[path].error!});}}
    for(const source of this.store.listSources(project,true).filter(source=>source.material_scope==='abstract'))for(const area of ['notes','wiki'] as const){
      const path=migrated?knowledgePath('abstract-library/'+area+'/'+source.source_id+'.md'):'abstract-library/'+area+'/'+source.source_id+'.md';
      const file=this.internal(project,path);if(!existsSync(file))continue;
      const text=readFileSync(file,'utf8');if(!text.trim())continue;
      const id=(area==='wiki'?'abstract-wiki-':'abstract-note-')+source.source_id;
      entries[path]={signature:'abstract:'+digest(text),document:{id,kind:area==='wiki'?'wiki-page':'literature-card',card_type:area==='wiki'?undefined:'detail',material_scope:'abstract',level:'abstract',source_id:source.source_id,title:source.title,path,hash:digest(text),modified:lstatSync(file).mtime.toISOString(),status:'accepted',summary:text.replace(/^#+.*$/gm,'').replace(/\s+/g,' ').slice(0,180),links:knowledgeLinks(path,text)}};
    }
    this.store.db.transaction(()=>{for(const [path,entry] of Object.entries(entries)){if(!entry.document){this.store.db.prepare('DELETE FROM knowledge_search_v2 WHERE project=? AND path=?').run(project,path);continue;}const cached=this.store.db.prepare('SELECT hash FROM knowledge_search_v2 WHERE project=? AND path=?').get(project,path) as {hash:string}|undefined;if(force||cached?.hash!==entry.document.hash)this.store.db.prepare('INSERT OR REPLACE INTO knowledge_search_v2(project,path,hash,text) VALUES(?,?,?,?)').run(project,path,entry.document.hash,readFileSync(this.locate(project,path),'utf8'));}for(const row of this.store.db.prepare('SELECT path FROM knowledge_search_v2 WHERE project=?').all(project) as {path:string}[])if(!entries[row.path]?.document)this.store.db.prepare('DELETE FROM knowledge_search_v2 WHERE project=? AND path=?').run(project,row.path);})();
    if(force||JSON.stringify(entries)!==JSON.stringify(old))this.writeIndex(project,{version:2,entries});
    const displayTitle=(d:Omit<MarkdownDocument,'text'>)=>d.source_id&&!d.id.includes('--')?(this.store.getSource(d.source_id)?.title||d.title):d.title;
    const lines=['# Wiki 导航','平台生成，可从 Markdown 重建；按需检索，不要求每轮全文读取。',''];
    for(const entry of Object.values(entries)){const d=entry.document;if(d?.kind==='wiki-page')lines.push(`- [${displayTitle(d).replace(/[\[\]\r\n]/g,' ')}](../${d.path}) · ${d.level} · ${d.summary??''}`);}
    const navigation=this.internal(project,'.trash/wiki-index.md'),navigationText=lines.join('\n')+'\n';
    if(!existsSync(navigation)||readFileSync(navigation,'utf8')!==navigationText){mkdirSync(dirname(navigation),{recursive:true});writeFileSync(navigation+'.tmp',navigationText,{mode:0o600});renameSync(navigation+'.tmp',navigation);}
    if(migrated){
      const homepage=['# 知识库','原始全文与摘要分开管理；卡片、研究记忆与主题统一导航。',''];
      const paperEntry=(d:Omit<MarkdownDocument,'text'>)=>d.path.includes('/papers/')&&(d.path===`knowledge_base/papers/${d.source_id}/whoami.md`||(!Object.values(entries).some(entry=>entry.document?.path===`knowledge_base/papers/${d.source_id}/whoami.md`)&&(d.path===`knowledge_base/papers/${d.source_id}/index.md`||(!Object.values(entries).some(entry=>entry.document?.path===`knowledge_base/papers/${d.source_id}/index.md`)&&(d.id===`wiki-${d.source_id}`||d.card_type==='key')))));
      for(const [label,test] of [['项目总览',(d:Omit<MarkdownDocument,'text'>)=>d.level==='overview'],['论文知识',paperEntry],['摘要知识',(d:Omit<MarkdownDocument,'text'>)=>d.material_scope==='abstract'&&(d.kind==='wiki-page'||!Object.values(entries).some(entry=>entry.document?.source_id===d.source_id&&entry.document?.kind==='wiki-page'))],['知识主题',(d:Omit<MarkdownDocument,'text'>)=>d.level==='topic'],['研究假设',(d:Omit<MarkdownDocument,'text'>)=>d.level==='hypothesis'],['发现清单',(d:Omit<MarkdownDocument,'text'>)=>d.level==='discovery'],['分批总结',(d:Omit<MarkdownDocument,'text'>)=>d.level==='summary']] as const){
        homepage.push('## '+label);for(const entry of Object.values(entries)){const doc=entry.document;if(doc&&test(doc))homepage.push('- ['+displayTitle(doc).replace(/[\[\]\r\n]/g,' ')+(doc.card_type?' · '+doc.card_type:'')+']('+doc.path.replace(/^knowledge_base\//,'')+')');}
      }
      const home=this.internal(project,'knowledge_base/index.md'),body=homepage.join('\n')+'\n';if(!existsSync(home)||readFileSync(home,'utf8')!==body){writeFileSync(home+'.tmp',body,{mode:0o600});renameSync(home+'.tmp',home);}
    }
    const documents=Object.values(entries).flatMap(e=>e.document?[{...e.document}]:[]);
    for(const doc of documents){
      if(doc.kind==='wiki-page'&&doc.level==='single'){doc.document_title=doc.title;doc.title=displayTitle(doc);}
      doc.status='accepted'; // Legacy wire status: validated Markdown is immediately usable.
      if(doc.material_scope==='abstract'){doc.stale=false;continue;}
      if(doc.source_id){try{const stamp=JSON.parse(readFileSync(this.internal(project,`.trash/knowledge-sources/${doc.id}.json`),'utf8'));doc.stale=stamp.hash!==sourceContentHash(this.store.getSource(doc.source_id))&&stamp.hash!==legacySourceContentHash(this.store.getSource(doc.source_id));}catch{doc.stale=true;}}
      if(doc.card_type==='key'){const detail=documents.find(d=>d.source_id===doc.source_id&&d.card_type==='detail');try{const pair=JSON.parse(readFileSync(this.internal(project,`.trash/markdown-pairs/${doc.id}.json`),'utf8'));doc.stale=Boolean(doc.stale)||!detail||(Object.entries(migrated?.beforeHashes??{}).some(([path,hash])=>hash===pair.detail&&migrated?.afterHashes?.[migrated.paths[path]]===detail.hash)?false:pair.detail!==detail.hash)||(Object.entries(migrated?.beforeHashes??{}).some(([path,hash])=>hash===pair.key&&migrated?.afterHashes?.[migrated.paths[path]]===doc.hash)?false:pair.key!==doc.hash);}catch{doc.stale=true;}}
      if(doc.kind==='wiki-page'){try{const stamp=JSON.parse(readFileSync(this.internal(project,`.trash/markdown-dependencies/${doc.id}.json`),'utf8')) as {path:string;hash:string}[];doc.dependencies=stamp.map(ref=>{const path=resolveBasePath(this.root(project),ref.path);return {path,hash:migrated?.beforeHashes?.[ref.path]===ref.hash?migrated.afterHashes?.[path]??ref.hash:ref.hash};});doc.stale=Boolean(doc.stale)||doc.dependencies.some(ref=>documents.find(d=>d.path===ref.path)?.hash!==ref.hash);}catch{doc.dependencies=[];doc.stale=true;}}
    }
    // Propagate invalidation through the actual dependency graph, including missing files.
    for(let i=0;i<documents.length;i++){let changed=false;for(const doc of documents)if(!doc.stale&&doc.dependencies?.some(ref=>documents.find(d=>d.path===ref.path)?.stale)){doc.stale=true;changed=true;}if(!changed)break;}
    return {documents:documents.sort((a,b)=>b.modified.localeCompare(a.modified)),errors};
  }
  read(project:string,id:string){
    if(id.startsWith('abstract-material-')){
      const source=this.store.getSource(id.slice('abstract-material-'.length));
      if(!source||source.project_id!==project||source.material_scope!=='abstract')fail('SOURCE_NOT_FOUND',404);
      const text='# '+source.title+'\n\n'+source.authors.join(', ')+'\n\n'+(source.publication_date??'')+'\n\n'+(source.abstract??'');
      return {id,kind:'literature-card' as const,material_scope:'abstract' as const,card_type:'detail' as const,level:'abstract',title:source.title,source_id:source.source_id,path:'abstract-library/materials/'+source.source_id+'.md',text,hash:digest(text),modified:source.imported_at,status:'accepted',stale:false};
    }
    const entry=this.index(project).documents.find(d=>d.id===id);if(!entry)fail('NOT_FOUND',404);const text=readFileSync(this.locate(project,entry.path),'utf8');if(digest(text)!==entry.hash)fail('VERSION_CONFLICT');return {...entry,text};}
  list(project:string){const indexed=this.index(project);return {...indexed,documents:indexed.documents.map(d=>this.read(project,d.id))};}
  query(project:string,options:{page?:number;limit?:number;kind?:string;level?:string;q?:string;rescan?:boolean;include_summaries?:boolean}={}){
    const indexed=this.index(project,options.rescan),q=options.q?.trim().toLowerCase();let docs=indexed.documents.filter(d=>(!options.kind||d.kind===options.kind)&&(!options.level||d.level===options.level));
    if(options.kind==='wiki-page'&&!options.level&&!q&&!options.include_summaries)docs=docs.filter(doc=>doc.level!=='summary');
    const matches:Record<string,string>={};if(q)docs=docs.filter(doc=>{if((doc.title+' '+(doc.aliases??[]).join(' ')+' '+doc.summary).toLowerCase().includes(q))return true;const hit=this.store.db.prepare('SELECT substr(text,max(1,instr(lower(text),?)-70),220) AS snippet FROM knowledge_search_v2 WHERE project=? AND path=? AND instr(lower(text),?)>0').get(q,project,doc.path,q) as {snippet:string}|undefined;if(!hit)return false;matches[doc.id]=hit.snippet;return true;});
    const rank:Record<string,number>={overview:0,topic:1,hypothesis:2,discovery:3,single:4,summary:5};docs.sort((a,b)=>(rank[a.level??'']??4)-(rank[b.level??'']??4)||b.modified.localeCompare(a.modified));
    const limit=Math.min(100,Math.max(1,options.limit??30)),page=Math.max(1,options.page??1);return {documents:docs.slice((page-1)*limit,page*limit).map(d=>({...d,...(matches[d.id]?{snippet:matches[d.id]}:{})})),total:docs.length,page,limit,errors:indexed.errors};
  }
  graph(project:string){
    const {documents,errors}=this.index(project);
    const nodes=documents.map(d=>({id:d.id,path:d.path,title:d.title,kind:d.kind,level:d.level,source_id:d.source_id,card_type:d.card_type,batch_label:d.batch_label,coverage:d.coverage,directions:d.directions,summary:d.summary??'',stale:Boolean(d.stale)}));
    // Abstract records share the directory index but remain excluded from full-text synthesis adapters.
    const byPath=new Map(nodes.map(n=>[n.path,n]));for(const [old,path] of Object.entries(migrationManifest(this.root(project))?.paths??{})){const target=byPath.get(path);if(target)byPath.set(old,target);}
    const edges:{id:string;source:string;target:string;relation:string;reason:string;evidence:boolean}[]=[],broken:{source:string;path:string}[]=[];
    for(const doc of documents){
      for(const link of doc.links??[]){const target=byPath.get(link.path);if(!target){broken.push({source:doc.id,path:link.path});continue;}if(target.id===doc.id)continue;
        const evidence=link.evidence||Boolean(doc.dependencies?.some(ref=>ref.path===link.path));
        const key=digest(JSON.stringify([doc.id,target.id,link.relation,link.reason,evidence])).slice(0,24);
        if(!edges.some(e=>e.id===key))edges.push({id:key,source:doc.id,target:target.id,relation:evidence?'依据':link.relation,reason:link.reason,evidence});
      }
      for(const ref of doc.dependencies??[]){const target=byPath.get(ref.path);if(!target){broken.push({source:doc.id,path:ref.path});continue;}if(target.id===doc.id||edges.some(e=>e.source===doc.id&&e.target===target.id&&e.evidence))continue;
        edges.push({id:digest(doc.id+':dependency:'+target.id).slice(0,24),source:doc.id,target:target.id,relation:'依据',reason:'生成或编辑时记录的依据',evidence:true});
      }
    }
    return {nodes,edges,broken,errors,total:nodes.length,version:digest(JSON.stringify({nodes,edges,broken,errors})),note:'只呈现实际链接与历史依据；空间接近不代表语义关系，节点大小不表示质量。'};
  }
  relations(project:string,id:string){
    const docs=this.index(project).documents,doc=docs.find(d=>d.id===id);if(!doc)fail('NOT_FOUND',404);
    const describe=(path:string)=>{const target=docs.find(d=>d.path===path);return {id:target?.id,path,title:target?.title??path,missing:!target,stale:target?.stale??false};};
    return {
      id,
      evidence:(doc.dependencies??[]).map(ref=>({...describe(ref.path),hash:ref.hash,changed:docs.find(d=>d.path===ref.path)?.hash!==ref.hash,relation:'依据',reason:doc.links?.find(l=>l.path===ref.path&&l.evidence)?.reason??'生成或编辑时记录的依据'})),
      related:(doc.links??[]).filter(link=>!link.evidence).map(link=>({...describe(link.path),relation:link.relation,reason:link.reason})),
      backlinks:docs.filter(d=>d.id!==id).flatMap(d=>{
        const links=(d.links??[]).filter(l=>l.path===doc.path);
        if(links.length)return links.map(l=>({...describe(d.path),relation:l.relation,reason:l.reason,evidence:l.evidence,source_line:l.source_line,source_section:l.source_section,source_anchor:l.source_anchor}));
        return d.dependencies?.some(r=>r.path===doc.path)?[{...describe(d.path),relation:'依据',reason:'生成时作为依据',evidence:true}]:[];
      }),
      broken:(doc.links??[]).filter(link=>!docs.some(d=>d.path===link.path)).map(link=>({...describe(link.path),relation:link.relation,reason:link.reason}))
    };
  }
  health(project:string){
    const {documents:docs,errors}=this.index(project);
    const links=docs.flatMap(d=>(d.links??[]).map(link=>({from:d.id,...link})));
    return {documents:docs.length,edges:links.length,
      broken:links.filter(link=>!docs.some(d=>d.path===link.path)),
      orphans:docs.filter(d=>d.kind==='wiki-page'&&d.level!=='overview'&&!d.links?.length&&!d.dependencies?.length&&!links.some(link=>link.path===d.path)).map(d=>({id:d.id,title:d.title})),
      stale:docs.filter(d=>d.stale).map(d=>({id:d.id,title:d.title})),
      duplicate_titles:docs.filter(d=>d.kind==='wiki-page').flatMap((d,i,all)=>all.slice(i+1).filter(other=>other.title.replace(/\s/g,'').toLowerCase()===d.title.replace(/\s/g,'').toLowerCase()).map(other=>({ids:[d.id,other.id],title:d.title}))),errors,
      note:'仅结构检查；结论真实性、语义重复与分歧需要阅读证据后判断。'};
  }
  navigation(project:string,options:{page?:number;limit?:number;q?:string}={}){
    const result=this.query(project,{...options,kind:'wiki-page'});
    return {...result,documents:result.documents.map(d=>({id:d.id,path:d.path,title:d.title,aliases:d.aliases,level:d.level,summary:d.summary,material_scope:d.material_scope,coverage:d.coverage,directions:d.directions,batch_label:d.batch_label,stale:d.stale,hash:d.hash}))};
  }
  context(project:string,query:string,budget=16000){
    const docs=this.index(project).documents;
    const terms=[...new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(query.toLowerCase())].filter(item=>item.isWordLike&&item.segment.length>1).map(item=>item.segment))].slice(0,30);
    const score=(d:typeof docs[number])=>terms.reduce((n,t)=>n+Number((d.title+' '+(d.aliases??[]).join(' ')).toLowerCase().includes(t))*8,0);
    const hits=terms.length?new Map((this.store.db.prepare(`SELECT path,(${terms.map(()=>"CASE WHEN instr(lower(text),?)>0 THEN 1 ELSE 0 END").join('+')}) AS score FROM knowledge_search_v2 WHERE project=?`).all(...terms,project) as {path:string;score:number}[]).map(row=>[row.path,row.score])):new Map<string,number>();
    const ranked=docs.filter(d=>d.page_role!=='evidence'&&d.page_role!=='evidence-index'&&!d.path.endsWith('/evidence.md')&&(d.kind==='wiki-page'||d.card_type==='key')).map(d=>({d,score:score(d)+(hits.get(d.path)??0)+Number((d.summary??'').toLowerCase().includes(query.toLowerCase()))*2})).filter(v=>v.score>0).sort((a,b)=>b.score-a.score);
    const selected=ranked.slice(0,6).map(v=>v.d);
    for(const d of [...selected])for(const path of [...(d.dependencies??[]).map(r=>r.path),...(d.links??[]).map(l=>l.path)]){
      const related=docs.find(item=>item.path===path);if(related&&related.page_role!=='evidence'&&related.page_role!=='evidence-index'&&!related.path.endsWith('/evidence.md')&&!selected.some(item=>item.id===related.id)&&selected.length<10)selected.push(related);
    }
    let remaining=Math.min(24000,Math.max(1000,budget));const omitted:string[]=[];
    const records=selected.flatMap(d=>{const text=this.read(project,d.id).text;if(text.length>remaining){omitted.push(d.id);return [];}remaining-=text.length;return [{id:d.id,path:d.path,title:d.title,hash:d.hash,stale:d.stale,text}];});
    const evidencePaths=new Set(selected.filter(d=>records.some(record=>record.id===d.id)).flatMap(d=>(d.links??[]).filter(link=>link.evidence).map(link=>link.path)));
    const evidence_candidates=docs.filter(d=>evidencePaths.has(d.path)).map(d=>({id:d.id,path:d.path,title:d.title,hash:d.hash,source_id:d.source_id,summary:d.summary,stale:d.stale}));
    return {query,documents:records,evidence_candidates,omitted,characters:records.reduce((n,d)=>n+d.text.length,0),candidates:ranked.length,note:'先读匹配职责页及一跳知识关联；evidence_candidates仅为未读目录，按需用evidence/get查支撑与反例，不能声称已查阅。'};
  }
  evidence(project:string,id:string){
    const record=this.read(project,id);
    if(!/\/evidence\/ev-[a-z0-9][a-z0-9_-]*\.md$/.test(record.path)||!('page_role' in record)||record.page_role!=='evidence')fail('EVIDENCE_RECORD_REQUIRED',422);
    return {record,citations:this.relations(project,id).backlinks.filter(link=>link.evidence),note:'引用位置基于当前正文解析；返回的依据内容不代表重新核验PDF。'};
  }
  recordOperation(project:string,operation:string,documents:{id:string;path:string;hash:string}[],note=''){
    this.store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_memory_events(id TEXT PRIMARY KEY,project TEXT NOT NULL,at TEXT NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL)');
    const at=new Date().toISOString();
    this.store.db.prepare('INSERT INTO knowledge_memory_events VALUES(?,?,?,?,?)').run(randomUUID(),project,at,operation,JSON.stringify({documents,note}));
    const file=this.internal(project,'.trash/wiki-log.md');mkdirSync(dirname(file),{recursive:true});
    if(migrationManifest(this.root(project))){const log=this.internal(project,'knowledge_base/maintenance/log.md');appendFileSync(log,'\n## '+at+' · '+operation+'\n'+documents.map(doc=>'- '+doc.path).join('\n')+'\n'+note.replace(/\r?\n/g,' ')+'\n',{mode:0o600});}
    appendFileSync(file,`## [${at}] ${operation}\n${documents.map(d=>`- ${d.path} @ ${d.hash}`).join('\n')}\n${note.replace(/\r?\n/g,' ')}\n\n`,{mode:0o600});
  }
  operations(project:string,page=1){
    this.store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_memory_events(id TEXT PRIMARY KEY,project TEXT NOT NULL,at TEXT NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL)');
    const total=(this.store.db.prepare('SELECT count(*) AS n FROM knowledge_memory_events WHERE project=?').get(project) as {n:number}).n;
    const events=(this.store.db.prepare('SELECT id,at,operation,data FROM knowledge_memory_events WHERE project=? ORDER BY at DESC,id DESC LIMIT 30 OFFSET ?').all(project,(Math.max(1,page)-1)*30) as {id:string;at:string;operation:string;data:string}[]).map(row=>({...row,...JSON.parse(row.data),data:undefined}));
    return {events,total,page,limit:30};
  }
  stamp(project:string,id:string,refs:{path:string;hash:string}[],merge=false){const file=this.internal(project,`.trash/markdown-dependencies/${id}.json`);mkdirSync(dirname(file),{recursive:true});if(merge){try{const previous=JSON.parse(readFileSync(file,'utf8')) as {path:string;hash:string}[];refs=[...previous.filter(old=>!refs.some(ref=>ref.path===old.path)),...refs];}catch{/* First stamp. */}}writeFileSync(file,JSON.stringify(refs),{mode:0o600});}
  private recover(project:string){
    const journal=this.internal(project,'.trash/markdown-transaction.json');if(!existsSync(journal))return;
    const batch=JSON.parse(readFileSync(journal,'utf8')) as {committed:boolean;files:{path:string;text:string;before:string|null}[]};
    for(const file of batch.files){const target=this.locate(project,file.path);const current=existsSync(target)?readFileSync(target,'utf8'):null;if(current!==file.text&&current!==file.before)fail('VERSION_CONFLICT');const wanted=batch.committed?file.text:file.before;if(wanted===null){if(existsSync(target))unlinkSync(target);}else{mkdirSync(dirname(target),{recursive:true});const temp=target+'.recovery.tmp';writeFileSync(temp,wanted,{mode:0o600});renameSync(temp,target);}}
    unlinkSync(journal);
  }
  summaryNamePreview(project:string){
    return this.index(project).documents.filter(doc=>doc.level==='summary'&&/^文献知识第\d+层分组\d+$/.test(doc.title)).map(doc=>{
      const text=this.read(project,doc.id).text;
      const headings=[...text.matchAll(/^## (?:知识主题|候选线索|研究假设)[：:]\s*(.+)$/gm)].map(match=>match[1].trim()).filter(title=>title.length>=4&&title.length<=60);
      return {id:doc.id,path:doc.path,title:doc.title,hash:doc.hash,text,summary:doc.summary,suggested:headings.length?headings.slice(0,2).join('、')+'：分批总结':'',basis:headings.length?'依据正文中的具体问题标题':'正文缺少明确问题标题，请阅读后填写',headings};
    });
  }
  renameSummary(project:string,id:string,title:string,expected:string){
    const doc=this.read(project,id);
    if(doc.level!=='summary')fail('INVALID_REQUEST',400);
    if(doc.hash!==expected)fail('VERSION_CONFLICT');
    if(/^文献知识第\d+层分组\d+$/.test(title)||/[\r\n]/.test(title))fail('INVALID_REQUEST',400);
    let text=doc.text.replace(/^#\s+.+$/m,()=> '# '+title);
    text=text.replace(/^level:\s*[^\r\n]+$/m,'level: summary');
    if(!/^level:/m.test(text.split(/---\r?\n/)[1]??''))text=text.replace(/^(---\r?\n)/,'$1level: summary\n');
    const alias=doc.title.replace(/[\r\n]/g,' ');
    if(/^## 别名\s*$/m.test(text))text=text.replace(/^(## 别名\s*\n)/m,()=> '## 别名\n'+alias+'、');
    else text+='\n## 别名\n'+alias+'\n';
    if(!/^## 批次标识\s*$/m.test(text))text+='\n## 批次标识\n'+doc.title+'\n';
    return this.save(project,doc.path,text,expected);
  }
  save(project:string,path:string,text:string,expected:string|null){return this.commit(project,[{path,text,expected}])[0];}
  commit(project:string,files:{path:string;text:string;expected:string|null}[],baselines:Record<string,{authors?:string[];title:string;publication_date?:string;year?:number;revision?:number}>={}){
    this.recover(project);
    if(!files.length||files.length>128||new Set(files.map(f=>f.path)).size!==files.length)fail('INVALID_REQUEST',400);
    const targets=files.map(original=>{const normalized=original.text.replace(/\r\n/g,'\n');const text=normalized.replace(/^---\n([\s\S]*?)\n---\n/,(_all,front:string)=>'---\nknowledge_version: 2\n'+front.replace(/^knowledge_version:.*\n?/gm,'')+'\n---\n');const manifest=migrationManifest(this.root(project));const nextPath=manifest?.paths[original.path]??knowledgePath(original.path,text.match(/^level:\s*(\S+)/m)?.[1]);const file={...original,path:manifest?nextPath:original.path,text:manifest&&nextPath!==original.path?rewriteKnowledgeText(text,original.path,nextPath,manifest.paths):text};const target=this.locate(project,file.path),before=existsSync(target)?readFileSync(target,'utf8'):null;if((before===null?null:digest(before))!==file.expected)fail('VERSION_CONFLICT');return {...file,target,before,doc:this.parse(project,file.path,file.text)};});
    for(const target of targets.filter(t=>t.doc.card_type==='basic' || t.doc.path.endsWith('/idcard.md') || t.doc.path.includes('/idcard-')))if(target.doc.path.endsWith('/idcard.md')===false)parseBasicCard(target.text);
    if(targets.length>1&&!targets.some(t=>t.doc.path.includes('/idcard'))&&!targets.every(t=>t.doc.kind==='wiki-page')&&!targets.some(t=>t.doc.source_id&&['index.md','whoami.md'].some(name=>t.doc.path===`knowledge_base/papers/${t.doc.source_id}/${name}`))){
      const cards=targets.filter(t=>t.doc.kind==='literature-card'),wiki=targets.filter(t=>t.doc.kind==='wiki-page');
      const types=new Set(cards.map(t=>t.doc.card_type));
      if(!cards.length||!cards[0].doc.source_id||targets.some(t=>t.doc.source_id!==cards[0].doc.source_id)||types.size!==cards.length||!types.has('detail')||!types.has('key')||wiki.length>1||wiki.some(t=>t.doc.id!==`wiki-${cards[0].doc.source_id}`)||(targets.length===4&&!types.has('basic')))fail('INVALID_REQUEST',400);
    }
    const paperRoots=targets.filter(t=>['index.md','whoami.md'].some(name=>t.doc.path===`knowledge_base/papers/${t.doc.source_id}/${name}`));
    for(const root of paperRoots){
      const prefix=`knowledge_base/papers/${root.doc.source_id}/`;
      if(targets.some(t=>t.doc.source_id!==root.doc.source_id||!t.doc.path.startsWith(prefix)))fail('INVALID_REQUEST',400);
      const paths=new Set(targets.map(t=>t.doc.path));
      for(const target of targets)for(const link of target.doc.links??[])if(link.path.startsWith(prefix)&&!paths.has(link.path)&&!existsSync(this.locate(project,link.path)))fail('KNOWLEDGE_LINK_MISSING',422);
      const reachable=new Set([root.doc.path]);let grew=true;while(grew){grew=false;for(const target of targets)if(reachable.has(target.doc.path))for(const link of target.doc.links??[])if(paths.has(link.path)&&!reachable.has(link.path)){reachable.add(link.path);grew=true;}}
      if(targets.some(t=>!t.doc.card_type&&!paperCompatibility(t.doc.path.slice(prefix.length))&&!reachable.has(t.doc.path)))fail('KNOWLEDGE_ORPHAN_PAGE',422);
    }
    for(const target of targets)for(const link of target.doc.links??[])if(link.fragment){
      const staged=targets.find(t=>t.path===link.path);const physical=this.locate(project,link.path);
      const body=staged?.text??(existsSync(physical)?readFileSync(physical,'utf8'):undefined);
      if(link.path.endsWith('/evidence.md')&&(!body||!body.split('\n').some(line=>line.trim()==='## '+link.fragment)))fail('KNOWLEDGE_ANCHOR_MISSING',422);
    }
    // All checks and writes are synchronous: no other server request can interleave this commit.
    const previousDependencies=new Map(this.index(project).documents.map(d=>[d.path,d.dependencies??[]]));
    const staged=targets.map(file=>{mkdirSync(dirname(file.target),{recursive:true});const temp=file.target+'.'+randomUUID()+'.tmp';writeFileSync(temp,file.text,{mode:0o600,flag:'wx'});return {...file,temp};});
    const journal=this.internal(project,'.trash/markdown-transaction.json');mkdirSync(dirname(journal),{recursive:true});
    const transaction={committed:false,files:targets.map(({path,text,before})=>({path,text,before}))};
    writeFileSync(journal,JSON.stringify(transaction),{mode:0o600,flag:'wx'});
    try{
      for(const file of staged){const history=this.internal(project,`.trash/markdown-history/${file.doc.id}`);mkdirSync(history,{recursive:true});if(file.before!==null)writeFileSync(join(history,digest(file.before)+'.md'),file.before,{mode:0o600});renameSync(file.temp,file.target);writeFileSync(join(history,file.doc.hash+'.md'),file.text,{mode:0o600});}
      const complete=journal+'.tmp';writeFileSync(complete,JSON.stringify({...transaction,committed:true}),{mode:0o600});renameSync(complete,journal);unlinkSync(journal);
    }catch(error){this.recover(project);throw error;}
    for(const file of staged.filter(f=>f.doc.card_type==='basic')){const source=this.store.getSource(file.doc.source_id!);if(source)this.store.db.transaction(()=>applyBasicCard(this.store,source,file.text,file.doc.hash,baselines[source.source_id]))();}
    const detail=staged.find(f=>f.doc.card_type==='detail'),key=staged.find(f=>f.doc.card_type==='key');if(detail&&key&&detail.doc.source_id===key.doc.source_id){const stamp=this.internal(project,`.trash/markdown-pairs/${key.doc.id}.json`);mkdirSync(dirname(stamp),{recursive:true});writeFileSync(stamp,JSON.stringify({detail:detail.doc.hash,key:key.doc.hash}),{mode:0o600});}
    for(const file of staged.filter(file=>file.doc.kind==='wiki-page')){
      const refs=(file.doc.links??[]).filter(link=>link.evidence).flatMap(link=>{try{const target=this.locate(project,link.path);const old=previousDependencies.get(file.path)?.find(ref=>ref.path===link.path);return existsSync(target)?[old??{path:link.path,hash:digest(readFileSync(target,'utf8'))}]:[{path:link.path,hash:old?.hash??'missing'}];}catch{return [];}});
      this.stamp(project,file.doc.id,refs);
    }
    for(const file of staged.filter(f=>f.doc.source_id)){const stamp=this.internal(project,`.trash/knowledge-sources/${file.doc.id}.json`);mkdirSync(dirname(stamp),{recursive:true});writeFileSync(stamp,JSON.stringify({hash:sourceContentHash(this.store.getSource(file.doc.source_id!))}),{mode:0o600});}
    this.recordOperation(project,'publish',staged.map(f=>({id:f.doc.id,path:f.path,hash:f.doc.hash})));
    return staged.map(f=>f.doc);
  }
  history(project:string,id:string){if(!/^[A-Za-z0-9_-]+$/.test(id))fail('INVALID_REQUEST',400);const dir=this.internal(project,`.trash/markdown-history/${id}`);return existsSync(dir)?readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.md$/.test(n)).map(n=>({hash:n.slice(0,-3),text:readFileSync(join(dir,n),'utf8')})):[];}
}

/** Adapter for workflow counters and dependency selection; Markdown remains the source. */
export function markdownVersions(store:TrashStore,project:string,kind:'literature-card'|'wiki-page'):(KnowledgeVersion & {stale?:boolean})[] {
  return new MarkdownKnowledge(store).list(project).documents.filter(d=>d.material_scope!=='abstract'&&d.kind===kind&&(!d.card_type||d.card_type==='detail')).map(doc=>({object_id:doc.id,stale:doc.stale,project_id:project,kind:doc.kind,version:1,status:doc.status as 'pending'|'accepted'|'rejected',title:doc.title,content:doc.kind==='wiki-page'?{title:doc.title,tags:[],body:doc.text,dependencies:[]}:{source_id:doc.source_id!,title:doc.title,tags:[],question:doc.text,method:'',contributions:'',limitations:'',datasets:[],baselines:[],metrics:[],reported_results:'',experimental_conditions:'',ideas:'',relevance:'',open_questions:'',evidence:[]},created_by:'agent' as const,created_at:doc.modified}));
}
