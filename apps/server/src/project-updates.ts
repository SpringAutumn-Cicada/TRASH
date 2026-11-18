import type {ServerResponse} from 'node:http';
import type {TrashStore} from '@trash/storage';

type Change={tasks?:true;sources?:Iterable<string>;wiki?:true};
type Update={tasks:boolean;sources:Set<string>;wiki:boolean};
type Subscription={update:(update:Update)=>void;close:()=>void};
type Project={listeners:Set<Subscription>;pending:Update;timer?:ReturnType<typeof setTimeout>};
const projectsByStore=new WeakMap<TrashStore,Map<string,Project>>();
const empty=():Update=>({tasks:false,sources:new Set(),wiki:false});

export function publishProjectChange(store:TrashStore,id:string,change:Change){
 const project=projectsByStore.get(store)?.get(id);
 if(!project)return;
 if(change.tasks)project.pending.tasks=true;
 if(change.wiki)project.pending.wiki=true;
 for(const source of change.sources??[])project.pending.sources.add(source);
 project.timer??=setTimeout(()=>{
  project.timer=undefined;
  const update=project.pending;
  project.pending=empty();
  for(const listener of project.listeners){
   try{listener.update(update);}catch{listener.close();}
  }
 },100);
 project.timer.unref();
}

export function projectStream(store:TrashStore,id:string,response:ServerResponse){
 const projects=projectsByStore.get(store)??new Map<string,Project>();
 projectsByStore.set(store,projects);
 const project:Project=projects.get(id)??{listeners:new Set<Subscription>(),pending:empty()};
 projects.set(id,project);
 let seq=0,closed=false,blocked=false;
 const drain=()=>{blocked=false;};
 const send=(event:string,data:unknown)=>{
  if(closed)return;
  if(blocked){close();return;}
  blocked=!response.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 };
 const close=()=>{
  if(closed)return;
  closed=true;
  clearInterval(heartbeat);
  response.off('drain',drain);
  project.listeners.delete(subscription);
  if(!project.listeners.size){clearTimeout(project.timer);projects.delete(id);}
  if(!response.writableEnded)response.end();
 };
 const subscription:Subscription={close,update:()=>{}};
 const heartbeat=setInterval(()=>{if(!blocked)blocked=!response.write(': heartbeat\n\n');},25000);
 heartbeat.unref();
 project.listeners.add(subscription);
 response.once('close',close);
 response.on('drain',drain);
 response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});
 response.flushHeaders();
 return {send,close,onUpdate:(update:Subscription['update'])=>{subscription.update=update;}};
}

export function closeProjectStreams(store:TrashStore){
 for(const project of projectsByStore.get(store)?.values()??[]){
  for(const listener of project.listeners)listener.close();
 }
 projectsByStore.delete(store);
}
