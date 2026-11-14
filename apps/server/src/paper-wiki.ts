import {resolveKnowledgeLink} from './knowledge-links.js';
import {markdownReferences,knowledgeDocumentId,knowledgeBasePath} from '@trash/protocol';
import {knowledgeFiles} from './knowledge-base-migration.js';
import {existsSync} from 'node:fs';
import {join,posix} from 'node:path';

export const paperWikiNames=['whoami.md','idcard.md','background.md','research_problem.md','contributions.md','method/method.md','results/results.md','limitations.md','insights.md','evidence.md'];
export const paperWikiPaths=(source:string)=>paperWikiNames.map(name=>`knowledge_base/papers/${source}/${name}`);
export const paperCompatibility=(name:string)=>['basic.md','key.md','detail.md','memory.md','index.md','problem.md','method/index.md'].includes(name)||name.startsWith('evidence/');
export function paperWikiOutputPaths(output:string,source:string,required:string[]){
 const prefix=`knowledge_base/papers/${source}/`;
 const found=existsSync(join(output,prefix))?knowledgeFiles(output,prefix.slice(0,-1)).filter(path=>knowledgeBasePath.test(path)&&!paperCompatibility(path.slice(prefix.length))):[];
 const paths=[...new Set([...required,...found])];if(paths.length>40)throw new Error('单篇知识页过多，请合并碎片页面（最多40页）');return paths;
}
export function paperWikiIssues(source:string,files:{path:string;text:string}[]){
 const unresolved=files.map(file=>({path:file.path,ids:markdownReferences(file.text).unresolved}));
 files=files.map(file=>({...file,text:markdownReferences(file.text).text}));
 const prefix=`knowledge_base/papers/${source}/`;const byPath=new Map(files.map(file=>[file.path,file.text]));
 const issues:{path:string;reason:string;unsafe:boolean}[]=[];
 const issue=(path:string,reason:string)=>issues.push({path,reason,unsafe:false});
 for(const file of unresolved)for(const id of file.ids)issue(file.path,'引用式链接缺少定义：'+id);
 const graph=new Map<string,string[]>();
 for(const file of files){const links=[...file.text.replace(/```[\s\S]*?```/g,'').matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].flatMap(match=>{const target=resolveKnowledgeLink(file.path,match[1]);if(!target)return [];if(!target.startsWith(prefix)||!byPath.has(target))issue(file.path,'知识导航仅引用本篇实际输出的知识页：'+match[1]);return [target];});graph.set(file.path,links);}
 const reachable=new Set([prefix+'whoami.md']);let changed=true;while(changed){changed=false;for(const path of [...reachable])for(const target of graph.get(path)??[])if(!reachable.has(target)){reachable.add(target);changed=true;}}
 for(const file of files)if(!reachable.has(file.path))issue(prefix+'whoami.md','该知识页未被论文导航或子目录覆盖：'+file.path.slice(prefix.length));
 const evidence=byPath.get(prefix+'evidence.md');const anchors=evidence?[...evidence.matchAll(/^##\s+(ev-[a-z0-9][a-z0-9_-]*)\s*$/gm)].map(match=>match[1]):[];
 if(evidence&&(!anchors.length||new Set(anchors).size!==anchors.length))issue(prefix+'evidence.md','依据页需要不重复的稳定ev-*二级标题锚点');
 for(const name of paperWikiNames)if(!byPath.has(prefix+name))issue(prefix+name,'缺少本篇必需知识页');
 for(const file of files){
  if(!file.path.startsWith(prefix)){issue(file.path,'不得生成其他来源内容');continue;}
  const name=file.path.slice(prefix.length);
  if(name!=='whoami.md'&&!(graph.get(file.path)??[]).includes(prefix+'whoami.md'))issue(file.path,'每个论文子页必须直接链接本篇whoami.md');
  if(!paperWikiNames.includes(name)&&!/^method\/[a-z][a-z0-9_-]*\.md$|^results\/[a-z][a-z0-9_-]*\.md$/.test(name))issue(file.path,'只允许本篇职责页及方法/实验子页');
  const body=file.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
  if(name!=='whoami.md'&&!/^\s*\[论文总览\]\([^\s)]+\)[ \t]*(?:\r?\n|$)/.test(body))issue(file.path,'论文总览导航必须在正文第一行单独成行，位于一级标题之前');
  if(name!=='evidence.md'&&(/\/pdf-view\?|\]\([^)]*\.pdf(?:[?#][^)]*)?\)/i.test(body)))issue(file.path,'原文定位仅放统一evidence.md，正文链接依据条目');
  if(name==='whoami.md'){
   const headings=[...body.matchAll(/^##\s+(.+)$/gm)].map(m=>m[1].trim());
   if(headings.join('|')!=='一句话认识|知识导航')issue(file.path,'whoami只保留题目、一句话认识、知识导航');
   const sentence=body.split(/^## 一句话认识\s*$/m)[1]?.split(/^## /m)[0]?.trim();if(!sentence)issue(file.path,'缺少问题与方法的一句话认识');
  }else if(name!=='evidence.md'&&name!=='idcard.md'){
   if(!/^## 概览\s*$/m.test(body))issue(file.path,'知识页需有概览，不另写检索摘要或适合回答栏目');
   if(/^## (检索摘要|适合回答)\s*$/m.test(body))issue(file.path,'删除重复检索摘要或固定问题列表');
   if(name==='background.md'){
    const headings=[...body.matchAll(/^##\s+(.+)$/gm)].map(m=>m[1].trim());if(headings.join('|')!=='概览|已有研究与不足')issue(file.path,'背景页仅概览和已有研究与不足两个正文部分');
   }
   const refs=[...body.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)].filter(m=>m[1].split('#')[0].endsWith('evidence.md'));
   if(!refs.length)issue(file.path,'知识页至少链接一个真实依据条目，缺失时在依据页明确材料不足');
   for(const ref of refs){const [target,fragment]=ref[1].split('#');const resolved=posix.normalize(posix.join(posix.dirname(file.path),target));if(resolved!==prefix+'evidence.md'||!fragment||!anchors.includes(fragment))issue(file.path,'依据链接必须指向本篇存在的ev-*条目：'+ref[1]);}
  }
  if(name==='evidence.md')for(const match of body.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)){
   const target=match[1];if(resolveKnowledgeLink(file.path,target)!==prefix+'whoami.md'&&!/^(?:\/api\/|https?:\/\/)/.test(target))issue(file.path,'依据页除返回whoami导航外，仅引用原文');
  }
 }
 return issues;
}
export function paperWikiPrompt(source:string,wikiOnly:boolean){
 const prefix=`knowledge_base/papers/${source}/`;
 return `读取 literature-skill/SKILL.md、literature-skill/references/paper-wiki.md 和 input.json。当前采用新版单篇论文知识协议，优先于旧四文档、index与分散原文引用规范。只处理 source_id=${source}。${wikiOnly?'基于本篇已有材料重组，不读取PDF或声称重新核验原文。':'完整读取本次全部四页图文批次笔记，在本次生成中综合全文并统一术语、条件与证据，直接组织Wiki组，不单独生成整篇认识文件或增加汇总调用。'}\n先在任务根目录保存knowledge-plan.md，列出职责页、实际需要的机制/实验子页和稳定依据条目。保留已有人工补充，将旧正文的认识和原文定位分配到新页；无法迁移的人工内容在新页明确保留，不静默删除。先生成知识与结果、归并依据，最后生成whoami。\n全部Markdown写入 output/${prefix}。必需：${paperWikiNames.join('、')}。可选 method/<slug>.md、results/<slug>.md，slug仅小写英文、数字、单个连字符或下划线，不使用连续--。不为数量凑页，不生成旧basic/key/detail/memory或index/problem/evidence目录正文；题录写入 idcard.md（kind: wiki-page），仅保留标题、作者、期刊/会议、发表时间、源码状态（有地址就填地址，没有写无）；whoami 的知识导航必须单向链接 ./idcard.md。现有非兼容知识子页仍有效时要一并保留并纳入导航。\n每页frontmatter knowledge_version: 2、kind: wiki-page、source_id: ${source}、level: single。稳定ID=${'wiki-'+source+'--'}加相对论文目录文件名去掉.md且将/替换为--。例如whoami=${knowledgeDocumentId(prefix+'whoami.md')}，方法总览=${knowledgeDocumentId(prefix+'method/method.md')}。\nwhoami仅正式题目、二级标题“ 一句话认识 ”（概括问题+方法，无性能数字和结果评价）、“ 知识导航 ”。作者、DOI、源码等题录不放入whoami。background仅“概览”“已有研究与不足”和研究问题/依据链接。其他职责页按references/paper-wiki.md精简模板写概览与职责正文，不重复添加检索摘要、适合回答和长篇关联栏目。概览保存认识与限定，不只写“本页介绍”。\n唯一evidence.md用## ev-具体英文标识建立稳定条目，记真实原文页、图表、原文链接、来源版本、支持范围与必要摘录；材料缺口明确记录，不伪造出处。知识页仅链接本篇evidence.md#ev-*，不重复PDF引用和页码出处；正文仍保留实验条件、指标口径、未知与作者声明/推断边界。每个子页（包括idcard与evidence）必须在frontmatter之后、一级标题之前的正文第一行单独放置 [论文总览](相对路径whoami.md)，根子页使用 ./whoami.md，method/results 子页使用 ../whoami.md；whoami 的知识导航直接链接全部子页。这些双向链接仅作导航，不是引用依据。依据页除入口导航外不反向链接知识页。相对链接按所在路径计算，所有页从whoami可达，子页链接总览。\n不生成其他论文、摘要或跨论文主题。不实现depth或渐进读取协议。完成后核对完整目录、出处锚点和内容分工。信息密度遵守 references/paper-wiki.md：方法先解释完整链路再集中列缺口；表格存数据、正文解释差异与反例；局限说明使用影响、认识提炼迁移判断，不重复摘要。依据页公共版本和阅读范围只声明一次，原文地址可用引用式链接定义复用。保留影响结论的条件，不硬截断、不新增压缩调用；完成前在本次调用内回读去重。用户要求：`;
}
