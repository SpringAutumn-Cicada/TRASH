import {knowledgeDocumentId,knowledgeBasePath} from '@trash/protocol';
import {knowledgeFiles} from './knowledge-base-migration.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export const paperWikiNames=['index.md','problem.md','method/index.md','contributions.md','evidence/index.md','limitations.md','insights.md'];
export const paperWikiPaths=(source:string)=>paperWikiNames.map(name=>`knowledge_base/papers/${source}/${name}`);
export function paperWikiOutputPaths(output:string,source:string,required:string[]){
 const prefix=`knowledge_base/papers/${source}/`;
 const found=existsSync(join(output,prefix))?knowledgeFiles(output,prefix.slice(0,-1)).filter(path=>knowledgeBasePath.test(path)&&!['basic.md','key.md','detail.md','memory.md'].includes(path.slice(prefix.length))):[];
 const paths=[...new Set([...required,...found])];if(paths.length>44)throw new Error('单篇知识页过多，请合并碎片页面（最多44页）');return paths;
}
export function paperWikiPrompt(source:string,wikiOnly:boolean){
 const prefix=`knowledge_base/papers/${source}/`;
 return `读取 literature-skill/SKILL.md、references/paper-wiki.md 和 input.json。本任务采用单篇分层 Wiki 协议，覆盖旧四文档协议；只处理 source_id=${source}。${wikiOnly?'依据已有卡片及本篇现有知识页重组，不重新读取PDF。保留人工补充，明确本轮未重新核验原文。':'完整阅读本篇PDF所有图文批次，先形成整体理解，再组织独立知识页。'}\n输出到 output/${prefix}。必需入口：${paperWikiNames.join('、')}。按论文实际内容可增加 method/<slug>.md 和 evidence/<slug>.md 等子页，不为了数量机械拆分。slug使用小写英文、数字、单个连字符或下划线，不使用连续双连字符。每页必须有 frontmatter：knowledge_version: 2、kind: wiki-page、source_id: ${source}、level: single；id 根据相对论文目录文件名（去.md，将 / 替换成 --）加前缀 wiki-${source}-- 生成，例如方法总览 id 为 wiki-${source}--method--index。根index稳定ID为 ${knowledgeDocumentId(prefix+'index.md')}。\n先写机制和证据页，最后写论文index；index一级标题使用正式论文标题，保留题录和原文资源入口、一句话认识、任务、方法主链、关键结果及条件、带内容说明的目录、阅读路线和材料范围；正文500–900字为软目标。所有知识页必须能沿index目录到达，子页有上级入口；索引必须覆盖本篇已有仍保留的知识页，已有页有实质更新需要一并输出。每张卡片能独立回答一个问题，关键数字有设置和PDF页码，事实/作者主张/推断分开。导航、前置、证据、限制、总结链接须说明含义，不伪造关系，不把相互引用当作相互支持。没有材料的栏目说明缺失，不生成虚假细节。\n${wikiOnly?'三张旧卡片仅作阅读依据，不改写。':'额外生成 basic.md，保持旧基本信息卡schema与id card-'+source+'-basic，严格遵守references/basic.md；它是题录兼容数据，完整解释放新知识页。'}不要生成key.md、detail.md或memory.md正文；平台会维护旧入口兼容。不要修改其他论文、摘要或跨论文主题。本轮用户要求：`;
}
