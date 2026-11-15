import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {knowledgeDocumentId,markdownReferences} from '@trash/protocol';
import type {MarkdownKnowledge} from './markdown-knowledge.js';
import {resolveKnowledgeLink} from './knowledge-links.js';
import {paperWikiIssues} from './paper-wiki.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const strip=(text:string)=>text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
const front=(path:string,source:string,role?:string,pdf?:string,scope?:string)=>`---\nknowledge_version: 2\nid: ${knowledgeDocumentId(path)}\nkind: wiki-page\nsource_id: ${source}\nlevel: single\n${role?'page_role: '+role+'\n':''}${pdf?'pdf_hash: '+pdf+'\n':''}${role==='evidence'?'verification: not-reverified\n':''}${scope?'scope_ref: '+scope+'\n':''}---\n`;
function plan(md:MarkdownKnowledge,project:string,source:string){
 const prefix=`knowledge_base/papers/${source}/`,all=md.index(project).documents;
 const docs=all.filter(d=>d.path.startsWith(prefix)).map(d=>md.read(project,d.id));
 const index=docs.find(d=>d.path===prefix+'evidence.md');
 if(!index)throw Object.assign(new Error('EVIDENCE_INDEX_REQUIRED'),{statusCode:422});
 const original=markdownReferences(index.text).text,body=strip(original);
 const matches=[...body.matchAll(/^##\s+(ev-[a-z0-9][a-z0-9_-]*)\s*$/gm)];
 const conflicts:string[]=[],files:{path:string;text:string;expected:string|null}[]=[];
 const converted='page_role' in index&&index.page_role==='evidence-index';
 if(!converted&&!matches.length)conflicts.push('没有可识别的ev-*条目；需人工整理后迁移。');
 if(new Set(matches.map(m=>m[1])).size!==matches.length)conflicts.push('存在重复ev-*标识。');
 if(!converted&&docs.some(d=>d.path.startsWith(prefix+'evidence/')))conflicts.push('目标依据目录已有内容，拒绝覆盖。');
 const external=all.filter(d=>!d.path.startsWith(prefix)&&(d.links??[]).some(l=>l.path===index.path&&l.fragment));
 if(external.length)conflicts.push('以下跨论文页面仍引用旧锚点，请先调整或取消引用：'+external.map(d=>d.path).join('、'));
 const hashes=[...new Set([...original.matchAll(/(?:hash=|`)([a-f0-9]{64})(?:[&#`\s)]|$)/g)].map(m=>m[1]))];
 if(hashes.length>1)conflicts.push('旧依据包含多个PDF版本，需要人工确认各条来源。');
 const pdf=hashes[0],ids=new Set(matches.map(m=>m[1]));
 const headingStart=body.search(/^#\s+.+$/m),headingEnd=body.indexOf('\n',headingStart);
 const common=matches.length?body.slice(headingEnd+1,matches[0].index).trim():'';
 const extraScope=Boolean(common&&!ids.has('ev-reading-scope'));if(extraScope)ids.add('ev-reading-scope');
 const rewrite=(path:string,text:string)=>text.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g,(full,label:string,href:string)=>{
  const [target,fragment]=href.split('#');
  if(resolveKnowledgeLink(path,target)!==index.path||!fragment)return full;
  let id=fragment;try{id=decodeURIComponent(fragment);}catch{/* Invalid fragments are rejected below. */}
  if(!ids.has(id)){conflicts.push(path+'引用不存在的依据：'+fragment);return full;}
  const relative=posix.relative(posix.dirname(path),prefix+'evidence/'+id+'.md');return `[${id}](${relative.startsWith('.')?relative:'./'+relative})`;
 });
 if(!converted){
  if(extraScope){const path=prefix+'evidence/ev-reading-scope.md';if(existsSync(md.locate(project,path)))conflicts.push('目标文件已存在：'+path);files.push({path,expected:null,text:front(path,source,'evidence',pdf??'unknown')+'[依据总览](../evidence.md)\n\n# ev-reading-scope\n\n**定位：** 原依据页共同材料说明，未新增原文定位。\n\n**事实：** '+common+'\n\n**边界：** 沿用历史材料范围，未重新核验PDF。\n'});}
  for(const [i,match] of matches.entries()){
   const id=match[1],path=prefix+'evidence/'+id+'.md';
   if(existsSync(md.locate(project,path)))conflicts.push('目标文件已存在：'+path);
   let content=body.slice(match.index!+match[0].length,matches[i+1]?.index??body.length).trim();
   // Inline references before moving the section: definitions may live at the old file's end.
   content=content.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g,(full,label:string,href:string)=>{const target=resolveKnowledgeLink(index.path,href);if(!target)return full;const relative=posix.relative(posix.dirname(path),target);return `[${label}](${relative.startsWith('.')?relative:'./'+relative}${href.includes('#')?'#'+href.split('#')[1]:''})`;});
   const facts:string[]=[],locations:string[]=[],limits:string[]=[];
   for(const paragraph of content.split(/\n\s*\n/)){
    const split=paragraph.match(/^([\s\S]*?)(?:定位[:：])([\s\S]*)$/);
    if(split){if(split[1].trim())facts.push(split[1].trim());locations.push(split[2].trim());}
    else if(/^(?:支持范围与缺口|缺口|限制|未核实)[:：]/.test(paragraph))limits.push(paragraph);
    else facts.push(paragraph);
   }
   const scope=ids.has('ev-reading-scope')&&id!=='ev-reading-scope'?'ev-reading-scope':undefined;
   const text=front(path,source,'evidence',pdf??'unknown',scope)+`[依据总览](../evidence.md)\n\n# ${id}\n\n**定位：** ${locations.join('\n\n')||'原条目未单列定位；材料说明保留于事实，未新增定位。'}\n\n**事实：** ${facts.join('\n\n')||'具体支持内容保留于以下原条目边界中，迁移未补造事实。'}\n\n**边界：** ${limits.join('\n\n').replace(/^支持范围与缺口[:：]\s*/,'')||'原条目未单列缺口，不代表已核验。'}\n`;
   files.push({path,text:rewrite(path,text),expected:null});
  }
  for(const doc of docs){
   let text=markdownReferences(doc.text).text;
   const header=text.match(/^(---\n[\s\S]*?\n---\n)/)?.[1];if(!header){conflicts.push(doc.path+'缺少规范元数据');continue;}
   let next=strip(text);
   if(doc.path===index.path){
    const title=strip(docs.find(d=>d.path===prefix+'whoami.md')?.text??'').match(/^#\s+(.+)$/m)?.[1]??'';
    next=title+'\n\n[论文总览](./whoami.md)\n\n# 原文依据\n\n'+[...ids].map(id=>`- [${id}](./evidence/${id}.md)`).join('\n')+'\n';
    text=front(doc.path,source,'evidence-index')+next;
   }else text=header+rewrite(doc.path,next);
   files.push({path:doc.path,text,expected:doc.hash});
  }
  for(const issue of paperWikiIssues(source,files))conflicts.push(issue.path+'：'+issue.reason);
 }
 if(files.length>120)conflicts.push('文件数超过迁移上限120。');
 const fingerprint=hash(JSON.stringify({source,docs:docs.map(d=>[d.path,d.hash]).sort(),external:external.map(d=>[d.path,d.hash]).sort(),files}));
 return {source_id:source,converted,fingerprint,conflicts:[...new Set(conflicts)],items:files.map(file=>({path:file.path,action:file.expected?'update':'create'})),evidence_count:converted?docs.filter(d=>d.path.startsWith(prefix+'evidence/')).length:ids.size,files};
}
export function evidenceMigrationPreview(md:MarkdownKnowledge,project:string,source:string){const {files,...preview}=plan(md,project,source);return preview;}
export function migrateEvidence(md:MarkdownKnowledge,project:string,source:string,expected:string){
 const result=plan(md,project,source);
 if(result.fingerprint!==expected)throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409});
 if(result.conflicts.length)throw Object.assign(new Error('EVIDENCE_MIGRATION_CONFLICT: '+result.conflicts.join('；')),{statusCode:422});
 if(result.converted)return evidenceMigrationPreview(md,project,source);
 const previous=md.index(project).documents,oldIndex=previous.find(doc=>doc.path===`knowledge_base/papers/${source}/evidence.md`);
 const records=md.commit(project,result.files,{}, {preserveSourceVersions:true});
 // Rewriting a link does not reverify claims: preserve any pre-existing outdated dependencies.
 const byPath=new Map(records.map(d=>[d.path,d]));
 for(const doc of records){
  const before=previous.find(item=>item.id===doc.id),oldDependency=before?.dependencies?.find(ref=>ref.path===oldIndex?.path);
  const outdated=oldDependency&&oldDependency.hash!==oldIndex?.hash;
  md.stamp(project,doc.id,(doc.links??[]).filter(l=>l.evidence).flatMap(l=>{const target=byPath.get(l.path);return target?[{path:target.path,hash:outdated?oldDependency.hash:target.hash}]:[];}));
 }
 md.recordOperation(project,'evidence-migration',records,'拆分依据并保留旧正文版本；未重新核验PDF。');
 return {source_id:source,converted:true,documents:records.map(({id,path,hash})=>({id,path,hash})),note:'旧正文保存在文档版本历史中；本操作未重新核验PDF。'};
}
