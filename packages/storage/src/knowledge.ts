import { existsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changedMarkdown, parseMarkdown, publishKnowledge, recoverKnowledge, publishKnowledgeHistory } from "./knowledge-markdown.js";
import { randomUUID } from "node:crypto";
import { parseKnowledge, type KnowledgeKind, type KnowledgeVersion, type KnowledgeTaskInput } from "@trash/protocol";
import type Database from "better-sqlite3";

const fail = (code: string, statusCode: number): never => { throw Object.assign(new Error(code), { statusCode }); };
export interface KnowledgeTask { task_id: string; project_id: string; input: KnowledgeTaskInput; snapshot: unknown; fingerprint: string; status: string; created_at: string; output_id?: string; output_version?: number; error?: string; attempt_of?: string; topic_draft?:{files:{path:string;hash:string}[]} }
export class KnowledgeStore {
  private syncing = false;
  constructor(readonly db: Database.Database) {}
  private workspace(projectId:string):string|undefined {
    const file=(this.db.pragma('database_list') as {name:string;file:string}[]).find(row=>row.name==='main')?.file;
    if(!file)return;
    const root=join(dirname(file),'projects',projectId);
    const marker=join(root,'project.yaml');
    if(!existsSync(marker)){
      try{if(lstatSync(root).isSymbolicLink())fail('KNOWLEDGE_FILE_MISSING',409);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return;
    }
    if(!readFileSync(marker,'utf8').includes(JSON.stringify(projectId)))fail('KNOWLEDGE_FILE_CONFLICT',409);
    return root;
  }
  private recoverProject(projectId:string):void {
    if(this.db.inTransaction||this.syncing)return;
    const root=this.workspace(projectId);if(!root)return;
    const directory=join(root,'.trash','knowledge-pending');if(!existsSync(directory))return;
    for(const name of readdirSync(directory)){
      if(!/^knowledge_[A-Za-z0-9-]+\.json$/.test(name))continue;
      const id=name.slice(0,-5);
      const row=this.db.prepare('SELECT data FROM knowledge_versions WHERE project_id=? AND object_id=? ORDER BY version DESC LIMIT 1').get(projectId,id) as {data:string}|undefined;
      recoverKnowledge(root,row?JSON.parse(row.data) as KnowledgeVersion:undefined,id);
    }
  }
  private reconcile(record:KnowledgeVersion):KnowledgeVersion {
    if(this.syncing||this.db.inTransaction||record.kind==='experiment-result')return record;
    const root=this.workspace(record.project_id);if(!root)return record;
    if(!this.db.inTransaction)recoverKnowledge(root,record,record.object_id);
    const text=changedMarkdown(root,record);if(text===undefined)return record;
    this.syncing=true;
    try{return this.write(record.project_id,record.kind,{object_id:record.object_id,base_version:record.version,content:parseMarkdown(text,record)});}
    catch(error){if(error&&typeof error==='object'&&'issues' in error)fail('KNOWLEDGE_FILE_INVALID',409);throw error;}
    finally{this.syncing=false;}
  }
  private publish(record:KnowledgeVersion):void {
    const root=this.workspace(record.project_id);if(root)publishKnowledge(root,record);
  }
  touch(projectId: string): void {
    const at = new Date().toISOString();
    this.db.prepare("UPDATE projects SET updated_at=?, data=json_set(data,'$.updated_at',?) WHERE project_id=?").run(at, at, projectId);
  }
  get(projectId: string, kind: KnowledgeKind, id: string, version?: number): KnowledgeVersion | undefined {
    this.recoverProject(projectId);
    const row = (version
      ? this.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=? AND kind=? AND object_id=? AND version=?").get(projectId, kind, id, version)
      : this.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=? AND kind=? AND object_id=? ORDER BY version DESC LIMIT 1").get(projectId, kind, id)) as { data: string } | undefined;
    const record=row ? JSON.parse(row.data) as KnowledgeVersion : undefined;
    return record && !version ? this.reconcile(record) : record;
  }
  materializeHistory(projectId:string,records:KnowledgeVersion[]):void {
    const root=this.workspace(projectId);if(root)for(const record of records)publishKnowledgeHistory(root,record);
  }
  history(projectId: string, kind: KnowledgeKind, id: string): KnowledgeVersion[] {
    this.get(projectId,kind,id);
    return (this.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=? AND kind=? AND object_id=? ORDER BY version DESC").all(projectId, kind, id) as { data: string }[]).map(r => JSON.parse(r.data) as KnowledgeVersion);
  }
  list(projectId: string, kind: KnowledgeKind, filters: Record<string, string> = {}): KnowledgeVersion[] {
    this.recoverProject(projectId);
    const rows = this.db.prepare(`SELECT v.data FROM knowledge_versions v WHERE v.project_id=? AND v.kind=? AND v.version=(SELECT MAX(h.version) FROM knowledge_versions h WHERE h.object_id=v.object_id)` ).all(projectId, kind) as { data: string }[];
    return rows.map(r => this.reconcile(JSON.parse(r.data) as KnowledgeVersion)).filter(v => {
      if (filters.status && v.status !== filters.status) return false;
      const c = { ...v.content } as unknown as Record<string, unknown>;
      if (kind === "literature-card") {
        const source = this.db.prepare("SELECT data FROM sources WHERE source_id=? AND project_id=?").get(c.source_id,projectId) as {data:string}|undefined;
        const details = this.db.prepare("SELECT data FROM source_details WHERE source_id=?").get(c.source_id) as {data:string}|undefined;
        Object.assign(c, source ? JSON.parse(source.data) : {}, details ? JSON.parse(details.data) : {});
      }
      return Object.entries(filters).every(([key, value]) => !value || ["status", "page", "limit", "format", "sort"].includes(key) ||
        String(key === "q" ? JSON.stringify(c) : typeof c[key] === "object" ? JSON.stringify(c[key]) : c[key] ?? "").toLowerCase().includes(value.toLowerCase()));
    }).sort((a, b) => filters.sort === "title" ? a.title.localeCompare(b.title) : b.created_at.localeCompare(a.created_at));
  }
  validateRefs(projectId: string, kind: KnowledgeKind, content: ReturnType<typeof parseKnowledge>): void {
    const c = content as unknown as Record<string, unknown>;
    const sourceIds = new Set<string>();
    if (kind === "literature-card") sourceIds.add(String(c.source_id));
    for (const e of (c.evidence ?? []) as { source_id: string }[]) sourceIds.add(e.source_id);
    for (const sourceId of sourceIds) {
      if (!this.db.prepare("SELECT 1 FROM sources WHERE source_id=? AND project_id=?").get(sourceId, projectId)) fail("SOURCE_NOT_FOUND", 404);
    }
    for (const e of (c.evidence ?? []) as { source_id:string; page?:number; paragraph?:number; quote?:string; file_sha256?:string }[]) {
      const row = this.db.prepare("SELECT data FROM sources WHERE source_id=? AND project_id=?").get(e.source_id,projectId) as {data:string};
      const source = JSON.parse(row.data) as {imported_file_sha256?:string};
      if (e.file_sha256 && source.imported_file_sha256 !== e.file_sha256) fail("SOURCE_VERSION_CONFLICT",409);
      if (e.page || e.paragraph) {
        const locator = e.page ? {kind:"pdf_page",page_number:e.page} : {kind:"paragraph",paragraph_index:e.paragraph};
        const segments = this.db.prepare("SELECT locator_json,content FROM source_segments WHERE source_id=?").all(e.source_id) as {locator_json:string;content:string}[];
        const matches = segments.filter(s => {const value=JSON.parse(s.locator_json);return value.kind===locator.kind && (e.page?value.page_number===e.page:value.paragraph_index===e.paragraph);});
        if (!matches.length || e.quote && !matches.some(s=>s.content.replace(/\s+/g," ").includes(e.quote!.replace(/\s+/g," ")))) fail("EVIDENCE_LOCATION_INVALID",400);
      } else if (e.quote) fail("EVIDENCE_LOCATION_REQUIRED",400);
    }
    for (const d of (c.dependencies ?? []) as { kind: KnowledgeKind; object_id: string; version: number }[]) {
      if (!this.get(projectId, d.kind, d.object_id, d.version)) fail("DEPENDENCY_NOT_FOUND", 404);
    }
  }
  write(projectId: string, kind: KnowledgeKind, input: { object_id?: string; base_version: number; content: unknown }, author: "user" | "agent" = "user"): KnowledgeVersion {
    if(!this.syncing){
      const current=input.object_id?this.get(projectId,kind,input.object_id):kind==='literature-card'?this.list(projectId,kind).find(record=>'source_id' in record.content && record.content.source_id===(input.content as {source_id?:string})?.source_id):undefined;
      if(current && current.version!==input.base_version)fail('VERSION_CONFLICT',409);
    }
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM projects WHERE project_id=?").get(projectId)) fail("PROJECT_NOT_FOUND", 404);
      const content = parseKnowledge(kind, input.content);
      this.validateRefs(projectId, kind, content);
      if (kind === "literature-card" && "source_id" in content) {
        const sourceRow = this.db.prepare("SELECT data FROM sources WHERE source_id=? AND project_id=?").get(content.source_id,projectId) as {data:string};
        const hash = (JSON.parse(sourceRow.data) as {imported_file_sha256?:string}).imported_file_sha256;
        if (author === "agent" && content.source_file_sha256 && content.source_file_sha256 !== hash) fail("SOURCE_VERSION_CONFLICT",409);
        if (hash) content.source_file_sha256 = hash;
      }
      let id = input.object_id;
      const c = content as unknown as Record<string, unknown>;
      if (!id && kind === "literature-card") {
        const match = this.db.prepare("SELECT object_id FROM knowledge_keys WHERE project_id=? AND kind=? AND natural_key=?").get(projectId, kind, String(c.source_id)) as { object_id: string } | undefined;
        if (match) id = match.object_id;
      }
      const previous = id ? this.get(projectId, kind, id) : undefined;
      if (id && !previous) fail("NOT_FOUND", 404);
      if ((previous?.version ?? 0) !== input.base_version) fail("VERSION_CONFLICT", 409);
      if (previous && kind === "literature-card" && (previous.content as { source_id: string }).source_id !== c.source_id) fail("SOURCE_IMMUTABLE", 400);
      id ??= `knowledge_${randomUUID()}`;
      const naturalKey = kind === "literature-card" ? String(c.source_id) : kind === "experiment-result" ? c.external_run_id as string | undefined : undefined;
      if (previous && kind === "experiment-result" && !naturalKey) this.db.prepare("DELETE FROM knowledge_keys WHERE object_id=?").run(id);
      if (naturalKey) {
        const existing = this.db.prepare("SELECT object_id FROM knowledge_keys WHERE project_id=? AND kind=? AND natural_key=?").get(projectId, kind, naturalKey) as { object_id: string } | undefined;
        if (existing && existing.object_id !== id) fail("DUPLICATE_RECORD", 409);
        this.db.prepare("DELETE FROM knowledge_keys WHERE object_id=?").run(id);
        this.db.prepare("INSERT INTO knowledge_keys VALUES (?,?,?,?)").run(projectId, kind, naturalKey, id);
      }
      const record: KnowledgeVersion = { object_id: id, project_id: projectId, kind, version: (previous?.version ?? 0) + 1, status: author === "agent" ? "pending" : "draft", title: content.title, content, created_by: author, created_at: new Date().toISOString() };
      this.db.prepare("INSERT INTO knowledge_versions VALUES (?,?,?,?,?,?)").run(id, record.version, projectId, kind, record.title, JSON.stringify(record));
      if (kind === "experiment-result" && "metrics" in content) {
        for (const metric of content.metrics) if (typeof metric !== "string") this.db.prepare("INSERT INTO knowledge_metrics VALUES (?,?,?,?,?,?,?)").run(id, record.version, metric.name, metric.value, metric.unit, metric.condition, projectId);
      }
      this.touch(projectId);
      this.publish(record);
      return record;
    })();
  }
  review(projectId: string, kind: KnowledgeKind, id: string, version: number, decision: "accepted" | "rejected", comment: string): KnowledgeVersion {
    const latest=this.get(projectId,kind,id);
    return this.db.transaction(() => {
      const record = this.get(projectId, kind, id, version) ?? fail("NOT_FOUND", 404);
      record.status = decision;
      this.db.prepare("UPDATE knowledge_versions SET data=? WHERE object_id=? AND version=?").run(JSON.stringify(record), id, version);
      this.db.prepare("INSERT INTO knowledge_reviews VALUES (?,?,?,?,?,?)").run(id, version, decision, comment, "user", new Date().toISOString());
      this.touch(projectId);
      if(latest?.version===version)this.publish(record);
      else {const root=this.workspace(projectId);if(root)publishKnowledgeHistory(root,record);}
      return record;
    })();
  }
  stale(record: KnowledgeVersion, seen = new Set<string>()): boolean {
    if (seen.has(record.object_id)) return false;
    seen.add(record.object_id);
    if ("source_id" in record.content) {
      const row = this.db.prepare("SELECT data FROM sources WHERE source_id=? AND project_id=?").get(record.content.source_id,record.project_id) as {data:string}|undefined;
      return !row || record.content.source_file_sha256 !== (JSON.parse(row.data) as {imported_file_sha256?:string}).imported_file_sha256;
    }
    if (!("dependencies" in record.content)) return false;
    return record.content.dependencies.some(d => {
      const current=this.get(record.project_id,d.kind,d.object_id);
      return !current || current.version!==d.version || this.stale(current,seen);
    });
  }
  tasks(projectId: string): KnowledgeTask[] {
    return (this.db.prepare("SELECT data FROM knowledge_tasks WHERE project_id=? ORDER BY created_at DESC").all(projectId) as { data: string }[]).map(r => JSON.parse(r.data) as KnowledgeTask);
  }
  saveTask(task: KnowledgeTask): void {
    this.db.prepare("INSERT INTO knowledge_tasks VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data").run(task.task_id, task.project_id, task.status, task.created_at, JSON.stringify(task));
    this.db.prepare("UPDATE knowledge_tasks SET status=? WHERE task_id=?").run(task.status, task.task_id);
  }
  event(taskId: string, message: string): void {
    this.db.prepare("INSERT INTO knowledge_task_events(task_id,at,message) VALUES (?,?,?)").run(taskId, new Date().toISOString(), message.slice(0, 10000));
  }
}
