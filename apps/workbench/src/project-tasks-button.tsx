import { useEffect, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { api } from './api.js';
import { subscribeTaskChanges } from './task-changes.js';

export function ProjectTasksButton({projectId,active,onOpen}:{projectId:string;active:boolean;onOpen:()=>void}){
  const [counts,setCounts]=useState<{queued:number;running:number}>();
  const [stale,setStale]=useState(false);
  useEffect(()=>{
    let request:AbortController|undefined;
    const refresh=()=>{
      request?.abort();
      const controller=new AbortController();
      request=controller;
      void api<{queued:number;running:number}>(`/projects/${encodeURIComponent(projectId)}/knowledge-tasks/counts`,{signal:controller.signal})
        .then(value=>{if(!controller.signal.aborted){setCounts(value);setStale(false);}})
        .catch(()=>{if(!controller.signal.aborted)setStale(true);});
    };
    const unsubscribe=subscribeTaskChanges(projectId,{update:refresh,disconnect:()=>setStale(true)});
    refresh();
    return()=>{request?.abort();unsubscribe();};
  },[projectId]);

  const total=counts?counts.queued+counts.running:0;
  const label=counts?`任务 · ${counts.running} 个运行中 · ${counts.queued} 个排队${stale?'（状态待更新）':''}`:
    stale?'任务 · 状态暂不可用':'任务';
  return <button type="button" className="secondary-button workspace-tasks-button"
    title={label} aria-label={label} aria-current={active?'page':undefined} onClick={onOpen}>
    <ListTodo size={16} aria-hidden="true"/><span className="workspace-tasks-label">任务</span>
    {counts&&total>0&&<>
      <span className="workspace-task-breakdown" aria-hidden="true">{counts.running} 运行 · {counts.queued} 排队</span>
      <span className="workspace-task-count" aria-hidden="true">{total>99?'99+':total}</span>
    </>}
  </button>;
}
