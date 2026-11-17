import {knowledgeLinks} from './knowledge-links.js';

export const RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS=6000;
export const RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS=8000;
export const RESEARCH_SUMMARY_HARD_MAX_CHARACTERS=10000;

export function researchExplorationIssues(path:string,text:string,mode:'summary'|'summary-working'|'directions'|'evidence-plan'|'research-map'|'comparison'|'background'|'topic-discovery'|'topic',sources:string[]=[],synthesis=false):string[]{
 const issues:string[]=[];
 const hasSection=(name:string)=>Boolean(text.split(new RegExp('^## '+name+'\\s*$','m'))[1]?.split(/^## /m)[0]?.trim());
 const summaryMode=mode==='summary'||mode==='summary-working';
 if(synthesis&&(summaryMode||mode==='topic-discovery')){
  for(const name of summaryMode?['何时读取','覆盖方向','材料范围','批次标识']:['何时读取','材料范围','来源覆盖'])if(!hasSection(name))issues.push('缺少有内容的栏目：'+name);
  if(mode==='summary')for(const source of sources)if(!text.includes(source))issues.push('缺少所选来源记录或未覆盖说明：'+source);
  for(const link of knowledgeLinks(path,text)){const source=link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.[1];if(source&&!sources.includes(source))issues.push('来源不在所选范围：'+source);}
  if(summaryMode&&text.length>RESEARCH_SUMMARY_HARD_MAX_CHARACTERS)issues.push(`中间总结超出硬上限：${text.length} 字符，上限 ${RESEARCH_SUMMARY_HARD_MAX_CHARACTERS}；目标 ${RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS}–${RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS} 字符，请压缩重复引用定义、完整目录和重复解释，保留问题、机制、差异、条件、分歧与未知，不得截断正文`);
 }
 if(mode==='topic-discovery'){if(!/^## 材料范围\s*$/m.test(text))issues.push('主题发现缺少材料范围');if(!/^## (知识主题|候选线索|研究假设)[：:]\s*\S/m.test(text)&&!text.includes('未发现可整理主题'))issues.push('主题发现需有效主题、候选线索或明确未发现可整理主题');return issues;}
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
