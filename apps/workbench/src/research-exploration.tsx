import {LiteratureDocumentDialog} from './literature-document-dialog.js';
import React,{useEffect,useState} from 'react';
import type {Source,ResearchProject} from '@trash/protocol';
import {knowledgeDocumentId} from '@trash/protocol/browser';
import {api,uiError} from './api.js';
import {ModalLayer} from './modal-layer.js';
import {ChatMarkdown} from './chat-markdown.js';
import {ErrorNotice} from './error-notice.js';
import {projectPath} from './navigation.js';
import './research-exploration.css';

type ResearchMode='directions'|'research-map'|'comparison'|'background'|'topics';
const modes:Record<ResearchMode,string>={directions:'探索研究方向','research-map':'研究地图',comparison:'指定主题综合',background:'大背景',topics:'自动发现多个主题'};
const active=(stage:string)=>['summarizing','generating','discovering','topics'].includes(stage);
type Topic={id:string;title:string;status:'candidate'|'pending'|'generating'|'completed'|'failed';task_id?:string;output_id?:string;error?:string};
type Run={mode?:ResearchMode;question_id?:string;id:string;stage:string;tasks:string[];source_ids:string[];result_id?:string;discovery_id?:string;topics?:Topic[];error?:string;created_at:string};
type Doc={id:string;path:string;text:string};
type Candidate={id:string;title:string;question:string;complete:boolean};
const stages:Record<string,string>={summarizing:'分组整理材料',generating:'组织研究内容',discovering:'发现并合并主题',topics:'分别综合主题',partial:'本轮结束，可继续处理',completed:'已完成',failed:'失败',interrupted:'已中断',cancelled:'已停止'};
const topicStages:Record<Topic['status'],string>={candidate:'候选线索',pending:'待展开',generating:'生成中',completed:'已完成',failed:'失败'};

export function ResearchExplorationButton({projectId,sources,questionId,onQuestionAdded}:{projectId:string;sources:Source[];questionId?:string;onQuestionAdded?:(project:ResearchProject)=>void}){
 const [ready,setReady]=useState(false);
 const [readingId,setReadingId]=useState<string>();
 const [open,setOpen]=useState(false),[mode,setMode]=useState<ResearchMode>('topics');
 const [runs,setRuns]=useState<Run[]>([]),[eligible,setEligible]=useState<string[]>([]),[chosen,setChosen]=useState<string[]>([]);
 const [topics,setTopics]=useState<{id:string;title:string;stale?:boolean}[]>([]),[topicIds,setTopicIds]=useState<string[]>([]);
 const [instructions,setInstructions]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[doc,setDoc]=useState<Doc>();
 const [candidates,setCandidates]=useState<Candidate[]>([]),[resultRun,setResultRun]=useState<string>(),[added,setAdded]=useState<string[]>([]);
 const base='/projects/'+encodeURIComponent(projectId);
 useEffect(()=>{if(!open)return;let alive=true;
  const load=async()=>{try{const data=await api<{runs:Run[];capabilities?:{multi_topic?:boolean}}>(base+'/research-exploration');if(alive){setRuns(data.runs);setReady(Boolean(data.capabilities?.multi_topic));}}catch(e){if(alive)setError(uiError(e,'无法读取研究分析记录'));}};
  void load();const timer=window.setInterval(()=>void load(),3000);
  void (async()=>{try{
   const ids:string[]=[],topicDocs:{id:string;title:string;stale?:boolean}[]=[];let page=1;
   while(true){const data=await api<{documents:{id:string;title:string;level?:string;stale?:boolean;path:string;source_id?:string;topic_id?:string}[];total:number}>(base+'/markdown-knowledge?limit=100&page='+page);
    for(const d of data.documents){if(d.path.endsWith('/whoami.md')&&d.source_id&&!d.stale)ids.push(d.source_id);else if((!d.topic_id||d.id===d.topic_id)&&['topic','hypothesis','overview','discovery'].includes(d.level??''))topicDocs.push(d);}
    if(page++*100>=data.total)break;
   }
   if(alive){setEligible(ids);setTopics(topicDocs);}
  }catch(e){if(alive)setError(uiError(e,'无法读取论文 Wiki'));}})();
  return()=>{alive=false;window.clearInterval(timer);};
 },[open,base]);
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();setRuns((await api<{runs:Run[]}>(base+'/research-exploration')).runs);}catch(e){setError(uiError(e,'研究分析操作失败，请查看任务或研究领域配置。'));}finally{setBusy(false);}};
 const openFor=(value:ResearchMode)=>{setMode(value);setDoc(undefined);setCandidates([]);setError('');setOpen(true);};
 const start=()=>run(()=>api(base+'/research-exploration',{method:'POST',body:JSON.stringify({source_ids:chosen,instructions,question_id:questionId,mode:questionId?'directions':mode,topic_ids:topicIds})}));
 const resume=(r:Run,topic?:Topic)=>run(()=>api(base+'/research-exploration/'+r.id+'/resume',{method:'POST',body:JSON.stringify({confirm:true,...(topic?{topic_id:topic.id}:{})})}));
 const showResult=(r:Run,id:string,withCandidates=false)=>run(async()=>{if(['topics','comparison'].includes(r.mode??'')){setReadingId(id);return;}setDoc((await api<{document:Doc}>(base+'/markdown-knowledge/document?id='+encodeURIComponent(id))).document);setResultRun(r.id);setCandidates(withCandidates?(await api<{candidates:Candidate[]}>(base+'/research-exploration/'+r.id+'/candidates')).candidates:[]);});
 const title=questionId?'定向补证据':['topics','comparison'].includes(mode)?'主题综合':modes[mode];
 const available=sources.filter(s=>eligible.includes(s.source_id));
 const hasActive=runs.some(r=>active(r.stage));
 return <>
  {!questionId&&<><button type="button" className="secondary-button" onClick={()=>openFor('research-map')}>研究地图</button><button type="button" className="secondary-button" onClick={()=>openFor('background')}>大背景</button><button type="button" className="secondary-button" onClick={()=>openFor('topics')}>主题综合</button></>}
  <button type="button" className="secondary-button" onClick={()=>openFor('directions')}>{questionId?'定向补证据':'探索研究方向'}</button>
  {open&&<ModalLayer><div className="modal-backdrop"><section className="modal research-analysis-modal" role="dialog" aria-modal="true" aria-label={title}>
   <div className="modal-heading"><h2>{title}</h2><button type="button" className="secondary-button" disabled={busy} onClick={()=>setOpen(false)}>关闭</button></div>
   <div className="research-analysis-body">
    {!ready&&<p role="status">正在确认新版研究功能是否可用。若后台尚未更新，需要在当前任务结束后重启服务才能启用。</p>}
    {!questionId&&['topics','comparison'].includes(mode)&&<div className="research-analysis-modes" role="group" aria-label="主题综合方式">{(['topics','comparison'] as const).map(value=><button type="button" key={value} className={mode===value?'primary-button':'secondary-button'} aria-pressed={mode===value} disabled={busy} onClick={()=>setMode(value)}>{modes[value]}</button>)}</div>}
    <p>{questionId?'针对当前问题整理已有支持、反例和定向补证据计划。':mode==='directions'?'结合项目研究条件提出候选假设、方法差异和推荐取舍，由你选择方向。':mode==='research-map'?'组织论文中的问题、路线和关系，形成可跳转的研究地图。':mode==='background'?'围绕需求、困难、已有进展和共同矛盾，生成可独立引用和组合的分点大背景。':mode==='comparison'?'围绕你指定的问题，深入比较相关方法、条件、认识和反例。':'从所选论文中发现并合并多个主题，为支撑充分的主题分别生成 Wiki 组，证据不足的保留为候选线索。每轮最多展开8个，剩余项可继续。'}</p>
    <small>仅使用已有 Wiki，按需深入，不重新分析 PDF 或执行实验。研究条件可在项目配置中保存；方向探索需填写研究领域。相同材料和要求优先复用结果，单篇完成不会自动启动本流程。</small>
    <div className="research-selection-actions"><strong>论文范围 · 已选 {chosen.length} 篇</strong><button type="button" className="text-button" disabled={busy} onClick={()=>{if(available.length>100){setError('单次最多100篇，请分批选择。');return;}setChosen(available.map(s=>s.source_id));}}>全选可用论文</button><button type="button" className="text-button" disabled={busy} onClick={()=>setChosen([])}>清空</button></div>
    <div className="research-source-list">{available.map(s=><label key={s.source_id}><input type="checkbox" checked={chosen.includes(s.source_id)} disabled={busy||chosen.length>=100&&!chosen.includes(s.source_id)} onChange={e=>setChosen(ids=>e.target.checked?[...ids,s.source_id]:ids.filter(id=>id!==s.source_id))}/><span>{s.title}</span></label>)}{!available.length&&<p>暂无可用全文 Wiki，请先完成单篇分析。</p>}</div>
    {topics.length>0&&<details><summary>参考已有知识（已选 {topicIds.length} 项）</summary><div className="research-source-list">{topics.map(t=><label key={t.id}><input type="checkbox" disabled={busy||topicIds.length>=30&&!topicIds.includes(t.id)} checked={topicIds.includes(t.id)} onChange={e=>setTopicIds(ids=>e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/><span>{t.title}{t.stale?' · 来源有变化':''}</span></label>)}</div></details>}
    <label>{mode==='comparison'?'指定主题或比较问题（必填）':'补充关注点（可选）'}<textarea maxLength={5000} value={instructions} onChange={e=>setInstructions(e.target.value)}/></label>
    <button type="button" className="primary-button" disabled={!ready||busy||!chosen.length||hasActive||mode==='comparison'&&!instructions.trim()} onClick={()=>void start()}>开始{title} · {chosen.length} 篇论文</button>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    <h3>研究分析记录</h3>
    {runs.map(r=><section className="research-run" key={r.id}>
     <div className="research-run-heading"><strong>{r.question_id?'定向补证据':modes[r.mode??'directions']}</strong><span>{stages[r.stage]??r.stage} · {r.source_ids.length} 篇</span></div><small>{new Date(r.created_at).toLocaleString()}</small>
     {r.error&&<p>{r.error}</p>}
     {r.topics&&<p>已完成 {r.topics.filter(t=>t.status==='completed').length} · 待展开 {r.topics.filter(t=>t.status==='pending').length} · 生成中 {r.topics.filter(t=>t.status==='generating').length} · 失败 {r.topics.filter(t=>t.status==='failed').length} · 候选 {r.topics.filter(t=>t.status==='candidate').length}</p>}
     <div className="research-run-actions">{r.tasks.map(id=><a key={id} href={projectPath(projectId,'tasks',{focus:id})}>查看任务进展</a>)}
      {r.discovery_id&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void showResult(r,r.discovery_id!)}>发现清单</button>}
      {r.result_id&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void showResult(r,r.result_id!,r.mode!=='topics')}>{r.mode==='topics'?'主题目录':'查看结果'}</button>}
      {['partial','failed','interrupted','cancelled'].includes(r.stage)&&<button type="button" className="secondary-button" disabled={busy||hasActive} onClick={()=>void resume(r)}>{r.mode==='topics'?'继续待展开与失败主题':'继续处理'}</button>}
      {active(r.stage)&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(()=>api(base+'/research-exploration/'+r.id+'/cancel',{method:'POST',body:JSON.stringify({confirm:true})}))}>停止，保留已有内容</button>}
     </div>
     {r.topics&&<details><summary>主题处理明细</summary><ul className="research-topic-list">{r.topics.map(t=><li key={t.id}><div><strong>{t.title}</strong><small>{topicStages[t.status]}</small></div>{t.error&&<p>{t.error}</p>}{t.output_id&&<button type="button" className="text-button" disabled={busy} onClick={()=>void showResult(r,t.output_id!)}>阅读主题组</button>}{['pending','failed'].includes(t.status)&&!active(r.stage)&&<button type="button" className="text-button" disabled={busy||hasActive} onClick={()=>void resume(r,t)}>{t.status==='failed'?'仅重试此主题':'展开此主题'}</button>}</li>)}</ul></details>}
    </section>)}
    {candidates.map(candidate=><div className="research-run" key={candidate.id}><strong>{candidate.title}</strong><p>{candidate.question}</p><button type="button" className="secondary-button" disabled={busy||!candidate.complete||added.includes(candidate.id)} onClick={()=>void run(async()=>{const current=await api<{project:ResearchProject}>(base+'/research-questions');const saved=await api<{project:ResearchProject}>(base+'/research-questions',{method:'POST',body:JSON.stringify({title:candidate.title,question:candidate.question,status:'candidate',rationale:'由文献探索提出，尚需补充检索与验证',expected_updated_at:current.project.updated_at,source_run_id:resultRun,source_candidate_id:candidate.id})});onQuestionAdded?.(saved.project);setAdded(ids=>[...ids,candidate.id]);})}>{added.includes(candidate.id)?'已加入候选问题':candidate.complete?'加入候选问题':'结构或依据不完整，暂不能加入'}</button></div>)}
    {doc&&<article className="research-result" onClick={event=>{const a=(event.target as HTMLElement).closest('a');if(!a)return;const href=a.getAttribute('href')??'';if(href.startsWith('./')||href.startsWith('../')){const path=new URL(href,'https://local/'+doc.path).pathname.slice(1),id=knowledgeDocumentId(path);if(id){event.preventDefault();window.location.href=projectPath(projectId,'wiki',{focus:id});}}}}><ChatMarkdown text={doc.text.replace(/^---\n[\s\S]*?\n---\n/,'')} allowRelativeLinks/></article>}
   </div>
  </section></div></ModalLayer>}
 {readingId&&<LiteratureDocumentDialog key={readingId} projectId={projectId} initialId={readingId} onClose={()=>setReadingId(undefined)} onSaved={()=>{}}/>}
 </>;
}
