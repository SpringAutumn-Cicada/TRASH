import {classifyPaperFiles,taskGeneratedHashes,groupPath,readPaperGroup} from './paper-wiki-groups.js';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import type {TrashStore} from '@trash/storage';
import type {MarkdownKnowledge} from './markdown-knowledge.js';
import {knowledgeLinks} from './knowledge-links.js';
import {bibliographyState,parseIdcard} from './source-bibliography.js';

type Ref={path:string;hash:string};
type FileVersion={path:string;hash:string;id:string;dependencies:Ref[];source_stamp?:string};
type Version={id:string;at:string;reason:string;note?:string;task_id?:string;files:FileVersion[];trashed_at?:string;historical?:boolean;missing_paths?:string[];publication_count?:number;publication_id?:string};
type Cleanup={id:string;at:string;reason?:string;files:FileVersion[];restored_at?:string};
type State={version:1;versions:Version[];cleanups:Cleanup[];historical_records?:Record<string,{trashed_at?:string;purged?:boolean}>};
export type VersionAction='restore'|'trash'|'untrash'|'purge'|'note'|'cleanup'|'undo-cleanup'|'migrate-group';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const activeRestores=new Set<string>();
function fail(message:string):never{throw Object.assign(new Error(message),{statusCode:409});}

/** Group manifests refer to immutable blobs; ungrouped old files are never inferred as versions. */
export class PaperWikiVersions{
 constructor(private store:TrashStore,private markdown:MarkdownKnowledge,private project:string,private source:string){if(!/^source_[A-Za-z0-9_-]+$/.test(source)||store.getSource(source)?.project_id!==project)fail('论文不存在');if(!activeRestores.has(this.project+'|'+this.source))this.recoverRestore();}
 private get prefix(){return `knowledge_base/papers/${this.source}/`;}
 private path(relative:string){
  const root=this.markdown.root(this.project),target=resolve(root,relative);
  if(!target.startsWith(root+sep))fail('版本路径越界');
  let current=root;for(const part of target.slice(root.length+1).split(sep)){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())fail('版本路径不能使用符号链接');}
  return target;
 }
 private get base(){return `.trash/paper-versions/${this.source}`;}
 private recoverRestore(){
  const journal=this.path(this.base+'/restore-pending.json');if(!existsSync(journal))return;
  const backup=JSON.parse(readFileSync(journal,'utf8')) as {files:{path:string;before:string|null}[];source:string;bibliography:string|null};
  for(const file of backup.files){if(file.before===null){const path=this.path(file.path);if(existsSync(path))unlinkSync(path);}else this.atomic(file.path,file.before);}
  this.store.db.transaction(()=>{this.store.db.prepare('UPDATE sources SET data=? WHERE source_id=?').run(backup.source,this.source);if(backup.bibliography===null)this.store.db.prepare('DELETE FROM source_bibliography WHERE source_id=?').run(this.source);else this.store.db.prepare('INSERT OR REPLACE INTO source_bibliography(source_id,data) VALUES(?,?)').run(this.source,backup.bibliography);})();
  unlinkSync(journal);
 }
 private readState():State{const file=this.path(this.base+'/state.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,versions:[],cleanups:[]};}
 private atomic(relative:string,text:string){const file=this.path(relative);mkdirSync(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,file);}
 private save(state:State){this.atomic(this.base+'/state.json',JSON.stringify(state));}
 private blob(value:string){const digest=hash(value),file=this.path(this.base+'/objects/'+digest+'.md');if(!existsSync(file))this.atomic(this.base+'/objects/'+digest+'.md',value);return digest;}
 private text(file:FileVersion){const historical=this.historicalCache?.texts.get(file.hash);if(historical!==undefined)return historical;if(!/^[a-f0-9]{64}$/.test(file.hash))fail('快照hash无效');const text=readFileSync(this.path(this.base+'/objects/'+file.hash+'.md'),'utf8');if(hash(text)!==file.hash)fail('版本快照已损坏');return text;}
 private docs(){return this.markdown.index(this.project,false,true).documents;}
 private live(){return this.markdown.index(this.project).documents.filter(doc=>doc.source_id===this.source&&doc.path.startsWith(this.prefix));}
 private files(){return this.live().map(doc=>{const stamp=this.path(`.trash/knowledge-sources/${doc.id}.json`);return {path:doc.path,hash:doc.hash,id:doc.id,dependencies:doc.dependencies??[],source_stamp:existsSync(stamp)?readFileSync(stamp,'utf8'):undefined};});}
 private fingerprint(files:FileVersion[]){return hash(JSON.stringify(files.map(file=>[file.path,file.hash,file.dependencies,file.source_stamp])));}
 private virtual():Version{const files=this.files();return {id:'current-'+this.fingerprint(files),at:this.live().map(doc=>doc.modified).sort().at(-1)??new Date().toISOString(),reason:'当前文件组（首次记录前）',files};}
 capture(reason:string,task_id?:string){
  const state=this.readState(),live=this.virtual();if(!live.files.length)return;
  if(state.versions.some(version=>!version.trashed_at&&this.fingerprint(version.files)===this.fingerprint(live.files)))return;
  for(const file of live.files){const text=readFileSync(this.path(file.path),'utf8');if(hash(text)!==file.hash)fail('文件在记录期间变化');this.blob(text);}
  const version={...live,id:'version_'+randomUUID(),at:new Date().toISOString(),reason,task_id};state.versions.unshift(version);this.save(state);return version;
 }
 private currentId(state:State,live:Version){return state.versions.find(version=>!version.trashed_at&&this.fingerprint(version.files)===this.fingerprint(live.files))?.id??live.id;}
 list(){
  const state=this.readState(),live=this.virtual(),current_id=this.currentId(state,live),byPath=new Map(live.files.map(file=>[file.path,file.hash]));
  const versions=[...(current_id===live.id&&live.files.length?[live]:[]),...state.versions,...this.historical().versions.filter(version=>!state.historical_records?.[version.id]?.purged&&!state.versions.some(saved=>saved.task_id===version.task_id)).map(version=>({...version,trashed_at:state.historical_records?.[version.id]?.trashed_at}))].map(version=>({...version,files:version.files.map(({path,hash})=>({path,hash})),knowledge_count:version.files.filter(file=>!file.path.includes('/evidence/')).length,evidence_count:version.files.filter(file=>file.path.includes('/evidence/')).length,changes:[...new Set([...version.files.map(file=>file.path),...byPath.keys()])].flatMap(path=>{const previous=version.files.find(file=>file.path===path)?.hash,current=byPath.get(path);return previous===current?[]:[{path,kind:!previous?'current-only':!current?'version-only':'modified'}];})}));
  const current=new Set(live.files.map(file=>file.path));
  const statuses=classifyPaperFiles(this.markdown.root(this.project),this.source,this.docs(),taskGeneratedHashes(this.store,this.project,this.source)).files;
  const old=this.docs().filter(doc=>doc.source_id===this.source&&doc.path.startsWith(this.prefix)&&!current.has(doc.path)).map(doc=>({path:doc.path,hash:doc.hash,title:doc.document_title??doc.title,group_status:statuses.find(file=>file.path===doc.path)?.status,reason:statuses.find(file=>file.path===doc.path)?.reason,blockers:[...this.blockers([doc.path]),...statuses.filter(file=>file.path===doc.path&&['retained','unassigned'].includes(file.status)).map(file=>file.reason)]}));
  return {current_id,versions,group_initialized:Boolean(readPaperGroup(this.markdown.root(this.project),this.source)),historical_analysis_count:this.historical().versions.length,old_files:old,cleanups:state.cleanups.map(item=>({...item,files:item.files.map(({path,hash})=>({path,hash}))})),expected:this.expected(),busy:this.busy()};
 }
 /** Replay only recorded publications. Never fill historical holes with live files. */
 private historicalCache?:{versions:Version[];texts:Map<string,string>};
 private historical(){
  if(this.historicalCache)return this.historicalCache;
  const rows=this.store.db.prepare("SELECT id,at,data FROM knowledge_memory_events WHERE project=? AND operation='publish' ORDER BY at,id").all(this.project) as {id:string;at:string;data:string}[];
  const taskEvents=this.store.db.prepare("SELECT e.task_id,e.at,e.message,t.data FROM knowledge_task_events e JOIN knowledge_tasks t ON t.task_id=e.task_id WHERE t.project_id=? AND t.status='completed' AND e.message LIKE 'Markdown 已发布：%' ORDER BY e.at").all(this.project) as {task_id:string;at:string;message:string;data:string}[];
  const completed=taskEvents.filter(event=>{try{const task=JSON.parse(event.data);return ['literature-card','paper-wiki','wiki-page'].includes(task.input?.kind)&&task.input?.source_ids?.includes(this.source);}catch{return false;}}).map(event=>({...event,paths:JSON.stringify(event.message.slice('Markdown 已发布：'.length).split('、').filter(path=>path.startsWith(this.prefix)).sort())}));
  const state=new Map<string,FileVersion>(),texts=new Map<string,string>(),groups=new Map<string,Version>();
  for(const row of rows){
   let documents:{id:string;path:string;hash:string}[];try{documents=JSON.parse(row.data).documents??[];if(!Array.isArray(documents))continue;}catch{continue;}
   const updates=documents.filter(doc=>typeof doc.path==='string'&&doc.path.startsWith(this.prefix)&&!doc.path.slice(this.prefix.length).split('/').some(part=>part==='..'||part==='.')&&/^[A-Za-z0-9_-]+$/.test(doc.id)&&/^[a-f0-9]{64}$/.test(doc.hash));
   if(!updates.length)continue;
   for(const doc of updates){state.set(doc.path,{...doc,dependencies:[]});if(texts.has(doc.hash))continue;
    const snapshot=this.path(`.trash/markdown-history/${doc.id}/${doc.hash}.md`);
    if(existsSync(snapshot)&&lstatSync(snapshot).size<=1024*1024){const text=readFileSync(snapshot,'utf8');if(hash(text)===doc.hash)texts.set(doc.hash,text);}
   }
   // Legacy logs have no shared publication ID. Require the exact published path set
   // and the task's completion event immediately after the publication, never a time bucket.
   const publishedPaths=JSON.stringify(updates.map(doc=>doc.path).sort());
   const matches=completed.filter(event=>event.paths===publishedPaths&&Date.parse(event.at)>=Date.parse(row.at)&&Date.parse(event.at)-Date.parse(row.at)<=5000);
   if(matches.length!==1)continue;const task=matches[0];
   const entry=state.has(this.prefix+'whoami.md')?this.prefix+'whoami.md':this.prefix+'index.md';if(!state.has(entry))continue;
   const pending=[entry],visited=new Set<string>(),files:FileVersion[]=[],missing=new Set<string>();
   while(pending.length){const path=pending.pop()!;if(visited.has(path))continue;visited.add(path);const file=state.get(path);if(!file){missing.add(path);continue;}files.push(file);const text=texts.get(file.hash);if(text===undefined){missing.add(path);continue;}
    const targets=knowledgeLinks(path,text).map(link=>link.path),scope=text.match(/^scope_ref:\s*(ev-[a-z0-9_-]+)\s*$/m)?.[1];if(scope&&path.includes('/evidence/'))targets.push(this.prefix+'evidence/'+scope+'.md');
    pending.push(...targets.filter(target=>target.startsWith(this.prefix)&&!visited.has(target)));
   }
   files.sort((a,b)=>a.path.localeCompare(b.path));
   if(!groups.has(task.task_id))groups.set(task.task_id,{id:'historical-'+task.task_id,at:task.at,reason:JSON.parse(task.data).input.kind==='wiki-page'?'历史Wiki整理':'历史论文分析',task_id:task.task_id,files,historical:true,publication_id:row.id,missing_paths:[...missing].sort()});
  }
  return this.historicalCache={versions:[...groups.values()].reverse(),texts};
 }
 private busy(){return Boolean(this.store.db.prepare("SELECT 1 FROM knowledge_tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(this.project));}
 private expected(){return hash(JSON.stringify([this.readState(),readPaperGroup(this.markdown.root(this.project),this.source),this.docs().map(doc=>[doc.path,doc.hash,doc.dependencies])]));}
 private blockers(paths:string[]){const selected=new Set(paths),current=new Set(this.live().map(doc=>doc.path));const refs=this.docs().filter(doc=>!selected.has(doc.path)&&[...(doc.links??[]).map(link=>link.path),...(doc.dependencies??[]).map(ref=>ref.path)].some(path=>selected.has(path))).map(doc=>doc.path);const retained=this.readState().versions.filter(version=>!version.trashed_at&&version.files.some(file=>selected.has(file.path))).map(version=>'历史版本：'+version.id);return [...new Set([...paths.filter(path=>current.has(path)),...refs,...retained])];}
 private getVersion(id:string){const state=this.readState(),live=this.virtual();return id===live.id?live:state.versions.find(version=>version.id===id)??this.historical().versions.filter(version=>!state.historical_records?.[version.id]?.purged).map(version=>({...version,trashed_at:state.historical_records?.[version.id]?.trashed_at})).find(version=>version.id===id)??fail('版本不存在');}
 file(version_id:string,path:string){const version=this.getVersion(version_id),file=version.files.find(item=>item.path===path);if(!file){const current=this.live().find(item=>item.path===path);if(!current)fail('版本中无此文件');return {path,text:'',current_text:this.markdown.read(this.project,current.id).text,hash:current.hash};}if(version.historical&&!this.historical().texts.has(file.hash))fail('此历史文件快照缺失，无法读取；未使用当前正文替代');const text=version.id.startsWith('current-')?readFileSync(this.path(path),'utf8'):this.text(file);if(hash(text)!==file.hash)fail('文件已变化，请刷新');const current=this.live().find(item=>item.path===path);return {path,text,current_text:current?this.markdown.read(this.project,current.id).text:'',hash:file.hash};}
 preview(action:VersionAction,id?:string,paths:string[]=[]){
  const list=this.list();
  if(action==='migrate-group')return {expected:list.expected,action,id,paths:list.old_files.filter(file=>file.group_status==='historical').map(file=>file.path),blockers:[],message:'建立当前组清单，将与成功任务快照一致且无外部引用的旧文件归档；人工与不确定内容保留，归档可从回收站恢复。'};
  if(action==='cleanup'){
   if(!paths.length||paths.some(path=>!list.old_files.some(file=>file.path===path)))fail('只能清理列出的旧文件');
   const blockers=[...new Set(paths.flatMap(path=>list.old_files.find(file=>file.path===path)?.blockers??[]))];return {expected:list.expected,action,id,paths,blockers,message:'旧文件将移入回收站；不会修改当前Wiki和原始PDF。'};
  }
  if(action==='undo-cleanup'){const item=this.readState().cleanups.find(item=>item.id===id&&!item.restored_at);if(!item)fail('清理记录不存在');return {expected:list.expected,action,id,paths:item.files.map(file=>file.path),blockers:item.files.filter(file=>existsSync(this.path(file.path))&&hash(readFileSync(this.path(file.path),'utf8'))!==file.hash).map(file=>file.path),message:'恢复旧文件；存在同名文件时拒绝覆盖。'};}
  const version=id?this.getVersion(id):undefined;
  if(version?.historical){
   if(!['trash','untrash','purge'].includes(action))fail('旧记录未保存完整来源状态，不能直接恢复正文或修改备注');
   if(action==='purge'&&!version.trashed_at)fail('请先移入回收站');
   return {expected:list.expected,action,id,paths:version.files.map(file=>file.path),blockers:[],message:action==='purge'?'彻底移除此历史组的展示记录，不能撤销；当前Wiki、其他版本及原始发布快照保留。':action==='untrash'?'将此历史组移回版本列表，不覆盖当前Wiki。':'将此历史组移入回收站，可随时移回；当前Wiki及共享文件保留。'};
  }
  if(!version)fail('请选择版本');
  if(['trash','purge'].includes(action)&&id===list.current_id)fail('不能删除当前版本');
  const blockers=action==='restore'?this.docs().filter(doc=>!doc.path.startsWith(this.prefix)&&[...(doc.links??[]).map(link=>link.path),...(doc.dependencies??[]).map(ref=>ref.path)].some(path=>path.startsWith(this.prefix)&&version.files.some(file=>file.path===path&&file.hash!==this.docs().find(doc=>doc.path===path)?.hash))).map(doc=>doc.path):[];
  const card=version.files.find(file=>file.path===this.prefix+'idcard.md');const proposed=action==='restore'&&card?parseIdcard(version.id.startsWith('current-')?readFileSync(this.path(card.path),'utf8'):this.text(card)):undefined;const source=this.store.getSource(this.source)!;const bibliography_changes=proposed?(['title','authors','publication_date'] as const).filter(field=>proposed[field]!==undefined&&JSON.stringify(proposed[field])!==JSON.stringify(source[field])).map(field=>({field,before:source[field],after:proposed[field]})):[];
  return {expected:list.expected,action,id,paths:version.files.map(file=>file.path),blockers,bibliography_changes,message:action==='restore'?'将恢复为一个新版本，保留当前版本；原文已变更时仍显示待更新。':action==='purge'?'彻底删除此历史版本记录，无法撤销；共享快照继续保留。':'版本记录将移入回收站，正文共享快照继续保留。'};
 }
 act(input:{action:VersionAction;id?:string;paths?:string[];expected:string;note?:string}){
  if(this.busy())fail('项目有活动任务，完成后可操作');
  if(input.expected!==this.expected())fail('版本或文件已变化，请刷新后重试');
  const preview=this.preview(input.action,input.id,input.paths);if(preview.blockers.length)fail('操作被有效引用或现存文件阻止：'+preview.blockers.join('、'));
  if(input.action==='migrate-group'){this.markdown.migratePaperGroup(this.project,this.source);
  }else if(input.id&&!['cleanup','undo-cleanup'].includes(input.action)&&this.getVersion(input.id).historical){
   const state=this.readState(),records=state.historical_records??={};
   if(input.action==='trash')records[input.id]={trashed_at:new Date().toISOString()};
   if(input.action==='untrash')delete records[input.id];
   if(input.action==='purge')records[input.id]={purged:true};
   this.save(state);
  }else if(input.action==='restore'){
   const version=this.getVersion(input.id!);if(version.trashed_at)fail('请先从回收站恢复该版本');
   const texts=version.files.map(file=>({file,text:version.id.startsWith('current-')?readFileSync(this.path(file.path),'utf8'):this.text(file)}));
   for(const item of texts)if(hash(item.text)!==item.file.hash)fail('快照hash不匹配');
   this.capture('恢复前保留');
   const paths=[...new Set([...version.files.flatMap(file=>[file.path,`.trash/knowledge-sources/${file.id}.json`,`.trash/markdown-dependencies/${file.id}.json`]),this.base+'/state.json',groupPath(this.source)])];
   bibliographyState(this.store,this.source);
   const backup={files:paths.map(path=>({path,before:existsSync(this.path(path))?readFileSync(this.path(path),'utf8'):null})),source:(this.store.db.prepare('SELECT data FROM sources WHERE source_id=?').get(this.source) as {data:string}).data,bibliography:(this.store.db.prepare('SELECT data FROM source_bibliography WHERE source_id=?').get(this.source) as {data:string}|undefined)?.data??null};
   this.atomic(this.base+'/restore-pending.json',JSON.stringify(backup));
   activeRestores.add(this.project+'|'+this.source);
   try{
   const baselines={[this.source]:{...this.store.getSource(this.source)!,revision:bibliographyState(this.store,this.source).revision??0}};
   this.markdown.commit(this.project,texts.map(({file,text})=>({path:file.path,text,expected:existsSync(this.path(file.path))?hash(readFileSync(this.path(file.path),'utf8')):null})),baselines,{preserveSourceVersions:true,skipPaperVersion:true,restorePaperSource:this.source});
   for(const {file} of texts){this.markdown.stamp(this.project,file.id,file.dependencies);if(file.source_stamp)this.atomic(`.trash/knowledge-sources/${file.id}.json`,file.source_stamp);else{const path=this.path(`.trash/knowledge-sources/${file.id}.json`);if(existsSync(path))unlinkSync(path);}}
   // A restore is an explicit new version even when restoring an older identical body.
   const state=this.readState(),live=this.virtual();for(const file of live.files)this.blob(readFileSync(this.path(file.path),'utf8'));state.versions.unshift({...live,id:'version_'+randomUUID(),at:new Date().toISOString(),reason:'恢复历史版本'});this.save(state);
   unlinkSync(this.path(this.base+'/restore-pending.json'));
   }catch(error){this.recoverRestore();throw error;}finally{activeRestores.delete(this.project+'|'+this.source);}
  }else if(input.action==='cleanup'){
   const state=this.readState(),docs=this.docs(),id='cleanup_'+randomUUID();const files=input.paths!.map(path=>{const doc=docs.find(doc=>doc.path===path)!;const text=readFileSync(this.path(path),'utf8');if(hash(text)!==doc.hash)fail('旧文件已变化');this.blob(text);return {path,hash:doc.hash,id:doc.id,dependencies:doc.dependencies??[]};});
   // Persist recovery information before removing any live pathname.
   state.cleanups.unshift({id,at:new Date().toISOString(),files});this.save(state);
   const moved:string[]=[];
   try{for(const file of files){const destination=this.path(this.base+'/'+id+'/'+file.path);mkdirSync(dirname(destination),{recursive:true});renameSync(this.path(file.path),destination);moved.push(file.path);}}
   catch(error){for(const path of moved.reverse())renameSync(this.path(this.base+'/'+id+'/'+path),this.path(path));state.cleanups=state.cleanups.filter(item=>item.id!==id);this.save(state);throw error;}
  }else if(input.action==='undo-cleanup'){
   const state=this.readState(),item=state.cleanups.find(item=>item.id===input.id)!;for(const file of item.files)this.text(file);
   const restored:string[]=[];try{for(const file of item.files){if(!existsSync(this.path(file.path))){this.atomic(file.path,this.text(file));restored.push(file.path);}}item.restored_at=new Date().toISOString();this.save(state);}catch(error){for(const path of restored)unlinkSync(this.path(path));throw error;}
  }else{
   const state=this.readState(),version=state.versions.find(item=>item.id===input.id);if(!version)fail('请先保存当前版本后再操作');
   if(input.action==='trash')version.trashed_at=new Date().toISOString();
   if(input.action==='untrash')delete version.trashed_at;
   if(input.action==='note')version.note=input.note;
   if(input.action==='purge'){if(!version.trashed_at)fail('请先移入回收站');state.versions=state.versions.filter(item=>item.id!==input.id);}
   this.save(state);
   if(input.action==='purge'){const keep=new Set([...state.versions.flatMap(item=>item.files.map(file=>file.hash)),...state.cleanups.flatMap(item=>item.files.map(file=>file.hash)),...this.files().map(file=>file.hash)]);for(const file of version.files)if(!keep.has(file.hash)){const blob=this.path(this.base+'/objects/'+file.hash+'.md');if(existsSync(blob))unlinkSync(blob);}}
  }
  this.markdown.recordOperation(this.project,'paper-version',[],`${this.source}：${input.action}`);return this.list();
 }
}

/** Recover interrupted restores before ordinary reads or writes see a mixed group. */
export function recoverPaperVersionWrites(store:TrashStore,markdown:MarkdownKnowledge,project:string){
 const base=join(markdown.root(project),'.trash','paper-versions');
 if(!existsSync(base))return;
 if(lstatSync(base).isSymbolicLink())fail('版本目录不能使用符号链接');
 for(const source of readdirSync(base)){if(!/^source_[A-Za-z0-9_-]+$/.test(source))continue;const directory=join(base,source);if(lstatSync(directory).isSymbolicLink())fail('版本目录不能使用符号链接');if(existsSync(join(directory,'restore-pending.json'))&&!activeRestores.has(project+'|'+source))new PaperWikiVersions(store,markdown,project,source);}
}
