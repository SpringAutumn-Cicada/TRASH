import { uploadChatAttachment, resolveChatAttachments } from "./chat-attachments.js";
import { ProjectFiles } from "./project-files.js";
import { directoryRepairBusy } from "./experiment/directory-repair.js";
import { ProjectWorkspaces, workspaceError } from "./project-workspace.js";
import { browseDirectories, createDirectory, selectDirectory } from "./experiment/directories.js";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { literatureSearchResultSchema, makeId, PROTOCOL_VERSION, sourceSchema, type LiteratureSearchResult, type Source } from "@trash/protocol";
import { OpenAlexProvider, fetchPublicWebpage, parseImportedFile, parseWebpage, type LiteratureSearchProvider, type ParsedSource } from "@trash/literature";
import { TrashStore, KnowledgeStore } from "@trash/storage";
import { knowledgeRoute } from "./knowledge.js";
import { KnowledgeAgent } from "./knowledge-agent.js";
import { LiteratureAnalysis } from "./literature-analysis.js";
import { CodeAgent } from "./code-agent.js";
import { projectChatTool } from "./project-chat-tools.js";
import { ExperimentService } from "./experiment/service.js";
import { experimentRoute } from "./experiment/routes.js";
import { projectOverview } from "./overview.js";
import { restoreKnowledge } from "./knowledge-restore.js";
import { z, ZodError } from "zod";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const now = () => new Date().toISOString();

interface WorkbenchServerOptions {
  store?: TrashStore;
  provider?: LiteratureSearchProvider;
  staticRoot?: string;
  frontend?: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
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

async function readJson<T>(request: IncomingMessage, limit = MAX_JSON_BYTES): Promise<T> {
  const bytes = await readBody(request, limit);
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
  if (error instanceof ZodError) return { status: 400, code: "INVALID_REQUEST" };
  if ([400, 403, 404, 409, 422].includes(statusCode)) return { status: statusCode, code: error instanceof Error ? error.message : "INVALID_REQUEST" };
  if (statusCode === 413) return { status: 413, code: "REQUEST_TOO_LARGE" };
  if (error instanceof Error && error.message === "PROJECT_NOT_FOUND") return { status: 404, code: error.message };
  if (error instanceof Error && ["UNSUPPORTED_FILE_TYPE", "URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED", "URL_HOST_NOT_PUBLIC", "WEBPAGE_NOT_HTML", "WEBPAGE_TOO_LARGE", "WEBPAGE_REDIRECT_LIMIT"].includes(error.message)) return { status: 422, code: error.message };
  if (statusCode === 400) return { status: 400, code: error instanceof Error ? error.message : "INVALID_REQUEST" };
  if (error instanceof Error && error.message.startsWith("OPENALEX_HTTP_")) return { status: 502, code: error.message };
  return { status: 500, code: "INTERNAL_ERROR" };
}

async function route(request: IncomingMessage, response: ServerResponse, store: TrashStore, provider: LiteratureSearchProvider, staticRoot: string, knowledge: KnowledgeStore, agent: KnowledgeAgent, experiments: ExperimentService, codeAgent: CodeAgent, analysis: LiteratureAnalysis, workspaces: ProjectWorkspaces, files: ProjectFiles): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  if(url.pathname==="/api/v1/workspace/defaults" && method==="GET"){mkdirSync(join(store.root,"workspaces"),{recursive:true});sendJson(response,200,{defaultRoot:join(store.root,"workspaces")});return;}
  if(url.pathname==="/api/v1/workspace/repository/directories" && method==="GET"){sendJson(response,200,await browseDirectories(url.searchParams.get("path")??undefined));return;}
  if(url.pathname==="/api/v1/workspace/repository/directories" && method==="POST"){sendJson(response,201,await createDirectory(await readJson(request)));return;}
  if(url.pathname==="/api/v1/workspace/repository/directories/select" && method==="POST"){
    const input=z.object({path:z.string(),initialize_git:z.literal(false)}).strict().parse(await readJson(request));sendJson(response,200,await selectDirectory(input));return;
  }
  if (url.pathname === "/api/v1/health" && method === "GET") {
    sendJson(response, 200, { name: "trash", status: "ready", protocol_version: PROTOCOL_VERSION });
    return;
  }
  if (url.pathname === "/api/v1/projects" && method === "GET") {
    sendJson(response, 200, { projects: store.listProjects() });
    return;
  }
  if (url.pathname === "/api/v1/knowledge-restore" && method === "POST") {
    const bytes = await readBody(request, 200 * 1024 * 1024);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 }); }
    sendJson(response, 201, { project: restoreKnowledge(store, value) }); return;
  }
  if (url.pathname === "/api/v1/projects" && method === "POST") {
    const input = await readJson<{ title: string; research_question: string; module?: { id: string; version: string }; workspace?: {root?:string;name:string} }>(request);
    if (!input || typeof input.title !== "string" || typeof input.research_question !== "string") throw Object.assign(new Error("PROJECT_FIELDS_REQUIRED"), { statusCode: 400 });
    z.object({ title:z.string().trim().min(1).max(120),research_question:z.string().trim().min(1).max(10000),module:z.object({id:z.string().regex(/^[a-z][a-z0-9-]*$/),version:z.string().min(1)}).strict().optional(),workspace:z.object({root:z.string().min(1).optional(),name:z.string().min(1)}).strict().optional() }).strict().parse(input);
    const project = store.createProject({ title: input.title, research_question: input.research_question, module: input.module ?? { id: "apt-provenance", version: "0.1.0" } });
    try{await workspaces.initialize(project.project_id,input.workspace?{...input.workspace,root:input.workspace.root??join(store.root,"workspaces")}:undefined);}
    catch(error){store.db.prepare("DELETE FROM projects WHERE project_id=?").run(project.project_id);workspaceError(error);}
    sendJson(response, 201, { project });
    return;
  }
  const projectRoute = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
  if (projectRoute) {
    const projectId = decodeURIComponent(projectRoute[1]);
    const project = store.getProject(projectId);
    if (!project) { sendJson(response, 404, { error: "PROJECT_NOT_FOUND" }); return; }
    const subpath = projectRoute[2] ?? "";
    if(subpath==="workspace" && method==="GET"){sendJson(response,200,workspaces.state(projectId));return;}
    if(workspaces.busy(projectId)){sendJson(response,409,{error:"WORKSPACE_MIGRATING"});return;}
    if(subpath==="files"||subpath.startsWith("files/")){
      const path=url.searchParams.get("path")??"",hidden=url.searchParams.get("hidden")==="true";
      try{
        if(subpath==="files"&&method==="GET"){sendJson(response,200,files.list(projectId,path,hidden));return;}
        if(subpath==="files/search"&&method==="GET"){sendJson(response,200,files.search(projectId,url.searchParams.get("q")??"",hidden));return;}
        if(subpath==="files/preview"&&method==="GET"){sendJson(response,200,files.preview(projectId,path));return;}
        if(subpath==="files/inspect"&&method==="GET"){sendJson(response,200,files.inspect(projectId,path));return;}
        if(subpath==="files/content"&&method==="GET"){await files.stream(projectId,path,request,response,url.searchParams.get("download")==="true");return;}
        if(subpath==="files/recycle"&&method==="GET"){sendJson(response,200,files.recycled(projectId));return;}
        if(subpath==="files/upload"&&method==="POST"){const bytes=await readBody(request,MAX_UPLOAD_BYTES);if(workspaces.busy(projectId))throw Object.assign(new Error("WORKSPACE_MIGRATING"),{statusCode:409});sendJson(response,201,files.upload(projectId,path,bytes));return;}
        const actions={save:files.save.bind(files),create:files.create.bind(files),move:files.move.bind(files),delete:files.recycle.bind(files),restore:files.restore.bind(files)};
        const action=subpath.slice('files/'.length);
        if(method==="POST"&&Object.hasOwn(actions,action)){
          const body=await readJson(request,action==="save"?12*1024*1024+8192:MAX_JSON_BYTES);if(workspaces.busy(projectId))throw Object.assign(new Error("WORKSPACE_MIGRATING"),{statusCode:409});
          sendJson(response,200,actions[action as keyof typeof actions](projectId,body));return;
        }
      }catch(error){
        if((error as NodeJS.ErrnoException).code==='EEXIST')throw Object.assign(new Error('FILES_EXISTS'),{statusCode:409});
        workspaceError(error);
      }
      sendJson(response,404,{error:'NOT_FOUND'});return;
    }
    if(subpath==="workspace/migrate" && method==="POST"){
      const input=z.object({root:z.string(),name:z.string(),confirm:z.literal(true)}).strict().parse(await readJson(request));
      if((workspaces.requests.get(projectId)??0)>1||agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||directoryRepairBusy(store,projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){sendJson(response,409,{error:"PROJECT_HAS_ACTIVE_TASKS"});return;}
      try{sendJson(response,202,{migration:await workspaces.start(projectId,{root:input.root,name:input.name})});}catch(error){workspaceError(error);}return;
    }
    if(subpath==="workspace/cleanup" && method==="POST"){
      const input=z.object({job_id:z.string().uuid(),confirm:z.literal(true)}).strict().parse(await readJson(request));
      sendJson(response,200,workspaces.cleanup(projectId,input.job_id));return;
    }
    if (subpath === "literature-analysis" && method === "GET") { sendJson(response, 200, { analysis: analysis.status(projectId) }); return; }
    if ((subpath === "literature-analysis" || subpath === "literature-analysis/cancel") && method === "POST") {
      z.object({ confirm: z.literal(true) }).strict().parse(await readJson(request));
      if (subpath.endsWith("/cancel")) { sendJson(response, 200, { analysis: analysis.cancel(projectId) }); return; }
      if (codeAgent.busy(projectId)) { sendJson(response, 409, { error: "CODE_AGENT_BUSY" }); return; }
      sendJson(response, 202, { analysis: analysis.start(projectId) }); return;
    }
    const deleteSourceRoute = subpath.match(/^sources\/([^/]+)$/);
    if (deleteSourceRoute && method === "DELETE") {
      z.object({ confirm: z.literal(true) }).strict().parse(await readJson(request));
      if (agent.isProjectBusy(projectId) || codeAgent.busy(projectId)) { sendJson(response, 409, { error: "PROJECT_HAS_ACTIVE_TASKS" }); return; }
      sendJson(response, 200, store.deleteSource(projectId, decodeURIComponent(deleteSourceRoute[1]))); return;
    }
    if (subpath === "agent-tools" && method === "POST") {
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const permission = codeAgent.authorizeTool(projectId, token);
      const result = projectChatTool(store, projectId, await readJson(request), permission.writable);
      codeAgent.recordTool(projectId, token, result); sendJson(response, 200, result); return;
    }
    if(subpath==='chat/attachments'&&method==='POST'){
      const bytes=await readBody(request,20*1024*1024);
      if(workspaces.busy(projectId))throw Object.assign(new Error('WORKSPACE_MIGRATING'),{statusCode:409});
      const name=z.string().min(1).max(255).parse(url.searchParams.get('name'));
      sendJson(response,201,{attachment:uploadChatAttachment(store,projectId,name,bytes)});return;
    }
    const chatAttachmentRoute=subpath.match(/^chat\/attachments\/(artifact_[A-Za-z0-9-]+)$/);
    if(chatAttachmentRoute&&method==='GET'){
      const [attachment]=resolveChatAttachments(store,projectId,[chatAttachmentRoute[1]]);
      const bytes=store.readArtifact(projectId,attachment.id)!;
      response.writeHead(200,{'content-type':attachment.mime,'content-length':bytes.length,'content-disposition':`${attachment.image?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(bytes);return;
    }
    if (subpath === "chat/tasks" && method === "GET") { sendJson(response, 200, { tasks: codeAgent.list(projectId).filter(task => task.purpose === "project-chat").map(task => ({ ...task, logs: "" })) }); return; }
    if (subpath === "chat/tasks" && method === "POST") {
      const toolUrl = `http://127.0.0.1:${request.socket.localPort}/api/v1/projects/${encodeURIComponent(projectId)}/agent-tools`;
      sendJson(response, 201, { task: await codeAgent.start(projectId, await readJson(request), toolUrl) }); return;
    }
    if (subpath === "code-agent/detect" && method === "GET") { sendJson(response, 200, await codeAgent.detect()); return; }
    if (subpath === "code-agent/tasks" && method === "GET") { sendJson(response, 200, { tasks: codeAgent.list(projectId).filter(task => task.purpose !== "project-chat").map(task => ({ ...task, logs: "", response: "" })) }); return; }
    if (subpath === "code-agent/tasks" && method === "POST") { sendJson(response, 201, { task: await codeAgent.start(projectId, await readJson(request)) }); return; }
    const codeTask = subpath.match(/^code-agent\/tasks\/(code_[a-f0-9-]+)(?:\/(cancel|acknowledge))?$/);
    if (codeTask && method === "GET" && !codeTask[2]) { const task = codeAgent.list(projectId).find(t => t.task_id === codeTask[1]); if (!task) { sendJson(response, 404, { error: "NOT_FOUND" }); return; } sendJson(response, 200, { task }); return; }
    if (codeTask && method === "POST" && codeTask[2]) {
      z.object({ confirm: z.literal(true) }).strict().parse(await readJson(request));
      if (codeTask[2] === "cancel") codeAgent.cancel(projectId, codeTask[1]); else codeAgent.acknowledge(projectId, codeTask[1]);
      sendJson(response, 200, { accepted: true }); return;
    }
    if (codeAgent.busy(projectId) && ((subpath.startsWith("repository") && method !== "GET") || ((subpath === "experiment-runs" || /^experiment-runs\/[^/]+\/retry$/.test(subpath)) && method === "POST"))) { sendJson(response, 409, { error: "CODE_AGENT_BUSY" }); return; }
    if (await experimentRoute(request,response,url,projectId,subpath,experiments,readJson,sendJson)) return;
    if (subpath === "overview" && method === "GET") {
      sendJson(response, 200, projectOverview(store, projectId));
      return;
    }
    if (!subpath && method === "DELETE") {
      const input = z.object({ confirm_title: z.string() }).strict().parse(await readJson(request));
      if (input.confirm_title !== project.title) { sendJson(response, 400, { error: "PROJECT_TITLE_MISMATCH" }); return; }
      if (agent.isProjectBusy(projectId) || experiments.busyProject(projectId) || codeAgent.busy(projectId)) { sendJson(response, 409, { error: "PROJECT_HAS_ACTIVE_TASKS" }); return; }
      const sshProfiles = experiments.data.profiles(projectId);
      const deleted = store.deleteProject(projectId);
      for (const profile of sshProfiles) experiments.ssh.forget(profile.profile_id);
      sendJson(response, 200, deleted);
      return;
    }
    if (await knowledgeRoute(request, response, url, projectId, subpath, store, knowledge, readJson, sendJson, agent)) return;
    const attachmentRoute = subpath.match(/^sources\/([^/]+)\/attachments$/);
    if (attachmentRoute && method === "POST") {
      const sourceId = decodeURIComponent(attachmentRoute[1]);
      const source = store.getSource(sourceId);
      if (!source || source.project_id !== projectId) { sendJson(response,404,{error:"SOURCE_NOT_FOUND"}); return; }
      const filename = url.searchParams.get("filename") ?? "";
      if (!filename.toLowerCase().endsWith(".pdf")) throw Object.assign(new Error("UNSUPPORTED_FILE_TYPE"),{statusCode:422});
      const bytes = await readBody(request, MAX_UPLOAD_BYTES);
      const parsed = (await parseImportedFile(filename,bytes))[0];
      const artifact = store.saveArtifact(projectId,filename,"application/pdf",bytes);
      try {
        store.db.transaction(()=>{
          if (source.artifact_id) store.db.prepare("INSERT OR IGNORE INTO source_attachments VALUES (?,?,?)").run(sourceId,source.artifact_id,source.imported_at);
          store.db.prepare("INSERT INTO source_attachments VALUES (?,?,?)").run(sourceId,artifact.artifact_id,new Date().toISOString());
          const updated = { ...source, artifact_id:artifact.artifact_id, imported_file_sha256:artifact.sha256, parse_status:parsed.parse_status, ...(parsed.import_error ? {import_error:parsed.import_error} : {}) };
          if (!parsed.import_error) delete updated.import_error;
          store.db.prepare("UPDATE sources SET artifact_id=?,imported_file_sha256=?,data=? WHERE source_id=?").run(artifact.artifact_id,artifact.sha256,JSON.stringify(updated),sourceId);
          store.db.prepare("DELETE FROM source_segments_fts WHERE source_id=?").run(sourceId);
          store.db.prepare("DELETE FROM source_segments WHERE source_id=?").run(sourceId);
          parsed.segments.forEach((segment,ordinal)=>{
            const locator=JSON.stringify(segment.locator);
            const row=store.db.prepare("INSERT INTO source_segments(source_id,ordinal,locator_json,content) VALUES (?,?,?,?)").run(sourceId,ordinal,locator,segment.text);
            store.db.prepare("INSERT INTO source_segments_fts(rowid,source_id,project_id,locator_json,content) VALUES (?,?,?,?,?)").run(row.lastInsertRowid,sourceId,projectId,locator,segment.text);
          });
          knowledge.touch(projectId);
        })();
      } catch(error) { store.discardArtifact(projectId,artifact.artifact_id); throw error; }
      sendJson(response,201,{artifact});return;
    }
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
      try { store.createSources(sources, new Map(parsedSources.map((item, index) => [sources[index].source_id, item.segments]))); }
      catch(error) { store.discardArtifact(projectId,artifact.artifact_id); throw error; }
      knowledge.touch(projectId);
      sendJson(response, 201, { sources, artifact, duplicate: false });
      return;
    }
    if (subpath === "sources/url" && method === "POST") {
      const input = await readJson<{ url: string }>(request);
      if (!input || typeof input.url !== "string") throw Object.assign(new Error("URL_REQUIRED"), { statusCode: 400 });
      const page = await fetchPublicWebpage(input.url);
      const parsed = parseWebpage(page.html, page.final_url);
      const artifact = store.saveArtifact(projectId, `${parsed.title}.html`, "text/html", page.html);
      const source = makeSource(projectId, parsed, { artifactId: artifact.artifact_id, fileHash: artifact.sha256 });
      try { store.createSources([source], new Map([[source.source_id, parsed.segments]])); }
      catch(error) { store.discardArtifact(projectId,artifact.artifact_id); throw error; }
      knowledge.touch(projectId);
      sendJson(response, 201, { source, artifact });
      return;
    }
    if (subpath === "sources/import-search-results" && method === "POST") {
      const body = await readJson<{ results: unknown }>(request);
      if (!body || !Array.isArray(body.results)) throw Object.assign(new Error("RESULTS_REQUIRED"), { statusCode: 400 });
      const results = body.results.map((item) => literatureSearchResultSchema.parse(item));
      const existing = new Set(store.listSources(projectId).filter((source) => source.provider_ref).map((source) => `${source.provider_id}:${source.provider_ref}`));
      const sources = results.filter((item) => { const key = `${item.provider_id}:${item.provider_ref}`; if(existing.has(key))return false; existing.add(key);return true; }).map((item) => makeSource(projectId, {
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
      if (!input || typeof input.query !== "string" || input.query.trim().length < 2) throw Object.assign(new Error("QUERY_TOO_SHORT"), { statusCode: 400 });
      z.object({query:z.string().min(2),limit:z.number().int().min(1).max(100).optional()}).parse(input);
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

export function createWorkbenchServer(options: WorkbenchServerOptions = {}): { server: Server; store: TrashStore; closeConnections: () => void } {
  const store = options.store ?? new TrashStore();
  const provider = options.provider ?? new OpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
  const staticRoot = options.staticRoot ?? resolve(fileURLToPath(new URL("../../workbench/dist/", import.meta.url)));
  const knowledge = new KnowledgeStore(store.db);
  const workspaces = new ProjectWorkspaces(store, knowledge);
  const agent = new KnowledgeAgent(store, knowledge);
  const experiments = new ExperimentService(store);
  const codeAgent = new CodeAgent(store, experiments);
  const analysis = new LiteratureAnalysis(store, knowledge, agent);
  const files = new ProjectFiles(store,id=>workspaces.busy(id)||agent.isProjectBusy(id)||codeAgent.busy(id)||experiments.busyProject(id)||directoryRepairBusy(store,id)||knowledge.tasks(id).some(task=>["queued","running"].includes(task.status)));
  const server = createServer((request, response) => {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin))) {
      sendJson(response,403,{error:"ORIGIN_NOT_ALLOWED"}); return;
    }
    const onError = (error: unknown): void => {
      if (!response.headersSent) {
        const mapped = jsonError(error);
        sendJson(response, mapped.status, { error: mapped.code });
      } else response.destroy();
    };
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (options.frontend && pathname !== "/api" && !pathname.startsWith("/api/")) {
      try {
        options.frontend(request, response, (error) => {
          if (error) onError(error);
          else if (!response.writableEnded) sendJson(response, 404, { error: "NOT_FOUND" });
        });
      } catch (error) { onError(error); }
      return;
    }
    const match=pathname.match(/^\/api\/v1\/projects\/([^/]+)/);
    let tracked:string|undefined;
    try{tracked=match?decodeURIComponent(match[1]):undefined;}catch{sendJson(response,400,{error:"INVALID_REQUEST"});return;}
    if(tracked)workspaces.requests.set(tracked,(workspaces.requests.get(tracked)??0)+1);
    void route(request, response, store, provider, staticRoot, knowledge, agent, experiments, codeAgent, analysis, workspaces, files).catch(onError).finally(()=>{
      if(tracked){const count=(workspaces.requests.get(tracked)??1)-1;if(count)workspaces.requests.set(tracked,count);else workspaces.requests.delete(tracked);}
    });
  });
  // Streaming datasets can reach 5 GiB; retain a bounded receive deadline for slow uploads.
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.on("close", () => { workspaces.close(); codeAgent.close(); experiments.close(); agent.close(); });
  return { server, store, closeConnections: () => {workspaces.close();experiments.terminals.close();} };
}

