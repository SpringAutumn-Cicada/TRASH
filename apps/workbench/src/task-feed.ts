import {useEffect,useRef,useState} from 'react';
import {api,uiError} from './api.js';
export type TaskItem={task_id:string;title:string;input:{abstract_mode?:boolean;kind:string;source_ids:string[];include_source_wiki?:boolean;wiki_level?:string};status:string;created_at:string;started_at?:string;last_at?:string;last_seq:number;error?:string;progress?:string;output_id?:string;attempt_of?:string;can_resume?:boolean};
export type TaskEvent={seq:number;at:string;message:string};
type Page={task:TaskItem;reading?:{total:number;completed:number;unit?:string;phase?:string;title?:string;warnings?:string[];sections?:{id:string;title:string;level:number;confidence:number;reason:string}[];blocks?:{id:string;title?:string;pages:number[];mode:string;warnings:string[];completed:boolean}[]};events:TaskEvent[];first_seq:number|null;last_seq:number;has_older:boolean;has_more:boolean};
export function useTaskFeed(projectId:string,id:string|undefined,onTask:(task:TaskItem)=>void){
 const base=`/projects/${encodeURIComponent(projectId)}/knowledge-tasks`;
 const [events,setEvents]=useState<TaskEvent[]>([]),[reading,setReading]=useState<Page['reading']>(),[connection,setConnection]=useState('connecting'),[error,setError]=useState(''),[hasOlder,setHasOlder]=useState(false),[olderBusy,setOlderBusy]=useState(false);
 const current=useRef(onTask);current.current=onTask;
 const cursor=useRef(0),oldest=useRef<number|undefined>(undefined),olderLock=useRef(false),generation=useRef(0);
 const merge=(incoming:TaskEvent[])=>setEvents(previous=>[...new Map([...previous,...incoming].map(event=>[event.seq,event])).values()].sort((a,b)=>a.seq-b.seq));
 useEffect(()=>{
  let closed=false,stream:EventSource|undefined,poll:ReturnType<typeof setInterval>|undefined,polling=false;
  const abort=new AbortController();++generation.current;cursor.current=0;oldest.current=undefined;olderLock.current=false;
  setEvents([]);setReading(undefined);setError('');setHasOlder(false);setOlderBusy(false);setConnection(id?'connecting':'idle');if(!id)return;
  const accept=(page:Page)=>{if(closed)return;merge(page.events);cursor.current=Math.max(cursor.current,page.last_seq);oldest.current=oldest.current===undefined?page.first_seq??undefined:page.first_seq===null?oldest.current:Math.min(oldest.current,page.first_seq);setReading(page.reading);current.current(page.task);};
  const incremental=async()=>{if(closed||polling)return;polling=true;try{const page=await api<Page>(`${base}/${encodeURIComponent(id)}/events?after=${cursor.current}`,{signal:abort.signal});accept(page);if(!closed){setError('');if(!['queued','running'].includes(page.task.status)&&!page.has_more){clearInterval(poll);stream?.close();setConnection('idle');}}}catch(e){if(!closed){setConnection('error');setError(uiError(e,'日志连接暂时中断，正在重试。'));}}finally{polling=false;}};
  const fallback=()=>{if(closed||poll)return;setConnection('polling');poll=setInterval(()=>void incremental(),2000);void incremental();};
  void (async()=>{try{
   const first=await api<Page>(`${base}/${encodeURIComponent(id)}/events?limit=100`,{signal:abort.signal});if(closed)return;accept(first);setHasOlder(first.has_older);
   if(!['queued','running'].includes(first.task.status)){setConnection('idle');return;}
   if(typeof EventSource==='undefined'){fallback();return;}
   stream=new EventSource(`/api/v1${base}/${encodeURIComponent(id)}/stream?after=${cursor.current}`);
   stream.onopen=()=>{if(!closed){setConnection('live');setError('');clearInterval(poll);poll=undefined;}};
   stream.addEventListener('batch',event=>{if(closed)return;try{accept(JSON.parse((event as MessageEvent).data));setError('');}catch{fallback();}});
   stream.addEventListener('done',()=>{if(closed)return;stream?.close();clearInterval(poll);setConnection('idle');});
   stream.addEventListener('removed',()=>{if(closed)return;stream?.close();clearInterval(poll);setConnection('error');setError('任务已不存在，请刷新任务列表。');});
   stream.onerror=()=>{if(!closed){setConnection('reconnecting');fallback();}};
  }catch(e){if(!closed){setError(uiError(e,'暂时无法读取日志，正在重试。'));fallback();}}})();
  return()=>{closed=true;++generation.current;abort.abort();stream?.close();clearInterval(poll);};
 },[base,id]);
 const older=async()=>{if(!id||oldest.current===undefined||olderLock.current)return;const token=generation.current;olderLock.current=true;setOlderBusy(true);try{
  const page=await api<Page>(`${base}/${encodeURIComponent(id)}/events?before=${oldest.current}&limit=100`);
  if(token!==generation.current)return;merge(page.events);if(page.first_seq!==null)oldest.current=page.first_seq;setHasOlder(page.has_older);setError('');
 }catch(e){if(token===generation.current)setError(uiError(e,'无法加载更早的日志。'));}finally{if(token===generation.current){olderLock.current=false;setOlderBusy(false);}}};
 return {events,reading,connection,error,hasOlder,olderBusy,older};
}
