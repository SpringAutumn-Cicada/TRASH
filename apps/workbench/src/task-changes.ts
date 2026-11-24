type Listener={update:()=>void;disconnect:()=>void};
const streams=new Map<string,{source:EventSource;listeners:Set<Listener>}>();

export function subscribeTaskChanges(projectId:string,listener:Listener){
  if(typeof EventSource==='undefined')return ()=>{};
  let entry=streams.get(projectId);
  if(!entry){
    const source=new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/knowledge-tasks/changes`);
    const listeners=new Set<Listener>();
    const update=()=>listeners.forEach(item=>item.update());
    source.addEventListener('ready',update);
    source.addEventListener('change',update);
    source.onerror=()=>listeners.forEach(item=>item.disconnect());
    entry={source,listeners};
    streams.set(projectId,entry);
  }
  entry.listeners.add(listener);
  return ()=>{
    const active=streams.get(projectId);
    if(!active)return;
    active.listeners.delete(listener);
    if(!active.listeners.size){active.source.close();streams.delete(projectId);}
  };
}
