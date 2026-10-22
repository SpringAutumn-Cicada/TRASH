import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION, agentTaskEventSchema, agentTaskSchema, artifactSchema,
  experimentTaskEventSchema, experimentTaskSchema, makeId, researchProjectSchema,
  workflowEventSchema, workflowRunSchema
} from "../src/index.js";

const time = "2026-10-21T08:00:00.000Z";
const project = {
  protocol_version: PROTOCOL_VERSION, project_id: "project_demo", title: "APT provenance",
  research_question: "How can provenance improve APT detection?", module: { id: "apt-provenance", version: "0.1.0" },
  status: "active", created_at: time, updated_at: time
};

test("accepts the minimal project and workflow records", () => {
  assert.equal(researchProjectSchema.parse(project).project_id, "project_demo");
  assert.equal(workflowRunSchema.parse({
    protocol_version: PROTOCOL_VERSION, workflow_run_id: "wfrun_1", project_id: "project_demo",
    workflow_id: "apt-default", status: "queued", current_stage: "question_and_literature", attempt: 1,
    input_refs: [], output_refs: [], created_at: time, updated_at: time
  }).status, "queued");
});

test("rejects invalid identities, incomplete experiment provenance and unknown fields", () => {
  assert.equal(researchProjectSchema.safeParse({ ...project, project_id: "case_1" }).success, false);
  const task = {
    protocol_version: PROTOCOL_VERSION, experiment_task_id: "exptask_1", project_id: "project_demo",
    plan_version_id: "plan_1", module: { id: "apt-provenance", version: "0.1.0" },
    git: { repository: "local", commit_sha: "abc", working_tree_clean: true }, dataset_refs: [],
    environment_summary: {}, command: ["python", "run.py"], status: "queued", artifact_ids: [], created_at: time
  };
  assert.equal(experimentTaskSchema.safeParse(task).success, false);
  assert.equal(agentTaskSchema.safeParse({ ...project, unexpected: true }).success, false);
});

test("validates local and remote artifacts without pretending remote data is local", () => {
  const base = {
    protocol_version: PROTOCOL_VERSION, artifact_id: "artifact_1", project_id: "project_demo",
    kind: "metrics", name: "metrics.json", media_type: "application/json", size_bytes: 120,
    sha256: "a".repeat(64), created_at: time, verification_status: "verified"
  };
  assert.equal(artifactSchema.safeParse({ ...base, location: { kind: "local", uri: "file:metrics.json" } }).success, true);
  assert.equal(artifactSchema.safeParse({ ...base, location: { kind: "remote", profile_id: "gpu-1", uri: "/datasets/apt", dataset_version: "v2" } }).success, true);
});

test("validates event types and creates namespaced IDs", () => {
  assert.equal(workflowEventSchema.safeParse({ protocol_version: PROTOCOL_VERSION, event_id: "event_1", workflow_run_id: "wfrun_1", type: "run.started", status: "running", refs: [], occurred_at: time }).success, true);
  assert.equal(agentTaskEventSchema.safeParse({ protocol_version: PROTOCOL_VERSION, event_id: "event_2", agent_task_id: "agenttask_1", type: "task.completed", occurred_at: time, payload: {} }).success, true);
  assert.equal(experimentTaskEventSchema.safeParse({ protocol_version: PROTOCOL_VERSION, event_id: "event_3", experiment_task_id: "exptask_1", type: "task.completed", status: "completed", occurred_at: time }).success, true);
  assert.match(makeId("project"), /^project_[0-9a-f-]{36}$/);
});
