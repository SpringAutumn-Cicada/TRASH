import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TrashStore, getWorkspaceRoot } from "../src/index.js";

test("workspace path follows platform defaults and TRASH_HOME override", () => {
  assert.equal(getWorkspaceRoot({ TRASH_HOME: "./trash-test" }), join(process.cwd(), "trash-test"));
});

test("persists projects and source locators through store reopen; migrations are repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "trash-store-"));
  try {
    const first = new TrashStore(root);
    first.migrate();
    const project = first.createProject({ title: "APT study", research_question: "Can provenance improve detection?", module: { id: "apt-provenance", version: "0.1.0" } });
    const bytes = new TextEncoder().encode("# APT Provenance\n\nA provenance graph can reveal lateral movement.");
    const artifact = first.saveArtifact(project.project_id, "../paper.md", "text/markdown", bytes);
    const source = {
      protocol_version: "v1" as const, source_id: "source_test", project_id: project.project_id,
      title: "APT Provenance", authors: [], source_type: "markdown" as const, artifact_id: artifact.artifact_id,
      imported_file_sha256: artifact.sha256, parse_status: "indexed" as const, imported_at: new Date().toISOString()
    };
    first.createSources([source], new Map([[source.source_id, [{ locator: { kind: "paragraph", paragraph_index: 1, heading: "APT Provenance" }, text: "A provenance graph can reveal lateral movement." }]]]));
    assert.equal(first.search(project.project_id, "lateral movement")[0].source_id, "source_test");
    assert.match(artifact.name, /^paper\.md$/);
    const file = join(root, "projects", project.project_id, "files", `${artifact.artifact_id}-paper.md`);
    assert.equal((await readFile(file)).byteLength, bytes.byteLength);
    first.close();

    const reopened = new TrashStore(root);
    assert.equal(reopened.listProjects()[0].project_id, project.project_id);
    assert.equal(reopened.listSources(project.project_id)[0].source_id, "source_test");
    assert.deepEqual(reopened.listSourceSegments("source_test")[0].locator, { kind: "paragraph", paragraph_index: 1, heading: "APT Provenance" });
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source inserts roll back as a unit when a duplicate source id is encountered", async () => {
  const root = await mkdtemp(join(tmpdir(), "trash-transaction-"));
  const store = new TrashStore(root);
  try {
    const project = store.createProject({ title: "APT", research_question: "Research question", module: { id: "apt-provenance", version: "0.1.0" } });
    const source = {
      protocol_version: "v1" as const, source_id: "source_duplicate", project_id: project.project_id,
      title: "Record", authors: [], source_type: "ris" as const, parse_status: "metadata_only" as const, imported_at: new Date().toISOString()
    };
    assert.throws(() => store.createSources([source, source], new Map()));
    assert.equal(store.listSources(project.project_id).length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
