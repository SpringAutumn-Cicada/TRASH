import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,realpathSync,renameSync,writeFileSync,copyFileSync,rmSync,unlinkSync,rmdirSync} from 'node:fs';
import {dirname,join,posix,sep} from 'node:path';
import {knowledgePath,knowledgeBasePath,legacyKnowledgePath} from '@trash/protocol';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function safeKnowledgeFile(root:string,path:string){
 let current=root;for(const part of path.split('/')){if(!part||part==='.'||part==='..')throw new Error('KNOWLEDGE_PATH_INVALID');current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('KNOWLEDGE_PATH_INVALID');}
 if(!current.startsWith(root+sep))throw new Error('KNOWLEDGE_PATH_INVALID');return current;
}
export function knowledgeFiles(root:string,dir:string):string[]{
 const physical=safeKnowledgeFile(root,dir);if(!existsSync(physical))return [];
 return readdirSync(physical).flatMap(name=>{const path=dir+'/'+name,target=safeKnowledgeFile(root,path);return lstatSync(target).isDirectory()?knowledgeFiles(root,path):name.endsWith('.md')?[path]:[];});
}
export function migrationManifest(root:string):{version:number;paths:Record<string,string>;beforeHashes?:Record<string,string>;afterHashes?:Record<string,string>;backup?:string}|undefined{
 const file=safeKnowledgeFile(root,'.trash/knowledge-base-migration.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;
}
export function resolveBasePath(root:string,path:string){
 if(knowledgeBasePath.test(path))return path;
 const manifest=migrationManifest(root);if(manifest?.paths[path])return manifest.paths[path];
 const candidates=[knowledgePath(path),...['summary','hypothesis','discovery'].map(level=>knowledgePath(path,level))];
 return candidates.find(candidate=>candidate!==path&&existsSync(safeKnowledgeFile(root,candidate)))??path;
}
export function rewriteKnowledgeText(text:string,from:string,to:string,paths:Record<string,string>){
 let fence='';
 return text.split('\n').map(line=>{
  const marker=line.match(/^\s*([`~]{3,})/);if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence='';return line;}if(fence)return line;
  return line.replace(/(!?\[[^\]\n]+\]\()([^\s)]+)([^)]*\))/g,(all,prefix:string,href:string,suffix:string)=>{
   if(href.startsWith('/api/')||/^(?:[a-z]+:|\/\/|#)/i.test(href))return all;
   const [raw,fragment='']=href.split(/(?=[?#])/s);let target:string;try{target=decodeURIComponent(raw);}catch{return all;}
   const old=posix.normalize(target.startsWith('/')?target.slice(1):posix.join(posix.dirname(from),target));
   const mapped=paths[old]??old;return mapped?prefix+(posix.relative(posix.dirname(to),mapped)||posix.basename(mapped))+fragment+suffix:all;
  });
 }).join('\n');
}
export function migrationPreview(root:string){
 const manifest=migrationManifest(root);if(manifest)return {migrated:true,items:[],conflicts:[],fingerprint:hash(JSON.stringify(manifest)),backup:manifest.backup};
 const files=['literature/cards','wiki','abstract-library/notes','abstract-library/wiki'].flatMap(dir=>knowledgeFiles(root,dir));
 const items=files.filter(path=>legacyKnowledgePath.test(path)||/^abstract-library\/(notes|wiki)\/source_[A-Za-z0-9_-]+\.md$/.test(path)).map(path=>{
  const text=readFileSync(safeKnowledgeFile(root,path),'utf8');
  let level=text.match(/^level:\s*(\S+)/m)?.[1];
  if(/^# 文献知识第\d+层分组\d+\s*$/m.test(text))level='summary';
  // Retain non-v2 legacy files in backup rather than silently indexing old knowledge.
  const active=path.startsWith('abstract-library/')||/^knowledge_version:\s*2\s*$/m.test(text);
  return {from:path,to:knowledgePath(path,level),hash:hash(text),active};
 });
 const conflicts=items.filter(item=>existsSync(safeKnowledgeFile(root,item.to))).map(item=>item.to);
 for(const path of ['knowledge_base/index.md','knowledge_base/AGENTS.md','knowledge_base/maintenance/log.md'])if(existsSync(safeKnowledgeFile(root,path)))conflicts.push(path);
 return {migrated:false,items,conflicts,fingerprint:hash(JSON.stringify(items)),backup:undefined as string|undefined};
}
export function migrateKnowledgeBase(rootInput:string,expected:string){
 const root=realpathSync(rootInput);
 const pending=safeKnowledgeFile(root,'.trash/knowledge-base-migration.json.tmp'),final=safeKnowledgeFile(root,'.trash/knowledge-base-migration.json');
 if(!existsSync(final)&&existsSync(pending)&&existsSync(safeKnowledgeFile(root,'knowledge_base'))){
  const snapshot=JSON.parse(readFileSync(pending,'utf8')) as {afterHashes:Record<string,string>;paths:Record<string,string>};
  if(Object.entries(snapshot.afterHashes).every(([path,expected])=>existsSync(safeKnowledgeFile(root,path))&&hash(readFileSync(safeKnowledgeFile(root,path),'utf8'))===expected))renameSync(pending,final);
  else throw new Error('KNOWLEDGE_MIGRATION_INCOMPLETE');
 }
 const preview=migrationPreview(root);
 if(preview.migrated){archiveAbstractHistory(root);return migrationPreview(root);}
 if(preview.fingerprint!==expected)throw new Error('VERSION_CONFLICT');
 if(preview.conflicts.length)throw new Error('KNOWLEDGE_BASE_CONFLICT');
 const backup='.trash/knowledge-base-backups/'+randomUUID(),paths=Object.fromEntries(preview.items.filter(item=>item.active).map(item=>[item.from,item.to]));
 const stage='.trash/knowledge-base-stage-'+randomUUID();mkdirSync(safeKnowledgeFile(root,stage),{recursive:true});
 const beforeHashes:Record<string,string>={},afterHashes:Record<string,string>={};
 try{
  for(const item of preview.items){
   const original=safeKnowledgeFile(root,item.from),copy=safeKnowledgeFile(root,backup+'/'+item.from);mkdirSync(dirname(copy),{recursive:true});copyFileSync(original,copy);
   beforeHashes[item.from]=item.hash;
   if(hash(readFileSync(copy,'utf8'))!==item.hash)throw new Error('KNOWLEDGE_BACKUP_INVALID');
   if(!item.active)continue;
   const text=readFileSync(original,'utf8');if(hash(text)!==item.hash)throw new Error('VERSION_CONFLICT');
   const body=rewriteKnowledgeText(text,item.from,item.to,paths),target=safeKnowledgeFile(root,stage+'/'+item.to);
   mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body,{mode:0o600});
   beforeHashes[item.from]=item.hash;afterHashes[item.to]=hash(body);
  }
  const base=safeKnowledgeFile(root,stage+'/knowledge_base');mkdirSync(base,{recursive:true});
  for(const dir of ['papers','abstracts','topics','hypotheses','discoveries','summaries'])mkdirSync(join(base,dir),{recursive:true});
  writeFileSync(join(base,'AGENTS.md'),'# 知识库阅读与维护\n\n先读 index.md，按问题读取关键卡片、研究记忆和主题；精确结果回查详细卡片及原文。区分全文证据与摘要级声明。关联、导航和证据分开，保留人工补充、稳定ID和出处。不要默认读取全库；分批总结不是正式主题。运行缓存和任务日志位于项目 .trash/，不作为研究事实。\n');
  mkdirSync(join(base,'maintenance'),{recursive:true});writeFileSync(join(base,'maintenance/log.md'),(existsSync(safeKnowledgeFile(root,'.trash/wiki-log.md'))?readFileSync(safeKnowledgeFile(root,'.trash/wiki-log.md'),'utf8')+'\n':'')+'# 知识维护记录\n\n迁移保留文档ID、原始资料与历史快照。平台后续发布和命名操作在此记录。\n');
  for(const item of preview.items)if(hash(readFileSync(safeKnowledgeFile(root,item.from),'utf8'))!==item.hash)throw new Error('VERSION_CONFLICT');
  const target=safeKnowledgeFile(root,'knowledge_base');if(existsSync(target))throw new Error('KNOWLEDGE_BASE_CONFLICT');
  const manifest={version:1,paths,beforeHashes,afterHashes,backup,at:new Date().toISOString()};
  const file=safeKnowledgeFile(root,'.trash/knowledge-base-migration.json');writeFileSync(file+'.tmp',JSON.stringify(manifest,null,2));renameSync(base,target);renameSync(file+'.tmp',file);
  for(const item of preview.items){const original=safeKnowledgeFile(root,item.from);if(hash(readFileSync(original,'utf8'))===item.hash)unlinkSync(original);}
  for(const dir of ['literature/cards','wiki','abstract-library/notes','abstract-library/wiki']){const path=safeKnowledgeFile(root,dir);if(existsSync(path)&&!readdirSync(path).length)rmdirSync(path);}
  archiveAbstractHistory(root);return {...migrationPreview(root),count:Object.keys(paths).length};
 }finally{rmSync(safeKnowledgeFile(root,stage),{recursive:true,force:true});}
}

export function rollbackKnowledgeBase(root:string){
 const manifest=migrationManifest(root);if(!manifest?.backup)throw new Error('KNOWLEDGE_MIGRATION_NOT_FOUND');
 for(const [path,expected] of Object.entries(manifest.afterHashes??{}))if(!existsSync(safeKnowledgeFile(root,path))||hash(readFileSync(safeKnowledgeFile(root,path),'utf8'))!==expected)throw new Error('KNOWLEDGE_BASE_CHANGED');
 const current=knowledgeFiles(root,'knowledge_base').filter(path=>knowledgeBasePath.test(path));
 if(current.some(path=>!manifest.afterHashes?.[path]))throw new Error('KNOWLEDGE_BASE_CHANGED');
 for(const [old,expected] of Object.entries(manifest.beforeHashes??{})){
  const file=safeKnowledgeFile(root,old),backup=safeKnowledgeFile(root,manifest.backup+'/'+old);
  if(!existsSync(backup)||hash(readFileSync(backup,'utf8'))!==expected||(existsSync(file)&&hash(readFileSync(file,'utf8'))!==expected))throw new Error('KNOWLEDGE_BACKUP_INVALID');
 }
 for(const old of Object.keys(manifest.beforeHashes??{})){const target=safeKnowledgeFile(root,old);mkdirSync(dirname(target),{recursive:true});copyFileSync(safeKnowledgeFile(root,manifest.backup+'/'+old),target);}
 renameSync(safeKnowledgeFile(root,'knowledge_base'),safeKnowledgeFile(root,manifest.backup+'/knowledge_base-before-rollback'));
 renameSync(safeKnowledgeFile(root,'.trash/knowledge-base-migration.json'),safeKnowledgeFile(root,manifest.backup+'/migration-manifest.json'));
 return {restored:true,backup:manifest.backup};
}

function archiveAbstractHistory(root:string){
 const manifest=migrationManifest(root);if(!manifest?.backup)return;
 const files=knowledgeFiles(root,'abstract-library/history');
 if(!files.length)return;
 const hashes={...(manifest.beforeHashes??{})};
 for(const old of files){
  const name=posix.basename(old);if(!/^source_[A-Za-z0-9_-]+-[a-f0-9]{64}\.md$/.test(name))continue;
  const source=safeKnowledgeFile(root,old),text=readFileSync(source,'utf8'),digest=hash(text);
  const backup=safeKnowledgeFile(root,manifest.backup+'/'+old),target=safeKnowledgeFile(root,'.trash/abstract-history/'+name);
  for(const file of [backup,target]){if(existsSync(file)&&hash(readFileSync(file,'utf8'))!==digest)throw new Error('KNOWLEDGE_BACKUP_INVALID');mkdirSync(dirname(file),{recursive:true});if(!existsSync(file))copyFileSync(source,file);}
  hashes[old]=digest;
 }
 const file=safeKnowledgeFile(root,'.trash/knowledge-base-migration.json');writeFileSync(file+'.tmp',JSON.stringify({...manifest,beforeHashes:hashes},null,2));renameSync(file+'.tmp',file);
 for(const old of files)if(hashes[old]&&hash(readFileSync(safeKnowledgeFile(root,old),'utf8'))===hashes[old])unlinkSync(safeKnowledgeFile(root,old));
 const directory=safeKnowledgeFile(root,'abstract-library/history');if(existsSync(directory)&&!readdirSync(directory).length)rmdirSync(directory);
}
