import React,{useId,useState} from 'react';
import {ChevronDown,ChevronRight} from 'lucide-react';
import {projectPath} from './navigation.js';

export type ResearchStageView='overview'|'materials'|'discovery'|'synthesis'|'done';
export type TopicStopAfter='materials'|'discovery'|'synthesis';
export type ResearchTopic={id:string;title:string;status:'candidate'|'pending'|'generating'|'completed'|'failed';task_id?:string;output_id?:string;error?:string;source_count?:number;preview_task_id?:string;preview_status?:string};
export type ResearchRun={mode?:'directions'|'research-map'|'comparison'|'background'|'topics';question_id?:string;id:string;stage:string;tasks:string[];source_ids:string[];result_id?:string;discovery_id?:string;material_output_ids?:string[];stop_after?:TopicStopAfter;topics?:ResearchTopic[];error?:string;created_at:string;updated_at?:string;instructions?:string;can_append?:boolean;superseded?:boolean;append?:{parent_id:string;added_ids:string[];rebuilt_ids:string[];batches:{source_ids:string[];task_id?:string;output_id?:string}[]};progress?:{phase:string;round:number;total:number;completed:number;running:number;queued:number;failed:number;candidates:number;current_title?:string;last_activity_at?:string;details:{id:string;title:string;status:string;last_activity_at?:string}[]}};
export const researchActive=(stage:string)=>['summarizing','generating','discovering','previewing','topics'].includes(stage);
const stages:Record<string,string>={summarizing:'整理材料','materials-ready':'材料已就绪','discovery-ready':'主题已发现',generating:'组织研究内容',discovering:'发现主题',previewing:'生成单主题试稿',topics:'综合主题',partial:'本轮已结束',completed:'已完成',failed:'处理失败',interrupted:'已中断',cancelled:'已停止'};
const statuses:Record<string,string>={running:'处理中',generating:'处理中',completed:'已完成',queued:'排队中',pending:'待展开',failed:'失败',interrupted:'已中断',cancelled:'已停止',missing:'记录缺失',candidate:'候选线索'};
const duration=(seconds:number)=>seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分${seconds%60?` ${seconds%60} 秒`:''}`;
export function ResearchRunCard({run:r,projectId,busy,blocked,onResult,onResume,onRediscover,onAppend,onStop,onGeneratePreview,onPreview,onSetStop,sourceTitles,view,onView,preview}:{run:ResearchRun;projectId:string;busy:boolean;blocked:boolean;onResult:(run:ResearchRun,id:string,candidates?:boolean)=>void;onResume:(run:ResearchRun,topic?:ResearchTopic,stopAfter?:TopicStopAfter)=>void;onRediscover:(run:ResearchRun)=>void;onAppend:(run:ResearchRun)=>void;onStop:(run:ResearchRun)=>void;onGeneratePreview:(run:ResearchRun,topic:ResearchTopic)=>void;onPreview:(run:ResearchRun,topic:ResearchTopic)=>void;onSetStop:(run:ResearchRun,stage:TopicStopAfter)=>void;sourceTitles:string[];view?:ResearchStageView;onView:(view:ResearchStageView)=>void;preview?:React.ReactNode}){
 const panelId=useId();
 const formalTopicsId=useId();
 const [showFormalTopics,setShowFormalTopics]=useState(true);
 const selected=view??(r.stage==='discovery-ready'||r.stage==='previewing'?'discovery':'overview');
 const viewingProgress=selected==='overview'||selected==='synthesis';
 const p=r.progress,working=researchActive(r.stage),now=Date.now();
 const last=p?.last_activity_at?Date.parse(p.last_activity_at):NaN;
 const age=Number.isFinite(last)?Math.max(0,Math.floor((now-last)/1000)):undefined;
 const elapsed=Math.max(0,Math.floor(((working?now:Date.parse(r.updated_at??r.created_at))-Date.parse(r.created_at))/1000));
 const steps: [Exclude<ResearchStageView,'overview'>,string][]=r.mode==='topics'?[['materials','整理材料'],['discovery','发现主题'],['synthesis','综合主题'],['done','完成']]:[['materials','整理材料'],['synthesis','组织内容'],['done','完成']];
 const position=steps.findIndex(([id])=>id===p?.phase);
 const counting=Boolean(p&&p.total>0&&['materials','synthesis'].includes(p.phase));
 const unit=p?.phase==='materials'?'组':r.mode==='topics'?'个主题':'个任务';
 const formalTopics=(r.topics??[]).filter(topic=>topic.status!=='candidate');
 const canAdvanceMaterials=!r.superseded&&r.stage==='materials-ready';
 const canSynthesize=!r.superseded&&r.stage==='discovery-ready';
 const canResume=!r.superseded&&['partial','failed','interrupted','cancelled'].includes(r.stage);
 return <section className={`research-current-card ${working?'is-active':''}`} aria-label="研究分析进度">
  <header className="research-current-heading"><div><small>{working?'当前任务':'任务结果'}</small><h3>{r.source_ids.length} 篇论文{r.mode==='topics'||r.mode==='comparison'?'主题综合':'研究分析'}</h3></div><span className={`research-state state-${r.stage}`}><i/>{stages[r.stage]??r.stage}</span></header>
  {r.append&&<p className="research-run-notice">追加 {r.append.added_ids.length} 篇 · 复用 {r.source_ids.length-r.append.added_ids.length-r.append.rebuilt_ids.length} 篇{r.append.rebuilt_ids.length>0&&` · 重整 ${r.append.rebuilt_ids.length} 篇`} · 已保存 {r.append.batches.filter(batch=>batch.output_id).length} / {r.append.batches.length} 组材料</p>}
  <ol className="research-stage-track" aria-label="处理阶段">{steps.map(([id,label],index)=>{
   const step=index===position?'current':index<position?'finished':'';
   const indicator=<span className="research-stage-number" aria-hidden="true">{index<position?'✓':index+1}</span>;
   return <li key={id} className={step} aria-current={index===position?'step':undefined}>
    {r.mode==='topics'
     ?<button type="button" className="research-stage-link" aria-pressed={selected===id} aria-controls={panelId} onClick={()=>onView(id)}>{indicator}{label}</button>
     :<>{indicator}{id==='done'&&r.result_id?<button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,r.result_id!,true)}>{label}</button>:label}</>}
   </li>;
  })}</ol>
  <div id={panelId}>
   {selected!=='overview'&&<header className="research-stage-heading">
    <h4>{steps.find(([id])=>id===selected)?.[1]}</h4>
    <button type="button" className="text-button" onClick={()=>onView('overview')}>返回任务概览</button>
   </header>}
   {selected==='materials'&&<div>
    {r.material_output_ids?.length?<ul className="research-task-rows">{r.material_output_ids.map((id,index)=><li key={id}><button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,id)}>查看材料 {index+1}</button></li>)}</ul>
     :r.append?.batches.some(batch=>batch.output_id)?<ul className="research-task-rows">{r.append.batches.map((batch,index)=>batch.output_id&&<li key={index}><button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,batch.output_id!)}>查看追加材料 {index+1} · {batch.source_ids.length} 篇</button></li>)}</ul>
     :<p className="research-run-notice">{r.stage==='summarizing'?'正在整理材料。':position>0?'此轮没有可单独打开的材料记录。':'材料整理结果尚未就绪。'}</p>}
   </div>}
   {selected==='done'&&!r.result_id&&<p className="research-run-notice">此轮尚无可打开的主题目录。</p>}
   {selected==='discovery'&&<div className="research-discovery-panel">
    <div className="research-discovery-meta">
     <button type="button" className="research-discovery-toggle" aria-expanded={showFormalTopics} aria-controls={formalTopicsId} onClick={()=>setShowFormalTopics(open=>!open)}>
      {showFormalTopics?<ChevronDown size={16} aria-hidden="true"/>:<ChevronRight size={16} aria-hidden="true"/>}
      正式主题 · {formalTopics.length} 个
     </button>
     {r.discovery_id&&<div className="research-discovery-actions">
      <button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,r.discovery_id!)}>查看发现清单</button>
      {!r.superseded&&<button type="button" className="secondary-button" disabled={busy||blocked} title={blocked?'当前任务结束后可重新生成':undefined} onClick={()=>onRediscover(r)}>重新生成主题发现清单</button>}
     </div>}
    </div>
    <div id={formalTopicsId} hidden={!showFormalTopics}>
     {!formalTopics.length&&<p className="research-run-notice">{r.stage==='discovering'?'正在发现主题。':r.discovery_id?'本轮没有可以单独生成的正式主题。':'主题发现结果尚未就绪。'}</p>}
     {blocked&&!r.superseded&&formalTopics.length>0&&<small>当前任务结束后可生成单主题试稿。</small>}
     {r.superseded&&<p className="research-run-notice">这是历史轮次。要生成试稿，请打开最新一轮的「发现主题」。</p>}
     {formalTopics.length>0&&<ul className="research-topic-list">{formalTopics.map(topic=><li key={topic.id}>
      <div><strong>{topic.title}</strong><small>{topic.preview_status==='queued'?'试稿排队中':topic.preview_status==='running'?'正在生成试稿':topic.preview_status==='completed'?'试稿待确认':statuses[topic.status]}{topic.source_count!==undefined&&` · ${topic.source_count} 篇`}</small></div>
      {topic.error&&<p>{topic.error}</p>}
      <div className="research-topic-actions">
       {topic.output_id&&<button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,topic.output_id!)}>阅读主题组</button>}
       {topic.preview_status==='completed'&&<button type="button" className="text-button" disabled={busy} onClick={()=>onPreview(r,topic)}>查看试稿</button>}
       {!r.superseded&&topic.status!=='generating'&&<button type="button" className="text-button" disabled={busy||blocked} onClick={()=>onGeneratePreview(r,topic)}>{topic.preview_status==='completed'?'重新生成试稿':topic.preview_status&&topic.preview_status!=='published'&&!['queued','running'].includes(topic.preview_status)?'重试单主题试稿':'生成单个主题'}</button>}
       {topic.preview_task_id&&topic.preview_status!=='published'&&<a href={projectPath(projectId,'tasks',{focus:topic.preview_task_id})}>试稿日志</a>}
      </div>
     </li>)}</ul>}
     {r.topics?.some(topic=>topic.preview_status==='completed')&&<small>已有试稿的主题可单独确认发布，批量综合会处理其余主题。</small>}
    </div>
    {preview}
   </div>}
  {viewingProgress&&<div className="research-progress-block">
   <div className="research-progress-caption"><strong>{p?.phase==='materials'&&working?`分组整理 · 第 ${p.round||1} 轮`:stages[r.stage]??'准备材料'}</strong>{counting&&<span>已完成 {p!.completed} / {p!.total} {unit}</span>}</div>
   {counting?<progress aria-label="当前阶段已完成数量" max={p!.total} value={p!.completed}/>:working&&<div className="research-phase-pending" role="status">{p?.phase==='discovery'?'正在分析主题边界，主题数量尚未确定。':'正在等待任务执行状态。'}</div>}
   {p&&<div className="research-progress-counts"><span>完成 <b>{p.completed}</b></span><span>处理中 <b>{p.running}</b></span><span>{p.phase==='materials'?'排队':'待处理'} <b>{p.queued}</b></span>{p.failed>0&&<span className="research-count-failed">未完成 <b>{p.failed}</b></span>}{p.candidates>0&&<span>候选线索 <b>{p.candidates}</b></span>}</div>}
   {working&&<p className="research-current-action">{p?.current_title?`当前：${p.current_title}`:p?.queued?'等待队列调度':'正在更新阶段状态'}</p>}
   <div className="research-activity"><span>{working?'已用时':'历时'} {duration(elapsed)}</span>{age!==undefined&&<span>{working?`最近活动：${duration(age)}前`:`最后活动：${new Date(last).toLocaleString()}`}</span>}</div>
   {working&&age!==undefined&&age>=60&&<p className={age>=300?'research-wait-notice':'research-wait-hint'} role="status">{age>=300?'较长时间未收到新活动，可展开执行详情查看日志；尚不能据此判定失败。':'暂未收到新输出，仍在等待模型响应。'}</p>}
   {!working&&r.error&&<p className="research-run-notice">{r.error}</p>}
   {r.stage==='partial'&&p&&<p className="research-run-notice">本轮已完成 {p.completed} 个主题，仍有 {p.queued} 个待展开、{p.failed} 个未完成。已发布内容保留，可继续处理。</p>}
  </div>}
  {r.mode==='topics'&&['summarizing','discovering'].includes(r.stage)&&<label className="research-selection-actions">执行到
   <select value={r.stop_after??'synthesis'} disabled={busy} onChange={event=>onSetStop(r,event.target.value as TopicStopAfter)}>
    {r.stage==='summarizing'&&<option value="materials">整理材料</option>}
    <option value="discovery">发现主题</option>
    <option value="synthesis">完成综合</option>
   </select>
  </label>}
  <div className="research-current-buttons">
   {r.result_id&&<button type="button" className="primary-button" disabled={busy} onClick={()=>onResult(r,r.result_id!,r.mode!=='topics')}>{r.mode==='topics'?'打开主题目录':'查看结果'}</button>}
   {r.mode==='topics'&&r.stage==='completed'&&!r.superseded&&selected!=='discovery'&&<button type="button" className="secondary-button" disabled={busy||blocked} title={blocked?'已有分析任务运行，完成后可重新发现':undefined} onClick={()=>onRediscover(r)}>重新发现主题</button>}
   {canAdvanceMaterials&&<>
    <button type="button" className="primary-button" disabled={busy||blocked} onClick={()=>onResume(r,undefined,'discovery')}>开始发现主题</button>
    <button type="button" className="secondary-button" disabled={busy||blocked} onClick={()=>onResume(r,undefined,'synthesis')}>继续到完成综合</button>
   </>}
   {canSynthesize&&<button type="button" className="primary-button" disabled={busy||blocked} onClick={()=>onResume(r,undefined,'synthesis')}>{r.topics?.some(topic=>topic.status!=='candidate')?'生成全部待处理主题':'完成本轮综合'}</button>}
   {canResume&&<button type="button" className={r.result_id?'secondary-button':'primary-button'} disabled={busy||blocked} title={blocked?'已有分析任务运行，完成后可继续':undefined} onClick={()=>onResume(r)}>{r.stage==='partial'?'继续综合':'继续处理'}</button>}
   {r.can_append&&<button type="button" className="secondary-button" disabled={busy||blocked} onClick={()=>onAppend(r)}>追加文献并综合</button>}
   {canResume&&blocked&&<small>已有分析任务运行，完成后可继续。</small>}
   {working&&<button type="button" className="text-button research-stop-button" disabled={busy} onClick={()=>onStop(r)}>停止任务</button>}
  </div>
  </div>
  <details className="research-execution-details"><summary>查看执行详情{p?.details.length?` · ${p.details.length} 个任务`:''}</summary>
   <ul className="research-task-rows">{(p?.details??r.tasks.map((id,index)=>({id,title:`任务 ${index+1}`,status:'unknown'}))).map(task=><li key={task.id}><span className={`research-task-dot task-${task.status}`}/><strong>{task.title}</strong><span>{statuses[task.status]??'状态待更新'}</span><a href={projectPath(projectId,'tasks',{focus:task.id})}>查看日志</a></li>)}</ul>
   {r.discovery_id&&<button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,r.discovery_id!)}>查看主题发现清单</button>}
   {r.append&&p?.phase!=='materials'&&<ul className="research-task-rows">{r.append.batches.map((batch,index)=><li key={index}><strong>追加材料 · 第 {index+1} 组 · {batch.source_ids.length} 篇</strong>{batch.output_id&&<button type="button" className="text-button" disabled={busy} onClick={()=>onResult(r,batch.output_id!)}>阅读材料</button>}{batch.task_id&&<a href={projectPath(projectId,'tasks',{focus:batch.task_id})}>查看日志</a>}</li>)}</ul>}
  </details>
  <details className="research-input-details"><summary>输入范围 · {r.source_ids.length} 篇论文 · {new Date(r.created_at).toLocaleString()}</summary>{r.instructions&&<p>关注点：{r.instructions}</p>}<ul>{sourceTitles.map((title,index)=><li key={r.source_ids[index]}>{title}</li>)}</ul></details>
 </section>;
}
