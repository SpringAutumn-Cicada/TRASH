import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { literatureSearchResultSchema, makeId, PROTOCOL_VERSION, sourceSchema, type LiteratureSearchResult, type Source } from "@trash/protocol";
import { OpenAlexProvider, fetchPublicWebpage, parseImportedFile, parseWebpage, type LiteratureSearchProvider, type ParsedSource } from "@trash/literature";
import { TrashStore } from "@trash/storage";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const now = () => new Date().toISOString();

interface WorkbenchServerOptions {
  store?: TrashStore;
  provider?: LiteratureSearchProvider;
  staticRoot?: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > limit) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 }); }
}

function makeSource(projectId: string, parsed: ParsedSource, options: { artifactId?: string; fileHash?: string; result?: LiteratureSearchResult }): Source {
  return sourceSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    source_id: makeId("source"),
    project_id: projectId,
    title: parsed.title,
    authors: parsed.authors,
    ...(parsed.year ? { year: parsed.year } : {}),
    ...(parsed.doi ? { doi: parsed.doi } : {}),
    source_type: parsed.source_type,
    ...(parsed.source_url ? { source_url: parsed.source_url } : {}),
    ...(options.result ? { provider_id: options.result.provider_id, provider_ref: options.result.provider_ref } : {}),
    ...(options.artifactId ? { artifact_id: options.artifactId } : {}),
    ...(options.fileHash ? { imported_file_sha256: options.fileHash } : {}),
    ...(parsed.abstract ? { abstract: parsed.abstract } : {}),
    parse_status: parsed.parse_status,
    ...(parsed.import_error ? { import_error: parsed.import_error } : {}),
    imported_at: now()
  });
}

function isSupportedFileName(fileName: string): boolean {
  return [".pdf", ".bib", ".bibtex", ".ris", ".md", ".markdown"].includes(extname(fileName).toLowerCase());
}

function resolveStaticPath(staticRoot: string, requestPath: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return undefined; }
  const relative = normalize(decoded).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, "");
  const root = resolve(staticRoot);
  const file = resolve(root, relative || "index.html");
  return file === root || file.startsWith(`${root}/`) ? file : undefined;
}

async function serveStatic(staticRoot: string, requestPath: string, response: ServerResponse): Promise<void> {
  const file = resolveStaticPath(staticRoot, requestPath);
  if (!file) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
  let candidate = file;
  try {
    if (!(await stat(candidate)).isFile()) candidate = join(staticRoot, "index.html");
  } catch { candidate = join(staticRoot, "index.html"); }
  try {
    const contentType = candidate.endsWith(".html") ? "text/html; charset=utf-8" : candidate.endsWith(".js") ? "text/javascript; charset=utf-8" : candidate.endsWith(".css") ? "text/css; charset=utf-8" : candidate.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    createReadStream(candidate).pipe(response);
  } catch { sendJson(response, 404, { error: "NOT_FOUND" }); }
}

function jsonError(error: unknown): { status: number; code: string } {
  const statusCode = error && typeof error === "object" && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : 0;
  if (statusCode === 413) return { status: 413, code: "REQUEST_TOO_LARGE" };
  if (error instanceof Error && error.message === "PROJECT_NOT_FOUND") return { status: 404, code: error.message };
  if (error instanceof Error && ["UNSUPPORTED_FILE_TYPE", "URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED", "URL_HOST_NOT_PUBLIC", "WEBPAGE_NOT_HTML", "WEBPAGE_TOO_LARGE", "WEBPAGE_REDIRECT_LIMIT"].includes(error.message)) return { status: 422, code: error.message };
  if (statusCode === 400) return { status: 400, code: error instanceof Error ? error.message : "INVALID_REQUEST" };
  if (error instanceof Error && error.message.startsWith("OPENALEX_HTTP_")) return { status: 502, code: error.message };
  return { status: 500, code: "INTERNAL_ERROR" };
}

async function route(request: IncomingMessage, response: ServerResponse, store: TrashStore, provider: LiteratureSearchProvider, staticRoot: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  if (url.pathname === "/api/v1/health" && method === "GET") {
    sendJson(response, 200, { name: "trash", status: "ready", protocol_version: PROTOCOL_VERSION });
    return;
  }
  if (url.pathname === "/api/v1/projects" && method === "GET") {
    sendJson(response, 200, { projects: store.listProjects() });
    return;
  }
  if (url.pathname === "/api/v1/projects" && method === "POST") {
    const input = await readJson<{ title: string; research_question: string; module?: { id: string; version: string } }>(request);
    if (typeof input.title !== "string" || typeof input.research_question !== "string") throw Object.assign(new Error("PROJECT_FIELDS_REQUIRED"), { statusCode: 400 });
    const project = store.createProject({ title: input.title, research_question: input.research_question, module: input.module ?? { id: "apt-provenance", version: "0.1.0" } });
    sendJson(response, 201, { project });
    return;
  }
  const projectRoute = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
  if (projectRoute) {
    const projectId = decodeURIComponent(projectRoute[1]);
    const project = store.getProject(projectId);
    if (!project) { sendJson(response, 404, { error: "PROJECT_NOT_FOUND" }); return; }
    const subpath = projectRoute[2] ?? "";
    if (!subpath && method === "GET") {
      sendJson(response, 200, { project, sources: store.listSources(projectId) });
      return;
    }
    if (subpath === "sources" && method === "GET") {
      sendJson(response, 200, { sources: store.listSources(projectId) });
      return;
    }
    if (subpath === "sources/files" && method === "POST") {
      const fileName = url.searchParams.get("filename") ?? "";
      if (!fileName || !isSupportedFileName(fileName)) throw Object.assign(new Error("UNSUPPORTED_FILE_TYPE"), { statusCode: 422 });
      const bytes = await readBody(request, MAX_UPLOAD_BYTES);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      const duplicate = store.findSourcesByImportedHash(projectId, fileHash);
      if (duplicate.length) { sendJson(response, 200, { sources: duplicate, duplicate: true }); return; }
      const mediaType = request.headers["content-type"]?.split(";")[0] ?? "application/octet-stream";
      const parsedSources = await parseImportedFile(fileName, bytes);
      const artifact = store.saveArtifact(projectId, fileName, mediaType, bytes);
      const sources = parsedSources.map((item) => makeSource(projectId, item, { artifactId: artifact.artifact_id, fileHash }));
      store.createSources(sources, new Map(parsedSources.map((item, index) => [sources[index].source_id, item.segments])));
      sendJson(response, 201, { sources, artifact, duplicate: false });
      return;
    }
    if (subpath === "sources/url" && method === "POST") {
      const input = await readJson<{ url: string }>(request);
      if (typeof input.url !== "string") throw Object.assign(new Error("URL_REQUIRED"), { statusCode: 400 });
      const page = await fetchPublicWebpage(input.url);
      const parsed = parseWebpage(page.html, page.final_url);
      const artifact = store.saveArtifact(projectId, `${parsed.title}.html`, "text/html", page.html);
      const source = makeSource(projectId, parsed, { artifactId: artifact.artifact_id, fileHash: artifact.sha256 });
      store.createSources([source], new Map([[source.source_id, parsed.segments]]));
      sendJson(response, 201, { source, artifact });
      return;
    }
    if (subpath === "sources/import-search-results" && method === "POST") {
      const body = await readJson<{ results: unknown }>(request);
      if (!Array.isArray(body.results)) throw Object.assign(new Error("RESULTS_REQUIRED"), { statusCode: 400 });
      const results = body.results.map((item) => literatureSearchResultSchema.parse(item));
      const existing = new Set(store.listSources(projectId).filter((source) => source.provider_ref).map((source) => `${source.provider_id}:${source.provider_ref}`));
      const sources = results.filter((item) => !existing.has(`${item.provider_id}:${item.provider_ref}`)).map((item) => makeSource(projectId, {
        source_type: "openalex",
        title: item.title,
        authors: item.authors,
        ...(item.year ? { year: item.year } : {}),
        ...(item.doi ? { doi: item.doi } : {}),
        ...(item.url ? { source_url: item.url } : {}),
        ...(item.abstract ? { abstract: item.abstract } : {}),
        parse_status: item.abstract ? "indexed" : "metadata_only",
        segments: []
      }, { result: item }));
      const segments = new Map(sources.map((source) => [source.source_id, source.abstract ? [{ locator: { kind: "abstract" as const, field: "abstract" as const }, text: source.abstract }] : []]));
      store.createSources(sources, segments);
      sendJson(response, 201, { sources, duplicate_count: results.length - sources.length });
      return;
    }
    const sourceRoute = subpath.match(/^sources\/([^/]+)$/);
    if (sourceRoute && method === "GET") {
      const sourceId = decodeURIComponent(sourceRoute[1]);
      const source = store.getSource(sourceId);
      if (!source || source.project_id !== projectId) { sendJson(response, 404, { error: "SOURCE_NOT_FOUND" }); return; }
      sendJson(response, 200, { source, segments: store.listSourceSegments(sourceId) });
      return;
    }
    if (subpath === "search" && method === "POST") {
      const input = await readJson<{ query: string; limit?: number }>(request);
      if (typeof input.query !== "string" || input.query.trim().length < 2) throw Object.assign(new Error("QUERY_TOO_SHORT"), { statusCode: 400 });
      const passages = store.search(projectId, input.query, input.limit);
      const sources = new Map(store.listSources(projectId).map((source) => [source.source_id, source]));
      sendJson(response, 200, { passages: passages.flatMap((passage) => {
        const source = sources.get(passage.source_id);
        return source ? [{ source, locator: passage.locator, text: passage.text, rank: passage.rank }] : [];
      }) });
      return;
    }
  }
  if (url.pathname === "/api/v1/literature/openalex/search" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    if (query.trim().length < 2) throw Object.assign(new Error("QUERY_TOO_SHORT"), { statusCode: 400 });
    sendJson(response, 200, { provider_id: provider.id, results: await provider.search(query, Number(url.searchParams.get("limit") ?? "20")) });
    return;
  }
  if (url.pathname.startsWith("/api/")) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
  if (method === "GET") { await serveStatic(staticRoot, url.pathname, response); return; }
  sendJson(response, 404, { error: "NOT_FOUND" });
}

export function createWorkbenchServer(options: WorkbenchServerOptions = {}): { server: Server; store: TrashStore } {
  const store = options.store ?? new TrashStore();
  const provider = options.provider ?? new OpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
  const staticRoot = options.staticRoot ?? resolve(fileURLToPath(new URL("../../workbench/dist/", import.meta.url)));
  const server = createServer((request, response) => {
    void route(request, response, store, provider, staticRoot).catch((error: unknown) => {
      if (!response.headersSent) {
        const mapped = jsonError(error);
        sendJson(response, mapped.status, { error: mapped.code });
      } else response.destroy();
    });
  });
  return { server, store };
}

