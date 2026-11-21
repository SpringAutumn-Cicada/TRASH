import { useRef, useState } from "react";
import { ChevronRight, FlaskConical, GitBranch, Plus } from "lucide-react";
import type { ExperimentCatalogEntry, ReproductionCode } from "@trash/protocol";
import { ModalLayer } from "./modal-layer.js";

export const experimentKeyOf = (item: ExperimentCatalogEntry) => `${item.direction_id}/${item.scheme_id}`;

export function ExperimentCatalog({ experiments, reproductions, busy, loading, create, open, openReproduction }: {
  experiments: ExperimentCatalogEntry[];
  reproductions: ReproductionCode[];
  busy: boolean;
  loading: boolean;
  create: (title: string, id: string) => Promise<boolean>;
  open: (item: ExperimentCatalogEntry) => void;
  openReproduction: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "original" | "reproduction">("all");
  const [draft, setDraft] = useState<{ title: string; id: string }>();
  const submission = useRef(false);
  const [creating, setCreating] = useState(false);
  const cards = [
    ...(filter === "reproduction" ? [] : experiments.map(item => ({
      id: experimentKeyOf(item), title: item.title, icon: FlaskConical, kind: "自研",
      detail: item.entrypoint ?? (item.repository_id ? "已关联仓库" : "待关联代码"),
      onOpen: () => open(item),
    }))),
    ...(filter === "original" ? [] : reproductions.map(item => ({
      id: item.id, title: item.name, icon: GitBranch, kind: "复现",
      detail: item.imported ? "已导入代码" : "待导入代码",
      onOpen: () => openReproduction(item.id),
    }))),
  ];
  return <section className="experiment-catalog">
    <div className="experiment-catalog-toolbar">
      <div className="experiment-subnav" aria-label="实验类型">
        {([{ id: "all", label: "全部" }, { id: "original", label: "自研" }, { id: "reproduction", label: "复现" }] as const)
          .map(item => <button type="button" className="secondary-button" key={item.id} aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
      <button type="button" className="primary-button" disabled={busy}
        onClick={() => setDraft({ title: "", id: crypto.randomUUID() })}><Plus size={16}/>新建自研实验</button>
    </div>
    <div className="experiment-catalog-grid">
      {cards.map(card => <button type="button" className="experiment-catalog-card" key={card.id} onClick={card.onOpen}>
        <span className="experiment-catalog-icon"><card.icon size={19} aria-hidden="true"/></span>
        <span className="experiment-catalog-copy"><small>{card.kind}</small><strong>{card.title}</strong><small>{card.detail}</small></span>
        <ChevronRight size={16} aria-hidden="true"/>
      </button>)}
    </div>
    {!cards.length && <p className="quiet" role="status">{loading ? "正在读取实验…" : "当前分类还没有实验。"}</p>}
    {draft && <ModalLayer><div className="modal-backdrop">
      <form className="modal experiment-form" role="dialog" aria-modal="true" aria-labelledby="new-experiment-heading" aria-busy={creating}
        onSubmit={async event => {
          event.preventDefault();
          if (busy || submission.current || !draft.title.trim()) return;
          submission.current = true;
          setCreating(true);
          try {
            if (await create(draft.title.trim(), draft.id)) setDraft(undefined);
          } finally {
            submission.current = false;
            setCreating(false);
          }
        }}>
        <h3 id="new-experiment-heading">新建自研实验</h3>
        <label>实验名称<input autoFocus required maxLength={120} disabled={busy} value={draft.title}
          onChange={event => setDraft({ title: event.target.value, id: crypto.randomUUID() })}/></label>
        <p>代码目录 <code>code/papers/{draft.title.trim() || "<实验名称>"}/</code></p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button>
          <button className="primary-button" disabled={busy || creating || !draft.title.trim()}>{creating ? "正在初始化 Git…" : "创建实验"}</button>
        </div>
      </form>
    </div></ModalLayer>}
  </section>;
}
