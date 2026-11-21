import { useState } from 'react';
import { api, uiError } from './api.js';
import { ErrorNotice } from './error-notice.js';

type Item={id:string;kind:'repository'|'reproduction';name:string;path:string;state?:Preview['state']};
type Preview={state:'ready'|'moving'|'completed'|'rolling-back'|'rolled-back';from:string;to:string;files:number;bytes:number;fingerprint?:string};

export function CodeLayoutSettings({projectId,disabled}:{projectId:string;disabled:boolean}){
  const endpoint=`/projects/${encodeURIComponent(projectId)}/workspace/code-layout`;
  const [items,setItems]=useState<Item[]>(),[selected,setSelected]=useState(''),[preview,setPreview]=useState<Preview>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const item=items?.find(value=>value.kind+':'+value.id===selected);
  const run=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('');
    try{await action();}
    catch(cause){setError(uiError(cause,'代码目录操作失败，请重新预览。'));}
    finally{setBusy(false);}
  };
  const read=async()=>setItems((await api<{items:Item[]}>(endpoint)).items);
  const inspect=()=>void run(async()=>{
    if(!item)return;
    setPreview(undefined);
    setPreview(await api<Preview>(endpoint+'?'+new URLSearchParams({kind:item.kind,id:item.id})));
  });
  const move=(rollback:boolean)=>{
    if(!item||!preview)return;
    if(!window.confirm(rollback?'恢复本次移动前的代码目录及登记路径？':'将项目内的源码移动到预览所示目录？'))return;
    void run(async()=>{
      setPreview(await api<Preview>(endpoint+(rollback?'/rollback':''),{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({kind:item.kind,id:item.id,confirm:true,fingerprint:preview.fingerprint})
      }));
      await read();
    });
  };

  return <section className="project-settings-section library-layout-settings">
    <h3>代码目录迁移</h3>
    <p>可预览旧代码目录并整理到 <code>code/papers/</code> 或 <code>code/reproductions/</code>。</p>
    <div className="library-layout-actions">
      <button type="button" className="secondary-button" disabled={disabled||busy} onClick={()=>void run(read)}>{busy?'正在处理…':items?'刷新代码登记':'查看代码登记'}</button>
      {!!items?.length&&<><select aria-label="待整理的代码" value={selected} disabled={busy||disabled} onChange={event=>{setSelected(event.target.value);setPreview(undefined);setError('');}}><option value="">选择仓库或复现代码</option>
        {items.map(value=><option key={value.kind+':'+value.id} value={value.kind+':'+value.id}>{value.name}{value.kind==='reproduction'?' · 复现':''}</option>)}</select>
        <button type="button" className="secondary-button" disabled={busy||disabled||!item} onClick={inspect}>查看迁移详情</button></>}
    </div>
    {items?.length===0&&<p>暂无已登记的代码。</p>}
    {item&&<p><code className="workspace-path">{item.path}</code></p>}
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {preview&&<>
      <p><code>{preview.from}</code> → <code>{preview.to}</code> · {preview.files} 个文件 · {(preview.bytes/1048576).toFixed(1)} MiB</p>
      <div className="library-layout-actions">
        {['ready','moving'].includes(preview.state)&&<button type="button" className="primary-button" disabled={busy||disabled} onClick={()=>move(false)}>{preview.state==='ready'?'确认迁移':'继续迁移'}</button>}
        {['completed','rolling-back'].includes(preview.state)&&<button type="button" className="secondary-button" disabled={busy||disabled} onClick={()=>move(true)}>{preview.state==='completed'?'恢复旧目录':'继续恢复'}</button>}
        {preview.state==='completed'&&<span role="status">已迁移</span>}
        {preview.state==='rolled-back'&&<span role="status">已恢复</span>}
      </div>
    </>}
  </section>;
}
