import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
    if (version >= 1) return;
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

  saveArtifact(projectId: string, name: string, mediaType: string, bytes: Uint8Array): Artifact {
    if (!this.getProject(projectId)) throw new Error("PROJECT_NOT_FOUND");
    const artifactId = makeId("artifact");
    const safeName = [...basename(name)].map((character) => character < " " || "\\/:*?\"<>|".includes(character) ? "_" : character).join("").slice(0, 180) || "source-file";
    const directory = join(this.root, "projects", projectId, "files");
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
      this.db.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)").run(artifactId, projectId, JSON.stringify(artifact), sha256);
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
  }

  listSources(projectId: string): Source[] {
    const rows = this.db.prepare("SELECT data FROM sources WHERE project_id = ? ORDER BY imported_at DESC, source_id").all(projectId) as Array<{ data: string }>;
    return rows.map((row) => sourceSchema.parse(JSON.parse(row.data)));
  }

  getSource(sourceId: string): Source | undefined {
    const row = this.db.prepare("SELECT data FROM sources WHERE source_id = ?").get(sourceId) as { data: string } | undefined;
    return row ? sourceSchema.parse(JSON.parse(row.data)) : undefined;
  }

  listSourceSegments(sourceId: string): StoredSourceSegment[] {
    const rows = this.db.prepare("SELECT source_id, ordinal, locator_json, content FROM source_segments WHERE source_id = ? ORDER BY ordinal").all(sourceId) as Array<{ source_id: string; ordinal: number; locator_json: string; content: string }>;
    return rows.map((row) => ({ source_id: row.source_id, ordinal: row.ordinal, locator: JSON.parse(row.locator_json) as SourceLocator, text: row.content }));
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
