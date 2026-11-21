import {posix} from 'node:path';
import {markdownReferences} from '@trash/protocol';
import {rewriteKnowledgeText} from './knowledge-base-migration.js';

export const explorationDirectory='knowledge_base/explorations';
export const explorationIndexId='wiki-exploration-index';
export const explorationIndexPath=explorationDirectory+'/index.md';
export const explorationTopicId=(candidate:string)=>'wiki-exploration-'+candidate;
export const explorationTopicPath=(candidate:string)=>`${explorationDirectory}/${explorationTopicId(candidate)}.md`;

const label=(text:string)=>text.replace(/[\\`\[\]*_]/g,'\\$&').replace(/[\r\n]/g,' ');
export function documentLink(from:string,path:string,title:string){
 const relative=posix.relative(posix.dirname(from),path);
 return `[${label(title)}](${relative.startsWith('.')?relative:'./'+relative})`;
}

export function explorationTopicFile(runId:string,report:{path:string;title:string;text:string},candidate:{id:string;title:string;body:string;complete:boolean}){
 const id=explorationTopicId(candidate.id),path=explorationTopicPath(candidate.id);
 const body=rewriteKnowledgeText(markdownReferences(candidate.body,report.text).text,report.path,path,{},true)
  .trim().replace(/^###(?=\s)/gm,'##');
 const origin=documentLink(path,report.path,'打开原始探索报告');
 const notice=candidate.complete?'':'> 待补齐：原报告的章节或可追溯论文依据不完整。\n\n';
 return {path,text:`---
knowledge_version: 2
id: ${id}
kind: wiki-page
level: exploration
page_role: exploration-topic
exploration_run_id: ${runId}
exploration_candidate_id: ${candidate.id}
---

# ${candidate.title}

${notice}${origin}

${body}
`};
}

export function explorationIndex(previous:string|undefined,sections:string[]){
 const start='<!-- exploration-index:start -->',end='<!-- exploration-index:end -->';
 const block=[start,...sections,end].join('\n\n');
 if(previous){
  const first=previous.indexOf(start),last=previous.indexOf(end);
  if(first<0||last<first)throw new Error('探索主题索引缺少生成区标记，已保留现有内容。');
  return previous.slice(0,first)+block+previous.slice(last+end.length);
 }
 return `---
knowledge_version: 2
id: ${explorationIndexId}
kind: wiki-page
level: exploration
page_role: exploration-index
---

# 探索主题索引

${block}
`;
}
