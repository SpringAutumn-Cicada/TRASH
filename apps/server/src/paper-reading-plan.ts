import {createHash} from 'node:crypto';
import type {inspectPdf,PdfLayoutLine} from '@trash/literature';
export const readingPlanVersion=2;
export type ReadingUnit={id:string;page:number;text:string;lines:string[];region:{x:number;y:number;width:number;height:number};kind:'paragraph'|'heading'|'visual';section:string};
export type PaperSection={id:string;title:string;level:number;parent?:string;children:string[];units:string[];confidence:number;reason:string};
export type ReadingBlock={id:string;chapter:string;sections:string[];units:string[];pages:number[];characters:number;mode:'section'|'paragraph-fallback'|'visual-fallback';warnings:string[]};
export type PaperReadingPlan={version:number;hash:string;pdf_hash:string;budget:{characters:number;pages:number};sections:PaperSection[];units:ReadingUnit[];blocks:ReadingBlock[];excluded:{id:string;reason:string}[];warnings:string[]};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planPaperReading(doc:Awaited<ReturnType<typeof inspectPdf>>,pdfHash:string,budget={characters:14000,pages:8}):PaperReadingPlan{
 const warnings=doc.pages.flatMap(p=>p.warnings.map(w=>`PDF第${p.page}页：${w}`));
 const normalize=(s:string)=>s.toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
 const margins=new Map<string,Set<number>>();
 for(const page of doc.pages)for(const line of page.lines)if(line.y<page.height*.08||line.y>page.height*.93){const key=normalize(line.text);if(!margins.has(key))margins.set(key,new Set());margins.get(key)!.add(page.page);}
 const excluded:PaperReadingPlan['excluded']=[];
 const lines=doc.pages.flatMap(page=>page.lines.filter(l=>{
  if((l.y<page.height*.08||l.y>page.height*.93)&&((margins.get(normalize(l.text))?.size??0)>=3||/^\d+$/.test(l.text.trim()))){excluded.push({id:l.id,reason:'重复边缘文字或页码，保留原图可回查'});return false;}return true;
 }));
 const sizes=lines.filter(l=>l.text.length>35).map(l=>l.fontSize).sort((a,b)=>a-b);const body=sizes[Math.floor(sizes.length/2)]??10;
 const headings=new Map<string,{title:string;level:number;confidence:number;reason:string}>();
 const known=/^(abstract|introduction|background|related work|preliminar(?:y|ies)|method(?:ology)?|approach|system (?:overview|design)|evaluation|experiments?|results?(?: and discussion)?|discussion|limitations?|conclusions?|references|acknowledg\w*|appendix(?:\s+\w+)?|摘要|引言|研究背景|相关工作|方法|实验|结论|参考文献)$/i;
 for(const line of lines){
  const title=line.text.trim();if(title.length>150||/^(?:fig(?:ure)?|table|algorithm|图|表)\s*[\d.:]/i.test(title))continue;
  const numbered=title.match(/^((?:\d{1,2}(?:\.\d{1,2}){0,4}|[IVX]{1,6}))[.)]?\s+(.+)$/);
  const bookmark=doc.outline.find(o=>o.page===line.page&&normalize(o.title)===normalize(title));
  const short=title.split(/\s+/).length<=17&&!/[;。！？]$/.test(title);
  if(bookmark)headings.set(line.id,{title,level:Math.min(5,bookmark.level),confidence:.92,reason:'书签与页面标题一致'});
  else if(known.test(title))headings.set(line.id,{title,level:1,confidence:.88,reason:'独立常见章节标题'});
  else if(numbered&&short&&line.fontSize>=body*.98&&!/[.!?]$/.test(numbered[2]))headings.set(line.id,{title,level:/^[IVX]+$/.test(numbered[1])?1:numbered[1].split('.').length,confidence:(line.fontSize>body*1.08||line.bold)? .87:.65,reason:'编号、长度与字体候选，需图像核对'});
  else if(short&&title.length>3&&line.fontSize>body*1.22&&(line.bold||/^[A-Z][A-Z\s-]{3,}$/.test(title))&&line.y>doc.pages[line.page-1].height*.1)headings.set(line.id,{title,level:2,confidence:.55,reason:'未编号版式候选，结构不确定'});
 }
 if(!headings.size)warnings.push('未识别可靠章节；采用连续段落/页面图像兜底，不声称按章节阅读');
 const sections:PaperSection[]=[{id:'front',title:'前置内容 / 未分章正文',level:0,children:[],units:[],confidence:1,reason:'覆盖标题前及无法归类的内容'}];
 const units:ReadingUnit[]=[];let current=sections[0];const stack:PaperSection[]=[];
 const put=(line:PdfLayoutLine,kind:ReadingUnit['kind'])=>{
  const prev=units.at(-1),region={x:line.x,y:line.y,width:line.width,height:line.height};
  if(kind==='paragraph'&&prev?.kind==='paragraph'&&prev.section===current.id&&prev.page===line.page&&Math.abs(prev.region.x-line.x)<24&&line.y>=prev.region.y&&line.y-(prev.region.y+prev.region.height)<line.fontSize*.8&&prev.text.length<6000){prev.text+='\n'+line.text;prev.lines.push(line.id);prev.region.width=Math.max(prev.region.width,line.x+line.width-prev.region.x);prev.region.height=line.y+line.height-prev.region.y;return;}
  const unit={id:line.id,page:line.page,text:line.text,lines:[line.id],region,kind,section:current.id};units.push(unit);current.units.push(unit.id);
 };
 for(const page of doc.pages){
  const own=lines.filter(l=>l.page===page.page);
  if(!own.length){const unit:ReadingUnit={id:`p${page.page}-visual`,page:page.page,text:'[本页无可用文字块，必须结合完整图像阅读；未执行OCR]',lines:[],region:{x:0,y:0,width:page.width,height:page.height},kind:'visual',section:current.id};units.push(unit);current.units.push(unit.id);continue;}
  for(const line of own){const heading=headings.get(line.id);if(heading){
    while(stack.length&&stack.at(-1)!.level>=heading.level)stack.pop();
    current={...heading,id:'section-'+line.id,parent:stack.at(-1)?.id,children:[],units:[]};if(current.parent)sections.find(s=>s.id===current.parent)!.children.push(current.id);sections.push(current);stack.push(current);
    if(heading.confidence<.8)warnings.push(`低置信度标题：${heading.title}（PDF第${line.page}页）`);put(line,'heading');
   }else put(line,'paragraph');}
 }
 const byUnit=new Map(units.map(u=>[u.id,u]));const order=new Map(units.map((u,i)=>[u.id,i]));
 const subtree=(s:PaperSection):string[]=>[...s.units,...s.children.flatMap(id=>subtree(sections.find(n=>n.id===id)!))].sort((a,b)=>order.get(a)!-order.get(b)!);
 const fits=(ids:string[])=>ids.reduce((n,id)=>n+byUnit.get(id)!.text.length,0)<=budget.characters&&new Set(ids.map(id=>byUnit.get(id)!.page)).size<=budget.pages;
 const chapter=(s:PaperSection):string=>s.parent?chapter(sections.find(n=>n.id===s.parent)!):s.id;
 const blocks:ReadingBlock[]=[];
 const add=(ids:string[],s:PaperSection,fallback:boolean)=>{if(!ids.length)return;const own=ids.map(id=>byUnit.get(id)!);const visual=own.some(u=>u.kind==='visual');blocks.push({id:'block-'+hash({pdfHash,ids,version:readingPlanVersion,budget}).slice(0,20),chapter:chapter(s),sections:[...new Set(own.map(u=>u.section))],units:ids,pages:[...new Set(own.map(u=>u.page))],characters:own.reduce((n,u)=>n+u.text.length,0),mode:visual?'visual-fallback':fallback||!headings.size?'paragraph-fallback':'section',warnings:[...(fallback?['章节超预算，按完整段落/页面内容拆分；承接前序定义']:[]),...(visual?['无文字页使用完整图像；图文范围需核对']:[])]});};
 const split=(s:PaperSection):string[][]=>{const all=subtree(s);if(fits(all))return all.length?[all]:[];
  const pieces=[...s.units.map(id=>[id]),...s.children.flatMap(id=>split(sections.find(n=>n.id===id)!))];
  const out:string[][]=[];let group:string[]=[];for(const piece of pieces){if(group.length&&!fits([...group,...piece])){out.push(group);group=[];}group.push(...piece);if(!fits(group)){out.push(group);group=[];}}if(group.length)out.push(group);return out;
 };
 for(const section of sections.filter(s=>!s.parent))for(const ids of split(section))add(ids,section,!fits(subtree(section)));
 for(const block of blocks)if(!fits(block.units))block.warnings.push('单个完整段落仍超预算；保留原段，不截断，需提高预算或人工调整');
 const coverage=blocks.flatMap(b=>b.units);if(coverage.length!==units.length||new Set(coverage).size!==units.length)throw new Error('PDF_READING_COVERAGE_INVALID');
 const plan={version:readingPlanVersion,pdf_hash:pdfHash,budget,sections,units,blocks,excluded,warnings};return {...plan,hash:hash(plan)};
}
