import { ExperimentMethodAgent } from "./experiment-method-agent.js";
import { useEffect, useState } from "react";
import { api, uiError } from "./api.js";
import { ChatMarkdown } from "./chat-markdown.js";
import { useUnsavedChanges } from "./navigation.js";

type Document = { content?: string; etag?: string; editable: boolean };
type MethodTask = {task_id:string; status:string; instructions:string; experiment?:{direction_id:string;scheme_id:string}};
type Source = { name: string; path: string; kind: string };

export function ExperimentMethod({ projectId, experimentKey, onOpenFile }: {
  projectId: string; experimentKey: string; onOpenFile: (path: string) => void;
}) {
  const base = "/projects/" + encodeURIComponent(projectId);
  const path = "experiments/" + experimentKey + "/README.md";
  const preview = base + "/files/preview?path=" + encodeURIComponent(path);
  const [document, setDocument] = useState<Document>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [tasks,setTasks] = useState<MethodTask[]>([]);
  const [readingReply,setReadingReply] = useState(false);
  const [incoming, setIncoming] = useState<Document>();
  const [revision, setRevision] = useState(0);
  const dirty = editing && draft !== document?.content;
  useUnsavedChanges(dirty);

  useEffect(() => {
    const controller = new AbortController();
    api<Document>(preview, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setDocument(value);
      setError(value.content === undefined ? "此档案无法作为 UTF-8 文本在线编辑。" : "");
    }).catch(cause => { if (!controller.signal.aborted) setError(uiError(cause, "读取方法档案失败。")); });
    return () => controller.abort();
  }, [preview, revision]);

  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    api<{ entries: Source[] }>(base + "/files?path=research", {signal:controller.signal}).then(({ entries }) => {
      if (!controller.signal.aborted) setSources(entries.filter(item => item.kind === "file" && /\.md$/i.test(item.name) && !item.name.includes("`")));
    }).catch(() => { /* A project without research notes can still edit its method. */ });
    api<{tasks:MethodTask[]}>(base + "/code-agent/tasks", {signal:controller.signal}).then(value=>{
      if (!controller.signal.aborted) setTasks(value.tasks.filter(task=>task.status==="completed" &&
        task.experiment && task.experiment.direction_id+"/"+task.experiment.scheme_id===experimentKey));
    }).catch(()=>{ /* The method draft is independent of Agent availability. */ });
    return () => controller.abort();
  }, [base, editing, experimentKey]);

  async function appendReply(id: string) {
    if (!id || readingReply) return;
    setReadingReply(true);
    try {
      const {task} = await api<{task:{response:string}}>(base+"/code-agent/tasks/"+encodeURIComponent(id));
      if (task.response.trim()) setDraft(value=>value.trimEnd()+"\n\n"+task.response.trim()+"\n");
      else setError("此任务没有可引用的回复。");
    } catch(cause) { setError(uiError(cause,"读取 Agent 回复失败。")); }
    finally { setReadingReply(false); }
  }

  async function save(content = draft, expected = document?.etag, fromAgent = false) {
    if (saving || !expected) return false;
    setSaving(true);
    setError("");
    try {
      const updated = await api<Document>(base + "/files/save", {method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({path, etag:expected, content})});
      setDocument(updated);
      setEditing(false);
      setIncoming(undefined);
      return true;
    } catch (cause) {
      setError(uiError(cause, "方法设计保存失败，草稿已保留。"));
      if (cause instanceof Error && cause.message === "FILES_CHANGED") {
        if (fromAgent) return "conflict" as const;
        try { setIncoming(await api<Document>(preview)); }
        catch { setError("无法读取外部修改，草稿已保留。"); }
      }
      return false;
    } finally { setSaving(false); }
  }

  const body = document?.content;
  return <section className="experiment-card experiment-method">
    <div className="section-heading"><h3>方法设计</h3><div className="knowledge-toolbar">
      {!editing && <button className="secondary-button" onClick={()=>setRevision(v=>v+1)}>重新读取</button>}
      {!editing && document?.editable && <button className="secondary-button" disabled={saving} onClick={()=>{setDraft(body ?? ""); setEditing(true);}}>编辑方法</button>}
    </div></div>
    {error && <p role="alert">{error}</p>}
    {document?.editable && document.etag && body !== undefined &&
      <ExperimentMethodAgent base={base} experimentKey={experimentKey} body={body} etag={document.etag}
        disabled={editing||saving} onApply={(content,etag)=>save(content,etag,true)} onRefresh={()=>setRevision(v=>v+1)}/>}
    {editing ? <>
      <label>方法说明（Markdown）<textarea className="json-editor" rows={16} value={draft} disabled={saving}
        onChange={event=>setDraft(event.target.value)}/></label>
      {incoming?.etag && <details open><summary>磁盘上的最新版本</summary><pre>{incoming.content}</pre>
        <button className="secondary-button" onClick={()=>{setDocument(incoming);setIncoming(undefined);setError("");}}>已核对，以此版本为基准继续编辑草稿</button></details>}
      <div className="knowledge-toolbar">
        {tasks.length>0 && <select aria-label="引用实验 Agent 回复" value="" disabled={saving||readingReply}
          onChange={e=>void appendReply(e.target.value)}><option value="">引用代码 Agent 回复</option>
          {tasks.map(task=><option key={task.task_id} value={task.task_id}>{task.instructions.slice(0,65)}</option>)}</select>}
        {sources.length>0 && <select aria-label="引用研究方案" value="" disabled={saving} onChange={e=>{
          const source=e.target.value;
          if(source) setDraft(value=>value.trimEnd()+"\n\n来源方案 · `"+source+"`\n");
        }}><option value="">引用 research 中的方案</option>{sources.map(s=><option key={s.path} value={s.path}>{s.name}</option>)}</select>}
        <button className="primary-button" disabled={saving||readingReply||!dirty||Boolean(incoming)} onClick={()=>void save()}>保存方法</button>
        <button className="secondary-button" disabled={saving||readingReply} onClick={()=>{
          if(dirty && !window.confirm("放弃尚未保存的方法修改？")) return;
          setEditing(false); setIncoming(undefined); setRevision(v=>v+1);
        }}>取消</button>
      </div>
    </> : body !== undefined ? <ChatMarkdown text={body} onOpenResearch={onOpenFile}/> : !error && <p role="status">正在读取方法档案…</p>}
  </section>;
}
