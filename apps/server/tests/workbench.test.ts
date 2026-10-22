import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LiteratureSearchResult } from "@trash/protocol";
import { TrashStore } from "@trash/storage";
import { createWorkbenchServer } from "../src/index.js";

const provider = {
  id: "openalex-works",
  async search(): Promise<LiteratureSearchResult[]> {
    return [{ provider_id: this.id, provider_ref: "https://openalex.org/W100", title: "APT provenance", authors: ["A. Researcher"], year: 2024, url: "https://example.org/apt" }];
  }
};

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "trash-server-"));
  const app = createWorkbenchServer({ store: new TrashStore(root), provider });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("project, source file and locator search form a persistent local workflow", async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "APT provenance study", research_question: "Can provenance improve APT detection?" })
    });
    assert.equal(created.status, 201);
    const { project } = await created.json() as { project: { project_id: string; module: { id: string; version: string } } };
    assert.deepEqual(project.module, { id: "apt-provenance", version: "0.1.0" });

    const markdown = "# Process lineage\n\nA provenance graph can expose lateral movement across host events.";
    const upload = await fetch(`${baseUrl}/api/v1/projects/${project.project_id}/sources/files?filename=apt-notes.md`, {
      method: "POST", headers: { "content-type": "text/markdown" }, body: markdown
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { sources: Array<{ source_id: string; imported_file_sha256: string; artifact_id: string }> };
    const sourceId = uploaded.sources[0].source_id;
    assert.match(uploaded.sources[0].imported_file_sha256, /^[a-f0-9]{64}$/);

    const duplicate = await fetch(`${baseUrl}/api/v1/projects/${project.project_id}/sources/files?filename=apt-notes.md`, {
      method: "POST", headers: { "content-type": "text/markdown" }, body: markdown
    });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

    const search = await fetch(`${baseUrl}/api/v1/projects/${project.project_id}/search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "lateral movement" })
    });
    const passages = await search.json() as { passages: Array<{ source: { source_id: string }; locator: { kind: string; paragraph_index?: number }; text: string }> };
    assert.equal(passages.passages[0].source.source_id, sourceId);
    assert.deepEqual(passages.passages[0].locator, { kind: "paragraph", paragraph_index: 1, heading: "Process lineage" });
    assert.match(passages.passages[0].text, /lateral movement/);

    const list = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal((await list.json() as { projects: unknown[] }).projects.length, 1);
  });
});

test("reports bad input and unsupported files without exposing internal paths", async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/v1/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "PROJECT_FIELDS_REQUIRED" });
    const missing = await fetch(`${baseUrl}/api/v1/projects/project_missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "PROJECT_NOT_FOUND" });
    const error = await fetch(`${baseUrl}/api/v1/literature/openalex/search?q=x`);
    assert.equal(error.status, 400);
  });
});

test("search results import once as metadata without a fictitious local artifact", async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "APT", research_question: "Research question" }) });
    const { project } = await created.json() as { project: { project_id: string } };
    const search = await fetch(`${baseUrl}/api/v1/literature/openalex/search?q=APT`);
    const result = (await search.json() as { results: LiteratureSearchResult[] }).results[0];
    const path = `${baseUrl}/api/v1/projects/${project.project_id}/sources/import-search-results`;
    const body = JSON.stringify({ results: [result] });
    const first = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    const firstPayload = await first.json() as { sources: Array<{ artifact_id?: string; parse_status: string }> };
    assert.equal(firstPayload.sources[0].artifact_id, undefined);
    assert.equal(firstPayload.sources[0].parse_status, "metadata_only");
    const second = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await second.json() as { duplicate_count: number }).duplicate_count, 1);
  });
});
