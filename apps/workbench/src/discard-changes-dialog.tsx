import React, { useEffect, useRef } from 'react';
import { ModalLayer } from './modal-layer.js';
export function DiscardChangesDialog({onConfirm,onCancel}:{onConfirm:()=>void;onCancel:()=>void}){
 const dialog=useRef<HTMLDivElement>(null);
 useEffect(()=>{const previous=document.activeElement;dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 return <ModalLayer><div className="modal-backdrop"><div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-changes-title" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onCancel();}if(event.key==='Tab'){const buttons=dialog.current?.querySelectorAll<HTMLButtonElement>('button');if(!buttons?.length)return;const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}><h2 id="discard-changes-title">放弃未保存的修改？</h2><p>修改尚未保存，放弃后将关闭编辑或离开当前页面。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>继续编辑</button><button type="button" className="primary-button" onClick={onConfirm}>放弃修改并继续</button></div></div></div></ModalLayer>;
}
