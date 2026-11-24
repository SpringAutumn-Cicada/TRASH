import { useEffect, useState } from 'react';
import type { ProjectPage } from '@trash/protocol';
import { api, uiError } from './api.js';
import { ErrorNotice } from './error-notice.js';

type Result={id:string;title:string;version:number;run_id?:string;dataset?:string};
type Evidence={etag:string|null;entries:{id:string;result_id:string;version:number;usage:string;result:Result|null}[];results:Result[]};

export function ManuscriptEvidence({projectId,paperId,onNavigate}:{
  projectId:string;paperId:string;
  onNavigate:(page:ProjectPage,options?:{focus?:string;action?:string})=>void;
}){
  const endpoint=`/projects/${encodeURIComponent(projectId)}/workspace/manuscripts/evidence?id=${encodeURIComponent(paperId)}`;
  const [data,setData]=useState<Evidence>(),[selected,setSelected]=useState(''),[versions,setVersions]=useState<Result[]>([]);
  const [version,setVersion]=useState(0),[usage,setUsage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    void api<Evidence>(endpoint,{signal:controller.signal}).then(setData)
      .catch(cause=>{if(!controller.signal.aborted)setError(uiError(cause,'无法读取论文实验依据。'));});
    return()=>controller.abort();
  },[endpoint]);
  useEffect(()=>{
    setVersions([]);setVersion(0);
    if(!selected)return;
    const controller=new AbortController();
    void api<{versions:Result[]}>(endpoint+'&result_id='+encodeURIComponent(selected),{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted){setVersions(value.versions);setVersion(value.versions[0]?.version??0);}})
      .catch(cause=>{if(!controller.signal.aborted)setError(uiError(cause,'无法读取结果版本。'));});
    return()=>controller.abort();
  },[endpoint,selected]);
  const change=async(input:Record<string,unknown>)=>{
    if(!data||busy)return;
    setBusy(true);setError('');
    try{
      const next=await api<Evidence>(endpoint,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...input,expected:data.etag})});
      setData(next);
      if(input.action==='add')setUsage('');
    }catch(cause){
      setError(uiError(cause,'无法保存实验依据。'));
      if(cause instanceof Error&&cause.message==='VERSION_CONFLICT')void api<Evidence>(endpoint).then(setData).catch(()=>{});
    }finally{setBusy(false);}
  };
  return <section className="manuscript-panel">
    <h3>实验依据</h3>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {data?.entries.length?<ul>{data.entries.map(entry=><li key={entry.id}>
      <strong>{entry.usage}</strong> · {entry.result?.title??entry.result_id} v{entry.version}
      {entry.result?.run_id&&<button type="button" className="text-button" onClick={()=>onNavigate('experiments',{focus:entry.result!.run_id})}>打开运行</button>}
      <button type="button" className="text-button" disabled={busy} onClick={()=>void change({action:'remove',entry_id:entry.id})}>移除引用</button>
    </li>)}</ul>:data&&<p>暂无实验结果引用。</p>}
    {data?.results.length?<form className="manuscript-settings" onSubmit={event=>{
      event.preventDefault();void change({action:'add',result_id:selected,version,usage});
    }}>
      <label>实验结果<select value={selected} onChange={event=>{setVersion(0);setVersions([]);setSelected(event.target.value);}}><option value="">选择实验结果</option>
        {data.results.map(result=><option key={result.id} value={result.id}>{result.title}{result.dataset?' · '+result.dataset:''}</option>)}</select></label>
      <label>版本<select value={version||''} disabled={!versions.length} onChange={event=>setVersion(Number(event.target.value))}>
        {!versions.length&&<option value="">选择版本</option>}{versions.map(result=><option key={result.version} value={result.version}>v{result.version}</option>)}
      </select></label>
      <label>论文用途<input required maxLength={200} value={usage} onChange={event=>setUsage(event.target.value)} placeholder="例如表 3 的主实验结果"/></label>
      <button className="secondary-button" disabled={busy||!version||!selected||!usage.trim()}>添加引用</button>
    </form>:data&&<p>可在数据页登记实验结果后添加引用。</p>}
  </section>;
}
