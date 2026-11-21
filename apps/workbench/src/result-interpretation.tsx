import { useEffect, useState } from "react";
import type { KnowledgeVersion } from "@trash/protocol";
import { api, uiError } from "./api.js";
import { formatEvaluationMetric } from "./evaluation.js";

type ResultContent = Extract<KnowledgeVersion["content"], {dataset:string}>;
type Result = Omit<KnowledgeVersion,"content"> & {content:ResultContent};

export function ResultInterpretation({projectId,recordId,records,content,update}:{
  projectId:string; recordId?:string; records:KnowledgeVersion[]; content:Record<string,unknown>;
  update:(field:string,value:unknown)=>void;
}) {
  const comparison = content.comparison as ResultContent["comparison"];
  const id = comparison?.object_id, version = comparison?.version;
  const [evidence,setEvidence] = useState<Result>();
  const [error,setError] = useState("");
  useEffect(()=>{
    setEvidence(undefined); setError("");
    if (!id || !version) return;
    const controller = new AbortController();
    api<{record:Result}>(`/projects/${encodeURIComponent(projectId)}/experiment-results/${encodeURIComponent(id)}?version=${version}`, {signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setEvidence(value.record);})
      .catch(cause=>{if(!controller.signal.aborted)setError(uiError(cause,"读取对照结果失败。"));});
    return ()=>controller.abort();
  },[projectId,id,version]);
  const selected = id && version ? id+":"+version : "";
  const options = records.filter(item=>item.object_id!==recordId);
  return <fieldset className="result-interpretation">
    <legend>研究判断</legend>
    <label>结果对方法假设的支持程度<select value={String(content.method_verdict??"")} onChange={e=>update("method_verdict",e.target.value||undefined)}>
      <option value="">尚未判断</option><option value="supported">支持</option><option value="unsupported">未支持</option><option value="inconclusive">目前无法判断</option>
    </select></label>
    <label>对照结果<select value={selected} onChange={e=>{
      const match=options.find(item=>item.object_id+":"+item.version===e.target.value);
      update("comparison",match?{object_id:match.object_id,version:match.version}:undefined);
    }}><option value="">选择对照结果（可选）</option>
      {selected && !options.some(item=>item.object_id+":"+item.version===selected) &&
        <option value={selected}>{evidence?.title??id} · v{version}</option>}
      {options.map(item=><option key={item.object_id} value={item.object_id+":"+item.version}>{item.title} · v{item.version} · {item.object_id.slice(-8)}</option>)}
    </select></label>
    {evidence && <details key={selected}><summary>查看对照 · {evidence.title} · v{evidence.version}</summary>
      <p>{[evidence.content.method,evidence.content.dataset,evidence.content.evaluation_protocol].filter(Boolean).join(" · ")}</p>
      <ul>{evidence.content.metrics.map((metric,i)=><li key={i}>{metric.name} · {formatEvaluationMetric(metric)} {metric.condition}</li>)}</ul>
    </details>}
    {error && <p role="alert">{error}</p>}
    <label>判断依据<textarea rows={3} value={String(content.interpretation??"")} onChange={e=>update("interpretation",e.target.value)}
      placeholder="哪些指标或观察支持这个判断？结论适用于什么条件？"/></label>
  </fieldset>;
}
