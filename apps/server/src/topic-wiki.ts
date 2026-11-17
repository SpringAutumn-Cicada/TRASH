import {existsSync,readFileSync} from 'node:fs';
import {join,posix} from 'node:path';
import {type KnowledgeTaskInput} from '@trash/protocol';
import {knowledgeFiles} from './knowledge-base-migration.js';
import {knowledgeLinks} from './knowledge-links.js';
import type {PaperWikiIssue} from './paper-wiki.js';

export const isTopicBundle=(input:KnowledgeTaskInput)=>!input.abstract_mode&&input.kind==='wiki-page'&&input.wiki_level==='topic'&&(!input.research_skill||input.research_skill==='synthesis')&&(!input.research_exploration||['topic','comparison'].includes(input.research_exploration));
export const topicRoles=['methods','results','insights'] as const;
export const topicPaths=(id:string)=>[`knowledge_base/topics/${id}.md`,...topicRoles.map(role=>`knowledge_base/topics/${id}--${role}.md`)];
export function topicOutputPaths(output:string,id:string,required:string[]){
 const allowed=topicPaths(id),prefix=`knowledge_base/topics/${id}--`;
 const found=knowledgeFiles(output,'knowledge_base/topics').filter(path=>path===allowed[0]||path.startsWith(prefix));
 return [...new Set([allowed[0],...required,...found])];
}
export function topicGroupIssues(id:string,files:{path:string;text:string}[],sources:string[],available:string[],invalid:string[]=[]):PaperWikiIssue[]{
 const allowed=topicPaths(id),root=allowed[0],issues:PaperWikiIssue[]=[];
 const paths=new Set([...files.map(f=>f.path),...invalid]),known=new Set([...available,...paths]);
 const issue=(path:string,reason:string)=>issues.push({path,reason,unsafe:false});
 if(!paths.has(root))issue(root,'主题组缺少总览入口');
 const graph=new Map<string,string[]>();
 for(const file of files){
  if(!allowed.includes(file.path)){issue(file.path,'只允许本主题入口与 methods/results/insights 子页');continue;}
  const meta=file.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1]??'';
  const field=(key:string)=>meta.match(new RegExp('^'+key+':\\s*(\\S+)\\s*$','m'))?.[1];
  if(field('topic_id')!==id||field('level')!=='topic'||field('source_id'))issue(file.path,`主题元数据要求 topic_id: ${id}、level: topic，不写 source_id`);
  if(field('page_role')!==(file.path===root?'topic-synthesis':'topic-page'))issue(file.path,'主题入口 page_role: topic-synthesis，子页 page_role: topic-page');
  const headings=file.path===root?['何时读取','材料范围','问题边界','背景与挑战','核心认识','路线与取舍','深入阅读','未知与后续','引用依据']:['何时读取','比较分析','未知与后续','引用依据'];
  for(const heading of headings){const section=file.text.split(new RegExp('^## '+heading+'\\s*$','m'))[1]?.split(/^## /m)[0]?.trim();if(!section)issue(file.path,'缺少有内容的栏目：'+heading);}
  const links=knowledgeLinks(file.path,file.text);graph.set(file.path,links.map(l=>l.path));
  if(file.path!==root&&!links.some(l=>l.path===root))issue(file.path,'子页必须链接主题总览：./'+id+'.md');
  for(const link of links){
   if(!known.has(link.path))issues.push({path:allowed.includes(link.path)?link.path:file.path,reason:'引用目标不存在：'+link.path,unsafe:false,...(allowed.includes(link.path)?{missing_target:link.path,referenced_by:[file.path]}:{})});
   const source=link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.[1];
   if(source&&!sources.includes(source))issue(file.path,'引用论文不属于本次主题范围：'+source);
  }
  if(!links.some(l=>l.evidence&&sources.some(source=>l.path.startsWith(`knowledge_base/papers/${source}/`))))issue(file.path,'引用依据需链接实际使用的原始论文 Wiki 或独立依据，不能只有分组总结');
 }
 if(files.some(f=>f.path===root)&&!invalid.includes(root)){
  const reached=new Set([root]);let changed=true;while(changed){changed=false;for(const path of [...reached])for(const target of graph.get(path)??[])if(paths.has(target)&&!reached.has(target)){reached.add(target);changed=true;}}
  for(const file of files)if(!reached.has(file.path))issue(root,'总览未覆盖主题子页：'+posix.basename(file.path));
 }
 return issues;
}
export function topicPrompt(id:string,title:string){
 return `本次生成一个主题 Wiki 组“${title}”。此组协议优先于单文件路径提示。入口 ${topicPaths(id)[0]} 为必需，按独立价值可增加 ${topicPaths(id).slice(1).join('、')}，不得生成其他路径。各页 id=文件名去.md，topic_id: ${id}，level: topic，kind: wiki-page，knowledge_version: 2；入口 page_role: topic-synthesis，子页 page_role: topic-page，不写 source_id。严格使用 literature-skill/references/synthesis.md 的主题组栏目。入口链接全部子页，子页链接入口；已有子页、人工内容和未覆盖认识必须保留，不删除有效内容规避检查。背景、可复用认识分点；判断机制补读方法、效果补读结果、争议及精确数字补读独立依据。引用依据必须链接实际原始论文，索引不算已读。只生成本主题，不触发地图、背景或方向任务。不读 PDF 或自动联网。`;
}
export function topicManifest(root:string,id:string){
 const file=join(root,'.trash/topic-groups',id+'.json');
 return existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as {version:1;topic_id:string;revision:number;current:{path:string;hash:string}[]}:undefined;
}
