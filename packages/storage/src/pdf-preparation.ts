import type Database from 'better-sqlite3';

/** Additive migration: kept separate from the core schema version for old workspaces. */
export function migratePdfPreparation(db:Database.Database){
 db.exec(`CREATE TABLE IF NOT EXISTS pdf_preparations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL,
  owner TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, data TEXT NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS pdf_preparation_active ON pdf_preparations(project_id,source_id)
 WHERE status IN ('queued','running');
 CREATE INDEX IF NOT EXISTS pdf_preparation_source ON pdf_preparations(project_id,source_id,created_at DESC);`);
}
