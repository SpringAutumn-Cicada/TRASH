import {resolveKnowledgeLink} from './knowledge-links.js';
import {markdownReferences,knowledgeDocumentId,knowledgeBasePath} from '@trash/protocol';
import {knowledgeFiles} from './knowledge-base-migration.js';
import {existsSync,readFileSync} from 'node:fs';
import {join,posix} from 'node:path';

const outputContract=JSON.parse(readFileSync(new URL('../../../.agents/skills/trash-literature-wiki/contract.json',import.meta.url),'utf8')) as {required_pages:string[];navigation:[string,string][]};
export const paperWikiNames=outputContract.required_pages;
export const paperWikiNavigation=outputContract.navigation;
export const paperWikiPaths=(source:string)=>paperWikiNames.map(name=>`knowledge_base/papers/${source}/${name}`);
export const paperCompatibility=(name:string)=>['basic.md','key.md','detail.md','memory.md','index.md','problem.md','method/index.md'].includes(name)||(name.startsWith('evidence/')&&!/^evidence\/ev-[a-z0-9][a-z0-9_-]*\.md$/.test(name));
export function paperWikiOutputPaths(output:string,source:string,required:string[]){
 const prefix=`knowledge_base/papers/${source}/`;
 const found=existsSync(join(output,prefix))?knowledgeFiles(output,prefix.slice(0,-1)).filter(path=>knowledgeBasePath.test(path)&&!paperCompatibility(path.slice(prefix.length))):[];
 const paths=[...new Set([...required,...found])];if(paths.filter(path=>!path.slice(prefix.length).startsWith('evidence/')).length>40||paths.filter(path=>path.slice(prefix.length).startsWith('evidence/')).length>80)throw new Error('单篇最多40个知识页、80个依据条目，请合并重复内容');return paths;
}
export function paperWikiIssues(source:string,files:{path:string;text:string}[]){
 const unresolved=files.map(file=>({path:file.path,ids:markdownReferences(file.text).unresolved}));
 files=files.map(file=>({...file,text:markdownReferences(file.text).text}));
 const prefix=`knowledge_base/papers/${source}/`;const byPath=new Map(files.map(file=>[file.path,file.text]));
 const issues:{path:string;reason:string;unsafe:boolean}[]=[];
 const issue=(path:string,reason:string)=>issues.push({path,reason,unsafe:false});
 for(const file of unresolved)for(const id of file.ids)issue(file.path,'引用式链接缺少定义：'+id);
 const paperTitle=byPath.get(prefix+'whoami.md')?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').match(/^#\s+(.+)$/m)?.[1]?.trim();
 const graph=new Map<string,string[]>();
 for(const file of files){const links=[...file.text.replace(/```[\s\S]*?```/g,'').matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].flatMap(match=>{const target=resolveKnowledgeLink(file.path,match[1]);if(!target)return [];if(!target.startsWith(prefix)||!byPath.has(target))issue(file.path,'知识导航仅引用本篇实际输出的知识页：'+match[1]);return [target];});graph.set(file.path,links);}
 const reachable=new Set([prefix+'whoami.md']);let changed=true;while(changed){changed=false;for(const path of [...reachable])for(const target of graph.get(path)??[])if(!reachable.has(target)){reachable.add(target);changed=true;}}
 for(const file of files)if(!reachable.has(file.path))issue(prefix+'whoami.md','该知识页未被论文导航或子目录覆盖：'+file.path.slice(prefix.length));
 const records=files.filter(file=>/^evidence\/ev-[a-z0-9][a-z0-9_-]*\.md$/.test(file.path.slice(prefix.length)));
 if(!records.length)issue(prefix+'evidence.md','至少提供一个独立依据条目，材料不足也需明确记载');
 for(const name of paperWikiNames)if(!byPath.has(prefix+name))issue(prefix+name,'缺少本篇必需知识页');
 for(const file of files){
  if(!file.path.startsWith(prefix)){issue(file.path,'不得生成其他来源内容');continue;}
  const name=file.path.slice(prefix.length);
  if(!paperWikiNames.includes(name)&&!/^method\/[a-z][a-z0-9_-]*\.md$|^results\/[a-z][a-z0-9_-]*\.md$|^evidence\/ev-[a-z0-9][a-z0-9_-]*\.md$/.test(name))issue(file.path,'只允许本篇职责页及方法/实验子页');
  const body=file.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
  const leading=body.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const isEvidence=name.startsWith('evidence/');
  if(isEvidence||name==='whoami.md'){
   if(name==='whoami.md'&&!/^#\s+\S/.test(leading[0]??''))issue(file.path,'论文入口从当前页标题开始');
   if(isEvidence&&/\[论文总览\]\(/.test(body))issue(file.path,'独立依据文档不添加论文名与论文总览');
  }else{
   if(!paperTitle||leading[0]!==paperTitle||!/^\[论文总览\]\([^\s)]+\)$/.test(leading[1]??'')||!/^#\s+\S/.test(leading[2]??''))issue(file.path,'普通知识子页前三个非空行依次为论文全名、论文总览链接、当前页标题');
   if(!(graph.get(file.path)??[]).includes(prefix+'whoami.md'))issue(file.path,'论文总览链接须指向本篇whoami.md');
  }
  if(!isEvidence&&(/\/pdf-view\?|\]\([^)]*\.pdf(?:[?#][^)]*)?\)/i.test(body)))issue(file.path,'PDF原文定位仅放独立evidence/ev-*.md');
  if(isEvidence){
   const id=name.slice('evidence/'.length,-3);
   if(leading[0]!=='[依据总览](../evidence.md)'||leading[1]!=='# '+id||!/^page_role:\s*evidence\s*$/m.test(file.text))issue(file.path,'独立依据首行必须为[依据总览](../evidence.md)，下一段为ev-*标题，并声明page_role: evidence');
   if(!/^pdf_hash:\s*(?:[a-f0-9]{64}|unknown)\s*$/m.test(file.text))issue(file.path,'独立依据必须记录pdf_hash，原文缺失时明确unknown');
   for(const field of ['定位','事实','边界'])if(!new RegExp('^\\*\\*'+field+'：\\*\\*\\s*\\S','m').test(body))issue(file.path,'紧凑依据需有非空的加粗字段：'+field);
   if(/^##\s+/m.test(body))issue(file.path,'依据使用加粗字段，不再使用二级标题');

  }
  if(name==='whoami.md'){
   const headings=[...body.matchAll(/^##\s+(.+)$/gm)].map(m=>m[1].trim());
   if(headings.join('|')!=='一句话认识|知识导航')issue(file.path,'whoami只保留题目、一句话认识、知识导航');
   const navigation=body.split(/^## 知识导航\s*$/m)[1]??'';
   const entries=[...navigation.matchAll(/^[-*+] \[([^\]\n]+)\]\(([^\s)]+)\)[：:]\s*(\S[^\n]*)$/gm)];
   const core=entries.filter(entry=>paperWikiNavigation.some(([,name])=>resolveKnowledgeLink(file.path,entry[2])===prefix+name));
   if(core.length!==paperWikiNavigation.length||core.some((entry,index)=>entry[1]!==paperWikiNavigation[index]?.[0]||resolveKnowledgeLink(file.path,entry[2])!==prefix+paperWikiNavigation[index]?.[1]))issue(file.path,'知识导航须按指定顺序包含九个固定名称和对应路径，每项链接后用冒号附非空简短说明');
   const sentence=body.split(/^## 一句话认识\s*$/m)[1]?.split(/^## /m)[0]?.trim();if(!sentence)issue(file.path,'缺少问题与方法的一句话认识');
  }else if(!isEvidence&&name!=='evidence.md'&&name!=='idcard.md'){
   if(!/^## 概览\s*$/m.test(body))issue(file.path,'知识页需有概览，不另写检索摘要或适合回答栏目');
   if(/^## (检索摘要|适合回答)\s*$/m.test(body))issue(file.path,'删除重复检索摘要或固定问题列表');
   if(name==='background.md'){
    const headings=[...body.matchAll(/^##\s+(.+)$/gm)].map(m=>m[1].trim());if(headings.join('|')!=='概览|已有研究与不足')issue(file.path,'背景页仅概览和已有研究与不足两个正文部分');
   }
   const refs=[...body.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)\)/g)].filter(m=>m[2].includes('evidence/')) ;
   if(!refs.length)issue(file.path,'知识页至少链接一个本篇独立依据条目');
  }
  for(const ref of body.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)\)/g)){
   const resolved=resolveKnowledgeLink(file.path,ref[2]);
   if(resolved?.startsWith(prefix+'evidence/')){const id=posix.basename(resolved,'.md');if(!byPath.has(resolved)||ref[1]!==id||ref[2].includes('#'))issue(file.path,'依据链接须使用条目名并直达独立文件：'+ref[2]);}
   if(resolved===prefix+'evidence.md'&&ref[2].includes('#'))issue(file.path,'不再引用统一依据页锚点');
  }
  if(name==='evidence.md'){
   if(!/^page_role:\s*evidence-index\s*$/m.test(file.text))issue(file.path,'依据目录声明page_role: evidence-index');
   const entries=body.slice(body.search(/^#\s+.+$/m)).split('\n').slice(1).map(line=>line.trim()).filter(Boolean);
   if(entries.some(line=>!/^[-*+] \[ev-[a-z0-9][a-z0-9_-]*\]\([^\s)]+\)$/.test(line)))issue(file.path,'原文依据标题后仅保留依据链接列表，不写说明文字');
   for(const record of records)if(!(graph.get(file.path)??[]).includes(record.path))issue(file.path,'依据目录遗漏条目：'+record.path);
  }
 }
 return issues;
}
/** Content review remains inside the existing generation turn, never a structural pass/fail claim. */
export const paperWikiSemanticReview='完成前在本次调用内按 literature-skill/references/paper-wiki.md 做语义回读；不新增审核调用或文件，结构检查不能代替原文核验。';

export function paperWikiPrompt(source:string,wikiOnly:boolean){
 const prefix=`knowledge_base/papers/${source}/`;
 return `读取 literature-skill/SKILL.md、literature-skill/references/paper-wiki.md、literature-skill/contract.json 和 input.json，使用 trash-literature-wiki。只处理 source_id=${source}。
${wikiOnly?'仅基于实际提供材料修订，保留人工内容，不宣称重新阅读PDF。':'完整读取本次全部有效四页图文批次笔记，在同一次生成中综合全文；重新分析从空输出开始，不读取历史Wiki。'}
直接写 Markdown 到 output/${prefix}。必需输出：${paperWikiNames.filter(name=>name!=='evidence.md').map(name=>name+'（ID='+knowledgeDocumentId(prefix+name)+'）').join('、')}。evidence.md由发布前脚本生成；若已有目录不得添加说明正文。方法和结果子页按需生成。独立依据是必需输出：必须写 evidence/ev-reading-scope.md，以及支撑正文引用的 evidence/ev-<slug>.md；每个引用对应一个实际文件，不能只在正文写链接。依据内容由模型依据当前材料生成，脚本仅生成目录，不会生成依据事实。不要运行发布前脚本或写派生manifest，由平台统一执行。其他文件仅供阅读，不修改。用户要求：`;
}
