import {publishProjectChange} from './project-updates.js';
import {createHash} from 'node:crypto';
import type {Source} from '@trash/protocol';
import type {TrashStore} from '@trash/storage';

export const publicationDatePattern=/^[12]\d{3}(?:-(?:0[1-9]|1[0-2]))?$/;
/** Bibliographic corrections are not changes to the original paper or its evidence. */
export function sourceContentHash(source:Source|undefined){
  if(!source)return '';
  const {title,year,publication_date,authors,...content}=source;void title;void year;void publication_date;void authors;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
export function legacySourceContentHash(source:Source|undefined){if(!source)return '';const {title,year,publication_date,...content}=source;void title;void year;void publication_date;return createHash('sha256').update(JSON.stringify(content)).digest('hex');}
export type BibliographyState={manual?:string[];revision?:number;suggestion?:{authors?:string[];title?:string;publication_date?:string;card_hash:string};history?:{at:string;before:{authors?:string[];title:string;year?:number;publication_date?:string};after:{authors?:string[];title:string;year?:number;publication_date?:string};card_hash?:string;reason:string}[]};
export function bibliographyState(store:TrashStore,id:string):BibliographyState{
  store.db.exec('CREATE TABLE IF NOT EXISTS source_bibliography(source_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const row=store.db.prepare('SELECT data FROM source_bibliography WHERE source_id=?').get(id) as {data:string}|undefined;
  return row?JSON.parse(row.data):{};
}
export function saveBibliographyState(store:TrashStore,id:string,state:BibliographyState){store.db.prepare('INSERT OR REPLACE INTO source_bibliography(source_id,data) VALUES(?,?)').run(id,JSON.stringify(state));
  const row=store.db.prepare('SELECT project_id FROM sources WHERE source_id=?').get(id) as {project_id:string}|undefined;
  if(row)publishProjectChange(store,row.project_id,{tasks:true,sources:[id]});
}
export function parseBasicCard(text:string){
  const fields:Record<string,string>={};
  for(const line of text.replace(/\r\n/g,'\n').split('\n')){const match=line.match(/^- ([^：:]+)[：:]\s*(.*)$/);if(match){if(fields[match[1]]!==undefined)throw Object.assign(new Error('BASIC_CARD_INVALID'),{statusCode:422});fields[match[1]]=match[2].trim();}}
  for(const key of ['标题','作者','期刊／会议','发表年月','DOI／论文链接','源码状态','官方源码地址','第三方实现地址','证据与备注'])if(!fields[key])throw Object.assign(new Error('BASIC_CARD_INVALID'),{statusCode:422});
  if(fields['发表年月']!=='未核实'&&!publicationDatePattern.test(fields['发表年月']))throw Object.assign(new Error('BASIC_DATE_INVALID'),{statusCode:422});
  if(!['官方公开','声明未公开','未找到','未核实'].includes(fields['源码状态']))throw Object.assign(new Error('BASIC_CARD_INVALID'),{statusCode:422});
  if(fields['标题'].length>500)throw Object.assign(new Error('BASIC_CARD_INVALID'),{statusCode:422});
  for(const key of ['官方源码地址','第三方实现地址']){
    const value=fields[key];if(['未找到','未核实','无'].includes(value))continue;
    const urls=[...value.matchAll(/https?:\/\/[^\s<>）)]+/g)].map(m=>m[0]);
    if(!urls.length)throw Object.assign(new Error('BASIC_CODE_URL_INVALID'),{statusCode:422});
    for(const raw of urls){const url=new URL(raw);if(url.username||url.password)throw Object.assign(new Error('BASIC_CODE_URL_INVALID'),{statusCode:422});}
  }
  if(fields['源码状态']==='官方公开'&&!/https?:\/\//.test(fields['官方源码地址']))throw Object.assign(new Error('BASIC_CODE_URL_INVALID'),{statusCode:422});
  // Require an explicit date basis; preprint is not silently promoted to formal publication.
  const date=fields['发表年月']!=='未核实'&&/日期依据[：:]\s*(正式发表|在线发表)/.test(fields['证据与备注'])?fields['发表年月']:undefined;
  const authors=fields['作者']==='未核实'?undefined:fields['作者'].split(/[、；;]|\s+and\s+|\s*&\s*/).map(s=>s.trim()).filter(Boolean);
  if(authors&&(authors.length>200||authors.some(s=>s.length>200)))throw Object.assign(new Error('BASIC_CARD_INVALID'),{statusCode:422});
  return {authors,title:fields['标题']==='未核实'?undefined:fields['标题'],publication_date:date};
}
/** Extract only explicit identity fields; unknown values never erase metadata. */
export function parseIdcard(text:string){
  const body=text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
  const fields:Record<string,string>={};
  for(const line of body.split(/\r?\n/)){
    const match=line.match(/^\s*[-*]\s+(?:\*\*)?(标题|题名|作者|发表时间|发表年月)(?:\*\*)?[：:]\s*(.*)$/);
    if(match)fields[match[1]]=match[2].trim().replace(/[。；;]$/,'');
  }
  const known=(value:string|undefined)=>value&&!/^(?:未知|未核实|未提供|无|暂无)(?:$|[（(，,。])/.test(value)?value:undefined;
  const title=known(fields['标题']??fields['题名'])??known(body.split(/\r?\n/).map(line=>line.trim()).find(Boolean));
  const rawAuthors=known(fields['作者']);
  const authors=rawAuthors?.split(/[；;、]|\s+and\s+|,\s+|，/).map(name=>name.trim()).filter(Boolean);
  const date=known(fields['发表时间']??fields['发表年月']);
  const match=date?.match(/^([12]\d{3})(?:[-年]\s*(0?[1-9]|1[0-2])(?:月|[-日]|$))?/);
  const publication_date=match?match[1]+(match[2]?'-'+match[2].padStart(2,'0'):''):undefined;
  return {title:title&&!title.startsWith('#')&&title.length<=500?title:undefined,authors:authors?.length&&authors.length<=200&&authors.every(name=>name.length<=200)?authors:undefined,publication_date};
}
export function applyIdcard(store:TrashStore,source:Source,text:string,hash:string,baseline?:{authors?:string[];title:string;publication_date?:string;year?:number;revision?:number}){
  applyBibliography(store,source,parseIdcard(text),hash,baseline,'agent-idcard');
}
export function applyBasicCard(store:TrashStore,source:Source,text:string,hash:string,baseline?:{authors?:string[];title:string;publication_date?:string;year?:number;revision?:number}){
  applyBibliography(store,source,parseBasicCard(text),hash,baseline,'agent-basic-card');
}
function applyBibliography(store:TrashStore,source:Source,parsed:{title?:string;authors?:string[];publication_date?:string},hash:string,baseline:{authors?:string[];title:string;publication_date?:string;year?:number;revision?:number}|undefined,reason:string){
  const state=bibliographyState(store,source.source_id);
  const legacy=store.db.prepare('SELECT data FROM source_details WHERE source_id=?').get(source.source_id) as {data:string}|undefined;
  const legacyDetails=legacy?JSON.parse(legacy.data):{};
  const manual=new Set(state.manual??[]);
  // Existing stored human metadata predating field provenance must also be protected.
  if(state.revision===undefined){if(legacyDetails.authors?.length)manual.add('authors');if(legacyDetails.title)manual.add('title');if(legacyDetails.year||legacyDetails.publication_date)manual.add('publication_date');}
  const next={...source},suggestion:NonNullable<BibliographyState['suggestion']>={card_hash:hash};
  for(const field of ['title','publication_date'] as const){const proposed=parsed[field];if(!proposed)continue;
    if(field==='publication_date'&&proposed.length===4&&source.publication_date?.startsWith(proposed+'-'))continue;
    const unchanged=baseline&&baseline.revision===(state.revision??0)&&baseline[field]===source[field]&&(field!=='publication_date'||baseline.year===source.year);
    if(manual.has(field)||!unchanged){if(proposed!==source[field])suggestion[field]=proposed;continue;}
    next[field]=proposed;if(field==='publication_date')next.year=Number(proposed.slice(0,4));
  }
  if(parsed.authors?.length){const proposed=parsed.authors,changed=JSON.stringify(proposed)!==JSON.stringify(source.authors);
    const unchanged=baseline&&baseline.revision===(state.revision??0)&&JSON.stringify(baseline.authors)===JSON.stringify(source.authors);
    if(manual.has('authors')||!unchanged){if(changed)suggestion.authors=proposed;}else next.authors=proposed;
  }
  const before={authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date},after={authors:next.authors,title:next.title,year:next.year,publication_date:next.publication_date};
  if(JSON.stringify(before)!==JSON.stringify(after)){store.db.prepare('UPDATE sources SET data=? WHERE source_id=?').run(JSON.stringify(next),source.source_id);state.history=[...(state.history??[]),{at:new Date().toISOString(),before,after,card_hash:hash,reason}];}
  state.manual=[...manual];state.suggestion=suggestion.authors||suggestion.title||suggestion.publication_date?suggestion:undefined;saveBibliographyState(store,source.source_id,state);
}
