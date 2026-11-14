import {knowledgeBasePath,legacyKnowledgePath} from '@trash/protocol';
import {posix} from 'node:path';

export type KnowledgeLink={path:string;fragment?:string;label:string;relation:string;reason:string;evidence:boolean};
const knowledgePath=/^(wiki|literature\/cards)\/[A-Za-z0-9_-]+\.md$/;
export function resolveKnowledgeLink(from:string,href:string):string|undefined {
  // Only local Markdown paths are knowledge edges; PDF/web links remain citations.
  if(!href||href.startsWith('#')||/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href))return;
  try{const decoded=decodeURIComponent(href.split(/[?#]/)[0]);const path=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(from),decoded));return (knowledgeBasePath.test(path)||legacyKnowledgePath.test(path))?path:undefined;}catch{return;}
}
export function knowledgeLinks(path:string,text:string):KnowledgeLink[] {
  const body=text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/<!--[\s\S]*?-->/g,'');
  const links:KnowledgeLink[]=[];let fence='',section='';
  const lines=body.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=lines[i],marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence='';continue;}if(fence)continue;
    const heading=line.match(/^#{1,6}\s+(.+)/);if(heading)section=heading[1].trim();
    const clean=line.replace(/`[^`]*`/g,'');
    for(const match of clean.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)){
      const target=resolveKnowledgeLink(path,match[2]);if(!target||target===path)continue;
      const prefix=clean.slice(0,match.index).replace(/^\s*[-*+]\s*/,'').trim();
      const navigation=match[1]==='返回论文入口'&&target.endsWith('/whoami.md');
      const evidence=!navigation&&(target.endsWith('/evidence.md')||/^(?:依据|证据|引用依据|证据依据)\s*[:：]/.test(prefix)||/^(?:引用依据|证据依据)$/.test(section));
      const relation=navigation?'导航':evidence?'依据':prefix.match(/^(支持|限制|对比|分歧|扩展|验证|相关|导航|前置|总结|上级)\s*[:：]/)?.[1]??'相关';
      const next=lines[i+1]??'';
      const reason=(clean.replace(match[0],match[1]).replace(/^\s*[-*+]\s*/,'')+(next.match(/^\s{2,}\S/)?' '+next.trim():'')).trim().slice(0,360);
      if(!links.some(link=>link.path===target&&link.fragment===match[2].split('#')[1]&&link.relation===relation&&link.reason===reason))links.push({path:target,fragment:match[2].split('#')[1],label:match[1],relation,reason,evidence});
    }
  }
  return links;
}
export function knowledgeAliases(text:string):string[]{
  const value=text.match(/^## 别名\s*\r?\n([^#\n][^\n]*)/m)?.[1]??'';
  return [...new Set(value.split(/[、,，;；]/).map(s=>s.trim()).filter(Boolean))].slice(0,12);
}
