import {knowledgeLinks} from './knowledge-links.js';

export function researchExplorationIssues(path:string,text:string,mode:'summary'|'directions'|'evidence-plan'|'research-map'|'comparison'|'background'|'topic-discovery'|'topic'):string[]{
 const issues:string[]=[];
 if(['summary','research-map','comparison','background','topic-discovery','topic'].includes(mode))return issues;
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
