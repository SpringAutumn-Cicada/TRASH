import {taskEventPage,eventOptions,streamTaskEvents} from './task-events.js';
import {listTasks} from './task-list.js';
import {bibliographyState,saveBibliographyState} from './source-bibliography.js';
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { KnowledgeStore, type KnowledgeTask, type TrashStore } from "@trash/storage";
import { sourceSchema, knowledgeWriteSchema, sourceDetailsSchema, type KnowledgeKind, type KnowledgeVersion, experimentResultSchema, knowledgeTaskInputSchema } from "@trash/protocol";

export const kinds = { "literature-cards": "literature-card", "wiki-pages": "wiki-page", "experiment-results": "experiment-result" } as const;
export function requestError(code: string, statusCode = 400): never { throw Object.assign(new Error(code), { statusCode }); }
export interface TaskRunner { enqueue(projectId: string, input: z.infer<typeof knowledgeTaskInputSchema>, retryOf?: string): KnowledgeTask[]; cancel(projectId: string, taskId: string): void; resumable?(task:KnowledgeTask):boolean }
function csv(records: KnowledgeVersion[]): string {
  const escape = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return "\uFEFF" + [ ["id", "version", "status", "title", "content"], ...records.map(v => [v.object_id, v.version, v.status, v.title, JSON.stringify(v.content)]) ].map(row => row.map(escape).join(",")).join("\r\n");
}
export async function knowledgeRoute(
  request: IncomingMessage, response: ServerResponse, url: URL, projectId: string, subpath: string,
  store: TrashStore, knowledge: KnowledgeStore, readJson: (r: IncomingMessage) => Promise<unknown>,
  send: (r: ServerResponse, status: number, value: unknown) => void, runner: TaskRunner
): Promise<boolean> {
  const method = request.method ?? "GET";
  const parts = subpath.split("/");
  if (parts[0] === "sources" && parts[1] && ["details", "parsed", "original", "attachments", "duplicates", "merge"].includes(parts[2])) {
    const sourceId = decodeURIComponent(parts[1]);
    const source = store.getSource(sourceId);
    if (!source || source.project_id !== projectId) requestError("SOURCE_NOT_FOUND", 404);
    if (parts[2] === "duplicates" && method === "GET") {
      const doi=(value:string|undefined)=>value?.replace(/^https?:\/\/doi.org\//i,"").trim().toLowerCase();
      send(response,200,{sources:store.listSources(projectId).filter(s=>s.source_id!==sourceId && (doi(source.doi) && doi(s.doi)===doi(source.doi) || source.imported_file_sha256 && s.imported_file_sha256===source.imported_file_sha256))});return true;
    }
    if (parts[2] === "merge" && method === "POST") {
      const input=z.object({target_source_id:z.string().min(1)}).strict().parse(await readJson(request));
      const target=store.getSource(input.target_source_id);
      if(!target || target.project_id!==projectId || target.source_id===sourceId)requestError("INVALID_MERGE_TARGET");
      const getDetails=(id:string)=>{const row=store.db.prepare("SELECT data FROM source_details WHERE source_id=?").get(id) as {data:string}|undefined;return row?JSON.parse(row.data) as Record<string,unknown>:{};};
      if(getDetails(target.source_id).merged_into || getDetails(sourceId).merged_into)requestError("SOURCE_ALREADY_MERGED",409);
      store.db.transaction(()=>{
        const details={...getDetails(sourceId),merged_into:target.source_id};
        store.db.prepare("INSERT INTO source_details VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET data=excluded.data").run(sourceId,JSON.stringify(details));
        const artifacts=new Set([source.artifact_id,...(store.db.prepare("SELECT artifact_id FROM source_attachments WHERE source_id=?").all(sourceId) as {artifact_id:string}[]).map(a=>a.artifact_id)]);
        for(const artifact of artifacts)if(artifact)store.db.prepare("INSERT OR IGNORE INTO source_attachments VALUES (?,?,?)").run(target.source_id,artifact,new Date().toISOString());
        const updated=sourceSchema.parse({...target,...(!target.doi&&source.doi?{doi:source.doi}:{}),...(!target.authors.length?{authors:source.authors}:{}),...(!target.year&&source.year?{year:source.year}:{}),...(!target.abstract&&source.abstract?{abstract:source.abstract}:{})});
        store.db.prepare("UPDATE sources SET data=? WHERE source_id=?").run(JSON.stringify(updated),target.source_id);
        knowledge.touch(projectId);
      })();
      send(response,200,{merged_into:target.source_id,preserved_source_id:sourceId});return true;
    }
    if (parts[2] === "details") {
      if (method === "GET") {
        const row = store.db.prepare("SELECT data FROM source_details WHERE source_id=?").get(sourceId) as { data: string } | undefined;
        send(response, 200, { details: row ? JSON.parse(row.data) : sourceDetailsSchema.parse({}), source, bibliography:bibliographyState(store,sourceId) }); return true;
      }
      if (method === "PUT") {
        const details = sourceDetailsSchema.parse(await readJson(request));
        const oldDetails=store.db.prepare("SELECT data FROM source_details WHERE source_id=?").get(sourceId) as {data:string}|undefined;
        const mergedInto=oldDetails?(JSON.parse(oldDetails.data) as {merged_into?:string}).merged_into:undefined;
        store.db.transaction(() => {
          const updated = { ...source, ...Object.fromEntries(Object.entries(details).filter(([key]) => ["title", "authors", "year", "publication_date", "doi"].includes(key))) };
          if(details.publication_date)updated.year=Number(details.publication_date.slice(0,4));
          const metadata=bibliographyState(store,sourceId),manual=new Set(metadata.manual??[]);
          const before={authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date};
          if(details.authors!==undefined&&JSON.stringify(details.authors)!==JSON.stringify(source.authors))manual.add('authors');
          if(details.title!==undefined&&details.title!==source.title)manual.add('title');
          if((details.publication_date!==undefined&&details.publication_date!==source.publication_date)||(details.year!==undefined&&details.year!==source.year))manual.add('publication_date');
          // Confirming a suggested value is an explicit human decision, even if unchanged.
          if(details.title!==undefined&&metadata.suggestion?.title===details.title)manual.add('title');
          if(details.publication_date!==undefined&&metadata.suggestion?.publication_date===details.publication_date)manual.add('publication_date');
          if(details.year!==undefined&&!details.publication_date&&details.year!==source.year)delete updated.publication_date;
          metadata.manual=[...manual];metadata.revision=(metadata.revision??0)+1;
          if(metadata.suggestion){if(details.authors&&JSON.stringify(details.authors)===JSON.stringify(metadata.suggestion.authors)){manual.add('authors');metadata.manual=[...manual];delete metadata.suggestion.authors;}if(details.title===metadata.suggestion.title)delete metadata.suggestion.title;if(details.publication_date===metadata.suggestion.publication_date)delete metadata.suggestion.publication_date;if(!metadata.suggestion.authors&&!metadata.suggestion.title&&!metadata.suggestion.publication_date)metadata.suggestion=undefined;}
          const after={authors:updated.authors,title:updated.title,year:updated.year,publication_date:updated.publication_date};
          if(JSON.stringify(before)!==JSON.stringify(after))metadata.history=[...(metadata.history??[]),{at:new Date().toISOString(),before,after,reason:'user-metadata'}];
          saveBibliographyState(store,sourceId,metadata);
          if (details.doi) {
            const normalized = details.doi.replace(/^https?:\/\/doi.org\//i, "").trim().toLowerCase();
            if (store.listSources(projectId).some(s => s.source_id !== sourceId && s.doi?.replace(/^https?:\/\/doi.org\//i, "").trim().toLowerCase() === normalized)) requestError("DUPLICATE_DOI", 409);
          }
          store.db.prepare("UPDATE sources SET data=? WHERE source_id=?").run(JSON.stringify(updated), sourceId);
          store.db.prepare("INSERT INTO source_details VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET data=excluded.data").run(sourceId, JSON.stringify({...details,...(mergedInto?{merged_into:mergedInto}:{})}));
          knowledge.touch(projectId);
        })();
        send(response, 200, { details }); return true;
      }
    }
    if (parts[2] === "parsed" && method === "GET") {
      const segments=store.listSourceSegments(sourceId);
      send(response,200,{source,segments});return true;
    }
    if (parts[2] === "original" && method === "GET") {
      const artifactId = url.searchParams.get("artifact_id") ?? source.artifact_id;
      const linked = artifactId && (artifactId === source.artifact_id || store.db.prepare("SELECT 1 FROM source_attachments WHERE source_id=? AND artifact_id=?").get(sourceId, artifactId));
      const file = linked && artifactId ? store.artifactFile(projectId, artifactId) : undefined;
      if (!file) requestError("NOT_FOUND", 404);
      response.writeHead(200, { "content-type": source.source_type === "pdf" || file.artifact.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.artifact.name)}`, "x-content-type-options": "nosniff", "cache-control": "no-store" });
      const stream = createReadStream(file.path); stream.on("error", () => response.destroy()); stream.pipe(response); return true;
    }
    if (parts[2] === "attachments" && method === "GET") {
      send(response, 200, { attachments: store.db.prepare("SELECT artifact_id,created_at FROM source_attachments WHERE source_id=? ORDER BY created_at DESC").all(sourceId) }); return true;
    }
  }
  const kind = kinds[parts[0] as keyof typeof kinds] as KnowledgeKind | undefined;
  if (kind && kind !== 'experiment-result') {
    if(method==='GET'){const {markdownVersions}=await import('./markdown-knowledge.js');const records=markdownVersions(store,projectId,kind);const record=parts[1]?records.find(item=>item.object_id===parts[1]):undefined;if(parts[1]&&!record)requestError('NOT_FOUND',404);send(response,200,parts[1]?{record}:{records,total:records.length,page:1,limit:records.length});return true;}
    requestError('MARKDOWN_DIRECT_WRITE_REQUIRED',409);
  }
  if (kind) {
    const id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    if (!id && method === "GET") {
      const filters = Object.fromEntries(url.searchParams);
      const records = knowledge.list(projectId, kind, filters);
      if (filters.format === "csv") {
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="knowledge.csv"' }); response.end(csv(records)); return true;
      }
      if (filters.format === "json") { send(response, 200, { records }); return true; }
      const page = z.coerce.number().int().min(1).parse(filters.page ?? 1), limit = z.coerce.number().int().min(1).max(100).parse(filters.limit ?? 20);
      send(response, 200, { records: records.slice((page - 1) * limit, page * limit).map(v => ({ ...v, stale: knowledge.stale(v) })), total: records.length, page, limit }); return true;
    }
    if (!id && method === "POST") {
      const input = knowledgeWriteSchema.parse(await readJson(request));
      send(response, 201, { record: knowledge.write(projectId, kind, input) }); return true;
    }
    if (id && parts[2] === "history" && method === "GET") {
      send(response, 200, { records: knowledge.history(projectId, kind, id), reviews: store.db.prepare("SELECT * FROM knowledge_reviews WHERE object_id=? ORDER BY at DESC").all(knowledge.get(projectId, kind, id)?.object_id ?? "") }); return true;
    }
    if (id && parts[2] === "review" && method === "POST") {
      const input = z.object({ version: z.number().int().positive(), decision: z.enum(["accepted", "rejected"]), comment: z.string().max(10000).default("") }).strict().parse(await readJson(request));
      send(response, 200, { record: knowledge.review(projectId, kind, id, input.version, input.decision, input.comment) }); return true;
    }
    if (id && parts.length === 2 && method === "GET") {
      const version = url.searchParams.has("version") ? z.coerce.number().int().positive().parse(url.searchParams.get("version")) : undefined;
      const record = knowledge.get(projectId, kind, id, version);
      if (!record) requestError("NOT_FOUND", 404);
      send(response, 200, { record, stale: knowledge.stale(record) }); return true;
    }
    if (id && parts.length === 2 && method === "PUT") {
      const input = knowledgeWriteSchema.omit({ object_id: true }).parse(await readJson(request));
      send(response, 200, { record: knowledge.write(projectId, kind, { ...input, object_id: id }) }); return true;
    }
    if (kind === "experiment-result" && id === "aggregate" && method === "POST") {
      const input = z.object({ ids: z.array(z.string()).min(1).max(100), metric: z.string().min(1) }).strict().parse(await readJson(request));
      const records = [...new Set(input.ids)].map(key => knowledge.get(projectId, kind, key) ?? requestError("NOT_FOUND", 404));
      const results = records.map(v => experimentResultSchema.parse(v.content));
      const signature = (r: typeof results[number]) => JSON.stringify([r.method,r.dataset,r.dataset_version,r.task,r.split,r.evaluation_protocol,r.evaluation?[r.evaluation.granularity,r.evaluation.positive_class,r.evaluation.threshold,r.evaluation.averaging]:null,r.confusion_matrix?[r.confusion_matrix.negative_label,r.confusion_matrix.positive_label]:null,r.config]);
      if (new Set(results.map(signature)).size !== 1) requestError("INCOMPATIBLE_CONDITIONS", 409);
      const metrics = results.map(r => { const matches = r.metrics.filter(m => m.name === input.metric); if (matches.length !== 1) requestError("METRIC_MISSING_OR_AMBIGUOUS"); return matches[0]; });
      if (new Set(metrics.map(m => JSON.stringify([m.unit,m.condition,m.source??"manual"]))).size !== 1) requestError("INCOMPATIBLE_CONDITIONS", 409);
      const mean = metrics.reduce((s,m) => s+m.value,0)/metrics.length;
      send(response, 200, { count: metrics.length, mean, sample_stddev: metrics.length > 1 ? Math.sqrt(metrics.reduce((s,m) => s+(m.value-mean)**2,0)/(metrics.length-1)) : null, unit: metrics[0].unit, condition: metrics[0].condition }); return true;
    }
  }
  if (parts[0] === "knowledge-tasks") {
    if (!parts[1] && method === "GET") {
      send(response,200,url.searchParams.get('summary')==='true'?listTasks(store,projectId,url):{
        tasks:knowledge.tasks(projectId).filter(task=>!(task as {archived_duplicate?:boolean}).archived_duplicate&&!(task as {deleted_at?:string}).deleted_at)
      });
      return true;
    }
    if (!parts[1] && method === "POST") { send(response, 201, { tasks: runner.enqueue(projectId, knowledgeTaskInputSchema.parse(await readJson(request))) }); return true; }
    const task = knowledge.task(projectId,parts[1]);
    if (!task) requestError("NOT_FOUND", 404);
    if(!parts[2]&&method==='DELETE'){
      z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));
      // Logical deletion preserves retry ancestry, workflow references and recovery files.
      const result=store.db.prepare("UPDATE knowledge_tasks SET data=json_set(data,'$.deleted_at',?) WHERE task_id=? AND project_id=? AND status='failed'").run(new Date().toISOString(),task.task_id,projectId);
      if(!result.changes)requestError('TASK_DELETE_FAILED_ONLY',409);
      send(response,200,{deleted:true,files_preserved:true});return true;
    }
    if(parts[2]==='events'&&method==='GET'){send(response,200,taskEventPage(store,task,eventOptions(url),runner.resumable?.bind(runner)));return true;}
    if(parts[2]==='stream'&&method==='GET'){streamTaskEvents(store,task,request,response,url,runner.resumable?.bind(runner));return true;}
    if (parts[2] === "cancel" && method === "POST") { runner.cancel(projectId, task.task_id); send(response,200,{ok:true}); return true; }
    if (parts[2] === "retry" && method === "POST") { if (["running","queued"].includes(task.status)) requestError("TASK_ACTIVE",409); send(response,201,{tasks:runner.enqueue(projectId,{...task.input,timeout_seconds:task.input.timeout_seconds===900?1800:task.input.timeout_seconds,regenerate:true},task.task_id)}); return true; }
    if (method === "GET") { send(response,200,{task,events:store.db.prepare("SELECT seq,at,message FROM knowledge_task_events WHERE task_id=? ORDER BY seq LIMIT 1000").all(task.task_id)}); return true; }
  }
  if (subpath === "wiki-templates" && method === "GET") {
    send(response,200,{templates:["研究问题","方法路线","数据集与评价方式","可借鉴思路","待验证假设"].map(title=>({title,tags:[],body:"## 当前认识\n\n## 相关文献与不同观点\n\n## 待验证事项",dependencies:[]}))});return true;
  }
  if (subpath === "experiment-template" && method === "GET") {
    send(response,200,{ schema_version:1,title:"实验运行",method:"",dataset:"",dataset_version:"",task:"",split:"",evaluation_protocol:"",config:{},environment:{},metrics:[{name:"accuracy",value:0,unit:"ratio",condition:""}],attachments:[],notes:"" }); return true;
  }
  if (subpath === "wiki-export" && method === "GET") {
    const {markdownVersions}=await import("./markdown-knowledge.js");
    const pages=markdownVersions(store,projectId,"wiki-page");
    const index=pages.map(p=>`- [${p.title}](#${p.object_id})`).join("\n");
    const body=pages.map(p=>`<a id="${p.object_id}"></a>\n\n# ${p.title}\n\n${"body" in p.content?p.content.body:""}\n\n引用对象：\n${"dependencies" in p.content?p.content.dependencies.map(d=>`- ${d.kind}: ${d.object_id} v${d.version}`).join("\n"):""}`).join("\n\n---\n\n");
    response.writeHead(200,{"content-type":"text/markdown; charset=utf-8","content-disposition":'attachment; filename="project-wiki.md"'});response.end(`# 项目 Wiki\n\n${index}\n\n${body}`);return true;
  }
  if (subpath === "knowledge-export" && method === "GET") {
    const project = store.getProject(projectId)!;
    const sources = store.listSources(projectId);
    const files = (store.db.prepare("SELECT artifact_id FROM artifacts WHERE project_id=?").all(projectId) as {artifact_id:string}[]).map(row => {
      const file = store.artifactFile(projectId,row.artifact_id);
      return file ? { artifact:file.artifact, bytes:Buffer.from(store.readArtifact(projectId,row.artifact_id)!).toString("base64") } : undefined;
    }).filter(Boolean);
    const {MarkdownKnowledge}=await import("./markdown-knowledge.js");
    const markdown_files=new MarkdownKnowledge(store).list(projectId).documents.map(({path,text})=>({path,text}));
    const records = (["experiment-result"] as KnowledgeKind[]).flatMap(k => knowledge.list(projectId,k).flatMap(v => knowledge.history(projectId,k,v.object_id))).sort((a,b)=>a.created_at.localeCompare(b.created_at));
    send(response,200,{schema_version:1,project,markdown_files,sources:sources.map(source=>({source,segments:store.listSourceSegments(source.source_id),details:(store.db.prepare("SELECT data FROM source_details WHERE source_id=?").get(source.source_id) as {data:string}|undefined)?.data})),files,records,attachments:store.db.prepare("SELECT a.* FROM source_attachments a JOIN sources s ON s.source_id=a.source_id WHERE s.project_id=?").all(projectId), reviews:store.db.prepare("SELECT r.* FROM knowledge_reviews r WHERE r.object_id IN (SELECT object_id FROM knowledge_versions WHERE project_id=?)").all(projectId)}); return true;
  }
  return false;
}
