import { useEffect, useId, useState } from "react";
import { ChatMarkdown } from "./chat-markdown.js";
import "./method-markdown.css";

type MethodDocument = { body: string; diagrams: string[] };

function readMethodMarkdown(text: string): MethodDocument {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  const diagrams: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opener = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!opener) {
      body.push(lines[index]);
      continue;
    }
    const marker = opener[1];
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
    let end = index + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end < lines.length && opener[2].trim().toLowerCase() === "mermaid") {
      diagrams.push(lines.slice(index + 1, end).join("\n"));
      body.push("");
    } else {
      for (let line = index; line <= end && line < lines.length; line++) body.push(lines[line]);
    }
    index = end;
  }
  return { body: body.join("\n"), diagrams };
}

let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
function loadRenderer() {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { useMaxWidth: false },
      theme: "base",
      themeVariables: {
        primaryColor: "#f2ebfb",
        primaryTextColor: "#2c223b",
        primaryBorderColor: "#bba3d9",
        lineColor: "#76638c",
        fontFamily: "system-ui, sans-serif",
      },
    });
    return mermaid;
  }).catch(error => {
    renderer = undefined;
    throw error;
  });
  return renderer;
}

function MethodDiagram({ source, label }: { source: string; label: string }) {
  const id = `method-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [result, setResult] = useState<{ source: string; url?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const diagram = source.trim();
    const supported = /^(?:flowchart|graph)[ \t]+(?:TB|TD|BT|LR|RL)\b/i.test(diagram);
    if (!supported || diagram.length > 16000 || /%%\{|@\s*\{/.test(diagram)) {
      setResult({ source, error: "请使用 16,000 字符以内的基础 Mermaid 流程图。" });
      return;
    }
    void loadRenderer().then(async mermaid => {
      if (!active) return;
      const { svg } = await mermaid.render(id, diagram);
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setResult({ source, url: objectUrl });
    }).catch(() => {
      if (active) setResult({ source, error: "流程图无法预览，可展开源码检查。" });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, source]);

  const current = result?.source === source ? result : undefined;
  return <figure className="method-diagram">
    <figcaption>{label}</figcaption>
    {current?.url ? <div className="method-diagram-scroll" tabIndex={0} aria-label={label}>
      <img src={current.url} alt={label} onError={() => setResult(previous => previous?.url === current.url ? { source, error: "流程图图像无法显示。" } : previous)}/>
    </div> : <p role="status">{current?.error ?? "正在绘制流程图…"}</p>}
    <details open={current?.error ? true : undefined}>
      <summary>流程图源码</summary>
      <pre><code>{source}</code></pre>
    </details>
  </figure>;
}

function MethodDiagrams({ diagrams }: { diagrams: string[] }) {
  return diagrams.map((source, index) => <MethodDiagram key={index} source={source}
    label={diagrams.length === 1 ? "方法流程图" : `方法流程图 ${index + 1}`}/>);
}

export function MethodMarkdown({ text, onOpenResearch }: { text: string; onOpenResearch?: (path: string) => void }) {
  const { body, diagrams } = readMethodMarkdown(text);
  return <>
    <MethodDiagrams diagrams={diagrams}/>
    <ChatMarkdown text={body} onOpenResearch={onOpenResearch}/>
  </>;
}

export function MethodDraftPreview({ current, proposed }: { current: string; proposed: string }) {
  const before = readMethodMarkdown(current);
  const after = readMethodMarkdown(proposed);
  const changed = before.diagrams.length !== after.diagrams.length ||
    before.diagrams.some((source, index) => source !== after.diagrams[index]);
  const [open, setOpen] = useState(false);
  return <>
    {changed && <div className="method-diagram-comparison">
      <section>
        <h5>现稿流程图</h5>
        {before.diagrams.length ? <MethodDiagrams diagrams={before.diagrams}/> : <p>现稿没有流程图。</p>}
      </section>
      <section>
        <h5>草稿流程图</h5>
        {after.diagrams.length ? <MethodDiagrams diagrams={after.diagrams}/> : <p>草稿没有流程图。</p>}
      </section>
    </div>}
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>查看草稿正文</summary>
      {open && <>
        {!changed && <MethodDiagrams diagrams={after.diagrams}/>}
        <ChatMarkdown text={after.body}/>
      </>}
    </details>
  </>;
}
