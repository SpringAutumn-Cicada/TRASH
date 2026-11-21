import { useEffect, useState } from 'react';
import type { ProjectRepository } from '@trash/protocol';
import { api, uiError } from './api.js';
import { CodeAgentPanel } from './code-agent.js';
import { ErrorNotice } from './error-notice.js';
import { DirectoryPicker } from './directory-picker.js';

type Binding = { repository: ProjectRepository | null; repositories: ProjectRepository[] };

export function ManuscriptRepository({projectId, paperId}: {projectId:string;paperId:string}){
  const base=`/projects/${encodeURIComponent(projectId)}`;
  const endpoint=base+'/workspace/manuscripts/repository';
  const [binding,setBinding]=useState<Binding>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState(''),[picker,setPicker]=useState(false),[agent,setAgent]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    void api<Binding>(endpoint+'?id='+encodeURIComponent(paperId),{signal:controller.signal})
      .then(setBinding).catch(cause=>{if(!controller.signal.aborted)setError(uiError(cause,'无法读取论文仓库。'));});
    return()=>controller.abort();
  },[endpoint,paperId]);
  const change=async(input:{action:'create'}|{action:'link';repository_id:string}|{action:'bind';path:string})=>{
    setBusy(true);setError('');
    try{
      const {repository}=await api<{repository:ProjectRepository}>(endpoint,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:paperId,...input})
      });
      setBinding(value=>({repository,repositories:value?.repositories??[]}));
    }catch(cause){setError(uiError(cause,'无法关联代码仓库。'));}
    finally{setBusy(false);}
  };
  const candidates=binding?.repositories.filter(item=>!item.paper_id)??[];
  return <section className="manuscript-panel">
    <h3>代码仓库</h3>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {binding?.repository?<><p><code>{binding.repository.path}</code></p>
      <button type="button" className="secondary-button" onClick={()=>setAgent(open=>!open)} aria-expanded={agent}>{agent?'收起代码 Agent':'打开代码 Agent'}</button>
      {agent&&<CodeAgentPanel projectId={projectId} repositoryPath={binding.repository.path} repositoryId={binding.repository.repository_id}/>}
    </>:binding&&<div className="knowledge-toolbar">
      <button type="button" className="primary-button" disabled={busy} onClick={()=>void change({action:'create'})}>创建 Git 仓库</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={()=>setPicker(true)}>绑定现有目录</button>
      {candidates.length>0&&<><select aria-label="已登记的仓库" disabled={busy} value={selected} onChange={event=>setSelected(event.target.value)}>
        <option value="">选择已登记仓库</option>
        {candidates.map(repo=><option key={repo.repository_id} value={repo.repository_id}>{repo.name??repo.path}</option>)}
      </select><button type="button" className="secondary-button" disabled={busy||!selected} onClick={()=>void change({action:'link',repository_id:selected})}>关联到本论文</button></>}
    </div>}
    {picker&&<DirectoryPicker base={'/api/v1'+base} initialPath="" onClose={()=>setPicker(false)} onSelect={path=>{setPicker(false);void change({action:'bind',path});}}/>}
  </section>;
}
