import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { makeId, researchProjectSchema, sourceSchema, type Artifact, type EvidencePassage, type ResearchProject, type Source, type SourceLocator } from "@trash/protocol";

export interface SourceSegmentInput {
  locator: SourceLocator;
  text: string;
}

export interface StoredSourceSegment extends SourceSegmentInput {
  source_id: string;
  ordinal: number;
}

export function getWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRASH_HOME) return resolve(env.TRASH_HOME);
  if (process.platform === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "trash");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "trash");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "trash");
}

export { ExperimentStore, experimentError } from "./experiment.js";
export { KnowledgeStore } from "./knowledge.js";
export type { KnowledgeTask } from "./knowledge.js";

export class TrashStore {
  readonly root: string;
  readonly db: Database.Database;

  constructor(root = getWorkspaceRoot()) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "projects"), { recursive: true });
    this.db = new Database(join(this.root, "workspace.sqlite"));
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 3) throw new Error("DATABASE_VERSION_TOO_NEW");
    if (version === 3) return;
    if (version === 2) this.db.exec(`VACUUM INTO '${join(this.root, `workspace-before-v3-${Date.now()}.sqlite`).replace(/'/g, "''")}'`);
    if (version === 1) {
      this.db.exec(`VACUUM INTO '${join(this.root, `workspace-before-v2-${Date.now()}.sqlite`).replace(/'/g, "''")}'`);
    }
    if (version < 1) {
    this.db.exec(`
      BEGIN EXCLUSIVE;
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        sha256 TEXT NOT NULL
      );
      CREATE INDEX artifacts_project_hash ON artifacts(project_id, sha256);
      CREATE TABLE sources (
        source_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        artifact_id TEXT REFERENCES artifacts(artifact_id),
        imported_file_sha256 TEXT,
        data TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE INDEX sources_project_imported ON sources(project_id, imported_at DESC);
      CREATE INDEX sources_project_hash ON sources(project_id, imported_file_sha256);
      CREATE TABLE source_segments (
        segment_id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        locator_json TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(source_id, ordinal)
      );
      CREATE VIRTUAL TABLE source_segments_fts USING fts5(
        source_id UNINDEXED,
        project_id UNINDEXED,
        locator_json UNINDEXED,
        content,
        tokenize='unicode61'
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
    }
    if (version < 2) this.db.exec(`
      BEGIN EXCLUSIVE;
      CREATE TABLE managed_files (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id), relative_path TEXT NOT NULL);
      CREATE TABLE source_details (source_id TEXT PRIMARY KEY REFERENCES sources(source_id), data TEXT NOT NULL);
      CREATE TABLE source_attachments (source_id TEXT NOT NULL REFERENCES sources(source_id), artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), created_at TEXT NOT NULL, PRIMARY KEY(source_id,artifact_id));
      CREATE TABLE knowledge_versions (object_id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id), kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(object_id,version));
      CREATE INDEX knowledge_project_kind ON knowledge_versions(project_id,kind,title);
      CREATE TABLE knowledge_keys (project_id TEXT NOT NULL, kind TEXT NOT NULL, natural_key TEXT NOT NULL, object_id TEXT NOT NULL, PRIMARY KEY(project_id,kind,natural_key));
      CREATE TABLE knowledge_metrics (object_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, condition TEXT NOT NULL, project_id TEXT NOT NULL);
      CREATE INDEX knowledge_metric_lookup ON knowledge_metrics(project_id,name,unit);
      CREATE TABLE knowledge_reviews (object_id TEXT NOT NULL, version INTEGER NOT NULL, decision TEXT NOT NULL, comment TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE knowledge_tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE knowledge_task_events (seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES knowledge_tasks(task_id), at TEXT NOT NULL, message TEXT NOT NULL);
      PRAGMA user_version = 2;
      COMMIT;
    `);
    this.db.exec(`
      BEGIN EXCLUSIVE;
      CREATE TABLE experiment_repositories(project_id TEXT PRIMARY KEY REFERENCES projects(project_id),data TEXT NOT NULL);
      CREATE TABLE experiment_profiles(profile_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),data TEXT NOT NULL);
      CREATE TABLE experiment_environments(snapshot_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),profile_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE experiment_datasets(dataset_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),data TEXT NOT NULL);
      CREATE TABLE experiment_plans(plan_id TEXT NOT NULL,version INTEGER NOT NULL,project_id TEXT NOT NULL REFERENCES projects(project_id),data TEXT NOT NULL,PRIMARY KEY(plan_id,version));
      CREATE TABLE experiment_runs(run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),profile_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX experiment_run_queue ON experiment_runs(profile_id,status,created_at);
      CREATE TABLE experiment_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),type TEXT NOT NULL,at TEXT NOT NULL,message TEXT NOT NULL);
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  createProject(input: Omit<ResearchProject, "protocol_version" | "project_id" | "status" | "created_at" | "updated_at">): ResearchProject {
    const createdAt = new Date().toISOString();
    const project = researchProjectSchema.parse({
      ...input,
      protocol_version: "v1",
      project_id: makeId("project"),
      status: "active",
      created_at: createdAt,
      updated_at: createdAt
    });
    this.db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(project.project_id, JSON.stringify(project), createdAt, createdAt);
    return project;
  }

  getProject(projectId: string): ResearchProject | undefined {
    const row = this.db.prepare("SELECT data FROM projects WHERE project_id = ?").get(projectId) as { data: string } | undefined;
    return row ? researchProjectSchema.parse(JSON.parse(row.data)) : undefined;
  }

  listProjects(): ResearchProject[] {
    const rows = this.db.prepare("SELECT data FROM projects ORDER BY updated_at DESC").all() as Array<{ data: string }>;
    return rows.map((row) => researchProjectSchema.parse(JSON.parse(row.data)));
  }

  deleteProject(projectId: string): { deleted: boolean; cleanup_pending: boolean } {
    const project = this.getProject(projectId);
    if (!project) return { deleted: false, cleanup_pending: false };
    const active = this.db.prepare("SELECT 1 FROM knowledge_tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId);
    if (active) throw Object.assign(new Error("PROJECT_HAS_ACTIVE_TASKS"), { statusCode: 409 });

    const remoteActive = this.db.prepare("SELECT 1 FROM experiment_runs WHERE project_id=? AND status NOT IN ('completed','failed','cancelled') LIMIT 1").get(projectId);
    if (remoteActive) throw Object.assign(new Error("EXPERIMENT_ACTIVE"), { statusCode: 409 });
    const directory = join(this.root, "projects", project.project_id);
    const quarantine = join(this.root, "deleted-projects", `${project.project_id}-${makeId("artifact")}`);
    const hasFiles = existsSync(directory);
    const externalWorkspace = hasFiles && lstatSync(directory).isSymbolicLink();
    if (hasFiles) {
      mkdirSync(join(this.root, "deleted-projects"), { recursive: true });
      renameSync(directory, quarantine);
    }
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM experiment_events WHERE run_id IN (SELECT run_id FROM experiment_runs WHERE project_id=?)").run(projectId);
        for (const table of ["experiment_runs","experiment_plans","experiment_environments","experiment_datasets","experiment_profiles","experiment_repositories"]) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
        this.db.prepare("DELETE FROM knowledge_task_events WHERE task_id IN (SELECT task_id FROM knowledge_tasks WHERE project_id=?)").run(projectId);
        this.db.prepare("DELETE FROM knowledge_tasks WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM knowledge_reviews WHERE object_id IN (SELECT object_id FROM knowledge_versions WHERE project_id=?)").run(projectId);
        this.db.prepare("DELETE FROM knowledge_metrics WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM knowledge_keys WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM knowledge_versions WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM source_details WHERE source_id IN (SELECT source_id FROM sources WHERE project_id=?)").run(projectId);
        this.db.prepare("DELETE FROM source_attachments WHERE source_id IN (SELECT source_id FROM sources WHERE project_id=?)").run(projectId);
        this.db.prepare("DELETE FROM source_segments_fts WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM sources WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM managed_files WHERE artifact_id IN (SELECT artifact_id FROM artifacts WHERE project_id=?)").run(projectId);
        this.db.prepare("DELETE FROM artifacts WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM projects WHERE project_id=?").run(projectId);
      })();
    } catch (error) {
      if (hasFiles) renameSync(quarantine, directory);
      throw error;
    }
    if (hasFiles) {
      try { rmSync(quarantine, { recursive: true, force: true }); }
      catch { return { deleted: true, cleanup_pending: true }; }
    }
    return { deleted: true, cleanup_pending: externalWorkspace };
  }

  saveArtifact(projectId: string, name: string, mediaType: string, bytes: Uint8Array): Artifact {
    if (!this.getProject(projectId)) throw new Error("PROJECT_NOT_FOUND");
    const artifactId = makeId("artifact");
    const safeName = [...basename(name)].map((character) => character < " " || "\\/:*?\"<>|".includes(character) ? "_" : character).join("").slice(0, 180) || "source-file";
    const directory = join(this.root, "projects", projectId, "raw");
    const target = join(directory, `${artifactId}-${safeName}`);
    const temporary = `${target}.tmp`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(temporary, bytes, { flag: "wx" });
      renameSync(temporary, target);
      const artifact: Artifact = {
        protocol_version: "v1",
        artifact_id: artifactId,
        project_id: projectId,
        kind: "document",
        name: safeName,
        media_type: mediaType,
        size_bytes: bytes.byteLength,
        sha256,
        location: { kind: "local", uri: `workspace://projects/${projectId}/files/${artifactId}/${encodeURIComponent(safeName)}` },
        created_at: new Date().toISOString(),
        verification_status: "verified"
      };
      this.db.transaction(() => {
        this.db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)").run(artifactId, projectId, JSON.stringify(artifact), sha256);
        this.db.prepare("INSERT INTO managed_files VALUES (?,?)").run(artifactId, `projects/${projectId}/raw/${artifactId}-${safeName}`);
      })();
      return artifact;
    } catch (error) {
      rmSync(temporary, { force: true });
      rmSync(target, { force: true });
      throw error;
    }
  }

  findSourcesByImportedHash(projectId: string, sha256: string): Source[] {
    const rows = this.db.prepare("SELECT data FROM sources WHERE project_id = ? AND imported_file_sha256 = ?").all(projectId, sha256) as Array<{ data: string }>;
    return rows.map((row) => sourceSchema.parse(JSON.parse(row.data)));
  }

  createSources(sources: Source[], segmentsBySource: Map<string, SourceSegmentInput[]>): void {
    const insertSource = this.db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?)");
    const insertSegment = this.db.prepare("INSERT INTO source_segments(source_id, ordinal, locator_json, content) VALUES (?, ?, ?, ?)");
    const insertFts = this.db.prepare("INSERT INTO source_segments_fts(rowid, source_id, project_id, locator_json, content) VALUES (?, ?, ?, ?, ?)");
    const transaction = this.db.transaction(() => {
      for (const input of sources) {
        const source = sourceSchema.parse(input);
        insertSource.run(source.source_id, source.project_id, source.artifact_id ?? null, source.imported_file_sha256 ?? null, JSON.stringify(source), source.imported_at);
        const segments = segmentsBySource.get(source.source_id) ?? [];
        segments.forEach((segment, ordinal) => {
          const locator = JSON.stringify(segment.locator);
          const result = insertSegment.run(source.source_id, ordinal, locator, segment.text);
          insertFts.run(result.lastInsertRowid, source.source_id, source.project_id, locator, segment.text);
        });
      }
    });
    transaction();
    for(const source of sources){
      const root=join(this.root,'projects',source.project_id);
      if(existsSync(join(root,'project.yaml'))){
        const directory=join(root,'literature','parsed');mkdirSync(directory,{recursive:true});
        const path=join(directory,source.source_id+'.json');writeFileSync(path+'.tmp',JSON.stringify({source,segments:segmentsBySource.get(source.source_id)??[]},null,2));renameSync(path+'.tmp',path);
      }
    }
    const at = new Date().toISOString();
    for (const projectId of new Set(sources.map(source => source.project_id))) this.db.prepare("UPDATE projects SET updated_at=?,data=json_set(data,'$.updated_at',?) WHERE project_id=?").run(at,at,projectId);
  }

  listSources(projectId: string): Source[] {
    const rows = this.db.prepare("SELECT data FROM sources WHERE project_id = ? ORDER BY imported_at DESC, source_id").all(projectId) as Array<{ data: string }>;
    return rows.map((row) => sourceSchema.parse(JSON.parse(row.data)));
  }

  getSource(sourceId: string): Source | undefined {
    const row = this.db.prepare("SELECT data FROM sources WHERE source_id = ?").get(sourceId) as { data: string } | undefined;
    return row ? sourceSchema.parse(JSON.parse(row.data)) : undefined;
  }

  deleteSource(projectId: string, sourceId: string): { deleted: true; original_files_preserved: true } {
    return this.db.transaction(() => {
      const source = this.getSource(sourceId);
      if (!source || source.project_id !== projectId) throw Object.assign(new Error("SOURCE_NOT_FOUND"), { statusCode: 404 });
      if (this.db.prepare("SELECT 1 FROM knowledge_tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId)) throw Object.assign(new Error("PROJECT_HAS_ACTIVE_TASKS"), { statusCode: 409 });
      const versions = this.db.prepare("SELECT data FROM knowledge_versions WHERE project_id=?").all(projectId) as { data: string }[];
      const merged = this.db.prepare("SELECT 1 FROM source_details WHERE source_id<>? AND json_extract(data,'$.merged_into')=? LIMIT 1").get(sourceId, sourceId);
      // Preserve evidence references in every historical version, including Wiki text.
      if (versions.some(version => version.data.includes(sourceId)) || merged) throw Object.assign(new Error("SOURCE_IN_USE"), { statusCode: 409 });
      this.db.prepare("DELETE FROM source_segments_fts WHERE source_id=?").run(sourceId);
      this.db.prepare("DELETE FROM source_segments WHERE source_id=?").run(sourceId);
      this.db.prepare("DELETE FROM source_attachments WHERE source_id=?").run(sourceId);
      this.db.prepare("DELETE FROM source_details WHERE source_id=?").run(sourceId);
      this.db.prepare("DELETE FROM sources WHERE source_id=? AND project_id=?").run(sourceId, projectId);
      const at = new Date().toISOString();
      this.db.prepare("UPDATE projects SET updated_at=?,data=json_set(data,'$.updated_at',?) WHERE project_id=?").run(at, at, projectId);
      // Imported bibliography files can be shared by several sources.
      return { deleted: true as const, original_files_preserved: true as const };
    })();
  }

  listSourceSegments(sourceId: string): StoredSourceSegment[] {
    const rows = this.db.prepare("SELECT source_id, ordinal, locator_json, content FROM source_segments WHERE source_id = ? ORDER BY ordinal").all(sourceId) as Array<{ source_id: string; ordinal: number; locator_json: string; content: string }>;
    return rows.map((row) => ({ source_id: row.source_id, ordinal: row.ordinal, locator: JSON.parse(row.locator_json) as SourceLocator, text: row.content }));
  }

  artifactFile(projectId: string, artifactId: string): { artifact: Artifact; path: string } | undefined {
    const row = this.db.prepare("SELECT data FROM artifacts WHERE artifact_id=? AND project_id=?").get(artifactId, projectId) as { data: string } | undefined;
    if (!row) return undefined;
    const artifact = JSON.parse(row.data) as Artifact;
    const managed = this.db.prepare("SELECT relative_path FROM managed_files WHERE artifact_id=?").get(artifactId) as { relative_path: string } | undefined;
    const path = managed ? resolve(this.root, managed.relative_path) : join(this.root, "projects", projectId, "files", `${artifactId}-${artifact.name}`);
    if (!path.startsWith(`${this.root}${sep}`) || !existsSync(path)) return undefined;
    return { artifact, path };
  }

  discardArtifact(projectId: string, artifactId: string): void {
    const file = this.artifactFile(projectId, artifactId);
    this.db.prepare("DELETE FROM managed_files WHERE artifact_id=?").run(artifactId);
    this.db.prepare("DELETE FROM artifacts WHERE artifact_id=? AND project_id=?").run(artifactId, projectId);
    if (file) rmSync(file.path, { force: true });
  }

  readArtifact(projectId: string, artifactId: string): Uint8Array | undefined {
    const file = this.artifactFile(projectId, artifactId);
    return file ? readFileSync(file.path) : undefined;
  }

  search(projectId: string, query: string, limit = 20): EvidencePassage[] {
    const normalized = query.trim().replace(/"/g, '""');
    if (normalized.length < 2) return [];
    const rows = this.db.prepare(`
      SELECT source_id, locator_json, content, bm25(source_segments_fts) AS score
      FROM source_segments_fts
      WHERE source_segments_fts MATCH ? AND project_id = ?
      ORDER BY score ASC
      LIMIT ?
    `).all(`"${normalized}"`, projectId, Math.max(1, Math.min(limit, 100))) as Array<{ source_id: string; locator_json: string; content: string; score: number }>;
    return rows.map((row) => ({ source_id: row.source_id, locator: JSON.parse(row.locator_json) as SourceLocator, text: row.content, rank: -row.score }));
  }
}
