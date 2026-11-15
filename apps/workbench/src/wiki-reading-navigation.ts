import {useEffect,useRef,useState,type RefObject} from 'react';

type Place={id:string;fragment:string;top:number;left:number;windowTop:number};
/** Each reader owns its stack, including repeated visits to the same document. */
export function useWikiReadingNavigation(id:string,loadedId:string|undefined,loading:boolean,scroller:RefObject<HTMLElement|null>,select:(id:string)=>void){
 const [stack,setStack]=useState<Place[]>([]),[fragment,setFragment]=useState(''),[revision,setRevision]=useState(0);
 const pending=useRef<Place|undefined>(undefined);
 const go=(next:string,anchor='')=>{
  if(loading)return;
  const element=scroller.current;
  setStack(items=>[...items,{id,fragment,top:element?.scrollTop??0,left:element?.scrollLeft??0,windowTop:window.scrollY}].slice(-100));
  pending.current=undefined;setFragment(anchor);setRevision(value=>value+1);select(next);
 };
 const back=()=>{
  const previous=stack.at(-1);if(!previous||loading)return;
  setStack(items=>items.slice(0,-1));pending.current=previous;setFragment(previous.fragment);setRevision(value=>value+1);select(previous.id);
 };
 useEffect(()=>{
  if(loading||loadedId!==id)return;
  const frame=requestAnimationFrame(()=>{
   const element=scroller.current;if(!element)return;
   const place=pending.current;
   if(place?.id===id){element.scrollTop=place.top;element.scrollLeft=place.left;window.scrollTo({top:place.windowTop,behavior:'instant'});pending.current=undefined;return;}
   element.scrollTop=0;
   if(fragment){let decoded=fragment;try{decoded=decodeURIComponent(fragment);}catch{/* Treat malformed fragments literally. */}
    Array.from(element.querySelectorAll<HTMLElement>('[data-wiki-anchor]')).find(node=>node.dataset.wikiAnchor===decoded)?.scrollIntoView({block:'start'});
   }
  });return()=>cancelAnimationFrame(frame);
 },[id,loadedId,loading,fragment,revision,scroller]);
 return {go,back,canBack:stack.length>0};
}
