import {useEffect,useState,type RefObject} from 'react';

/** Scroll local document links to their requested section without keeping reading history. */
export function useWikiReadingNavigation(id:string,loadedId:string|undefined,loading:boolean,scroller:RefObject<HTMLElement|null>,select:(id:string)=>void){
 const [fragment,setFragment]=useState(''),[revision,setRevision]=useState(0);
 const go=(next:string,anchor='')=>{if(loading)return;setFragment(anchor);setRevision(value=>value+1);select(next);};
 useEffect(()=>{
  if(loading||loadedId!==id)return;
  const frame=requestAnimationFrame(()=>{
   const element=scroller.current;if(!element)return;element.scrollTop=0;
   if(fragment){let decoded=fragment;try{decoded=decodeURIComponent(fragment);}catch{/* Treat malformed fragments literally. */}
    Array.from(element.querySelectorAll<HTMLElement>('[data-wiki-anchor]')).find(node=>node.dataset.wikiAnchor===decoded)?.scrollIntoView({block:'start'});
   }
  });return()=>cancelAnimationFrame(frame);
 },[id,loadedId,loading,fragment,revision,scroller]);
 return {go};
}
