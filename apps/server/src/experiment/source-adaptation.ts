import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { CodeEnvironmentContent } from '@trash/protocol';
export class AdaptationMatchError extends Error {constructor(public detail:{path:string;reason:string;matches:number}){super('ENVIRONMENT_ADAPTATION_AMBIGUOUS');}}
export function applySourceAdaptation(root:string,backup:string,patches:NonNullable<Extract<CodeEnvironmentContent,{schema_version:2}>['adaptation']>['patches'],inputs:{path:string;sha256:string;text:string}[]){
 const canonical=realpathSync(root),groups=new Map<string,typeof patches>();
 for(const patch of patches){if(!inputs.some(file=>file.path===patch.path&&file.sha256===patch.sha256)||isAbsolute(patch.path)||/[\\\x00-\x1f]/.test(patch.path)||patch.path.split('/').some(part=>['..','.git','.venv','.agents','.codex'].includes(part)))throw new Error('ENVIRONMENT_ADAPTATION_UNSAFE');groups.set(patch.path,[...(groups.get(patch.path)??[]),patch]);}
 const changes=[...groups].map(([path,items])=>{
  const target=resolve(canonical,path),rel=relative(canonical,realpathSync(target));if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||lstatSync(target).isSymbolicLink())throw new Error('ENVIRONMENT_ADAPTATION_UNSAFE');
  const bytes=readFileSync(target),original=bytes.toString('utf8');if(bytes.includes(0)||createHash('sha256').update(bytes).digest('hex')!==items[0].sha256)throw new Error('ENVIRONMENT_ADAPTATION_CODE_CHANGED');
  let text=original;for(const item of items){const matches=text.split(item.before).length-1;if(matches!==1||item.before.includes('[REDACTED]')||item.after.includes('[REDACTED]'))throw new AdaptationMatchError({path,reason:item.before.includes('[REDACTED]')||item.after.includes('[REDACTED]')?'补丁含脱敏占位符':matches===0?'原文片段不存在':'原文片段出现多次',matches});text=text.replace(item.before,()=>item.after);}
  return {path,target,original,text};
 });
 // Save all originals and exact proposed differences before the first mutation.
 mkdirSync(backup,{recursive:true});writeFileSync(resolve(backup,'changes.json'),JSON.stringify(changes.map(({target:_target,...item})=>item),null,2),{mode:0o600});
 const written:typeof changes=[];try{for(const change of changes){if(readFileSync(change.target,'utf8')!==change.original)throw new Error('ENVIRONMENT_ADAPTATION_CODE_CHANGED');written.push(change);writeFileSync(change.target,change.text);}}catch(error){for(const change of written.reverse())writeFileSync(change.target,change.original);throw error;}
 return changes.map(change=>change.path);
}
export function restoreSourceAdaptation(root:string,backup:string){
 const changes=JSON.parse(readFileSync(resolve(backup,'changes.json'),'utf8')) as {path:string;original:string;text:string}[];
 const canonical=realpathSync(root);
 const targets=changes.map(change=>{const target=resolve(canonical,change.path),rel=relative(canonical,realpathSync(target));if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||lstatSync(target).isSymbolicLink()||readFileSync(target,'utf8')!==change.text)throw new Error('ENVIRONMENT_ADAPTATION_CODE_CHANGED');return {...change,target};});
 writeFileSync(resolve(backup,'before-restore.json'),JSON.stringify(targets.map(({target:_target,...item})=>item)),{mode:0o600});
 const written:typeof targets=[];try{for(const change of targets){if(readFileSync(change.target,'utf8')!==change.text)throw new Error('ENVIRONMENT_ADAPTATION_CODE_CHANGED');written.push(change);writeFileSync(change.target,change.original);}}catch(error){for(const change of written.reverse())writeFileSync(change.target,change.text);throw error;}
 return targets.map(change=>change.path);
}
