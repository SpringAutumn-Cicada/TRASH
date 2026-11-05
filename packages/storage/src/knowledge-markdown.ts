import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeVersion } from '@trash/protocol';

export const cardFields = ['question','method','contributions','limitations','reported_results','experimental_conditions','ideas','relevance','open_questions'] as const;
const labels: Record<typeof cardFields[number], string> = {question:'研究问题',method:'方法',contributions:'贡献',limitations:'局限',reported_results:'作者报告结果',experimental_conditions:'实验条件',ideas:'可借鉴思路',relevance:'项目相关性',open_questions:'待解决问题'};
export function markdownPath(root:string, record:KnowledgeVersion):string {
  if(!/^knowledge_[A-Za-z0-9-]+$/.test(record.object_id))throw new Error('INVALID_KNOWLEDGE_ID');
  return join(root,record.kind==='wiki-page'?'wiki':'literature/cards',record.object_id+'.md');
}
export function renderKnowledge(record:KnowledgeVersion):string {
  const content={...record.content} as Record<string,unknown>;
  let body:string;
  if(record.kind==='wiki-page'){body=String(content.body);delete content.body;}
  else {body=cardFields.map(key=>`## ${labels[key]}\n\n${String(content[key]??'')}`).join('\n\n');for(const key of cardFields)delete content[key];}
  // JSON is valid YAML; a single metadata value avoids ambiguous YAML scalar coercion.
  const metadata={object_id:record.object_id,project_id:record.project_id,kind:record.kind,base_version:record.version,status:record.status,content};
  return `---\nmetadata: ${JSON.stringify(metadata)}\n---\n${body}\n`;
}
export function parseMarkdown(text:string,record:KnowledgeVersion):unknown {
  text=text.replace(/\r\n/g,'\n');
  const match=text.match(/^---\r?\nmetadata: ([^\r\n]+)\r?\n---\r?\n([\s\S]*)$/);
  if(!match)throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
  let decoded:unknown;try{decoded=JSON.parse(match[1]);}catch{throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});}
  const meta=decoded as {object_id:string;project_id:string;kind:string;base_version:number;content:Record<string,unknown>};
  if(!meta||typeof meta!=='object'||!meta.content||typeof meta.content!=='object')throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
  if(meta.object_id!==record.object_id||meta.project_id!==record.project_id||meta.kind!==record.kind||meta.base_version!==record.version)throw Object.assign(new Error('KNOWLEDGE_FILE_CONFLICT'),{statusCode:409});
  const content={...meta.content};
  if(record.kind==='wiki-page')content.body=match[2].replace(/\n$/,'');
  else {
    const body=match[2];
    const headings=cardFields.map(key=>`## ${labels[key]}\n\n`);
    let cursor=0;
    for(let i=0;i<cardFields.length;i++){
      if(!body.startsWith(headings[i],cursor))throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
      const start=cursor+headings[i].length;
      const end=i+1<headings.length?body.indexOf('\n\n'+headings[i+1],start):body.length;
      if(end<0)throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
      content[cardFields[i]]=body.slice(start,end).replace(/\n$/,'');cursor=end+2;
    }
  }
  return content;
}
export const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function safePath(root:string,path:string):void {
  const actual=realpathSync(root);
  let parent=dirname(path);while(!existsSync(parent))parent=dirname(parent);
  const resolved=realpathSync(parent);
  if(resolved!==actual&&!resolved.startsWith(actual+sep))throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Object.assign(new Error('KNOWLEDGE_FILE_INVALID'),{statusCode:409});
}
export function atomicText(path:string,text:string):void {
  mkdirSync(dirname(path),{recursive:true});
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('WORKSPACE_SYMLINK_FILE');
  const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,path);
}
function files(root:string,record:KnowledgeVersion){
  const text=renderKnowledge(record);
  return [
    {path:join(root,'.trash','knowledge-history',record.object_id,`${record.version}.json`),text:JSON.stringify(record,null,2)},
    {path:markdownPath(root,record),text},
    {path:join(root,'.trash','knowledge-state',record.object_id+'.json'),text:JSON.stringify({version:record.version,hash:digest(text)})}
  ];
}
export function recoverKnowledge(root:string,record:KnowledgeVersion|undefined,id:string):void {
  if(!/^knowledge_[A-Za-z0-9-]+$/.test(id))throw new Error('INVALID_KNOWLEDGE_ID');
  const journal=join(root,'.trash','knowledge-pending',id+'.json');safePath(root,journal);
  if(!existsSync(journal))return;
  const pending=JSON.parse(readFileSync(journal,'utf8')) as {record:KnowledgeVersion;before:(string|null)[]};
  const committed=record && JSON.stringify(record)===JSON.stringify(pending.record);
  const targets=files(root,pending.record);
  for(const [index,target] of targets.entries()){
    safePath(root,target.path);
    const current=existsSync(target.path)?readFileSync(target.path,'utf8'):null;
    if(committed&&index===1&&current!==null&&current!==target.text&&current!==pending.before[index]){
      parseMarkdown(current,pending.record);continue;
    }
    if(current!==target.text&&current!==pending.before[index])throw Object.assign(new Error('KNOWLEDGE_FILE_CONFLICT'),{statusCode:409});
    const value=committed?target.text:pending.before[index];
    if(value===null)rmSync(target.path,{force:true});else atomicText(target.path,value);
  }
  rmSync(journal);
}
export function publishKnowledge(root:string,record:KnowledgeVersion):void {
  if(record.kind==='experiment-result')return;
  const targets=files(root,record);
  for(const target of targets)safePath(root,target.path);
  const journal=join(root,'.trash','knowledge-pending',record.object_id+'.json');safePath(root,journal);
  atomicText(journal,JSON.stringify({record,before:targets.map(target=>existsSync(target.path)?readFileSync(target.path,'utf8'):null)}));
  for(const target of targets)atomicText(target.path,target.text);
}
export function changedMarkdown(root:string,record:KnowledgeVersion):string|undefined {
  const path=markdownPath(root,record),state=join(root,'.trash','knowledge-state',record.object_id+'.json');
  safePath(root,path);safePath(root,state);
  if(!existsSync(path)){
    if(existsSync(state))throw Object.assign(new Error('KNOWLEDGE_FILE_MISSING'),{statusCode:409});
    publishKnowledge(root,record);return;
  }
  const text=readFileSync(path,'utf8');
  if(!existsSync(state)){
    if(text!==renderKnowledge(record))throw Object.assign(new Error('KNOWLEDGE_FILE_CONFLICT'),{statusCode:409});
    publishKnowledge(root,record);return;
  }
  const saved=JSON.parse(readFileSync(state,'utf8')) as {hash:string;version:number};
  if(saved.version!==record.version)throw Object.assign(new Error('KNOWLEDGE_FILE_CONFLICT'),{statusCode:409});
  return saved.hash===digest(text)?undefined:text;
}

export function publishKnowledgeHistory(root:string,record:KnowledgeVersion):void {
  const path=join(root,'.trash','knowledge-history',record.object_id,`${record.version}.json`);safePath(root,path);atomicText(path,JSON.stringify(record,null,2));
}
