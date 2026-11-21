import { useRef, useState } from "react";
import { ChevronRight, FlaskConical, GitBranch, Plus, Trash2 } from "lucide-react";
import type { ExperimentCatalogEntry, ReproductionCode } from "@trash/protocol";
import { ModalLayer } from "./modal-layer.js";

export const experimentKeyOf = (item: ExperimentCatalogEntry) => `${item.direction_id}/${item.scheme_id}`;

export function ExperimentCatalog({ experiments, reproductions, busy, loading, create, recycle, open, openReproduction }: {
  experiments: ExperimentCatalogEntry[];
  reproductions: ReproductionCode[];
  busy: boolean;
  loading: boolean;
  create: (title: string, id: string) => Promise<boolean>;
  recycle: (item: ExperimentCatalogEntry) => Promise<boolean>;
  open: (item: ExperimentCatalogEntry) => void;
  openReproduction: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "original" | "reproduction">("all");
  const [draft, setDraft] = useState<{ title: string; id: string }>();
  const [recycling, setRecycling] = useState<ExperimentCatalogEntry>();
  const submission = useRef(false);
  const [creating, setCreating] = useState(false);
  const cards = [
    ...(filter === "reproduction" ? [] : experiments.map(item => ({
      id: experimentKeyOf(item), title: item.title, icon: FlaskConical, kind: "自研",
      detail: item.entrypoint ?? (item.repository_id ? "已关联仓库" : "待关联代码"),
      onOpen: () => open(item), experiment: item,
    }))),
    ...(filter === "original" ? [] : reproductions.map(item => ({
      id: item.id, title: item.name, icon: GitBranch, kind: "复现",
      detail: item.imported ? "已导入代码" : "待导入代码",
      onOpen: () => openReproduction(item.id), experiment: undefined,
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
      {cards.map(card => <article className="experiment-catalog-card" key={card.id}>
        <button type="button" className="experiment-catalog-open" onClick={card.onOpen}>
          <span className="experiment-catalog-icon"><card.icon size={19} aria-hidden="true"/></span>
          <span className="experiment-catalog-copy"><small>{card.kind}</small><strong>{card.title}</strong><small>{card.detail}</small></span>
          <ChevronRight size={16} aria-hidden="true"/>
        </button>
        {card.experiment && <button type="button" className="icon-button experiment-catalog-delete"
          title="删除实验" aria-label={`删除实验 ${card.title}`} disabled={busy} onClick={() => setRecycling(card.experiment)}>
          <Trash2 size={16} aria-hidden="true"/>
        </button>}
      </article>)}
    </div>
    {!cards.length && <p className="quiet" role="status">{loading ? "正在读取实验…" : "当前分类还没有实验。"}</p>}
    {recycling && <ModalLayer><div className="modal-backdrop">
      <div className="modal experiment-form" role="dialog" aria-modal="true" aria-labelledby="recycle-experiment-heading">
        <h3 id="recycle-experiment-heading">删除「{recycling.title}」？</h3>
        <p>实验档案将移入「项目文件 → 回收站」。代码仓库、计划和运行记录会保留，可在回收站恢复实验。</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setRecycling(undefined)}>取消</button>
          <button type="button" className="primary-button" disabled={busy} onClick={async () => {
            if (submission.current) return;
            submission.current = true;
            try { if (await recycle(recycling)) setRecycling(undefined); }
            finally { submission.current = false; }
          }}>{busy ? "正在移入…" : "移入回收站"}</button>
        </div>
      </div>
    </div></ModalLayer>}
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
