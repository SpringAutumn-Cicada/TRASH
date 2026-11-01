import React, { useEffect, useState } from "react";
import type { TerminalSession } from "./autodl-terminal.js";

export function AutoDlConnectionStatus({projectId}:{projectId:string}) {
  const [state,setState]=useState<{kind:"loading"|"connected"|"disconnected"|"unknown";name?:string}>({kind:"loading"});
  useEffect(()=>{
    let alive=true;
    let request:AbortController|undefined;
    const refresh=async()=>{
      request?.abort();
      const controller=new AbortController();request=controller;
      try {
        const response=await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/terminals`,{signal:controller.signal,cache:"no-store"});
        if(!response.ok)throw new Error("Unable to read SSH status");
        const data=await response.json() as {terminals:TerminalSession[]};
        const session=data.terminals.find(item=>!item.ended);
        if(alive&&!controller.signal.aborted)setState(session?{kind:"connected",name:session.name}:{kind:"disconnected"});
      }catch{if(alive&&!controller.signal.aborted)setState({kind:"unknown"});}
    };
    const changed=(event:Event)=>{if((event as CustomEvent<{projectId:string}>).detail?.projectId===projectId)void refresh();};
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},5000);
    window.addEventListener("trash-autodl-changed",changed);
    document.addEventListener("visibilitychange",visible);
    return()=>{alive=false;request?.abort();window.clearInterval(timer);window.removeEventListener("trash-autodl-changed",changed);document.removeEventListener("visibilitychange",visible);};
  },[projectId]);
  const label=state.kind==="connected"?`已连接${state.name?` · ${state.name}`:""}`:state.kind==="disconnected"?"未连接":state.kind==="unknown"?"状态未知":"读取连接状态…";
  return <span className={`workspace-autodl-status ${state.kind}`} role="status" title={label}><i aria-hidden="true"/><span>{label}</span></span>;
}
