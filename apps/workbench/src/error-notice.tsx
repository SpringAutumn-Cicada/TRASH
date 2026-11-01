import React, { useSyncExternalStore, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modalAlertsRoot, subscribeModals, modalCount } from "./modal-layer.js";

// Errors follow the modal layer even when produced by a parent page's request.
export function ErrorNotice({children,className="notice error-notice"}:{children:React.ReactNode;className?:string}){
 const opened=useSyncExternalStore(subscribeModals,modalCount,()=>0);
 const anchor=useRef<HTMLSpanElement>(null),[hidden,setHidden]=useState(false);
 useLayoutEffect(()=>{
  if(!opened)return;
  const parents:HTMLElement[]=[];let parent=anchor.current?.parentElement;
  while(parent){parents.push(parent);parent=parent.parentElement;}
  const update=()=>setHidden(parents.some(element=>element.hidden||getComputedStyle(element).display==="none"||getComputedStyle(element).visibility==="hidden"));
  const observer=new MutationObserver(update);for(const element of parents)observer.observe(element,{attributes:true,attributeFilter:["hidden","class","style"]});update();return()=>observer.disconnect();
 },[opened]);
 const alert=<div role="alert" className={className}>{children}</div>;
 return <><span ref={anchor} hidden aria-hidden="true"/>{opened?(hidden?null:createPortal(alert,modalAlertsRoot())):alert}</>;
}
