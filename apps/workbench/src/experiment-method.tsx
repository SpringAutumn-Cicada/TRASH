import { useEffect, useState } from "react";
import { api, uiError } from "./api.js";
import { ChatMarkdown } from "./chat-markdown.js";
import { useUnsavedChanges } from "./navigation.js";

type Document = { content?: string; etag?: string; editable: boolean };
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
    return () => controller.abort();
  }, [base, editing]);

  async function save() {
    if (saving || !document?.etag) return;
    setSaving(true);
    setError("");
    try {
      const updated = await api<Document>(base + "/files/save", {method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({path, etag:document.etag, content:draft})});
      setDocument(updated);
      setEditing(false);
      setIncoming(undefined);
    } catch (cause) {
      setError(uiError(cause, "方法设计保存失败，草稿已保留。"));
      if (cause instanceof Error && cause.message === "FILES_CHANGED") {
        try { setIncoming(await api<Document>(preview)); }
        catch { setError("无法读取外部修改，草稿已保留。"); }
      }
    } finally { setSaving(false); }
  }

  const body = document?.content;
  return <section className="experiment-card experiment-method">
    <div className="section-heading"><h3>方法设计</h3><div className="knowledge-toolbar">
      {!editing && <button className="secondary-button" onClick={()=>setRevision(v=>v+1)}>重新读取</button>}
      {!editing && document?.editable && <button className="primary-button" onClick={()=>{setDraft(body ?? ""); setEditing(true);}}>编辑方法</button>}
    </div></div>
    {error && <p role="alert">{error}</p>}
    {editing ? <>
      <label>方法说明（Markdown）<textarea className="json-editor" rows={16} value={draft} disabled={saving}
        onChange={event=>setDraft(event.target.value)}/></label>
      {incoming?.etag && <details open><summary>磁盘上的最新版本</summary><pre>{incoming.content}</pre>
        <button className="secondary-button" onClick={()=>{setDocument(incoming);setIncoming(undefined);setError("");}}>已核对，以此版本为基准继续编辑草稿</button></details>}
      <div className="knowledge-toolbar">
        {sources.length>0 && <select aria-label="引用研究方案" value="" disabled={saving} onChange={e=>{
          const source=e.target.value;
          if(source) setDraft(value=>value.trimEnd()+"\n\n来源方案 · `"+source+"`\n");
        }}><option value="">引用 research 中的方案</option>{sources.map(s=><option key={s.path} value={s.path}>{s.name}</option>)}</select>}
        <button className="primary-button" disabled={saving||!dirty||Boolean(incoming)} onClick={()=>void save()}>保存方法</button>
        <button className="secondary-button" disabled={saving} onClick={()=>{
          if(dirty && !window.confirm("放弃尚未保存的方法修改？")) return;
          setEditing(false); setIncoming(undefined); setRevision(v=>v+1);
        }}>取消</button>
      </div>
    </> : body !== undefined ? <ChatMarkdown text={body} onOpenResearch={onOpenFile}/> : !error && <p role="status">正在读取方法档案…</p>}
  </section>;
}
