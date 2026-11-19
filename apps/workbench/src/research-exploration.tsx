import {ResearchRunCard,researchActive,type ResearchRun,type ResearchStageView,type ResearchTopic,type TopicStopAfter} from './research-run-card.js';
import {LiteratureDocumentDialog} from './literature-document-dialog.js';
import React,{useCallback,useEffect,useState} from 'react';
import type {Source,ResearchProject} from '@trash/protocol';
import {knowledgeDocumentId} from '@trash/protocol/browser';
import {api,uiError} from './api.js';
import {ModalLayer} from './modal-layer.js';
import {ChatMarkdown} from './chat-markdown.js';
import {orderTopicOverview} from './topic-overview-order.js';
import {ErrorNotice} from './error-notice.js';
import {projectPath} from './navigation.js';
import './research-exploration.css';

type ResearchMode='directions'|'research-map'|'comparison'|'background'|'topics';
const modes:Record<ResearchMode,string>={directions:'探索研究方向','research-map':'研究地图',comparison:'指定主题综合',background:'大背景',topics:'自动发现多个主题'};
const active=researchActive;
type Topic=ResearchTopic;
type Run=ResearchRun;
type Doc={id:string;path:string;text:string};
type TopicDraft={title:string;task_id:string;files:{path:string;text:string;hash:string}[];published:boolean};
type Candidate={id:string;title:string;question:string;complete:boolean};
type AppendPlan={token:string;added_ids:string[];rebuilt_ids:string[];reused_count:number;batch_count:number;total:number};
const stages:Record<string,string>={summarizing:'分组整理材料','materials-ready':'材料已就绪','discovery-ready':'主题已发现',generating:'组织研究内容',discovering:'发现并合并主题',previewing:'生成单主题试稿',topics:'分别综合主题',partial:'本轮结束，可继续处理',completed:'已完成',failed:'失败',interrupted:'已中断',cancelled:'已停止'};

function TopicStagePicker({value,onChange,disabled}:{value:TopicStopAfter;onChange:(next:TopicStopAfter)=>void;disabled:boolean}){
 return <div className="research-analysis-modes" role="group" aria-label="执行到哪个阶段">
  <strong>执行到</strong>
  {([['materials','整理材料'],['discovery','发现主题'],['synthesis','完成综合']] as const).map(([stage,label])=>
   <button key={stage} type="button" className={value===stage?'primary-button':'secondary-button'} aria-pressed={value===stage} disabled={disabled} onClick={()=>onChange(stage)}>{label}</button>
  )}
 </div>;
}

type DirectionMaterials={
 directory?:{id:string;hash:string};
 topics:{id:string;title:string;source_ids:string[];stale:boolean}[];
 sources:{id:string;title:string;status:'available'|'stale'|'missing-wiki'|'missing-source';extra:boolean}[];
 source_ids:string[];invalid_topic_ids:string[];available_sources:{id:string;title:string}[];
 research_area?:string;research_constraints?:string;token?:string;
};
const materialLabels={'available':'可用','stale':'Wiki 待更新','missing-wiki':'缺少论文 Wiki','missing-source':'论文已移除'};
export function ResearchExplorationButton({projectId,sources,questionId,onQuestionAdded,initialTopicId,initialQuestion,onOpenSettings,projectUpdatedAt}:{projectId:string;sources:Source[];questionId?:string;initialTopicId?:string;initialQuestion?:string;onOpenSettings?:()=>void;projectUpdatedAt?:string;onQuestionAdded?:(project:ResearchProject)=>void}){
 const [ready,setReady]=useState(false);
 const [stageViews,setStageViews]=useState<Record<string,ResearchStageView>>({});
 const [stopAfter,setStopAfter]=useState<TopicStopAfter>('synthesis');
 const [creating,setCreating]=useState(false),[focusedId,setFocusedId]=useState('');
 const [appendId,setAppendId]=useState(''),[additional,setAdditional]=useState<string[]>([]),[appendPlan,setAppendPlan]=useState<AppendPlan>();
 const [readingId,setReadingId]=useState<string>();
 const [preview,setPreview]=useState<{run:Run;topic:Topic;draft:TopicDraft}>(),[previewPage,setPreviewPage]=useState(0);
 const [open,setOpen]=useState(false),[mode,setMode]=useState<ResearchMode>('topics');
 const [runs,setRuns]=useState<Run[]>([]),[eligible,setEligible]=useState<string[]>([]),[chosen,setChosen]=useState<string[]>([]);
 const [topics,setTopics]=useState<{id:string;title:string;stale?:boolean}[]>([]),[topicIds,setTopicIds]=useState<string[]>([]);
 const [instructions,setInstructions]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[doc,setDoc]=useState<Doc>();
 const [candidates,setCandidates]=useState<Candidate[]>([]),[resultRun,setResultRun]=useState<string>(),[added,setAdded]=useState<string[]>([]);
 const base='/projects/'+encodeURIComponent(projectId);
 const [scopeRefresh,setScopeRefresh]=useState(0);
 const [byTopic,setByTopic]=useState(true),[extraSources,setExtraSources]=useState<string[]>([]);
 const [materialPreview,setMaterialPreview]=useState<{key:string;data:DirectionMaterials}>();
 const [materialError,setMaterialError]=useState<{key:string;message:string}>();
 const isDirection=mode==='directions'&&!questionId;
 const scopeQuery=new URLSearchParams([...topicIds.map(id=>['topic_id',id]),...extraSources.map(id=>['source_id',id])]).toString();
 const scope=materialPreview?.data;
 const useTopics=isDirection&&byTopic&&Boolean(scope?.topics.length||topicIds.length);
 const currentScope=materialPreview?.key===scopeQuery?scope:undefined;
 const focusPreview=useCallback((heading:HTMLHeadingElement|null)=>{heading?.focus();},[]);

 useEffect(()=>{
  if(!initialTopicId)return;
  setByTopic(true);setExtraSources([]);
  setMode('directions');setCreating(true);setOpen(true);
  setAppendId('');setFocusedId('');setTopicIds([initialTopicId]);setChosen([]);
  setInstructions(initialQuestion?.slice(0,5000)??'');setError('');
 },[base,initialTopicId,initialQuestion]);
 useEffect(()=>{if(!open)return;let alive=true,loading=false;const controller=new AbortController();
  const load=async()=>{if(!alive||loading||document.hidden)return;loading=true;try{const data=await api<{runs:Run[];capabilities?:{multi_topic?:boolean}}>(base+'/research-exploration',{signal:controller.signal});if(alive){setRuns(data.runs);setReady(Boolean(data.capabilities?.multi_topic));}}catch(e){if(alive)setError(uiError(e,'无法读取研究分析记录'));}finally{loading=false;}};
  void load();const timer=window.setInterval(()=>void load(),3000);
  void (async()=>{try{
   const ids:string[]=[],topicDocs:{id:string;title:string;stale?:boolean}[]=[];let page=1;
   while(true){const data=await api<{documents:{id:string;title:string;level?:string;stale?:boolean;path:string;source_id?:string;topic_id?:string}[];total:number}>(base+'/markdown-knowledge?limit=100&page='+page,{signal:controller.signal});if(!alive)return;
    for(const d of data.documents){if(d.path.endsWith('/whoami.md')&&d.source_id&&!d.stale)ids.push(d.source_id);else if((!d.topic_id||d.id===d.topic_id)&&['topic','hypothesis','overview','discovery'].includes(d.level??''))topicDocs.push(d);}
    if(page++*100>=data.total)break;
   }
   if(!alive)return;
   setEligible(ids);setTopics(topicDocs);
  }catch(e){if(alive)setError(uiError(e,'无法读取论文 Wiki'));}})();
  return()=>{alive=false;controller.abort();window.clearInterval(timer);};
 },[open,base,initialTopicId,initialQuestion]);
 useEffect(()=>{
  if(!open||mode!=='directions')return;
  const controller=new AbortController();
  void api<DirectionMaterials>(base+'/research-exploration/direction-materials?'+scopeQuery,{signal:controller.signal})
   .then(data=>{if(!controller.signal.aborted){setMaterialPreview({key:scopeQuery,data});setMaterialError(undefined);}})
   .catch(cause=>{if(!controller.signal.aborted)setMaterialError({key:scopeQuery,message:uiError(cause,'无法读取方向探索材料。')});});
  return()=>controller.abort();
 },[open,mode,base,scopeQuery,projectUpdatedAt,scopeRefresh]);
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();setRuns((await api<{runs:Run[]}>(base+'/research-exploration')).runs);}catch(e){if(e instanceof Error&&e.message==='DIRECTION_SCOPE_CHANGED'){setMaterialPreview(undefined);setScopeRefresh(value=>value+1);}setError(uiError(e,'研究分析操作失败，请查看任务或研究领域配置。'));}finally{setBusy(false);}};
 const openFor=(value:ResearchMode)=>{setByTopic(true);setExtraSources([]);setTopicIds([]);setChosen([]);setInstructions('');setMaterialPreview(undefined);setMaterialError(undefined);setMode(value);setCreating(value==='directions');setAppendId('');setFocusedId('');setDoc(undefined);setPreview(undefined);setCandidates([]);setError('');setOpen(true);};
 const start=()=>run(async()=>{const data=await api<{run:Run}>(base+'/research-exploration',{method:'POST',body:JSON.stringify({source_ids:useTopics?extraSources:chosen,topic_token:useTopics?currentScope?.token:undefined,instructions,question_id:questionId,mode:questionId?'directions':mode,topic_ids:topicIds,stop_after:mode==='topics'&&!questionId?stopAfter:undefined})});setFocusedId(data.run.id);setCreating(false);});
 const resume=(r:Run,topic?:Topic,nextStage?:TopicStopAfter)=>run(()=>api(base+'/research-exploration/'+r.id+'/resume',{method:'POST',body:JSON.stringify({confirm:true,topic_id:topic?.id,stop_after:nextStage})}));
 const rediscover=(r:Run)=>{if(!window.confirm('复用已整理材料重新发现主题？不会重新分析论文或 PDF。'))return;void run(async()=>{const data=await api<{run:Run}>(base+'/research-exploration/'+r.id+'/rediscover',{method:'POST',body:JSON.stringify({confirm:true})});setFocusedId(data.run.id);setCreating(false);});};
 const showResult=(r:Run,id:string,withCandidates=false)=>run(async()=>{if(['topics','comparison'].includes(r.mode??'')){setReadingId(id);return;}setDoc((await api<{document:Doc}>(base+'/markdown-knowledge/document?id='+encodeURIComponent(id))).document);setResultRun(r.id);setCandidates(withCandidates?(await api<{candidates:Candidate[]}>(base+'/research-exploration/'+r.id+'/candidates')).candidates:[]);});
 const title=questionId?'定向补证据':['topics','comparison'].includes(mode)?'主题综合':modes[mode];
 const available=sources.filter(s=>eligible.includes(s.source_id));
 const hasActive=runs.some(r=>active(r.stage));
 const matching=runs.filter(r=>questionId?r.question_id===questionId:!r.question_id&&(['topics','comparison'].includes(mode)?['topics','comparison'].includes(r.mode??''):r.mode===mode));
 const featured=matching.find(r=>active(r.stage))??matching.find(r=>r.id===focusedId)??matching[0];
 const showForm=creating||(!featured&&ready);
 const history=matching.filter(r=>r.id!==featured?.id);
 const appendBase=runs.find(r=>r.id===appendId);
 const appendAvailable=appendBase?available.filter(source=>!appendBase.source_ids.includes(source.source_id)):[];
 const appendLimit=100-(appendBase?.source_ids.length??100);
 const appendBulkCount=Math.min(appendAvailable.length,appendLimit);
 const changeAdditional=(update:React.SetStateAction<string[]>)=>{
  setAdditional(update);setAppendPlan(undefined);setError('');
 };
 const sourceTitle=(id:string)=>sources.find(source=>source.source_id===id)?.title??'来源已移除';
 const openAppend=(r:Run)=>{setFocusedId(r.id);setCreating(false);setAppendId(r.id);setAdditional([]);setAppendPlan(undefined);setError('');};
 const previewAppend=async()=>{
  setBusy(true);setAppendPlan(undefined);setError('');
  try{
   const data=await api<{plan:AppendPlan}>(base+'/research-exploration/'+appendId+'/append-preview',{method:'POST',body:JSON.stringify({source_ids:additional})});
   setAppendPlan(data.plan);
  }catch(e){setError(uiError(e,'无法核对追加范围，请稍后重试。'));}finally{setBusy(false);}
 };
 const submitAppend=()=>run(async()=>{
  if(!appendPlan)return;
  const data=await api<{run:Run}>(base+'/research-exploration/'+appendId+'/append',{method:'POST',body:JSON.stringify({source_ids:appendPlan.added_ids,token:appendPlan.token,stop_after:stopAfter})});
  setFocusedId(data.run.id);setAppendId('');setCreating(false);
 });
 const result=(r:Run,id:string,withCandidates=false)=>void showResult(r,id,withCandidates);
 const stop=(r:Run)=>{if(!window.confirm('停止当前任务？已完成内容和草稿会保留，可稍后继续。'))return;void run(()=>api(base+'/research-exploration/'+r.id+'/cancel',{method:'POST',body:JSON.stringify({confirm:true})}));};
 const selectStage=(r:Run,view:ResearchStageView)=>setStageViews(views=>({...views,[r.id]:view}));
 const previewPath=(r:Run,topic:Topic)=>base+'/research-exploration/'+r.id+'/topics/'+topic.id;
 const generatePreview=(r:Run,topic:Topic)=>void run(async()=>{
  if(topic.preview_status==='completed'&&!window.confirm('重新生成试稿？新试稿将替换本轮的预览入口。'))return;
  await api(previewPath(r,topic)+'/preview',{method:'POST',body:'{}'});
  setPreview(undefined);setFocusedId(r.id);
  selectStage(r,'discovery');
 });
 const openPreview=(r:Run,topic:Topic)=>void run(async()=>{
  const {draft}=await api<{draft:TopicDraft}>(previewPath(r,topic)+'/preview');
  selectStage(r,'discovery');
  setPreviewPage(0);setPreview({run:r,topic,draft});
 });
 const publishPreview=()=>void run(async()=>{
  if(!preview)return;
  await api(previewPath(preview.run,preview.topic)+'/publish',{method:'POST',body:JSON.stringify({task_id:preview.draft.task_id,confirm:true})});
  setFocusedId(preview.run.id);setPreview(undefined);
 });
 const setRunStop=(r:Run,stop_after:TopicStopAfter)=>void run(()=>api(base+'/research-exploration/'+r.id+'/stop-after',{method:'POST',body:JSON.stringify({stop_after})}));
 const previewFile=preview?.draft.files[previewPage];
 const previewText=previewFile?.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')??'';
 const previewPanel=preview&&(<section className="research-create-form" aria-label="单主题试稿">
     <header><h3 ref={focusPreview} tabIndex={-1}>{preview.draft.title} · 试稿</h3><button type="button" className="text-button" disabled={busy} onClick={()=>setPreview(undefined)}>关闭试稿</button></header>
     <div className="research-analysis-modes" role="group" aria-label="试稿页面">{preview.draft.files.map((file,index)=><button key={file.path} type="button" className={index===previewPage?'primary-button':'secondary-button'} aria-pressed={index===previewPage} onClick={()=>setPreviewPage(index)}>{file.path.endsWith('--methods.md')?'方法与条件':file.path.endsWith('--results.md')?'结果与分歧':file.path.endsWith('--insights.md')?'可复用认识':'主题总览'}</button>)}</div>
     <article className="research-result"><ChatMarkdown text={previewFile&&!/--(?:methods|results|insights)\.md$/.test(previewFile.path)?orderTopicOverview(previewText):previewText}/></article>
     {!preview.draft.published&&<div className="research-create-footer">
      <button type="button" className="primary-button" disabled={busy||hasActive||runs.some(item=>item.id===preview.run.id&&item.superseded)} onClick={publishPreview}>确认发布主题</button>
     </div>}
    </section>);
 const card=(r:Run)=><ResearchRunCard key={r.id}
  run={r} projectId={projectId} busy={busy} blocked={hasActive}
  view={stageViews[r.id]} onView={view=>selectStage(r,view)}
  preview={preview?.run.id===r.id?previewPanel:undefined}
  onResult={result} onResume={(item,topic,nextStage)=>{
   setFocusedId(item.id);setAppendId('');setCreating(false);
   if(nextStage)selectStage(item,nextStage==='discovery'?'discovery':'synthesis');
   void resume(item,topic,nextStage);
  }}
  onRediscover={rediscover} onAppend={openAppend} onStop={stop}
  onGeneratePreview={generatePreview} onPreview={openPreview}
  onSetStop={setRunStop} sourceTitles={r.source_ids.map(sourceTitle)}/>;
 const resultText=doc?.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')??'';
 const recommendation=candidates.length?resultText.match(/^## 推荐与取舍[ \t]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m)?.[0]:undefined;
 return <>
  {!questionId&&<><button type="button" className="secondary-button" onClick={()=>openFor('research-map')}>研究地图</button><button type="button" className="secondary-button" onClick={()=>openFor('background')}>大背景</button><button type="button" className="secondary-button" onClick={()=>openFor('topics')}>主题综合</button></>}
  <button type="button" className="secondary-button" onClick={()=>openFor('directions')}>{questionId?'定向补证据':'探索研究方向'}</button>
  {open&&<ModalLayer><div className="modal-backdrop"><section className="modal research-analysis-modal" role="dialog" aria-modal="true" aria-label={title}>
   <div className="modal-heading"><div><h2>{title}</h2><small>从论文 Wiki 到有依据的跨论文认识</small></div><div className="research-heading-actions">{!showForm&&!appendBase&&<button type="button" className="text-button" disabled={busy||hasActive} title={hasActive?'当前分析结束后可新建':undefined} onClick={()=>setCreating(true)}>{mode==='directions'?'新建探索':'新建综合'}</button>}{hasActive&&!showForm&&<small>当前任务结束后可新建</small>}<button type="button" className="secondary-button" disabled={busy} onClick={()=>setOpen(false)}>关闭</button></div></div>
   <div className="research-analysis-body">
    {!ready&&<p role="status">正在读取任务状态…</p>}
    {!showForm&&!appendBase&&featured&&card(featured)}
    {appendBase&&<section className="research-create-form" aria-label="追加文献并综合">
     <header><h3>追加文献并综合</h3><button type="button" className="text-button" disabled={busy} onClick={()=>{setAppendId('');setError('');}}>返回任务</button></header>
     <p>已纳入 {appendBase.source_ids.length} 篇。新增论文先整理为独立材料分组，再与已有主题和相关材料对照。</p>
     <div className="research-selection-actions">
      <strong>已选 {additional.length} 篇 · 最多可追加 {appendLimit} 篇</strong>
      <button type="button" className="text-button" disabled={busy||hasActive||additional.length>=appendBulkCount} onClick={()=>changeAdditional(ids=>[
       ...ids,...appendAvailable.filter(source=>!ids.includes(source.source_id)).slice(0,appendBulkCount-ids.length).map(source=>source.source_id),
      ])}>{appendAvailable.length>appendLimit&&appendLimit>0?`选满 ${appendLimit} 篇`:'全选可追加文献'}</button>
      <button type="button" className="text-button" disabled={busy||hasActive||!additional.length} onClick={()=>changeAdditional([])}>清空</button>
     </div>
     <div className="research-source-list">{appendAvailable.map(source=><label key={source.source_id}><input type="checkbox" checked={additional.includes(source.source_id)} disabled={busy||hasActive||(additional.length>=appendLimit&&!additional.includes(source.source_id))} onChange={event=>{const checked=event.target.checked;changeAdditional(ids=>checked?[...ids,source.source_id]:ids.filter(id=>id!==source.source_id));}}/><span>{source.title}</span></label>)}
      {!appendAvailable.length&&<p>暂无可追加的全文 Wiki。</p>}
     </div>
     <TopicStagePicker value={stopAfter} onChange={setStopAfter} disabled={busy||hasActive}/>
    {appendPlan&&<div className="research-run-notice" role="status">
      <strong>复用 {appendPlan.reused_count} 篇 · 整理新增 {appendPlan.added_ids.length} 篇{appendPlan.rebuilt_ids.length>0&&` · 重整旧材料 ${appendPlan.rebuilt_ids.length} 篇`}</strong>
      <p>本轮计划生成 {appendPlan.batch_count} 组材料，综合范围共 {appendPlan.total} 篇。</p>
      {appendPlan.rebuilt_ids.length>0&&<details><summary>查看需要重整的论文</summary><p>有旧分组缺失或版本变化，以下论文涉及这些分组。</p><ul>{appendPlan.rebuilt_ids.map(id=><li key={id}>{sourceTitle(id)}</li>)}</ul></details>}
     </div>}
     <div className="research-create-footer">
      <button type="button" className={appendPlan?'secondary-button':'primary-button'} disabled={busy||hasActive||!additional.length} onClick={()=>void previewAppend()}>{appendPlan?'重新预览':'预览追加范围'}</button>
      {appendPlan&&<button type="button" className="primary-button" disabled={busy||hasActive} onClick={()=>void submitAppend()}>开始追加综合</button>}
     </div>
    </section>}
    {showForm&&<section className="research-create-form"><header><h3>新建{title}</h3>{featured&&<button type="button" className="text-button" disabled={busy} onClick={()=>setCreating(false)}>返回任务</button>}</header>
    {!questionId&&['topics','comparison'].includes(mode)&&<div className="research-analysis-modes" role="group" aria-label="主题综合方式">{(['topics','comparison'] as const).map(value=><button type="button" key={value} className={mode===value?'primary-button':'secondary-button'} aria-pressed={mode===value} disabled={busy} onClick={()=>setMode(value)}>{modes[value]}</button>)}</div>}
    <p>{questionId?'针对当前问题整理已有支持、反例和定向补证据计划。':mode==='directions'?'结合项目研究条件提出候选假设、方法差异和推荐取舍，由你选择方向。':mode==='research-map'?'组织论文中的问题、路线和关系，形成可跳转的研究地图。':mode==='background'?'围绕需求、困难、已有进展和共同矛盾，生成可独立引用和组合的分点大背景。':mode==='comparison'?'围绕你指定的问题，深入比较相关方法、条件、认识和反例。':'从所选论文中发现并合并多个主题，为支撑充分的主题分别生成 Wiki 组，证据不足的保留为候选线索。可在发现后停下来选择要综合的主题。'}</p>
    <small>使用已发布 Wiki，按需读取原始依据；不重新分析 PDF 或执行实验。</small>
    {isDirection&&scope?.topics.length? <div className="research-analysis-modes" role="group" aria-label="探索材料来源">
      <button type="button" className={byTopic?'primary-button':'secondary-button'} onClick={()=>setByTopic(true)} disabled={busy} aria-pressed={byTopic}>按主题探索</button>
      <button type="button" className={!byTopic?'primary-button':'secondary-button'} onClick={()=>{setByTopic(false);setTopicIds([]);setExtraSources([]);}} disabled={busy} aria-pressed={!byTopic}>按论文探索</button>
    </div>:null}
    {isDirection&&byTopic&&!scope&&!materialError&&<p role="status">正在读取本轮已发布主题…</p>}
    {useTopics&&<section className="research-run" aria-label="本轮主题">
      <div className="research-selection-actions"><strong>本轮主题 · 已选 {topicIds.length} / {scope?.topics.length??0}</strong>
        <button type="button" className="text-button" disabled={busy||!scope?.topics.length} onClick={()=>setTopicIds(scope?.topics.map(topic=>topic.id)??[])}>全选本轮主题</button>
        <button type="button" className="text-button" disabled={busy||!topicIds.length} onClick={()=>setTopicIds([])}>清空</button>
      </div>
      <div className="research-source-list">{scope?.topics.map(topic=><label key={topic.id}>
        <input type="checkbox" checked={topicIds.includes(topic.id)} disabled={busy} onChange={event=>setTopicIds(ids=>event.target.checked?[...ids,topic.id]:ids.filter(id=>id!==topic.id))}/>
        <span>{topic.title} · {topic.source_ids.length} 篇{topic.stale?' · 来源待更新':''}</span>
      </label>)}</div>
      {!!currentScope?.invalid_topic_ids.length&&<ErrorNotice>有选中的主题已不在当前目录。请重新选择，或点击「全选本轮主题」。</ErrorNotice>}
      <details><summary>关联论文{currentScope?` · ${currentScope.source_ids.length} 篇可用`:' · 正在核对'}</summary>
        <ul>{currentScope?.sources.map(source=><li key={source.id}>{source.title} · {materialLabels[source.status]}{source.extra?' · 手动补充':''}</li>)}</ul>
        <details><summary>补充对照论文</summary><div className="research-source-list">{scope?.available_sources
          .filter(source=>!currentScope?.sources.some(item=>item.id===source.id&&!item.extra))
          .map(source=><label key={source.id}><input type="checkbox" disabled={busy||extraSources.length>=100&&!extraSources.includes(source.id)} checked={extraSources.includes(source.id)}
            onChange={event=>setExtraSources(ids=>event.target.checked?[...ids,source.id]:ids.filter(id=>id!==source.id))}/><span>{source.title}</span></label>)}</div></details>
      </details>
    </section>}
    {isDirection&&byTopic&&scope&&!scope.topics.length&&<p>当前目录暂无已发布主题，可以先按论文探索。</p>}
    {(!isDirection||!byTopic||scope&&!scope.topics.length&&!topicIds.length)&&<>
    <div className="research-selection-actions"><strong>论文范围 · 已选 {chosen.length} 篇</strong><button type="button" className="text-button" disabled={busy} onClick={()=>{if(available.length>100){setError('单次最多100篇，请分批选择。');return;}setChosen(available.map(s=>s.source_id));}}>全选可用论文</button><button type="button" className="text-button" disabled={busy} onClick={()=>setChosen([])}>清空</button></div>
    <div className="research-source-list">{available.map(s=><label key={s.source_id}><input type="checkbox" checked={chosen.includes(s.source_id)} disabled={busy||chosen.length>=100&&!chosen.includes(s.source_id)} onChange={e=>setChosen(ids=>e.target.checked?[...ids,s.source_id]:ids.filter(id=>id!==s.source_id))}/><span>{s.title}</span></label>)}{!available.length&&<p>暂无可用全文 Wiki，请先完成单篇分析。</p>}</div>
    {topics.length>0&&<details><summary>参考已有知识（已选 {topicIds.length} 项）</summary><div className="research-source-list">{topics.map(t=><label key={t.id}><input type="checkbox" disabled={busy||topicIds.length>=30&&!topicIds.includes(t.id)} checked={topicIds.includes(t.id)} onChange={e=>setTopicIds(ids=>e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/><span>{t.title}{t.stale?' · 来源有变化':''}</span></label>)}</div></details>}
    </>}
    {mode==='directions'&&scope&&<div className="research-run">
      <strong>研究条件</strong>
      <p>{scope.research_area?`研究领域 · ${scope.research_area}`:'请先在项目设置填写研究领域。'}</p>
      {scope.research_constraints?<details><summary>查看项目研究约束</summary><p style={{whiteSpace:'pre-wrap'}}>{scope.research_constraints}</p></details>:<small>项目尚未填写代码、数据、算力或时间等研究约束，可在下方补充。</small>}
      {onOpenSettings&&<button type="button" className="text-button" disabled={busy} onClick={onOpenSettings}>打开项目设置</button>}
    </div>}
    {materialError?.key===scopeQuery&&mode==='directions'&&<ErrorNotice>{materialError.message}</ErrorNotice>}
    <label>{mode==='comparison'?'指定主题或比较问题（必填）':'补充关注点（可选）'}<textarea maxLength={5000} value={instructions} onChange={e=>setInstructions(e.target.value)}/></label>
    {!questionId&&mode==='topics'&&<TopicStagePicker value={stopAfter} onChange={setStopAfter} disabled={busy||hasActive}/>}
    <div className="research-create-footer">
      <button type="button" className="primary-button" disabled={!ready||busy||hasActive||
        mode==='directions'&&!currentScope?.research_area||
        (useTopics?!currentScope?.token||!currentScope.source_ids.length||currentScope.source_ids.length>100:!chosen.length)||
        mode==='comparison'&&!instructions.trim()} onClick={()=>void start()}>
        {busy?'正在创建任务…':useTopics?`开始探索方向 · ${topicIds.length} 个主题`:`开始${title} · ${chosen.length} 篇论文`}
      </button>
      <small>{hasActive?'已有分析任务运行，结束后可新建。':mode==='directions'&&scope&&!scope.research_area?'填写研究领域后即可启动。':
        useTopics?(currentScope&&currentScope.source_ids.length>100?'关联论文超过 100 篇，请分批选择。':!topicIds.length?'请先选择主题。':currentScope&&!currentScope.source_ids.length?'暂无可用论文 Wiki，请补充或更新材料。':'启动后将自动切换到任务进度。'):
        !chosen.length?'请先选择论文。':mode==='comparison'&&!instructions.trim()?'请填写要比较的具体问题。':'启动后将自动切换到任务进度。'}</small>
    </div></section>}
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {!appendBase&&history.length>0&&<details className="research-history"><summary>历史记录 · {history.length}</summary>{history.map(r=><details className="research-history-row" key={r.id}><summary><span className={`research-state state-${r.stage}`}>{stages[r.stage]??r.stage}</span><strong>{r.direction_scope?`${r.direction_scope.topics.length} 个主题 · `:''}{r.source_ids.length} 篇 · {r.append?'追加文献':modes[r.mode??'directions']}</strong><time>{new Date(r.created_at).toLocaleString()}</time></summary><div className="research-history-actions">{r.result_id&&<button type="button" className="text-button" disabled={busy} onClick={()=>result(r,r.result_id!,r.mode!=='topics')}>{r.mode==='topics'?'打开主题目录':'查看结果'}</button>}<button type="button" className="text-button" onClick={()=>{setFocusedId(r.id);setCreating(false);}}>置顶查看</button></div>{card(r)}</details>)}</details>}
    {recommendation&&<article className="research-result"><ChatMarkdown text={recommendation}/></article>}
    {candidates.map(candidate=><div className="research-run" key={candidate.id}><strong>{candidate.title}</strong><p>{candidate.question}</p><button type="button" className="secondary-button" disabled={busy||!candidate.complete||added.includes(candidate.id)} onClick={()=>void run(async()=>{const current=await api<{project:ResearchProject}>(base+'/research-questions');const saved=await api<{project:ResearchProject}>(base+'/research-questions',{method:'POST',body:JSON.stringify({title:candidate.title,question:candidate.question,status:'candidate',rationale:'由文献探索提出，尚需补充检索与验证',expected_updated_at:current.project.updated_at,source_run_id:resultRun,source_candidate_id:candidate.id})});onQuestionAdded?.(saved.project);setAdded(ids=>[...ids,candidate.id]);})}>{added.includes(candidate.id)?'已加入候选问题':candidate.complete?'加入候选问题':'结构或依据不完整，暂不能加入'}</button></div>)}
    {doc&&<article className="research-result" onClick={event=>{const a=(event.target as HTMLElement).closest('a');if(!a)return;const href=a.getAttribute('href')??'';if(href.startsWith('./')||href.startsWith('../')){const path=new URL(href,'https://local/'+doc.path).pathname.slice(1),id=knowledgeDocumentId(path);if(id){event.preventDefault();window.location.href=projectPath(projectId,'wiki',{focus:id});}}}}><ChatMarkdown text={recommendation?resultText.replace(recommendation,''):resultText} allowRelativeLinks/></article>}
   </div>
  </section></div></ModalLayer>}
 {readingId&&<LiteratureDocumentDialog key={readingId} projectId={projectId} initialId={readingId} onClose={()=>setReadingId(undefined)} onSaved={()=>{}}/>}
 </>;
}
