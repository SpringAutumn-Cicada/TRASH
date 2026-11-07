import React, { useRef, useState } from 'react';
import { FileText, ImagePlus, LoaderCircle, Paperclip, X } from 'lucide-react';
export type ChatAttachment={id:string;name:string;size:number;mime:string;image:boolean};
const size=(bytes:number)=>bytes<1048576?`${Math.ceil(bytes/1024)} KiB`:`${(bytes/1048576).toFixed(1)} MiB`;
export function useChatAttachments(base:string,conversation:string,onError:(message:string)=>void){
  const [drafts,setDrafts]=useState<Record<string,ChatAttachment[]>>({}),[uploading,setUploading]=useState(false),[dragging,setDragging]=useState(false);
  const locked=useRef(false),alive=useRef(true);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const entries=drafts[conversation]??[];
  const upload=async(files:File[])=>{
    if(!files.length)return;
    if(locked.current){onError('附件正在上传，请稍候再添加。');return;}
    if(files.length+entries.length>10){onError('每条消息最多添加 10 个附件。');return;}
    if(files.some(file=>file.size===0||file.size>20*1048576)){onError('请选择非空附件，单文件不能超过 20 MiB。');return;}
    locked.current=true;setUploading(true);let added=0;
    try{for(const file of files){
      const response=await fetch(base+`/chat/attachments?name=${encodeURIComponent(file.name||'pasted-image.png')}`,{method:'POST',body:file});
      const data=await response.json();if(!response.ok)throw new Error(data.error==='CHAT_IMAGE_UNSUPPORTED'?'图片仅支持 PNG、JPEG、WebP，请转换格式后上传。':'附件上传失败，请检查文件或稍后重试。');
      if(alive.current)setDrafts(old=>({...old,[conversation]:[...(old[conversation]??[]),data.attachment as ChatAttachment]}));added++;
    }}catch(cause){if(alive.current)onError(`${cause instanceof Error?cause.message:'附件上传失败。'}${added?` 已保留 ${added} 个上传成功的附件。`:''}`);}
    finally{locked.current=false;if(alive.current)setUploading(false);}
  };
  return {entries,uploading,dragging,setDragging,upload,hasDrafts:Object.values(drafts).some(list=>list.length>0),remove:(id:string)=>setDrafts(old=>({...old,[conversation]:(old[conversation]??[]).filter(item=>item.id!==id)})),clear:()=>setDrafts(old=>({...old,[conversation]:[]})),
    paste:(event:React.ClipboardEvent)=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void upload(files);}},
    drop:(event:React.DragEvent)=>{event.preventDefault();setDragging(false);void upload(Array.from(event.dataTransfer.files));}
  };
}
export function ChatAttachmentButtons({disabled,onUpload}:{disabled:boolean;onUpload:(files:File[])=>void}){
  const images=useRef<HTMLInputElement>(null),files=useRef<HTMLInputElement>(null);
  return <><input hidden ref={images} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event=>{onUpload(Array.from(event.target.files??[]));event.currentTarget.value='';}}/><input hidden ref={files} type="file" multiple onChange={event=>{onUpload(Array.from(event.target.files??[]));event.currentTarget.value='';}}/><button type="button" className="chat-attachment-icon" aria-label="上传图片" title="上传图片，也可拖放或粘贴" disabled={disabled} onClick={()=>images.current?.click()}><ImagePlus size={16}/></button><button type="button" className="chat-attachment-icon" aria-label="上传文件" title="上传文件，也可拖放或粘贴" disabled={disabled} onClick={()=>files.current?.click()}><Paperclip size={16}/></button></>;
}
export function ChatAttachmentList({base,entries,onRemove,uploading=false}:{base:string;entries:ChatAttachment[];onRemove?:(id:string)=>void;uploading?:boolean}){
  if(!entries.length&&!uploading)return null;
  return <div className="chat-attachments">{entries.map(item=><div key={item.id} className={`chat-attachment ${item.image?'image':''}`}><a href={`${base}/chat/attachments/${encodeURIComponent(item.id)}`} target="_blank" rel="noopener noreferrer" title={item.name}>{item.image?<img src={`${base}/chat/attachments/${encodeURIComponent(item.id)}`} alt={item.name}/>:<FileText size={22}/>}<span><strong>{item.name}</strong><small>{size(item.size)}</small></span></a>{onRemove&&<button type="button" aria-label={`移除附件：${item.name}`} disabled={uploading} onClick={()=>onRemove(item.id)}><X size={12}/></button>}</div>)}{uploading&&<span className="chat-attachment-uploading" role="status"><LoaderCircle size={15} className="spin"/>上传中…</span>}</div>;
}
