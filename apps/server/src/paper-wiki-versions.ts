import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import type {TrashStore} from '@trash/storage';
import type {MarkdownKnowledge} from './markdown-knowledge.js';
import {bibliographyState} from './source-bibliography.js';

type Ref={path:string;hash:string};
type FileVersion={path:string;hash:string;id:string;dependencies:Ref[];source_stamp?:string};
type Version={id:string;at:string;reason:string;note?:string;task_id?:string;files:FileVersion[];trashed_at?:string};
type Cleanup={id:string;at:string;files:FileVersion[];restored_at?:string};
type State={version:1;versions:Version[];cleanups:Cleanup[]};
export type VersionAction='restore'|'trash'|'untrash'|'purge'|'note'|'cleanup'|'undo-cleanup';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail(message:string):never{throw Object.assign(new Error(message),{statusCode:409});}

/** Group manifests refer to immutable blobs; ungrouped old files are never inferred as versions. */
export class PaperWikiVersions{
 constructor(private store:TrashStore,private markdown:MarkdownKnowledge,private project:string,private source:string){if(!/^source_[A-Za-z0-9_-]+$/.test(source)||store.getSource(source)?.project_id!==project)fail('论文不存在');}
 private get prefix(){return `knowledge_base/papers/${this.source}/`;}
 private path(relative:string){
  const root=this.markdown.root(this.project),target=resolve(root,relative);
  if(!target.startsWith(root+sep))fail('版本路径越界');
  let current=root;for(const part of target.slice(root.length+1).split(sep)){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())fail('版本路径不能使用符号链接');}
  return target;
 }
 private get base(){return `.trash/paper-versions/${this.source}`;}
 private readState():State{const file=this.path(this.base+'/state.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,versions:[],cleanups:[]};}
 private atomic(relative:string,text:string){const file=this.path(relative);mkdirSync(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,file);}
 private save(state:State){this.atomic(this.base+'/state.json',JSON.stringify(state));}
 private blob(value:string){const digest=hash(value),file=this.path(this.base+'/objects/'+digest+'.md');if(!existsSync(file))this.atomic(this.base+'/objects/'+digest+'.md',value);return digest;}
 private text(file:FileVersion){if(!/^[a-f0-9]{64}$/.test(file.hash))fail('快照hash无效');const text=readFileSync(this.path(this.base+'/objects/'+file.hash+'.md'),'utf8');if(hash(text)!==file.hash)fail('版本快照已损坏');return text;}
 private docs(){return this.markdown.index(this.project).documents;}
 private live(){
  const all=this.docs(),byPath=new Map(all.map(doc=>[doc.path,doc]));
  const entry=this.prefix+'whoami.md';if(!byPath.has(entry))return [];
  const paths=new Set([entry]),pending=[entry];
  while(pending.length){const doc=byPath.get(pending.pop()!);for(const target of [...(doc?.links??[]).map(link=>link.path),...(doc?.dependencies??[]).map(ref=>ref.path)])if(target.startsWith(this.prefix)&&!paths.has(target)){paths.add(target);pending.push(target);}}
  return [...paths].sort().flatMap(path=>{const doc=byPath.get(path);return doc?[doc]:[];});
 }
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
  const versions=[...(current_id===live.id&&live.files.length?[live]:[]),...state.versions].map(version=>({...version,files:version.files.map(({path,hash})=>({path,hash})),knowledge_count:version.files.filter(file=>!file.path.includes('/evidence/')).length,evidence_count:version.files.filter(file=>file.path.includes('/evidence/')).length,changes:[...new Set([...version.files.map(file=>file.path),...byPath.keys()])].flatMap(path=>{const previous=version.files.find(file=>file.path===path)?.hash,current=byPath.get(path);return previous===current?[]:[{path,kind:!previous?'current-only':!current?'version-only':'modified'}];})}));
  const current=new Set(live.files.map(file=>file.path));
  const old=this.docs().filter(doc=>doc.source_id===this.source&&doc.path.startsWith(this.prefix)&&!current.has(doc.path)).map(doc=>({path:doc.path,hash:doc.hash,title:doc.document_title??doc.title,blockers:this.blockers([doc.path])}));
  return {current_id,versions,old_files:old,cleanups:state.cleanups.map(item=>({...item,files:item.files.map(({path,hash})=>({path,hash}))})),expected:this.expected(),busy:this.busy()};
 }
 private busy(){return Boolean(this.store.db.prepare("SELECT 1 FROM knowledge_tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(this.project));}
 private expected(){return hash(JSON.stringify([this.readState(),this.docs().map(doc=>[doc.path,doc.hash,doc.dependencies])]));}
 private blockers(paths:string[]){const selected=new Set(paths),current=new Set(this.live().map(doc=>doc.path));const refs=this.docs().filter(doc=>!selected.has(doc.path)&&[...(doc.links??[]).map(link=>link.path),...(doc.dependencies??[]).map(ref=>ref.path)].some(path=>selected.has(path))).map(doc=>doc.path);return [...new Set([...paths.filter(path=>current.has(path)),...refs])];}
 private getVersion(id:string){const state=this.readState(),live=this.virtual();return id===live.id?live:state.versions.find(version=>version.id===id)??fail('版本不存在');}
 file(version_id:string,path:string){const version=this.getVersion(version_id),file=version.files.find(item=>item.path===path);if(!file)fail('版本中无此文件');const text=version.id.startsWith('current-')?readFileSync(this.path(path),'utf8'):this.text(file);if(hash(text)!==file.hash)fail('文件已变化，请刷新');const current=this.live().find(item=>item.path===path);return {path,text,current_text:current?this.markdown.read(this.project,current.id).text:'',hash:file.hash};}
 preview(action:VersionAction,id?:string,paths:string[]=[]){
  const list=this.list();
  if(action==='cleanup'){
   if(!paths.length||paths.some(path=>!list.old_files.some(file=>file.path===path)))fail('只能清理列出的旧文件');
   const blockers=this.blockers(paths);return {expected:list.expected,action,id,paths,blockers,message:'旧文件将移入回收站；不会修改当前Wiki和原始PDF。'};
  }
  if(action==='undo-cleanup'){const item=this.readState().cleanups.find(item=>item.id===id&&!item.restored_at);if(!item)fail('清理记录不存在');return {expected:list.expected,action,id,paths:item.files.map(file=>file.path),blockers:item.files.filter(file=>existsSync(this.path(file.path))).map(file=>file.path),message:'恢复旧文件；存在同名文件时拒绝覆盖。'};}
  const version=id?this.getVersion(id):undefined;
  if(!version)fail('请选择版本');
  if(['trash','purge'].includes(action)&&id===list.current_id)fail('不能删除当前版本');
  const blockers=action==='restore'?this.docs().filter(doc=>!doc.path.startsWith(this.prefix)&&[...(doc.links??[]).map(link=>link.path),...(doc.dependencies??[]).map(ref=>ref.path)].some(path=>path.startsWith(this.prefix)&&version.files.some(file=>file.path===path&&file.hash!==this.docs().find(doc=>doc.path===path)?.hash))).map(doc=>doc.path):[];
  return {expected:list.expected,action,id,paths:version.files.map(file=>file.path),blockers,message:action==='restore'?'将恢复为一个新版本，保留当前版本；原文已变更时仍显示待更新。':action==='purge'?'彻底删除此历史版本记录，无法撤销；共享快照继续保留。':'版本记录将移入回收站，正文共享快照继续保留。'};
 }
 act(input:{action:VersionAction;id?:string;paths?:string[];expected:string;note?:string}){
  if(this.busy())fail('项目有活动任务，完成后可操作');
  if(input.expected!==this.expected())fail('版本或文件已变化，请刷新后重试');
  const preview=this.preview(input.action,input.id,input.paths);if(preview.blockers.length)fail('操作被有效引用或现存文件阻止：'+preview.blockers.join('、'));
  if(input.action==='restore'){
   const version=this.getVersion(input.id!);if(version.trashed_at)fail('请先从回收站恢复该版本');
   const texts=version.files.map(file=>({file,text:version.id.startsWith('current-')?readFileSync(this.path(file.path),'utf8'):this.text(file)}));
   for(const item of texts)if(hash(item.text)!==item.file.hash)fail('快照hash不匹配');
   this.capture('恢复前保留');
   const baselines={[this.source]:{...this.store.getSource(this.source)!,revision:bibliographyState(this.store,this.source).revision??0}};
   this.markdown.commit(this.project,texts.map(({file,text})=>({path:file.path,text,expected:existsSync(this.path(file.path))?hash(readFileSync(this.path(file.path),'utf8')):null})),baselines,{preserveSourceVersions:true,skipPaperVersion:true});
   for(const {file} of texts){this.markdown.stamp(this.project,file.id,file.dependencies);if(file.source_stamp)this.atomic(`.trash/knowledge-sources/${file.id}.json`,file.source_stamp);else{const path=this.path(`.trash/knowledge-sources/${file.id}.json`);if(existsSync(path))unlinkSync(path);}}
   // A restore is an explicit new version even when restoring an older identical body.
   const state=this.readState(),live=this.virtual();for(const file of live.files)this.blob(readFileSync(this.path(file.path),'utf8'));state.versions.unshift({...live,id:'version_'+randomUUID(),at:new Date().toISOString(),reason:'恢复历史版本'});this.save(state);
  }else if(input.action==='cleanup'){
   const state=this.readState(),docs=this.docs(),id='cleanup_'+randomUUID();const files=input.paths!.map(path=>{const doc=docs.find(doc=>doc.path===path)!;const text=readFileSync(this.path(path),'utf8');if(hash(text)!==doc.hash)fail('旧文件已变化');this.blob(text);return {path,hash:doc.hash,id:doc.id,dependencies:doc.dependencies??[]};});
   // Persist recovery information before removing any live pathname.
   state.cleanups.unshift({id,at:new Date().toISOString(),files});this.save(state);
   const moved:string[]=[];
   try{for(const file of files){const destination=this.path(this.base+'/'+id+'/'+file.path);mkdirSync(dirname(destination),{recursive:true});renameSync(this.path(file.path),destination);moved.push(file.path);}}
   catch(error){for(const path of moved.reverse())renameSync(this.path(this.base+'/'+id+'/'+path),this.path(path));state.cleanups=state.cleanups.filter(item=>item.id!==id);this.save(state);throw error;}
  }else if(input.action==='undo-cleanup'){
   const state=this.readState(),item=state.cleanups.find(item=>item.id===input.id)!;for(const file of item.files)this.text(file);
   const restored:string[]=[];try{for(const file of item.files){this.atomic(file.path,this.text(file));restored.push(file.path);}item.restored_at=new Date().toISOString();this.save(state);}catch(error){for(const path of restored)unlinkSync(this.path(path));throw error;}
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
