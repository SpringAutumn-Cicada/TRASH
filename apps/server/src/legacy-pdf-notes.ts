import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';

// Only the known four-page image-and-text reader (prompt versions 6–8).
// No old input.json, Wiki or card contents are read by this adapter.
export function safeReadingFile(base:string,path:string):Buffer {
 const root=realpathSync(base),rel=relative(resolve(base),resolve(base,path)),target=resolve(root,rel);
 if(!rel||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('UNSAFE_READING_PATH');
 let current=root;for(const part of rel.split(sep)){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('UNSAFE_READING_PATH');}
 const info=lstatSync(target);if(!info.isFile()||info.size<1||info.size>1024*1024)throw new Error('INVALID_READING_FILE');
 return readFileSync(target);
}
export function legacyPdfNotes(base:string,source:string,hash?:string,pageCount?:number){
 try{
  base=realpathSync(base);
  const meta=JSON.parse(safeReadingFile(base,'metadata.json').toString());
  if(meta.adapter!=='codex-cli'||meta.skill!=='trash-literature-knowledge'||![6,7,8].includes(meta.prompt_version))return [];
  const skill=safeReadingFile(base,'literature-skill/SKILL.md').toString();
  if(!skill.includes('所有页面图像及文字')||!skill.includes('每四页一个批次'))return [];
  const manifest=JSON.parse(safeReadingFile(base,'pdf-reading.json').toString());
  if(manifest.reading_version!==1||!Array.isArray(manifest.sources))return [];
  const record=manifest.sources.find((r:{source_id:string;hash:string})=>r.source_id===source&&(!hash||r.hash===hash));
  if(!record||!Number.isInteger(record.pageCount)||record.pageCount<1||(pageCount!==undefined&&record.pageCount!==pageCount)||!Array.isArray(record.batches))return [];
  return record.batches.flatMap((batch:{pages:number[];status:string;notes:string;note_hash?:string})=>{
   try{
    if(!['notes-produced','reused-notes'].includes(batch.status)||!Array.isArray(batch.pages)||!batch.pages.length)return [];
    const first=batch.pages[0];if(!Number.isInteger(first)||first<1||(first-1)%4!==0)return [];
    const expected=Array.from({length:Math.min(4,record.pageCount-first+1)},(_,i)=>first+i);
    if(!expected.length||JSON.stringify(expected)!==JSON.stringify(batch.pages))return [];
    const path=isAbsolute(batch.notes)?batch.notes:join(base,batch.notes);
    if(!relative(join(base,'readings'),path)||relative(join(base,'readings'),path).startsWith('..')||isAbsolute(relative(join(base,'readings'),path)))return [];
    const bytes=safeReadingFile(base,path),note_hash=createHash('sha256').update(bytes).digest('hex');
    if(batch.note_hash&&batch.note_hash!==note_hash)return [];
    return [{bytes,pages:expected,provenance:{mode:'legacy-record' as const,task_id:basename(base),note_path:relative(base,path),pdf_hash:record.hash,pages:expected,legacy_note_hash:batch.note_hash,validation:'legacy-image-text-record' as const}}];
   }catch{return [];}
  });
 }catch{return [];}
}
