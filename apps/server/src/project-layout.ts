import {existsSync,lstatSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {z} from 'zod';
import type {TrashStore} from '@trash/storage';

export const publicDirectories=['literature','knowledge_base','code','data','experiments','manuscript'];
export const runtimeNames=new Set(['research-exploration','agent-workspace','code-agent','tasks','literature-analysis','dataset-hashes','directory-repairs','environment-analysis','environment-deployments','experiment-bindings','remote-workspaces','dataset-upload-sessions','reproduction-queues','experiment-runs']);
// Existing absolute references and imported code remain valid. No implicit data migration.
export function projectRuntime(root:string,project:string,name:string,...parts:string[]){
  const base=join(root,'projects',project),legacy=join(base,name);
  const target=existsSync(legacy)?legacy:name==='reproductions'?join(base,'code','reproductions'):join(base,'.trash','runtime',name);
  return join(target,...parts);
}
export const visibleEntry=(parent:string,name:string,internal:boolean)=>internal||(!name.startsWith('.')&&(parent!==''||!runtimeNames.has(name)&&!['raw','files','project.yaml'].includes(name)));
const slug=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const input=z.object({kind:z.enum(['direction','scheme','run']),id:slug,title:z.string().trim().min(1).max(120),direction:slug.optional(),scheme:slug.optional()}).strict();
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{statusCode});}
export function createResearchFolder(store:TrashStore,project:string,value:unknown){
  const data=input.parse(value);if(!store.getProject(project))fail('PROJECT_NOT_FOUND',404);
  if(data.kind!=='direction'&&!data.direction||data.kind==='run'&&!data.scheme)fail('INVALID_REQUEST',400);
  const root=join(store.root,'projects',project);if(!existsSync(root))fail('FILES_WORKSPACE_MISSING',404);
  const physical=resolve(root);const paths=data.kind==='direction'?[`wiki/directions/${data.id}.md`,`code/directions/${data.id}`,`experiments/${data.id}`]:data.kind==='scheme'?[`experiments/${data.direction}/${data.id}`]:[`experiments/${data.direction}/${data.scheme}/runs/${data.id}`];
  const safe=(relative:string)=>{let current=physical;for(const part of relative.split('/')){current=join(current,part);try{if(lstatSync(current).isSymbolicLink())fail('FILES_SYMLINK',403);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}if(!current.startsWith(physical+sep))fail('FILES_OUTSIDE_WORKSPACE',403);return current;};
  if(data.kind!=='direction'&&!existsSync(safe(`wiki/directions/${data.direction}.md`)))fail('DIRECTION_NOT_FOUND',404);
  if(data.kind==='run'&&!existsSync(safe(`experiments/${data.direction}/${data.scheme}/README.md`)))fail('SCHEME_NOT_FOUND',404);
  for(const path of paths)if(existsSync(safe(path)))fail('FILES_EXISTS');
  const created:string[]=[];
  try{
    for(const path of paths){const target=safe(path);mkdirSync(join(target,'..'),{recursive:true});if(path.endsWith('.md')){writeFileSync(target,`# ${data.title}\n\n方向 ID：${data.id}\n\n## 研究问题与假设\n\n## 当前结论与证据\n\n## 计划与状态\n\n状态：探索中\n\n实验目录：\`experiments/${data.id}/\`\n`,{flag:'wx',mode:0o600});created.push(target);}else{mkdirSync(target);created.push(target);if(data.kind==='run')for(const sub of ['configs','results','figures','logs'])mkdirSync(join(target,sub));const heading=data.kind==='run'?'运行批次':data.kind==='scheme'?'实验方案':path.startsWith('code/')?'方向代码':'方向实验';writeFileSync(join(target,'README.md'),`# ${data.title} · ${heading}\n\n方向：${data.direction??data.id}\n${data.scheme?`方案：${data.scheme}\n`:''}\n${data.kind==='run'?'## 运行配置、随机种子与代码版本\n\n## 结果与实际验证\n\n状态：尚未运行':data.kind==='scheme'?'## 验证问题\n\n## 对照与评价方式\n\n## 运行批次\n\n各次运行保存到 runs/<批次ID>/，不覆盖既有结果。':'## 说明\n\n共享代码与数据通过引用使用，不重复复制。'}\n`,{flag:'wx',mode:0o600});}}
    return {paths,kind:data.kind,id:data.id};
  }catch(error){for(const path of created.reverse())rmSync(path,{recursive:true,force:true});throw error;}
}
