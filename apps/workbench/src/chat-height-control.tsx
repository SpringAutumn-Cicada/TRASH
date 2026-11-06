import React, { useRef, useState } from 'react';
import { GripHorizontal, RotateCcw } from 'lucide-react';
import { readPreference, writePreference } from './navigation.js';

const min=240,max=1400;
const clamp=(height:number)=>Math.min(max,Math.max(min,Math.round(height)));
export function useChatHeight(projectId:string){
  const key=`trash-chat-height:${projectId}`;
  const [height,setHeight]=useState<number|null>(()=>{const saved=readPreference(key);if(!saved)return null;const value=Number(saved);return Number.isFinite(value)?clamp(value):null;});
  const change=(value:number|null)=>{setHeight(value===null?null:clamp(value));writePreference(key,value===null?'':String(clamp(value)));};
  return {height,change};
}
export function ChatHeightControl({height,onChange,target}:{height:number|null;onChange:(value:number|null)=>void;target:React.RefObject<HTMLDivElement|null>}){
  const drag=useRef<{id:number;y:number;height:number}>();
  const actual=()=>height??target.current?.getBoundingClientRect().height??480;
  const finish=(event:React.PointerEvent<HTMLDivElement>)=>{if(drag.current?.id!==event.pointerId)return;drag.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  return <div className="chat-height-controls"><div className="chat-height-grip" role="separator" tabIndex={0} aria-label="调整对话消息区域高度" aria-orientation="horizontal" aria-valuemin={min} aria-valuemax={max} aria-valuenow={clamp(actual())} title="上下拖动调整高度；方向键微调，双击恢复默认" onDoubleClick={()=>onChange(null)} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,y:event.clientY,height:actual()};}} onPointerMove={event=>{if(drag.current?.id===event.pointerId)onChange(drag.current.height+event.clientY-drag.current.y);}} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={()=>{drag.current=undefined;}} onKeyDown={event=>{let value:number|null;if(event.key==='ArrowUp')value=actual()-(event.shiftKey?100:20);else if(event.key==='ArrowDown')value=actual()+(event.shiftKey?100:20);else if(event.key==='Home')value=min;else if(event.key==='End')value=max;else if(event.key==='Enter')value=null;else return;event.preventDefault();onChange(value);}}><GripHorizontal size={17}/><span>拖动调整对话高度</span>{height!==null&&<small>{height}px</small>}</div>{height!==null&&<button type="button" className="chat-height-reset" aria-label="恢复默认对话高度" onClick={()=>onChange(null)}><RotateCcw size={12}/>默认</button>}</div>;
}
