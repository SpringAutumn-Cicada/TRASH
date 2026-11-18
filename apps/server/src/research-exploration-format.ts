import {knowledgeLinks} from './knowledge-links.js';
import {markdownReferences} from '@trash/protocol';

export const RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS=6000;
export const RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS=8000;
export const RESEARCH_SUMMARY_HARD_MAX_CHARACTERS=10000;

const materialDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function materialGroupTitle(at:string,category:string,group:number){
 return `${materialDate.format(new Date(at))}：${category}·第${group}组`;
}
export function legacyMaterialTitle(title:string,modified:string,tracked?:string){
 const legacy=title.match(/^文献知识第(\d+)层分组(\d+)$/);
 if(legacy)return materialGroupTitle(modified,`文献知识第${legacy[1]}层材料分组`,Number(legacy[2]));
 if(tracked&&(/^(?:追加材料[：:]\s*第\s*\d+\s*组|.+：材料(?:分组|工作版))$/.test(title)))return tracked;
 return title;
}

export function topicDiscoveryEntries(text:string){
 return markdownReferences(text).text.split(/^##[ \t]+/m).slice(1).flatMap(section=>{
  const [heading,...lines]=section.split(/\r?\n/);
  const match=heading.match(/^(知识主题|候选线索|研究假设)[：:][ \t]*(.+)$/);
  return match?[{kind:match[1],title:match[2].trim(),body:lines.join('\n').trim()}]:[];
 });
}

export function researchExplorationIssues(path:string,text:string,mode:'summary'|'summary-working'|'directions'|'evidence-plan'|'research-map'|'comparison'|'background'|'topic-discovery'|'topic',sources:string[]=[],synthesis=false,changedSources?:string[]):string[]{
 const issues:string[]=[];
 const hasSection=(name:string)=>Boolean(text.split(new RegExp('^## '+name+'\\s*$','m'))[1]?.split(/^## /m)[0]?.trim());
 const summaryMode=mode==='summary'||mode==='summary-working';
 if(synthesis&&(summaryMode||mode==='topic-discovery')){
  for(const name of summaryMode?['何时读取','覆盖方向','材料范围','批次标识']:['何时读取','材料范围'])if(!hasSection(name))issues.push('缺少有内容的栏目：'+name);
  const links=knowledgeLinks(path,text),linkedSources=new Set(links.flatMap(link=>link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.slice(1)??[]));
  const missing=(changedSources??sources).filter(source=>!linkedSources.has(source)&&!text.includes(source));
  if(missing.length)issues.push('缺少所选来源的短引用定义或未覆盖说明：'+missing.join('、'));
  for(const link of links){const source=link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.[1];if(source&&!sources.includes(source))issues.push('来源不在所选范围：'+source);}
  if(summaryMode&&text.length>RESEARCH_SUMMARY_HARD_MAX_CHARACTERS)issues.push(`中间总结超出硬上限：${text.length} 字符，上限 ${RESEARCH_SUMMARY_HARD_MAX_CHARACTERS}；目标 ${RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS}–${RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS} 字符，请压缩重复引用定义、完整目录和重复解释，保留问题、机制、差异、条件、分歧与未知，不得截断正文`);
 }
 if(mode==='topic-discovery'){
  if(!/^## 材料范围\s*$/m.test(text))issues.push('主题发现缺少材料范围');
  const entries=topicDiscoveryEntries(text);
  if(!entries.length&&!text.includes('未发现可整理主题'))issues.push('主题发现需有效主题、候选线索或明确未发现可整理主题');
  for(const {kind,title,body} of entries){
   if(body.length<80)issues.push(`主题发现条目“${title}”内容过少，不能只记录来源覆盖`);
   if(kind!=='知识主题')continue;
   const linked=new Set(knowledgeLinks(path,body).flatMap(link=>link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.slice(1)??[]));
   if(!linked.size)issues.push(`正式主题“${title}”缺少论文 Wiki 链接，不能拆分为独立主题 Wiki`);
   if(changedSources&&(linked.size<2||!changedSources.some(source=>linked.has(source))))issues.push(`正式主题“${title}”须链接至少两篇不同论文，其中至少一篇来自本轮新材料`);
  }
  return issues;
 }
 if(['summary','summary-working','research-map','comparison','background','topic'].includes(mode))return issues;
 const sections=text.split(/^##\s+/m).slice(1);
 if(mode==='evidence-plan'){
  for(const name of ['当前问题','已有支持与反例','关键证据缺口','定向检索计划','最小验证与推翻条件','停止或收敛条件'])if(!sections.some(section=>section.split('\n')[0].trim()===name&&section.split('\n').slice(1).join('').trim()))issues.push('补证据计划缺少有内容的栏目：'+name);
  return issues;
 }
 if(!sections.some(section=>section.startsWith('材料范围\n')))issues.push('缺少材料范围');
 const directions=sections.filter(section=>/^候选方向[：:]/.test(section));
 if(!directions.length&&!text.includes('未形成有依据的候选方向'))issues.push('需候选方向或明确说明尚未形成有依据的方向');
 for(const section of directions){
  for(const name of ['研究问题','文献依据','已有解法与反例','候选假设','最小验证','可行性','补充检索'])if(!section.split(/^###\s+/m).slice(1).some(part=>part.split('\n')[0].trim()===name&&part.split('\n').slice(1).join('').trim()))issues.push(section.split('\n')[0]+'缺少有内容的栏目：'+name);
  if(!knowledgeLinks(path,section).some(link=>link.path.startsWith('knowledge_base/papers/')))issues.push('每个候选方向需链接原始论文Wiki依据，不能只有分组总结');
 }
 return issues;
}
