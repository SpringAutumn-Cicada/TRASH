import {markdownReferences} from '@trash/protocol/browser';
import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from './clipboard.js';

function inline(text:string,allowRelativeLinks=false,onOpenResearch?:(path:string)=>void):React.ReactNode[]{
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part,index)=>{
    if(onOpenResearch && /^`research\/[^/`\r\n]+\.md`$/i.test(part))return <button type="button" className="text-button" key={index} onClick={()=>onOpenResearch(part.slice(1,-1))}>{part.slice(1,-1)}</button>;
    if(part.startsWith('`')&&part.endsWith('`'))return <code key={index}>{part.slice(1,-1)}</code>;
    if(part.startsWith('**')&&part.endsWith('**'))return <strong key={index}>{part.slice(2,-2)}</strong>;
    const link=part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if(link&&(/^\/projects\/[\w-]+\/coordination\?action=memory&focus=[a-f\d-]{36}$/i.test(link[2])||/^(https?:\/\/|#)/i.test(link[2])||/^\/api\/v1\/projects\/[^/]+\/sources\/[^/]+\/pdf-view(?:[?#]|$)/.test(link[2])||(allowRelativeLinks&&!/^[a-z][a-z0-9+.-]*:/i.test(link[2])&&!link[2].startsWith('//'))))return <a key={index} href={link[2]} target={/^(https?:|\/api\/)/i.test(link[2])?'_blank':undefined} rel="noopener noreferrer">{link[1]}</a>;
    return part;
  });
}
function CodeBlock({language,body}:{language:string;body:string}){
  const [copied,setCopied]=useState(false),[error,setError]=useState(false);
  return <div className="chat-code-block"><header><span>{language||'代码'}</span><button type="button" onClick={()=>{void copyText(body).then(()=>{setCopied(true);setError(false);}).catch(()=>setError(true));}}>{copied?<Check size={13}/>:<Copy size={13}/>} {error?'复制失败，请手动选择':copied?'已复制':'复制代码'}</button></header><pre><code>{body}</code></pre></div>;
}
export function ChatMarkdown({text,allowRelativeLinks=false,onOpenResearch}:{text:string;allowRelativeLinks?:boolean;onOpenResearch?:(path:string)=>void}){
  const renderInline=(value:string)=>inline(value,allowRelativeLinks,onOpenResearch);
  const lines=markdownReferences(text).text.replace(/\r\n/g,'\n').split('\n'),blocks:React.ReactNode[]=[];
  const first=lines.findIndex(line=>line.trim());
  const next=lines.slice(first+1).find(line=>line.trim())?.trim();
  const paperNameLine=allowRelativeLinks&&first>=0&&!/^[#>`]/.test(lines[first])&&/^\[论文总览\]\((?:\.\.?\/)+whoami\.md\)$/.test(next??'')?first:-1;
  for(let i=0;i<lines.length;){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    if(i===paperNameLine){blocks.push(<p key={blocks.length} className="wiki-paper-name">{renderInline(line)}</p>);i++;continue;}
    const fence=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence){const language=fence[2].trim(),body:string[]=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(fence[1]))body.push(lines[i++]);if(i<lines.length)i++;blocks.push(<CodeBlock key={blocks.length} language={language} body={body.join('\n')}/>);continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){const Tag=(`h${Math.min(heading[1].length+1,6)}`) as 'h2'|'h3'|'h4'|'h5'|'h6';blocks.push(<Tag key={blocks.length} data-wiki-anchor={allowRelativeLinks?heading[2].trim().toLowerCase().replace(/\s+/g,'-'):undefined}>{renderInline(heading[2])}</Tag>);i++;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){blocks.push(<hr key={blocks.length}/>);i++;continue;}
    if(line.startsWith('>')){const quote:string[]=[];while(i<lines.length&&lines[i].startsWith('>'))quote.push(lines[i++].replace(/^>\s?/,''));blocks.push(<blockquote key={blocks.length}>{renderInline(quote.join('\n'))}</blockquote>);continue;}
    if(/^\s*[-*+]\s+/.test(line)||/^\s*\d+[.)]\s+/.test(line)){
      const ordered=/^\s*\d+[.)]\s+/.test(line),items:string[]=[];
      const pattern=ordered?/^\s*\d+[.)]\s+/:/^\s*[-*+]\s+/;
      while(i<lines.length&&pattern.test(lines[i]))items.push(lines[i++].replace(pattern,''));
      const Tag=ordered?'ol':'ul';blocks.push(<Tag key={blocks.length}>{items.map((item,index)=><li key={index}>{renderInline(item)}</li>)}</Tag>);continue;
    }
    if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
      const cells=(value:string)=>value.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
      const headers=cells(line),rows:string[][]=[];i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(cells(lines[i++]));
      blocks.push(<div className="chat-table-scroll" key={blocks.length}><table><thead><tr>{headers.map((cell,index)=><th key={index}>{renderInline(cell)}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((cell,column)=><td key={column}>{renderInline(cell)}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    const paragraph=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(?:\s*`{3,}|\s*~{3,}|#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])&&!(lines[i].includes('|')&&i+1<lines.length&&/^[\s|:-]+$/.test(lines[i+1])))paragraph.push(lines[i++]);
    blocks.push(<p key={blocks.length}>{renderInline(paragraph.join('\n'))}</p>);
  }
  return <div className="chat-markdown">{blocks}</div>;
}
