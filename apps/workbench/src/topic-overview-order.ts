// Reorder the reading view without changing stored Markdown or revision history.
export function orderTopicOverview(markdown:string):string {
 const headings:{title:string;offset:number}[]=[];
 let fence='',offset=0;
 for(const line of markdown.match(/[^\n]*\n|[^\n]+$/g)??[]){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
  if(marker){
   if(!fence)fence=marker;
   else if(marker[0]===fence[0]&&marker.length>=fence.length&&!line.trim().slice(marker.length).trim())fence='';
  }else if(!fence){
   const title=line.match(/^##[ \t]+([^\r\n]+)/)?.[1]?.trim();
   if(title)headings.push({title,offset});
  }
  offset+=line.length;
 }
 const preferred=[
  headings.some(({title})=>title==='何时读取')?'何时读取':'研究问题',
  '核心认识','材料范围',
 ].map(title=>headings.findIndex(heading=>heading.title===title));
 if(preferred.some(index=>index<0)||preferred.every((index,position)=>index===position))return markdown;
 const sections=headings.map(({offset},index)=>markdown.slice(offset,headings[index+1]?.offset).trimEnd());
 const remaining=sections.map((_,index)=>index).filter(index=>!preferred.includes(index));
 return markdown.slice(0,headings[0].offset)+[...preferred,...remaining].map(index=>sections[index]).join('\n\n')+'\n';
}
