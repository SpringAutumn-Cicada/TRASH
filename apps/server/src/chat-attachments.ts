import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { TrashStore } from '@trash/storage';
export interface ChatAttachment{id:string;name:string;size:number;mime:string;image:boolean}
function imageType(bytes:Uint8Array):string|undefined{
  const b=Buffer.from(bytes);
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
}
export function uploadChatAttachment(store:TrashStore,project:string,name:string,bytes:Uint8Array){
  if(!bytes.length||bytes.length>20*1024*1024)throw Object.assign(new Error('CHAT_ATTACHMENT_SIZE'),{statusCode:413});
  const mime=imageType(bytes),extension=extname(name).toLowerCase();
  if(!mime&&['.png','.jpg','.jpeg','.webp','.gif','.bmp','.heic','.avif','.svg'].includes(extension))throw Object.assign(new Error('CHAT_IMAGE_UNSUPPORTED'),{statusCode:422});
  const artifact=store.saveArtifact(project,basename(name)||'attachment',mime??'application/octet-stream',bytes);
  return {id:artifact.artifact_id,name:artifact.name,size:bytes.length,mime:mime??'application/octet-stream',image:Boolean(mime)} satisfies ChatAttachment;
}
export function resolveChatAttachments(store:TrashStore,project:string,ids:string[]){
  return [...new Set(ids)].map(id=>{
    const file=store.artifactFile(project,id);
    if(!file||file.artifact.size_bytes>20*1024*1024)throw Object.assign(new Error('CHAT_ATTACHMENT_NOT_FOUND'),{statusCode:404});
    const bytes=readFileSync(file.path);
    if(bytes.length>20*1024*1024||createHash('sha256').update(bytes).digest('hex')!==file.artifact.sha256)throw Object.assign(new Error('CHAT_ATTACHMENT_NOT_FOUND'),{statusCode:404});
    const mime=imageType(bytes);
    return {id,name:file.artifact.name,size:bytes.length,mime:mime??'application/octet-stream',image:Boolean(mime),path:file.path};
  });
}
