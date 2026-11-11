import type { KnowledgeVersion } from '@trash/protocol';

/** Discovery is Markdown; only recognized, evidenced sections become formal tasks. */
export function discoverWikiTopics(text:string,materials:KnowledgeVersion[]){
  const sections=[...text.matchAll(/^## (知识主题|候选线索|研究假设)[：:]\s*(.+)$/gm)];
  if(!sections.length&&!text.includes('未发现可整理主题'))throw new Error('主题发现清单格式无效，未创建正式主题；请查看工作副本');
  const seen=new Set<string>();
  return sections.flatMap((match,index)=>{
    const title=match[2].trim(),key=title.toLocaleLowerCase().replace(/[\s\p{P}]/gu,'');
    if(!key||title.length>200||seen.has(key))return [];
    seen.add(key);
    const body=text.slice(match.index!+match[0].length,sections[index+1]?.index??text.length);
    const evidence=materials.filter(record=>body.includes(record.object_id));
    const eligible=match[1]!=='候选线索'&&evidence.length>0&&(match[1]==='研究假设'||evidence.length>1||/单篇价值[：:]\s*\S/.test(body));
    return [{title,body,evidence,eligible,level:match[1]==='研究假设'?'hypothesis' as const:'topic' as const}];
  });
}
