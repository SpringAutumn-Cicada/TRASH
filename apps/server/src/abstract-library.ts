import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import type {TrashStore} from '@trash/storage';

export const abstractSkill=()=>readFileSync(fileURLToPath(new URL('../../../.agents/skills/trash-abstract-literature/SKILL.md',import.meta.url)),'utf8');
export function abstractFile(store:TrashStore,project:string,source:string,area:'materials'|'notes'|'wiki'|'history'='notes',version?:string){
  if(!/^source_[a-zA-Z0-9_-]+$/.test(source))throw new Error('SOURCE_NOT_FOUND');
  const root=join(store.root,'projects',project);
  const parts=['abstract-library',area];let dir=root;
  for(const part of parts){dir=join(dir,part);if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw new Error('KNOWLEDGE_PATH_INVALID');mkdirSync(dir,{recursive:true});}
  const target=join(dir,source+(version?'-'+version:'')+'.md');
  if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('KNOWLEDGE_PATH_INVALID');
  return target;
}
export function abstractText(store:TrashStore,project:string,source:string,area:'notes'|'wiki'='notes'){const file=abstractFile(store,project,source,area);return existsSync(file)?readFileSync(file,'utf8'):'';}
export function publishAbstract(store:TrashStore,project:string,source:string,text:string,expected:string|null){
  const target=abstractFile(store,project,source),before=existsSync(target)?readFileSync(target,'utf8'):null;
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  if((before===null?null:hash(before))!==expected)throw new Error('VERSION_CONFLICT');
  if(before!==null)writeFileSync(abstractFile(store,project,source,'history',hash(before)),before,{mode:0o600});
  const temp=join(dirname(target),'.'+source+'-'+Date.now()+'.tmp');writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,target);
}

export function publishAbstractWiki(store:TrashStore,project:string,source:string,text:string){const target=abstractFile(store,project,source,'wiki');const temp=join(dirname(target),'.'+source+'-'+Date.now()+'.tmp');writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,target);}
