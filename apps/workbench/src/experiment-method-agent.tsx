import { useEffect, useRef, useState } from "react";
import { api, uiError } from "./api.js";
import { ChatMarkdown } from "./chat-markdown.js";
import { useUnsavedChanges } from "./navigation.js";

type MethodDraft = { markdown: string | null; summary: string; questions: string[]; expected: string };
type MethodTask = {
  task_id: string; status: string; created_at: string; instructions: string; error?: string; method_draft?: MethodDraft;
};
type Source = { name: string; path: string; kind: string };
const statusNames: Record<string,string> = {
  running: "生成中", cancelling: "正在停止", completed: "已完成", failed: "生成失败",
  cancelled: "已停止", interrupted: "已中断",
};
const activeTask = (task: MethodTask) => ["running","cancelling"].includes(task.status);

function MethodDiff({ before, after }: { before: string; after: string }) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  if (oldLines.length * newLines.length > 500000) {
    return <div className="method-large-diff">
      <section><h4>当前正文</h4><pre>{before}</pre></section>
      <section><h4>Agent 草稿</h4><pre>{after}</pre></section>
    </div>;
  }
  const width = newLines.length + 1;
  const lengths = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const cell = i * width + j;
      lengths[cell] = oldLines[i] === newLines[j]
        ? 1 + lengths[cell + width + 1]
        : Math.max(lengths[cell + width], lengths[cell + 1]);
    }
  }
  const lines: { kind: "kept" | "removed" | "added"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({kind:"kept", text:oldLines[i]}); i++; j++;
    } else if (i < oldLines.length && (j === newLines.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      lines.push({kind:"removed", text:oldLines[i++]});
    } else {
      lines.push({kind:"added", text:newLines[j++]});
    }
  }
  return <pre className="method-diff" aria-label="方法设计差异" tabIndex={0}>{lines.map(({kind,text},index)=>
    <span className={kind} key={index}>{kind==="added"?"+ ":kind==="removed"?"− ":"  "}{text}{"\n"}</span>)}</pre>;
}

export function ExperimentMethodAgent({ base, experimentKey, body, etag, onApply, onRefresh, disabled }: {
  base:string; experimentKey:string; body:string; etag:string; disabled:boolean;
  onApply:(markdown:string, expected:string)=>Promise<boolean | "conflict">; onRefresh:()=>void;
}) {
  const [direction_id, scheme_id] = experimentKey.split("/");
  const path = base + "/experiment-method/tasks";
  const query = path + "?" + new URLSearchParams({direction_id, scheme_id});
  const [tasks,setTasks] = useState<MethodTask[]>([]);
  const [sources,setSources] = useState<Source[]>([]);
  const [form,setForm] = useState(false);
  const [instructions,setInstructions] = useState("");
  const [source,setSource] = useState("");
  const [selection,setSelection] = useState("");
  const [submitting,setSubmitting] = useState(false);
  const [saving,setSaving] = useState(false);
  const [stopping,setStopping] = useState(false);
  const [error,setError] = useState("");
  const [superseded,setSuperseded] = useState("");
  const busy = useRef(false);
  useUnsavedChanges(form && Boolean(instructions.trim() || source));
  const selected = tasks.find(task => task.task_id === selection);
  const active = tasks.find(activeTask);
  const candidate = selected?.method_draft;
  const stale = candidate && (candidate.expected !== etag || selected?.task_id === superseded);
  const hasMethod = body.split(/\r?\n/).some(line => {
    const value = line.trim();
    return value && !value.startsWith("#");
  });
  useEffect(() => {
    let ignore = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await api<{tasks:MethodTask[]}>(query);
        if (!ignore) setTasks(value.tasks);
      } catch (cause) {
        if (!ignore) setError(uiError(cause,"读取方法生成任务失败。"));
      } finally {
        if (!ignore) timer = setTimeout(refresh, 3500);
      }
    }
    void refresh();
    return () => { ignore = true; clearTimeout(timer); };
  }, [query]);
  useEffect(() => {
    if (!form) return;
    const controller = new AbortController();
    api<{entries:Source[]}>(base+"/files?path=research",{signal:controller.signal}).then(value => {
      if (!controller.signal.aborted) setSources(value.entries.filter(item =>
        item.kind==="file" && /^[^/\\`\r\n]+\.md$/i.test(item.name)));
    }).catch(() => { /* Research notes are optional. */ });
    return () => controller.abort();
  }, [base,form]);

  async function generate() {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    const request = instructions.trim() || (hasMethod
      ? "核对当前方法与仓库实现，修订需要同步的部分。"
      : "从选定材料或现有实现起草实验方法。若缺少确定研究问题的材料，请提出关键问题。");
    try {
      const {task_id} = await api<{task_id:string}>(path, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({instructions:request,method:{direction_id,scheme_id,source:source||undefined,expected:etag}}),
      });
      setTasks(items=>items.some(item=>item.task_id===task_id) ? items : [
        {task_id,status:"running",instructions:request,created_at:new Date().toISOString()}, ...items,
      ]);
      setSelection(task_id);
      setInstructions("");
      setForm(false);
    } catch (cause) {
      setError(uiError(cause,"无法启动方法设计任务。"));
    } finally { busy.current = false; setSubmitting(false); }
  }

  async function updateTask(taskId: string, action: "cancel" | "acknowledge") {
    if (busy.current) return;
    busy.current = true;
    setStopping(true);
    setError("");
    try {
      await api(base+"/code-agent/tasks/"+encodeURIComponent(taskId)+"/"+action, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({confirm:true}),
      });
      setTasks(items=>items.map(item=>item.task_id===taskId ? {
        ...item,status:action==="cancel"?"cancelling":"failed",
      } : item));
    } catch (cause) {
      setError(uiError(cause,"无法更新任务状态。"));
    } finally { busy.current = false; setStopping(false); }
  }

  async function adopt(draft: MethodDraft) {
    if (busy.current || !draft.markdown) return;
    busy.current = true;
    setSaving(true);
    try {
      const result = await onApply(draft.markdown, draft.expected);
      if (result === true) setSelection("");
      if (result === "conflict") {
        setSuperseded(selection);
        onRefresh();
      }
    } finally { busy.current = false; setSaving(false); }
  }

  return <div className="method-agent">
    <div className="knowledge-toolbar">
      {!form && <button type="button" className="primary-button" disabled={disabled||submitting||Boolean(active)||saving}
        onClick={()=>setForm(true)}>{hasMethod?"让 Agent 修订":"让 Agent 起草"}</button>}
      {tasks.length>0 && <select aria-label="方法生成记录" value={selection} disabled={saving}
        onChange={event=>setSelection(event.target.value)}>
        <option value="">方法生成记录</option>
        {tasks.map(task=><option key={task.task_id} value={task.task_id}>
          {statusNames[task.status]??task.status} · {task.method_draft?.summary || task.instructions.slice(0,65)}
        </option>)}
      </select>}
      {active && <span role="status">{statusNames[active.status]}</span>}
      {active?.status==="running" && <button type="button" className="secondary-button" disabled={stopping}
        onClick={()=>void updateTask(active.task_id,"cancel")}>停止生成</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {form && <form onSubmit={event=>{event.preventDefault();void generate();}}>
      <label>给 Agent 的要求<textarea rows={3} value={instructions} disabled={submitting} maxLength={30000}
        onChange={event=>setInstructions(event.target.value)} placeholder="写下研究意图，或指出要修订的内容"/></label>
      <div className="knowledge-toolbar">
        {sources.length>0 && <select aria-label="选择研究方案" value={source} disabled={submitting}
          onChange={event=>setSource(event.target.value)}>
          <option value="">选择 research 中的方案（可选）</option>
          {sources.map(item=><option key={item.path} value={item.path}>{item.name}</option>)}
        </select>}
        <button className="primary-button" disabled={disabled||submitting||Boolean(active)}>生成草稿</button>
        <button type="button" className="secondary-button" disabled={submitting}
          onClick={()=>{setForm(false);setInstructions("");setSource("");}}>取消</button>
      </div>
    </form>}
    {selected?.status==="interrupted" && <button type="button" className="secondary-button" disabled={stopping}
      onClick={()=>{if(window.confirm("请核对旧任务的 Codex 进程已结束。确认后可重新生成。"))
        void updateTask(selected.task_id,"acknowledge");}}>已核对旧进程，解除中断状态</button>}
    {selected?.error && <p role="alert">{selected.error}</p>}
    {candidate && <div className="method-candidate">
      <h4>{candidate.markdown ? "Agent 方法草稿" : "需要确认"}</h4>
      {candidate.summary && <p>{candidate.summary}</p>}
      {candidate.questions.length>0 && <ul>{candidate.questions.map((question,index)=><li key={index}>{question}</li>)}</ul>}
      {candidate.markdown && <>
        {stale ? <p role="status">当前正文已经变化。请查看旧草稿后重新生成，或将需要的内容手动合入。</p>
          : candidate.markdown===body ? <p role="status">草稿和当前正文一致。</p>
          : <MethodDiff before={body} after={candidate.markdown}/>}
        <details><summary>查看草稿正文</summary><ChatMarkdown text={candidate.markdown}/></details>
        <button type="button" className="primary-button" disabled={disabled||saving||Boolean(stale)||candidate.markdown===body}
          onClick={()=>void adopt(candidate)}>采用草稿</button>
      </>}
      {!candidate.markdown && <button type="button" className="secondary-button" disabled={form||Boolean(active)}
        onClick={()=>{setInstructions([selected.instructions,...candidate.questions.map(question=>"\n"+question+"\n答：")].join("\n").slice(0,30000));setForm(true);}}>
        补充后继续
      </button>}
    </div>}
  </div>;
}
