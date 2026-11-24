import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ACTIVE_EXPERIMENT_STATES, type ProjectRepository, type SshProfile, type DatasetRef, type ExperimentPlanVersion, type ExperimentRun } from "@trash/protocol";
export function experimentError(code: string, statusCode = 400): never { throw Object.assign(new Error(code), { statusCode }); }
export class ExperimentStore {
  constructor(readonly db: Database.Database) {}
  repository(projectId: string, id?: string): ProjectRepository | undefined {
    return id ? this.repositories(projectId).find(repo => repo.repository_id === id) : this.one("experiment_repositories", "project_id", projectId);
  }
  repositories(projectId: string): ProjectRepository[] {
    return (this.db.prepare("SELECT data FROM project_code_repositories WHERE project_id=? ORDER BY rowid").all(projectId) as {data:string}[]).map(row => JSON.parse(row.data) as ProjectRepository);
  }
  setDefaultRepository(value: ProjectRepository): void {
    this.db.prepare("INSERT INTO experiment_repositories VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data").run(value.project_id, JSON.stringify(value));
  }
  saveRepository(value: ProjectRepository, makeDefault = true): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO project_code_repositories VALUES (?,?,?) ON CONFLICT(repository_id) DO UPDATE SET data=excluded.data WHERE project_id=excluded.project_id").run(value.repository_id,value.project_id,JSON.stringify(value));
      if (makeDefault || !this.repository(value.project_id) || this.repository(value.project_id)?.repository_id === value.repository_id) this.setDefaultRepository(value);
    })();
  }
  private one<T>(table: string, column: string, key: string): T | undefined { const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${column}=?`).get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) as T : undefined; }
  profiles(projectId: string): SshProfile[] { return (this.db.prepare("SELECT data FROM experiment_profiles WHERE project_id=? ORDER BY rowid").all(projectId) as { data: string }[]).map(r => JSON.parse(r.data) as SshProfile); }
  profile(projectId: string, id: string): SshProfile { return this.profiles(projectId).find(p => p.profile_id === id) ?? experimentError("SSH_PROFILE_NOT_FOUND", 404); }
  saveProfile(value: SshProfile): void { this.db.prepare("INSERT INTO experiment_profiles VALUES (?,?,?) ON CONFLICT(profile_id) DO UPDATE SET data=excluded.data").run(value.profile_id, value.project_id, JSON.stringify(value)); }
  deleteProfile(projectId: string, id: string): void { this.profile(projectId,id); if (this.runs().some(r => r.profile_id === id && this.active(r))) experimentError("EXPERIMENT_ACTIVE",409); this.db.prepare("DELETE FROM experiment_profiles WHERE profile_id=? AND project_id=?").run(id,projectId); }
  datasets(projectId: string): DatasetRef[] { return (this.db.prepare("SELECT data FROM experiment_datasets WHERE project_id=?").all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data) as DatasetRef); }
  saveDataset(value: DatasetRef): void { this.db.prepare("INSERT INTO experiment_datasets VALUES (?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET data=excluded.data").run(value.dataset_id,value.project_id,JSON.stringify(value)); }
  plans(projectId: string): ExperimentPlanVersion[] { return (this.db.prepare("SELECT data FROM experiment_plans WHERE project_id=? ORDER BY version DESC").all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data) as ExperimentPlanVersion); }
  plan(projectId:string,id:string,version:number):ExperimentPlanVersion { return this.plans(projectId).find(p=>p.plan_id===id&&p.version===version) ?? experimentError("EXPERIMENT_PLAN_NOT_FOUND",404); }
  savePlan(value:ExperimentPlanVersion):void { this.db.prepare("INSERT INTO experiment_plans VALUES (?,?,?,?) ON CONFLICT(plan_id,version) DO UPDATE SET data=excluded.data").run(value.plan_id,value.version,value.project_id,JSON.stringify(value)); }
  runs(projectId?:string):ExperimentRun[] {
    const rows = (projectId
      ? this.db.prepare("SELECT data FROM experiment_runs WHERE project_id=? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT data FROM experiment_runs ORDER BY created_at").all()) as {data:string}[];
    return rows.map(row=>JSON.parse(row.data) as ExperimentRun);
  }
  run(projectId:string,id:string):ExperimentRun { return this.runs(projectId).find(r=>r.run_id===id) ?? experimentError("EXPERIMENT_RUN_NOT_FOUND",404); }
  active(run:ExperimentRun):boolean { return (ACTIVE_EXPERIMENT_STATES as readonly string[]).includes(run.status); }
  saveRun(value:ExperimentRun):void { value.updated_at=new Date().toISOString();this.db.prepare("INSERT INTO experiment_runs VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,data=excluded.data").run(value.run_id,value.project_id,value.profile_id,value.status,value.created_at,JSON.stringify(value)); }
  event(runId:string,type:string,message:string):void { this.db.prepare("INSERT INTO experiment_events(event_id,run_id,type,at,message) VALUES (?,?,?,?,?)").run(randomUUID(),runId,type,new Date().toISOString(),message.slice(0,10000)); }
  events(projectId:string,runId:string):unknown[] { this.run(projectId,runId);return this.db.prepare("SELECT * FROM experiment_events WHERE run_id=? ORDER BY rowid DESC LIMIT 200").all(runId); }
}
