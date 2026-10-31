import type { KnowledgeVersion, ProjectOverview, ProjectPage } from "@trash/protocol";
import { ExperimentStore, KnowledgeStore, type TrashStore } from "@trash/storage";

export function projectOverview(store: TrashStore, projectId: string): ProjectOverview {
  const knowledge = new KnowledgeStore(store.db);
  const sources = store.listSources(projectId);
  const cards = knowledge.list(projectId, "literature-card");
  const pages = knowledge.list(projectId, "wiki-page");
  const results = knowledge.list(projectId, "experiment-result");
  const cardSources = new Set(cards.flatMap(c => "source_id" in c.content ? [c.content.source_id] : []));
  const acceptedRows = store.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=? AND kind='literature-card' AND json_extract(data,'$.status')='accepted'").all(projectId) as { data: string }[];
  const accepted = new Set(acceptedRows.flatMap(row => { const card = JSON.parse(row.data) as KnowledgeVersion; return "source_id" in card.content ? [card.content.source_id] : []; }));
  const tasks = knowledge.tasks(projectId);
  const experimentStore = new ExperimentStore(store.db);
  const experiments = experimentStore.runs(projectId);
  const pageFor = (kind: KnowledgeVersion["kind"]): ProjectPage => kind === "literature-card" ? "cards" : kind === "wiki-page" ? "wiki" : "results";
  const labels = { "literature-card": "文献卡片", "wiki-page": "Wiki", "experiment-result": "实验结果" };
  const activities: ProjectOverview["activities"] = sources.slice(0, 10).map(source => ({ id: `source-${source.source_id}`, title: source.title, description: "导入文献", at: source.imported_at, page: "literature", object_id: source.source_id }));
  const versions = store.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=? ORDER BY json_extract(data,'$.created_at') DESC LIMIT 10").all(projectId) as { data: string }[];
  for (const row of versions) {
    const record = JSON.parse(row.data) as KnowledgeVersion;
    activities.push({ id: `${record.object_id}-${record.version}`, title: record.title, description: `${labels[record.kind]}保存 v${record.version}`, at: record.created_at, page: pageFor(record.kind), object_id: record.object_id });
  }
  const reviews = store.db.prepare(`SELECT r.rowid AS review_id,r.decision,r.at,v.data FROM knowledge_reviews r JOIN knowledge_versions v ON r.object_id=v.object_id AND r.version=v.version WHERE v.project_id=? ORDER BY r.at DESC LIMIT 10`).all(projectId) as { review_id: number; decision: string; at: string; data: string }[];
  for (const row of reviews) {
    const record = JSON.parse(row.data) as KnowledgeVersion;
    activities.push({ id: `review-${row.review_id}`, title: record.title, description: `${row.decision === "accepted" ? "采纳" : "拒绝"}${labels[record.kind]} v${record.version}`, at: row.at, page: pageFor(record.kind), object_id: record.object_id });
  }
  const taskTimes = store.db.prepare("SELECT t.task_id,MAX(e.at) AS at FROM knowledge_tasks t LEFT JOIN knowledge_task_events e ON e.task_id=t.task_id WHERE t.project_id=? GROUP BY t.task_id").all(projectId) as { task_id: string; at: string | null }[];
  const taskAt = new Map(taskTimes.map(row => [row.task_id, row.at]));
  const states: Record<string, string> = { queued: "排队", running: "运行", completed: "完成", failed: "失败", cancelled: "取消", interrupted: "中断" };
  for (const task of tasks) activities.push({ id: task.task_id, title: task.input.title, description: `Agent 任务${states[task.status] ?? task.status}`, at: taskAt.get(task.task_id) ?? task.created_at, page: "tasks", object_id: task.task_id });
  for (const run of experiments) activities.push({ id:run.run_id,title:run.plan.content.title,description:`实验：${run.status}`,at:run.updated_at,page:"experiments",object_id:run.run_id });
  return {
    counts: { sources: sources.length, accepted_cards: accepted.size, wiki_pages: pages.length, experiment_results: results.length },
    pending: { unorganized_sources: sources.filter(source => !cardSources.has(source.source_id)).length, cards: cards.filter(card => card.status === "pending").length, wiki_pages: pages.filter(page => page.status === "pending").length, stale_wiki_pages: pages.filter(page => knowledge.stale(page)).length, unsuccessful_tasks: tasks.filter(task => ["failed", "interrupted"].includes(task.status)).length, active_experiments: experiments.filter(run => experimentStore.active(run)).length, failed_experiments: experiments.filter(run => run.status === "failed").length, pending_collection: experiments.filter(run => run.status === "collecting" || run.status === "completed" && !run.preparation && !run.result_id).length },
    activities: activities.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 10)
  };
}
