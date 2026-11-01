import React, { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import "./modal-layer.css";

let opened = 0;
const listeners=new Set<()=>void>();
export const modalCount=()=>opened;
export const subscribeModals=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const announce=()=>{for(const listener of listeners)listener();};
export function modalAlertsRoot(){
 const root=modalRoot();let host=document.getElementById("modal-alert-root");
 if(!host){host=document.createElement("div");host.id="modal-alert-root";root.appendChild(host);}return host;
}
let stopPositioning:(()=>void)|undefined;
function positionAlerts(){
 const root=modalRoot(),host=modalAlertsRoot();let frame=0;let observedDialog:HTMLElement|undefined;
 const resize=new ResizeObserver(()=>schedule());
 const update=()=>{
  frame=0;
  const dialogs=Array.from(root.querySelectorAll<HTMLElement>('.modal-backdrop')).filter(element=>element.getClientRects().length>0).sort((a,b)=>Number(getComputedStyle(a).zIndex)-Number(getComputedStyle(b).zIndex));
  const backdrop=dialogs.at(-1),dialog=backdrop?.querySelector<HTMLElement>('[role="dialog"]');
  if(!dialog)return;
  const box=dialog.getBoundingClientRect();host.style.width=`${box.width}px`;host.style.left=`${box.left}px`;host.style.top=`${Math.max(12,box.top-host.getBoundingClientRect().height-14)}px`;
  if(observedDialog!==dialog){if(observedDialog)resize.unobserve(observedDialog);observedDialog=dialog;resize.observe(dialog);}
 };
 function schedule(){if(!frame)frame=requestAnimationFrame(update);}
 resize.observe(host);
 const changes=new MutationObserver(schedule);changes.observe(root,{childList:true,subtree:true});
 window.addEventListener("resize",schedule);window.addEventListener("scroll",schedule,true);schedule();
 return()=>{changes.disconnect();resize.disconnect();window.removeEventListener("resize",schedule);window.removeEventListener("scroll",schedule,true);cancelAnimationFrame(frame);};
}
let previousOverflow = "";
let previousInert = false;
function modalRoot(): HTMLElement {
  let root = document.getElementById("modal-root");
  if (!root) { root = document.createElement("div"); root.id = "modal-root"; document.body.appendChild(root); }
  return root;
}

// All application dialogs live outside the page stacking context, including nested pickers.
export function ModalLayer({ children }: { children: React.ReactNode }) {
  const target = modalRoot();
  useLayoutEffect(() => {
    const app = document.getElementById("root");
    if (opened++ === 0) {
      previousOverflow = document.body.style.overflow;
      previousInert = app?.inert ?? false;
      document.body.style.overflow = "hidden";
      if (app) app.inert = true;
      stopPositioning=positionAlerts();
    }
    announce();
    return () => {
      if (--opened === 0) {
        document.body.style.overflow = previousOverflow;
        if (app) app.inert = previousInert;
        stopPositioning?.();stopPositioning=undefined;
      }
      announce();
    };
  }, []);
  return createPortal(children, target);
}
