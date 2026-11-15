import {resolveKnowledgeLink} from './knowledge-links.js';
import {markdownReferences,knowledgeDocumentId,knowledgeBasePath} from '@trash/protocol';
import {knowledgeFiles} from './knowledge-base-migration.js';
import {existsSync} from 'node:fs';
import {join,posix} from 'node:path';

export const paperWikiNames=['whoami.md','idcard.md','background.md','research_problem.md','contributions.md','method/method.md','results/results.md','limitations.md','insights.md','evidence.md'];
export const paperWikiNavigation=[['题录','idcard.md'],['背景','background.md'],['研究问题','research_problem.md'],['贡献','contributions.md'],['方法','method/method.md'],['实验与结果','results/results.md'],['局限','limitations.md'],['可复用认识','insights.md'],['依据总览','evidence.md']] as const;
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
/** Single-paper priorities are stated once in generation; the in-turn review checks their effect. */
const paperWikiWritingGuidance=`内容投入：重点展开背景、方法、可复用认识；研究问题、贡献及实验与结果简明但充分；局限按实际影响保留，题录与依据保持紧凑且可追溯。不设统一字数配额，简单论文不扩写，复杂方法不省关键机制，重要结果与反例不因优先级降低而省略。
背景概览用短段说明核心矛盾，“已有研究与不足”按研究路线或核心问题分点，每点用“**简短主题：** 完整解释”组织已有做法解决了什么、仍有哪些问题及其影响，并就近引用。每点须可独立阅读、引用和组合，不机械切段、不只列缺点、不固定类别和条数，不提前展开本论文完整方法。
方法总览串起输入→表示→核心处理→输出，正文按实际步骤或机制解释具体实现、原文支持的设计原因、信息传递及与已有做法的差别，说明必要训练/计算/推理与核心公式的变量和作用；不只列组件。算法、系统、基准及其他类型按实际贡献组织，不强拆模块或补造设计原因；复杂机制可放子页，主方法页仍保留完整链路。实验参数取值、划分、调参、训练轮数、硬件和配置归实验页。
可复用认识按独立设计经验分点，每点用“**认识名称：** 完整说明”，自然讲清可借鉴做法、为何有用及适用条件，链接原文方法/结果依据，不机械增加固定字段。不重述贡献，不写空泛启示，不从单篇结果推出普遍规律；整理者的新方法、组合和实验建议仅放可选的“延伸思考（待验证）”，不冒充原文认识，没有必要则不生成。
研究问题简短分点交代目标、任务与核心挑战，贡献简短分点交代具体新增工作及作用，均不重复背景或方法细节。实验设置集中简写，主要结果按发现分点，代表性数字与原文解释就近呈现，只保留帮助理解设计取舍的关键消融和效率结果，必要时使用紧凑表格；不新增原文未讨论的保守推断。局限按原文明示的重要限制分点，不凑风险清单。
同一内容在职责页完整解释，其他页面只留必要衔接、限定和链接：背景讲研究必要性，研究问题讲具体目标，贡献讲新增工作，方法讲实现，实验讲验证发现，局限讲使用限制，可复用认识讲可借鉴经验，依据保存支撑事实与出处。保持本论文作者式叙述，公共范围与核验记录保持客观。`;

/** One targeted self-check in the existing generation call; no mandatory full reread. */
export const paperWikiSelfCheck=`本次生成或修复结束后，只在当前调用内做一次轻量自查：方法链路是否有明显缺环，主要结果的对象、数值、关键条件与依据是否一致。先利用已读材料和刚写内容判断；只有发现具体疑点时才读取相关文件片段，修正本次允许修改的内容，没有疑点即可结束。不固定重读整个Wiki组、全部依据或PDF，不重新审阅已保护草稿，不反复整组润色。文件存在、格式、路径、ID和链接由后台校验；不额外调用模型或创建检查脚本、审核文件。如实报告未确认事项，不把自查称为事实核验。`;

export function paperWikiPrompt(source:string,wikiOnly:boolean){
 const prefix=`knowledge_base/papers/${source}/`;
 return `读取 literature-skill/SKILL.md、literature-skill/references/paper-wiki.md 和 input.json。当前采用新版单篇论文知识协议，优先于旧四文档、index与统一依据锚点规范。只处理 source_id=${source}。全文采用作者式研究说明，使用“本论文提出”“实验表明”或直接陈述，不使用“我们”，不机械重复主语；减少第三方审阅措辞，不添加原文未讨论且不影响准确表述的保守推断。作者口吻不代表已核验，不扩大原文结论。${wikiOnly?'基于本篇已有材料重组，不读取PDF或声称重新核验原文。':'完整读取本次全部四页图文批次笔记，在本次生成中综合全文并统一术语、条件与证据，直接组织Wiki组，不单独生成整篇认识文件或增加汇总调用。'}\n${paperWikiWritingGuidance}\n先在任务根目录保存knowledge-plan.md，列明本篇研究目标与贡献类型，再按实际论证需要列出职责页、必要机制/实验子页和稳定依据条目。算法/方法侧重机制与消融，基准/评估侧重任务及比较协议，系统/工具的方法侧重协作与工作流，实验页简述运行条件并呈现成本结果；其他类型按实际论证组织，混合贡献可组合，不为模板编造训练、实验或强制增加子页。保留已有人工补充，将旧正文的认识和原文定位分配到新页；无法迁移的人工内容在新页明确保留，不静默删除。先生成知识与结果、归并依据，最后生成whoami。\n全部Markdown写入 output/${prefix}。必需：${paperWikiNames.join('、')}。可选 method/<slug>.md、results/<slug>.md，slug仅小写英文、数字、单个连字符或下划线，不使用连续--。先写正文，再按实际论断生成事实依据；每个事实依据须有具体正文使用位置，目录收录不代替正文引用。合并重复条目，撤下无正文用途的依据，不强塞无关引用；ev-reading-scope通过scope_ref关联，不要求正文重复引用。不手动删除已发布旧文件，整组清单与归档由后台处理。局部修订不扩大整组替换。不为数量凑页，不生成旧basic/key/detail/memory或index/problem正文；独立依据放evidence/ev-<slug>.md；题录写入 idcard.md（kind: wiki-page），仅保留标题、作者、期刊/会议、发表时间、源码状态（有地址就填地址，没有写无）；whoami 的知识导航必须单向链接 ./idcard.md。现有非兼容知识子页仍有效时要一并保留并纳入导航。\n每页frontmatter knowledge_version: 2、kind: wiki-page、source_id: ${source}、level: single。稳定ID=${'wiki-'+source+'--'}加相对论文目录文件名去掉.md且将/替换为--。例如whoami=${knowledgeDocumentId(prefix+'whoami.md')}，方法总览=${knowledgeDocumentId(prefix+'method/method.md')}。\nwhoami仅正式题目、二级标题“ 一句话认识 ”（概括问题+方法，无性能数字和结果评价）、“ 知识导航 ”。知识导航核心九项必须按顺序使用 ${paperWikiNavigation.map(([label,name])=>label+'→./'+name).join('、')}；每项格式为- [固定名称](对应路径)：简短内容说明，说明根据本篇实际内容填写，不省略、不复制正文。必要的额外子页导航排在九项之后，或由方法/结果总览覆盖。作者、DOI、源码等题录不放入whoami。background保留“概览”“已有研究与不足”和研究问题/依据链接；研究问题、贡献、方法、实验、局限、可复用认识继续使用references/paper-wiki.md对应职责标题，按上述内容重点写作。概览保存核心认识与限定，不写“本页介绍”，不重复检索摘要、适合回答和长篇关联栏目。\n依据协议：evidence.md仅为轻量目录（page_role: evidence-index），标题后只列出全部依据链接，不写目录说明、范围概括或条目简介，由whoami链接，不把目录塞入题录。每条依据保存为evidence/ev-<slug>.md（page_role: evidence、pdf_hash: 实际64位SHA256；原文缺失写unknown），正文第一行固定为[依据总览](../evidence.md)，空一行后一级标题为ev-<slug>，正文使用**定位：**、**事实：**、**边界：**三个非空加粗字段，不使用二级标题；事实支持正文到相应具体层级，关键数字带对象、条件及单位，组件映射有实际关系，不只复述主题；无需复制完整表格，仅定位的内容在边界明确待回查，缺失材料不补造；保留与本条直接相关的条件、实际异常与材料缺口，不自动凑批评；无额外缺口可简述适用条件，不硬截字数；记录本篇source_id、真实PDF哈希、页码/图表/章节、原文链接、支持范围、作者事实与推断边界；无法核实明确写未知。每条独立记录元数据保留其来源版本；共同阅读范围集中于ev-reading-scope：此条目客观简述真实覆盖范围和材料类型，定位仅实际页范围加一个原PDF入口，不逐页列链接；边界区分原生成与当前整理，说明复用笔记及图像/代码/实验核验情况，不默认完整阅读，不套用作者式主语。批次文件名、任务标识和哈希留元数据或历史，不重复正文。其他条目frontmatter写scope_ref: ev-reading-scope；核验状态写verification: unknown或not-reverified或verified，仅实际复核原文后才可写verified。不要重复迁移说明或公共范围段落，条目特有缺口仍写边界，不凭笔记存在宣称已核验。知识正文使用[ev-名称](按当前路径计算的evidence/ev-名称.md)，不用笼统的“依据”标签或旧evidence.md#锚点；不要把必要条件藏入依据。只有独立evidence/ev-*.md依据文档不添加论文名和论文总览。其余子页（包括evidence.md目录）前三个非空行依次为与whoami一致的论文全名（普通文本）、[论文总览](相对路径whoami.md)、当前页一级标题，三者间各留一空行。whoami导航覆盖知识页与依据目录，目录链接全部条目；依据不手写固定返回知识页链接，Agent从反向引用取得使用位置。\n不生成其他论文、摘要或跨论文主题。不实现depth或渐进读取协议。按规定目录、依据链接及页面分工直接写作，机械校验由后台处理。信息密度遵守 references/paper-wiki.md：方法只解释完整方法链路，实验配置移到实验页简写，材料缺口集中依据；表格存数据、正文解释差异与反例；局限保留原文明示不足、认识提炼设计启示，不重复摘要。概览直接讲核心内容，不写审阅式评价；实验参数与硬件只在实验页简写，方法页解释完整原理、设计依据与机制衔接。依据目录仅保留全部条目链接，公共范围保存在ev-reading-scope等条目，每个独立条目仍需带自己的版本与范围，原文地址可用引用式链接定义复用。保留影响结论的条件，不硬截断、不新增压缩调用；完成后的轻量自查仅执行一次，以调用末尾说明及references/paper-wiki.md为准，不另做全文回读或增加调用。用户要求：`;
}
