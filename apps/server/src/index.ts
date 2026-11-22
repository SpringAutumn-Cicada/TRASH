import { methodDraftInput } from "./experiment/method-agent.js";
import { CodeDirectoryMigration, codeMigrationPending } from './code-directory-migration.js';
import { ManuscriptEvidence } from './manuscript-evidence.js';
import { chatSkills } from "./project-chat-skills.js";
import {legacyMaterialTitle} from './research-exploration-format.js';
import {topicVersions} from './topic-wiki.js';
import {PaperWikiVersions} from './paper-wiki-versions.js';
import {evidenceMigrationPreview,migrateEvidence} from './evidence-migration.js';
import {projectQuestions,saveProjectQuestion} from './research-questions.js';
import {ResearchExploration} from './research-exploration.js';
import {migrationPreview,migrateKnowledgeBase,rollbackKnowledgeBase} from './knowledge-base-migration.js';
import {libraryMigrationPending,libraryPreview,migrateLibrary,rollbackLibrary} from './library-migration.js';
import {pdfPreparation} from './pdf-preparation.js';
import {abstractFile,abstractText} from './abstract-library.js';
import {closeTaskStreams} from './task-events.js';
import {sourceAnalyses,streamSourceAnalyses} from './source-analyses.js';
import {closeProjectStreams,projectStream,publishProjectChange} from './project-updates.js';
import { PdfReading } from "./pdf-reading.js";
import { createResearchFolder, ensureResearchDirectory } from "./project-layout.js";
import { MarkdownKnowledge } from "./markdown-knowledge.js";
import { uploadChatAttachment, resolveChatAttachments } from "./chat-attachments.js";
import { ProjectFiles } from "./project-files.js";
import { directoryRepairBusy } from "./experiment/directory-repair.js";
import { ProjectWorkspaces, workspaceError } from "./project-workspace.js";
import { browseDirectories, createDirectory, selectDirectory } from "./experiment/directories.js";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync,existsSync,readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeTaskInputSchema, literatureSearchResultSchema, makeId, PROTOCOL_VERSION, sourceSchema, type LiteratureSearchResult, type Source } from "@trash/protocol";
import { pdfViewerAsset, OpenAlexProvider, fetchPublicWebpage, parseImportedFile, parseWebpage, type LiteratureSearchProvider, type ParsedSource } from "@trash/literature";
import { TrashStore, KnowledgeStore, projectLibraryPath } from "@trash/storage";
import { knowledgeRoute } from "./knowledge.js";
import { KnowledgeAgent } from "./knowledge-agent.js";
import { LiteratureAnalysis } from "./literature-analysis.js";
import { CodeAgent, chatRepositoryId } from "./code-agent.js";
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
  if ([400, 403, 404, 409, 422, 503].includes(statusCode)) return { status: statusCode, code: error instanceof Error ? error.message : "INVALID_REQUEST" };
  if (statusCode === 413) return { status: 413, code: "REQUEST_TOO_LARGE" };
  if (error instanceof Error && error.message === "PROJECT_NOT_FOUND") return { status: 404, code: error.message };
  if (error instanceof Error && ["UNSUPPORTED_FILE_TYPE", "URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED", "URL_HOST_NOT_PUBLIC", "WEBPAGE_NOT_HTML", "WEBPAGE_TOO_LARGE", "WEBPAGE_REDIRECT_LIMIT"].includes(error.message)) return { status: 422, code: error.message };
  if (statusCode === 400) return { status: 400, code: error instanceof Error ? error.message : "INVALID_REQUEST" };
  if (error instanceof Error && error.message.startsWith("OPENALEX_HTTP_")) return { status: 502, code: error.message };
  return { status: 500, code: "INTERNAL_ERROR" };
}

async function route(request: IncomingMessage, response: ServerResponse, store: TrashStore, provider: LiteratureSearchProvider, staticRoot: string, knowledge: KnowledgeStore, agent: KnowledgeAgent, experiments: ExperimentService, codeAgent: CodeAgent, analysis: LiteratureAnalysis, exploration:ResearchExploration, workspaces: ProjectWorkspaces, files: ProjectFiles): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  if(url.pathname.startsWith('/api/v1/pdf-assets/')&&method==='GET'){try{const path=url.pathname.slice('/api/v1/pdf-assets/'.length);const bytes=await pdfViewerAsset(path);response.writeHead(200,{'content-type':path.endsWith('.wasm')?'application/wasm':'application/octet-stream','content-length':bytes.length,'cache-control':'public, max-age=86400'});response.end(bytes);}catch{sendJson(response,404,{error:'NOT_FOUND'});}return;}
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
    const input=z.object({title:z.string().trim().min(1).max(120),research_question:z.string().trim().max(10000).default(''),research_area:z.string().trim().max(500).optional(),research_interests:z.array(z.string().trim().min(1).max(200)).max(30).default([]),research_stage:z.enum(['exploration','focused']).default('exploration'),module:z.object({id:z.string().regex(/^[a-z][a-z0-9-]*$/),version:z.string().min(1)}).strict().optional(),workspace:z.object({root:z.string().min(1).optional(),name:z.string().min(1)}).strict().optional()}).strict().parse(await readJson(request));
    const project=store.createProject({title:input.title,research_question:input.research_question,research_area:input.research_area||undefined,research_interests:input.research_interests,research_stage:input.research_stage,module:input.module??{id:'apt-provenance',version:'0.1.0'}});
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
    const anchor=join(store.root,'projects',projectId);
    const libraryRoute=subpath==='workspace/library'||subpath==='workspace/library/rollback';
    if(libraryMigrationPending(anchor)&&!libraryRoute&&!(subpath==='workspace'&&method==='GET')){
      sendJson(response,409,{error:'LIBRARY_MIGRATION_PENDING'});return;
    }
    if(codeMigrationPending(anchor)&&!(subpath==='workspace'&&method==='GET')&&subpath!=='workspace/code-layout'&&subpath!=='workspace/code-layout/rollback'){
      sendJson(response,409,{error:'CODE_MOVE_RESUME_FIRST'});return;
    }
    if(!subpath&&method==='PATCH'){
      const input=z.object({title:z.string().trim().min(1).max(120),research_question:z.string().trim().max(10000).optional(),research_constraints:z.string().trim().max(10000).optional(),research_area:z.string().trim().max(500).optional(),research_interests:z.array(z.string().trim().min(1).max(200)).max(30).optional(),research_stage:z.enum(['exploration','focused']).optional(),expected_updated_at:z.string().optional()}).strict().parse(await readJson(request));
      if(input.expected_updated_at&&input.expected_updated_at!==project.updated_at){sendJson(response,409,{error:'VERSION_CONFLICT'});return;}
      if(project.research_questions&&input.research_question!==undefined){sendJson(response,409,{error:'USE_RESEARCH_QUESTIONS'});return;}
      const at=new Date().toISOString(),{expected_updated_at,...changes}=input;
      if(changes.research_area==='')changes.research_area=undefined;
      store.db.prepare('UPDATE projects SET data=?,updated_at=? WHERE project_id=?').run(JSON.stringify({...project,...changes,updated_at:at}),at,projectId);
      sendJson(response,200,{project:store.getProject(projectId)});return;
    }
    if(subpath==="workspace" && method==="GET"){sendJson(response,200,workspaces.state(projectId));return;}
    if(workspaces.busy(projectId)){sendJson(response,409,{error:"WORKSPACE_MIGRATING"});return;}
    if(libraryRoute){
      if(subpath==='workspace/library'&&method==='GET'){sendJson(response,200,libraryPreview(anchor));return;}
      if(method==='POST'){
        const input=z.object({confirm:z.literal(true),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await readJson(request));
        if(workspaces.busy(projectId)||(workspaces.requests.get(projectId)??0)>1||agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||directoryRepairBusy(store,projectId)||pdfPreparation(store).busy(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){
          sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;
        }
        try {
          const result=subpath==='workspace/library'?migrateLibrary(anchor,input.fingerprint):rollbackLibrary(anchor);
          new MarkdownKnowledge(store).invalidate(projectId);
          publishProjectChange(store,projectId,{wiki:true});
          sendJson(response,200,result);
        }catch(error){workspaceError(error);}
        return;
      }
      sendJson(response,404,{error:'NOT_FOUND'});return;
    }
    if(subpath==='research-questions'&&method==='GET'){sendJson(response,200,{project,questions:projectQuestions(project)});return;}
    const questionRoute=subpath.match(/^research-questions\/(question_[A-Za-z0-9_-]+)$/);
    if((subpath==='research-questions'&&method==='POST')||(questionRoute&&method==='PATCH')){
      const input=z.object({title:z.string().trim().min(1).max(200),question:z.string().trim().min(1).max(10000),status:z.enum(['candidate','evidence-needed','selected','paused','excluded']),rationale:z.string().max(5000).default(''),expected_updated_at:z.string(),source_run_id:z.string().optional(),source_candidate_id:z.string().optional()}).strict().parse(await readJson(request));
      if(Boolean(input.source_run_id)!==Boolean(input.source_candidate_id)){sendJson(response,422,{error:'RESEARCH_CANDIDATE_SOURCE_REQUIRED'});return;}
      if(questionRoute&&(input.source_run_id||input.source_candidate_id)){sendJson(response,400,{error:'RESEARCH_ORIGIN_IMMUTABLE'});return;}
      let evidence:{id:string;path:string}[]|undefined;
      if(!questionRoute&&input.source_run_id){const candidate=exploration.candidates(projectId,input.source_run_id).find(c=>c.id===input.source_candidate_id);if(!candidate?.complete){sendJson(response,422,{error:'RESEARCH_CANDIDATE_INCOMPLETE'});return;}evidence=candidate.evidence;}
      sendJson(response,200,saveProjectQuestion(store,project,{...input,evidence},questionRoute?.[1]));return;
    }
    const topicStopAfter=z.enum(['materials','discovery','synthesis']).optional();
    const candidatesRoute=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/candidates$/);
    if(candidatesRoute&&method==='GET'){sendJson(response,200,{project,candidates:exploration.candidates(projectId,candidatesRoute[1])});return;}
    if(subpath==='research-exploration/exploration-documents'&&method==='POST'){
      z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));
      sendJson(response,200,exploration.refreshExplorationDocuments(projectId));return;
    }
    if(subpath==='research-exploration/direction-materials'&&method==='GET'){
      const selection=z.object({topic_ids:z.array(z.string().min(1)).max(1000),source_ids:z.array(z.string().min(1)).max(100)}).parse({
        topic_ids:url.searchParams.getAll('topic_id'),source_ids:url.searchParams.getAll('source_id'),
      });
      sendJson(response,200,exploration.directionMaterials(projectId,selection));return;
    }
    if(subpath==='research-exploration'&&method==='GET'){sendJson(response,200,{runs:exploration.summaries(projectId),capabilities:{multi_topic:true,progress_summary:true,stage_checkpoints:true,topic_preview:true,research_skills:['map','background','synthesis','exploration'],version:16}});return;}
    if(subpath==='research-exploration'&&method==='POST'){
      if(codeAgent.busy(projectId)){sendJson(response,409,{error:'CODE_AGENT_BUSY'});return;}
      const input=z.object({source_ids:z.array(z.string()).max(100),instructions:z.string().max(5000).default(''),question_id:z.string().optional(),mode:z.enum(['directions','research-map','comparison','background','topics']).default('directions'),topic_ids:z.array(z.string().min(1)).max(1000).default([]),topic_token:z.string().regex(/^[a-f0-9]{64}$/).optional(),stop_after:topicStopAfter}).strict().parse(await readJson(request));
      if((input.stop_after&&input.mode!=='topics')||(input.topic_token&&(input.mode!=='directions'||input.question_id||!input.topic_ids.length))||(!input.topic_token&&input.topic_ids.length>30)){sendJson(response,400,{error:'INVALID_REQUEST'});return;}
      const question=input.question_id?projectQuestions(project).find(q=>q.id===input.question_id):undefined;
      if(input.question_id&&!question){sendJson(response,404,{error:'RESEARCH_QUESTION_NOT_FOUND'});return;}
      sendJson(response,202,{run:exploration.start(projectId,input.source_ids,input.instructions,question,input.mode,input.topic_ids,input.stop_after,input.topic_token)});return;
    }
    const topicPreviewRoute=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/topics\/([a-f0-9]{20})\/(preview|publish)$/);
    if(topicPreviewRoute){
      const [,runId,topicId,action]=topicPreviewRoute;
      if(action==='preview'&&method==='GET'){sendJson(response,200,{draft:exploration.readPreview(projectId,runId,topicId)});return;}
      if(method==='POST'){
        if(codeAgent.busy(projectId)){sendJson(response,409,{error:'CODE_AGENT_BUSY'});return;}
        const body=await readJson(request);
        if(action==='preview'){
          z.object({}).strict().parse(body);
          sendJson(response,202,{run:exploration.generatePreview(projectId,runId,topicId)});return;
        }
        const input=z.object({task_id:z.string().regex(/^task_[a-f0-9-]+$/),confirm:z.literal(true)}).strict().parse(body);
        sendJson(response,200,{run:exploration.publishPreview(projectId,runId,topicId,input.task_id)});return;
      }
    }
    const stageRoute=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/stop-after$/);
    if(stageRoute&&method==='POST'){
      const input=z.object({stop_after:z.enum(['materials','discovery','synthesis'])}).strict().parse(await readJson(request));
      sendJson(response,200,{run:exploration.setStopAfter(projectId,stageRoute[1],input.stop_after)});return;
    }
    const explorationAction=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/(resume|cancel)$/);
    if(explorationAction&&method==='POST'){const input=z.object({confirm:z.literal(true),topic_id:z.string().optional(),stop_after:topicStopAfter}).strict().parse(await readJson(request));if((input.topic_id||input.stop_after)&&explorationAction[2]!=='resume'){sendJson(response,400,{error:'INVALID_REQUEST'});return;}sendJson(response,200,{run:explorationAction[2]==='resume'?exploration.resume(projectId,explorationAction[1],input.topic_id,input.stop_after):exploration.cancel(projectId,explorationAction[1])});return;}
    const rediscoverRoute=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/rediscover$/);
    if(rediscoverRoute&&method==='POST'){z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));sendJson(response,202,{run:exploration.rediscover(projectId,rediscoverRoute[1])});return;}
    const appendRoute=subpath.match(/^research-exploration\/(exploration_[a-f0-9-]+)\/(append-preview|append)$/);
    if(appendRoute&&method==='POST'){
      const sourceIds=z.array(z.string().min(1)).min(1).max(100);
      const body=await readJson(request),runId=appendRoute[1];
      if(appendRoute[2]==='append-preview'){
        const input=z.object({source_ids:sourceIds}).strict().parse(body);
        sendJson(response,200,{plan:exploration.previewAppend(projectId,runId,input.source_ids)});return;
      }
      if(codeAgent.busy(projectId)){sendJson(response,409,{error:'CODE_AGENT_BUSY'});return;}
      const input=z.object({source_ids:sourceIds,token:z.string().regex(/^[a-f0-9]{64}$/),stop_after:topicStopAfter}).strict().parse(body);
      sendJson(response,202,{run:exploration.appendSources(projectId,runId,input.source_ids,input.token,input.stop_after)});return;
    }
    const pdfView=subpath.match(/^sources\/([^/]+)\/pdf-view$/);
    if(pdfView&&method==='GET'){const source=store.getSource(pdfView[1]);if(!source||source.project_id!==projectId){sendJson(response,404,{error:'SOURCE_NOT_FOUND'});return;}response.writeHead(302,{location:`/pdf-reader?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(pdfView[1])}&hash=${encodeURIComponent(url.searchParams.get('hash')??'')}`});response.end();return;}
    const pdfRoute=subpath.match(/^sources\/([^/]+)\/pdf(?:\/pages\/(\d+))?$/);
    if(pdfRoute&&method==='GET'){
      const pdf=new PdfReading(store);
      if(pdfRoute[2]){const page=await pdf.page(projectId,pdfRoute[1],Number(pdfRoute[2]),Number(url.searchParams.get('scale')??2200));const bytes=await import('node:fs/promises').then(fs=>fs.readFile(page.path));response.writeHead(200,{'content-type':'image/png','content-length':bytes.length,'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});response.end(bytes);return;}
      const doc=await pdf.document(projectId,pdfRoute[1]);sendJson(response,200,{source_id:doc.source_id,hash:doc.hash,artifact_id:doc.artifact_id,pageCount:doc.pageCount,pages:doc.pages});return;
    }
    if(subpath==='workspace/code-layout'||subpath==='workspace/code-layout/rollback'){
      const selection=z.object({kind:z.enum(['repository','reproduction']),id:z.string().min(1).max(160)});
      const service=new CodeDirectoryMigration(experiments,projectId);
      try{
        if(subpath==='workspace/code-layout'&&method==='GET'){
          const query=url.searchParams;
          sendJson(response,200,query.has('id')?service.preview(selection.strict().parse(Object.fromEntries(query))):{items:service.list()});return;
        }
        if(method==='POST'){
          const input=selection.extend({confirm:z.literal(true),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await readJson(request));
          if(workspaces.busy(projectId)||(workspaces.requests.get(projectId)??0)>1||agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)){
            sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;
          }
          const key={kind:input.kind,id:input.id};
          sendJson(response,200,subpath.endsWith('/rollback')?service.rollback(key):service.migrate(key,input.fingerprint));return;
        }
      }catch(error){workspaceError(error);}
      sendJson(response,404,{error:'NOT_FOUND'});return;
    }
    if(subpath==='workspace/research'&&method==='POST'){
      if(workspaces.busy(projectId)){sendJson(response,409,{error:'WORKSPACE_MIGRATING'});return;}
      try { ensureResearchDirectory(store.root,projectId); }
      catch(error){workspaceError(error);}
      sendJson(response,200,{path:'research'});return;
    }
    if(subpath==='workspace/research-folders'&&method==='POST'){
      if(agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}
      sendJson(response,201,createResearchFolder(store,projectId,await readJson(request)));return;
    }
    if(subpath==='workspace/manuscripts'||subpath.startsWith('workspace/manuscripts/')){
      try{
        if(subpath==='workspace/manuscripts'&&method==='GET'){
          sendJson(response,200,files.manuscripts(projectId));return;
        }
        if(subpath==='workspace/manuscripts/detail'&&method==='GET'){
          sendJson(response,200,files.manuscriptDetails(projectId,url.searchParams.get('id')??''));return;
        }
        if(subpath==='workspace/manuscripts/evidence'&&(method==='GET'||method==='POST')){
          const evidence=new ManuscriptEvidence(store);
          const paperPath=files.manuscriptPath(projectId,url.searchParams.get('id')??'');
          if(method==='GET'){
            const resultId=url.searchParams.get('result_id');
            sendJson(response,200,resultId?evidence.versions(projectId,resultId):evidence.read(projectId,anchor,paperPath));
          }else{
            const input=await readJson(request);
            if(workspaces.busy(projectId)){sendJson(response,409,{error:'WORKSPACE_MIGRATING'});return;}
            sendJson(response,200,evidence.update(projectId,anchor,files.manuscriptPath(projectId,url.searchParams.get('id')??''),input));
          }
          return;
        }
        if(subpath==='workspace/manuscripts/repository'&&method==='GET'){
          const paperId=url.searchParams.get('id')??'';
          files.manuscriptPath(projectId,paperId);
          sendJson(response,200,{repository:experiments.repository.forPaper(projectId,paperId)??null,repositories:experiments.data.repositories(projectId)});return;
        }
        if(subpath==='workspace/manuscripts/repository'&&method==='POST'){
          const input=z.discriminatedUnion('action',[
            z.object({id:z.string(),action:z.literal('create')}).strict(),
            z.object({id:z.string(),action:z.literal('link'),repository_id:z.string()}).strict(),
            z.object({id:z.string(),action:z.literal('bind'),path:z.string().min(1)}).strict()
          ]).parse(await readJson(request));
          files.manuscriptPath(projectId,input.id);
          if(workspaces.busy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}
          if(input.action==='create'){
            sendJson(response,201,{repository:await experiments.repository.initializePaper(projectId,input.id,anchor)});return;
          }
          const repositoryId=input.action==='link'?input.repository_id:(await experiments.repository.bind(projectId,{path:input.path},false)).repository_id;
          sendJson(response,200,{repository:experiments.repository.linkPaper(projectId,input.id,repositoryId)});return;
        }
        if(method==='POST'){
          const actions={
            'workspace/manuscripts':files.createManuscript.bind(files),
            'workspace/manuscripts/update':files.updateManuscript.bind(files),
            'workspace/manuscripts/adopt':files.adoptManuscript.bind(files),
            'workspace/manuscripts/section':files.createManuscriptSection.bind(files)
          };
          if(Object.hasOwn(actions,subpath)){
            const input=await readJson(request);
            sendJson(response,subpath.endsWith('/update')?200:201,actions[subpath as keyof typeof actions](projectId,input));return;
          }
        }
      }catch(error){workspaceError(error);}
      sendJson(response,404,{error:'NOT_FOUND'});return;
    }
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
          const result=actions[action as keyof typeof actions](projectId,body);
          new MarkdownKnowledge(store).invalidate(projectId);
          sendJson(response,200,result);return;
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
    if ((subpath === "literature-analysis" || subpath === "literature-analysis/cancel" || subpath === "literature-analysis/resume") && method === "POST") {
      const input=z.object({ confirm: z.literal(true),mode:z.enum(['all','missing','changed','synthesis','overview']).default('all'),source_ids:z.array(z.string().min(1)).max(1000).optional(),title:z.string().min(1).max(500).optional(),instructions:z.string().max(10000).optional() }).strict().parse(await readJson(request));
      if (subpath.endsWith("/cancel")) { sendJson(response, 200, { analysis: analysis.cancel(projectId) }); return; }
      if(subpath.endsWith('/resume')){sendJson(response,202,{analysis:analysis.resume(projectId)});return;}
      sendJson(response, 202, { analysis: analysis.start(projectId,input.mode,input) }); return;
    }
    const deleteSourceRoute = subpath.match(/^sources\/([^/]+)$/);
    if (deleteSourceRoute && method === "DELETE") {
      z.object({ confirm: z.literal(true) }).strict().parse(await readJson(request));
      // Unrelated analysis, code tasks and SSH sessions do not own this source.
      // The storage transaction checks active tasks that actually reference it.
      const sourceId=decodeURIComponent(deleteSourceRoute[1]);
      const referenced=new MarkdownKnowledge(store).index(projectId).documents.some(doc=>doc.source_id===sourceId||(doc.links??[]).some(link=>link.path.includes(sourceId)));
      if(referenced){sendJson(response,409,{error:'SOURCE_IN_USE'});return;}
      const result=store.deleteSource(projectId,sourceId);
      publishProjectChange(store,projectId,{tasks:true,sources:[sourceId]});
      sendJson(response,200,result); return;
    }
    if (subpath === "agent-tools" && method === "POST") {
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      codeAgent.authorizeTool(projectId, token);
      const body = await readJson(request);
      if (body && typeof body === "object" && "operation" in body && body.operation === "load-chat-skill") {
        sendJson(response, 200, codeAgent.loadChatSkill(projectId, token, body)); return;
      }
      if (body && typeof body === "object" && "operation" in body &&
        (body.operation === "stage-shared-file" || body.operation === "publish-shared-file")) {
        sendJson(response, 200, codeAgent.sharedFileTool(projectId, token, body)); return;
      }
      if (body && typeof body === "object" && "operation" in body &&
        (body.operation === "paper-code-list" || body.operation === "paper-code-read")) {
        sendJson(response, 200, await codeAgent.paperCodeTool(projectId, token, body)); return;
      }
      if (body && typeof body === "object" && "operation" in body &&
        ["method-experiments", "method-context", "method-draft"].includes(String(body.operation))) {
        sendJson(response, 200, codeAgent.methodChatTool(projectId, token, body as Record<string,unknown>)); return;
      }
      const permission = codeAgent.authorizeTool(projectId, token);
      const result = await projectChatTool(store, projectId, body, permission);
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
    if (subpath === 'markdown-knowledge' || subpath.startsWith('markdown-knowledge/')) {
      const markdown=new MarkdownKnowledge(store);
      if(subpath==='markdown-knowledge'&&method==='GET'){const number=(name:string,fallback:number)=>{const value=Number(url.searchParams.get(name)??fallback);return Number.isFinite(value)?Math.max(1,Math.floor(value)):fallback;};const current=url.searchParams.get('current_topic_directory')==='true'?exploration.topicDirectories(projectId).current:undefined;sendJson(response,200,markdown.query(projectId,{page:number('page',1),limit:number('limit',30),kind:url.searchParams.get('kind')??undefined,level:url.searchParams.get('level')??undefined,q:url.searchParams.get('q')??undefined,rescan:url.searchParams.get('rescan')==='true',include_summaries:url.searchParams.get('include_summaries')==='true',include_evidence:url.searchParams.get('include_evidence')==='true',current_topic_directory:current?.id,summary_titles:url.searchParams.get('include_summaries')==='true'?exploration.summaryTitles(projectId):undefined,archived_topic_discoveries:url.searchParams.get('current_topic_discovery')==='true'?new Set(exploration.topicDiscoveries(projectId).archived.map(doc=>doc.id)):undefined}));return;}
      if(subpath==='markdown-knowledge/summary-name-preview'&&method==='GET'){sendJson(response,200,{items:markdown.summaryNamePreview(projectId)});return;}
      if(subpath==='markdown-knowledge/rename-summary'&&method==='POST'){const input=z.object({id:z.string(),title:z.string().trim().min(4).max(150),expected:z.string()}).strict().parse(await readJson(request));sendJson(response,200,{document:markdown.renameSummary(projectId,input.id,input.title,input.expected)});return;}
      if(subpath==='markdown-knowledge/migration-preview'&&method==='GET'){sendJson(response,200,migrationPreview(markdown.root(projectId)));return;}
      if(subpath==='markdown-knowledge/home'&&method==='GET'){
        const root=markdown.root(projectId),{archived}=exploration.topicDirectories(projectId),manifest=migrationPreview(root),file=join(root,projectLibraryPath(root,'knowledge_base/index.md'));
        const oldLinks=new Set(archived.map(doc=>doc.path.replace(/^knowledge_base\//,'')));
        const text=existsSync(file)?readFileSync(file,'utf8').split('\n').filter(line=>!oldLinks.has(line.match(/^- \[.*\]\(([^)]+)\)$/)?.[1]??'')).join('\n'):'# 知识库\n请先预览并迁移到 knowledge_base/。';
        sendJson(response,200,{path:'knowledge_base/index.md',text,migration:manifest.migrated});return;
      }
      if(subpath==='markdown-knowledge/maintenance-log'&&method==='GET'){const root=markdown.root(projectId),file=join(root,projectLibraryPath(root,'knowledge_base/maintenance/log.md'));sendJson(response,200,{text:existsSync(file)?readFileSync(file,'utf8'):'暂无维护记录。'});return;}
      if(['markdown-knowledge/migrate','markdown-knowledge/rollback-migration'].includes(subpath)&&method==='POST'){
        const input=z.object({confirm:z.literal(true),expected:z.string().optional()}).strict().parse(await readJson(request));
        if(agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}
        const result=subpath.endsWith('/migrate')?migrateKnowledgeBase(markdown.root(projectId),input.expected??''):rollbackKnowledgeBase(markdown.root(projectId));markdown.index(projectId,true);sendJson(response,200,result);return;
      }
      if(subpath==='markdown-knowledge/evidence-migration-preview'&&method==='GET'){const source=z.string().regex(/^source_[A-Za-z0-9_-]+$/).parse(url.searchParams.get('source_id'));sendJson(response,200,evidenceMigrationPreview(markdown,projectId,source));return;}
      if(subpath==='markdown-knowledge/evidence-migrate'&&method==='POST'){
        const input=z.object({source_id:z.string().regex(/^source_[A-Za-z0-9_-]+$/),expected:z.string().length(64),confirm:z.literal(true)}).strict().parse(await readJson(request));
        if(agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}
        sendJson(response,200,migrateEvidence(markdown,projectId,input.source_id,input.expected));return;
      }
      if(subpath==='markdown-knowledge/evidence'&&method==='GET'){sendJson(response,200,markdown.evidence(projectId,url.searchParams.get('id')??''));return;}
      if(subpath==='markdown-knowledge/graph'&&method==='GET'){sendJson(response,200,markdown.graph(projectId));return;}
      if(subpath==='markdown-knowledge/relations'&&method==='GET'){sendJson(response,200,markdown.relations(projectId,url.searchParams.get('id')??''));return;}
      if(subpath==='markdown-knowledge/health'&&method==='GET'){sendJson(response,200,markdown.health(projectId));return;}
      if(subpath==='markdown-knowledge/navigation'&&method==='GET'){const input=z.object({page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(30),q:z.string().max(500).optional()}).parse(Object.fromEntries(url.searchParams));sendJson(response,200,markdown.navigation(projectId,input));return;}
      if(subpath==='markdown-knowledge/context'&&method==='GET'){const input=z.object({q:z.string().min(1).max(500),budget:z.coerce.number().int().min(1000).max(24000).default(16000)}).parse(Object.fromEntries(url.searchParams));sendJson(response,200,markdown.context(projectId,input.q,input.budget));return;}
      if(subpath==='markdown-knowledge/log'&&method==='GET'){const page=z.coerce.number().int().positive().default(1).parse(url.searchParams.get('page')??undefined);sendJson(response,200,markdown.operations(projectId,page));return;}
      if(subpath==='markdown-knowledge/document'&&method==='GET'){
        const document=markdown.read(projectId,url.searchParams.get('id')??'');
        if(document.page_role==='exploration-topic'){
          const candidate=exploration.explorationOrigin(projectId,document);
          const added=candidate&&projectQuestions(project).some(question=>question.source_run_id===candidate.run_id&&question.source_candidate_id===candidate.candidate_id);
          sendJson(response,200,{document:{...document,exploration_candidate:candidate&&{...candidate,added}}});return;
        }
        if(document.level==='summary'){
          const title=legacyMaterialTitle(document.title,document.modified,exploration.summaryTitles(projectId).get(document.id));
          sendJson(response,200,{document:{...document,title}});return;
        }
        if(document.level==='discovery'){
          const {current,archived}=exploration.topicDiscoveries(projectId);
          sendJson(response,200,{document:{...document,topic_discovery_history:current?.id===document.id||archived.some(doc=>doc.id===document.id)}});return;
        }
        sendJson(response,200,{document});return;
      }
      if(subpath==='markdown-knowledge/delete'&&method==='POST'){const input=z.object({id:z.string().min(1),expected:z.string().length(64),confirm:z.literal(true)}).strict().parse(await readJson(request));if(agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}sendJson(response,200,markdown.recycleDocument(projectId,input.id,input.expected));return;}
      if(subpath==='markdown-knowledge/paper-versions'&&method==='GET'){const source=z.string().regex(/^source_[A-Za-z0-9_-]+$/).parse(url.searchParams.get('source_id'));sendJson(response,200,{...new PaperWikiVersions(store,markdown,projectId,source).list(),busy:agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)||knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status))});return;}
      if(subpath==='markdown-knowledge/paper-versions/file'&&method==='GET'){const source=z.string().regex(/^source_[A-Za-z0-9_-]+$/).parse(url.searchParams.get('source_id'));sendJson(response,200,new PaperWikiVersions(store,markdown,projectId,source).file(url.searchParams.get('version_id')??'',url.searchParams.get('path')??''));return;}
      if(['markdown-knowledge/paper-versions/preview','markdown-knowledge/paper-versions/action'].includes(subpath)&&method==='POST'){
        const input=z.object({source_id:z.string().regex(/^source_[A-Za-z0-9_-]+$/),action:z.enum(['restore','trash','untrash','purge','note','cleanup','undo-cleanup','migrate-group']),id:z.string().max(120).optional(),paths:z.array(z.string().max(500)).max(120).optional(),expected:z.string().optional(),note:z.string().max(200).optional(),confirm:z.literal(true).optional()}).strict().parse(await readJson(request));
        const manager=new PaperWikiVersions(store,markdown,projectId,input.source_id);
        if(subpath.endsWith('/preview')){sendJson(response,200,manager.preview(input.action,input.id,input.paths));return;}
        if(!input.confirm||!input.expected){sendJson(response,400,{error:'请先预览并确认操作'});return;}
        if(agent.isProjectBusy(projectId)||codeAgent.busy(projectId)||experiments.busyProject(projectId)){sendJson(response,409,{error:'项目有活动任务，完成后可操作'});return;}
        const result=manager.act({...input,expected:input.expected});
        if(input.action!=='note')markdown.invalidate(projectId);
        sendJson(response,200,result);return;
      }
      if(subpath==='markdown-knowledge/topic-versions'&&method==='GET'){const id=z.string().regex(/^wiki-[A-Za-z0-9_-]+$/).parse(url.searchParams.get('id'));sendJson(response,200,{versions:topicVersions(markdown.root(projectId),id)});return;}
      if(subpath==='markdown-knowledge/topic-directory-versions'&&method==='GET'){sendJson(response,200,exploration.directoryVersions(projectId,url.searchParams.get('id')??''));return;}
      if(subpath==='markdown-knowledge/topic-discovery-versions'&&method==='GET'){sendJson(response,200,exploration.discoveryVersions(projectId,url.searchParams.get('id')??''));return;}
      if(subpath==='markdown-knowledge/history'&&method==='GET'){sendJson(response,200,{versions:markdown.history(projectId,url.searchParams.get('id')??'')});return;}
      if(method==='POST'){
        // Local saves/reviews use the document hash, not the project-wide Agent lock.
        // Markdown commits are synchronous; competing writes fail VERSION_CONFLICT.
        if(subpath==='markdown-knowledge/save'){const input=z.object({path:z.string(),text:z.string().max(1024*1024),expected:z.string().nullable()}).strict().parse(await readJson(request));sendJson(response,200,{document:markdown.save(projectId,input.path,input.text,input.expected)});return;}
      }
      sendJson(response,404,{error:'NOT_FOUND'});return;
    }
    if (subpath === "chat/tasks" && method === "GET") { sendJson(response,200,codeAgent.chatHistory(projectId)); return; }
    if (subpath === "chat/write-targets" && method === "GET") {
      response.setHeader("cache-control","no-store");
      sendJson(response,200,codeAgent.writeTargets(projectId));return;
    }
    if (subpath === "chat/skills" && method === "GET") { sendJson(response,200,{skills:chatSkills}); return; }
    if (subpath === "chat/model-config" && method === "GET") {
      sendJson(response,200,await codeAgent.chatModelConfig(projectId));return;
    }
    const conversationRoute=subpath.match(/^chat\/conversations\/([^/]+)\/(rename|delete|repository)$/);
    if(conversationRoute&&method==='POST'){
      const [,id,action]=conversationRoute;
      const body=await readJson(request);
      if(action==='rename'){
        const {title}=z.object({title:z.string().trim().min(1).max(120)}).strict().parse(body);
        codeAgent.changeConversation(projectId,id,{title});
      }else if(action==='repository'){
        const input=z.object({repository_id:chatRepositoryId.nullable()}).strict().parse(body);
        codeAgent.changeConversation(projectId,id,input);
      }else{
        z.object({confirm:z.literal(true)}).strict().parse(body);
        codeAgent.changeConversation(projectId,id,{deleted:true});
      }
      sendJson(response,200,{ok:true});return;
    }
    if (subpath === "chat/tasks" && method === "POST") {
      const toolUrl = `http://127.0.0.1:${request.socket.localPort}/api/v1/projects/${encodeURIComponent(projectId)}/agent-tools`;
      sendJson(response, 201, { task: await codeAgent.start(projectId, await readJson(request), toolUrl) }); return;
    }
    const chatAppend = subpath.match(/^chat\/tasks\/(code_[a-f0-9-]+)\/append$/);
    if (chatAppend && method === "POST") {
      const toolUrl = `http://127.0.0.1:${request.socket.localPort}/api/v1/projects/${encodeURIComponent(projectId)}/agent-tools`;
      sendJson(response, 201, { task: await codeAgent.append(projectId, chatAppend[1], await readJson(request), toolUrl) }); return;
    }
    if (subpath === "experiment-method/tasks" && method === "GET") {
      const selection = methodDraftInput.parse({
        direction_id: url.searchParams.get("direction_id"),
        scheme_id: url.searchParams.get("scheme_id"),
      });
      response.setHeader("cache-control", "no-store");
      sendJson(response, 200, { tasks: codeAgent.methodTasks(projectId, selection.direction_id, selection.scheme_id) });
      return;
    }
    if (subpath === "code-agent/detect" && method === "GET") { sendJson(response, 200, await codeAgent.detect()); return; }
    if (subpath === "code-agent/tasks" && method === "GET") { sendJson(response, 200, { tasks: codeAgent.list(projectId).filter(task => !task.purpose).map(task => ({ ...task, logs: "", response: "" })) }); return; }
    if (subpath === "code-agent/tasks" && method === "POST") { sendJson(response, 201, { task: await codeAgent.start(projectId, await readJson(request)) }); return; }
    if (subpath === "experiment-method/tasks" && method === "POST") {
      const input = z.object({ method: methodDraftInput, instructions: z.string().max(30000) }).strict().parse(await readJson(request));
      const task = await codeAgent.start(projectId, { ...input, sandbox:"read-only", confirm:true });
      sendJson(response, 201, { task_id: task.task_id });
      return;
    }
    const codeTask = subpath.match(/^code-agent\/tasks\/(code_[a-f0-9-]+)(?:\/(cancel|acknowledge))?$/);
    if (codeTask && method === "GET" && !codeTask[2]) { const task = codeAgent.list(projectId).find(t => t.task_id === codeTask[1]); if (!task) { sendJson(response, 404, { error: "NOT_FOUND" }); return; } sendJson(response, 200, { task }); return; }
    if (codeTask && method === "POST" && codeTask[2]) {
      z.object({ confirm: z.literal(true) }).strict().parse(await readJson(request));
      if (codeTask[2] === "cancel") codeAgent.cancel(projectId, codeTask[1]); else codeAgent.acknowledge(projectId, codeTask[1]);
      sendJson(response, 200, { accepted: true }); return;
    }
    if (codeAgent.busy(projectId) && (((subpath.startsWith("repository") || subpath === "experiment-catalog/register") && method !== "GET") || ((subpath === "experiment-runs" || /^experiment-runs\/[^/]+\/retry$/.test(subpath)) && method === "POST"))) { sendJson(response, 409, { error: "CODE_AGENT_BUSY" }); return; }
    if (await experimentRoute(request,response,url,projectId,subpath,experiments,readJson,sendJson,files)) return;
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
    if(subpath==='source-analyses/stream'&&method==='GET'){
      streamSourceAnalyses(store,agent,projectId,response);
      return;
    }
    if(subpath==='knowledge-tasks/changes'&&method==='GET'){
      const stream=projectStream(store,projectId,response);
      stream.onUpdate(update=>{if(update.tasks)stream.send('change',{});});
      stream.send('ready',{});
      return;
    }
    if(subpath==='source-analyses' && method==='GET'){
      const sourceId=url.searchParams.get('source_id')??undefined;
      sendJson(response,200,sourceAnalyses(store,agent,projectId,sourceId));
      return;
    }
    const keepOriginal=subpath.match(/^sources\/([^/]+)\/keep-original$/);
    if(keepOriginal&&method==='POST'){
      const input=z.object({confirm:z.literal(true),task_id:z.string()}).strict().parse(await readJson(request));
      const sourceId=decodeURIComponent(keepOriginal[1]),source=store.getSource(sourceId);
      if(!source||source.project_id!==projectId){sendJson(response,404,{error:'SOURCE_NOT_FOUND'});return;}
      const docs=new MarkdownKnowledge(store).index(projectId).documents.filter(doc=>doc.source_id===sourceId);
      if(!docs.some(doc=>doc.kind==='wiki-page')){sendJson(response,409,{error:'ORIGINAL_ANALYSIS_REQUIRED'});return;}
      const tasks=store.db.prepare(`SELECT task_id,status,created_at FROM knowledge_task_summaries
        WHERE project_id=? AND include_source_wiki=1 AND json_extract(source_ids,'$[0]')=?
        ORDER BY created_at DESC,task_id DESC`).all(projectId,sourceId) as {task_id:string;status:string;created_at:string}[];
      const latest=tasks[0];
      if(!latest||latest.task_id!==input.task_id||latest.status==='completed'){sendJson(response,409,{error:'TASK_FINISHED'});return;}
      if(['queued','running'].includes(latest.status))agent.cancel(projectId,latest.task_id);
      store.db.prepare(`UPDATE knowledge_tasks SET data=json_set(data,'$.dismissed_reanalysis',json('true'))
        WHERE task_id IN (SELECT task_id FROM knowledge_task_summaries WHERE project_id=? AND include_source_wiki=1
        AND json_extract(source_ids,'$[0]')=? AND status IN ('failed','interrupted','cancelled')
        AND dismissed_reanalysis=0)`).run(projectId,sourceId);
      knowledge.event(latest.task_id,'用户退出重新分析，保留当前已整理版本；日志与草稿保留');
      publishProjectChange(store,projectId,{sources:[sourceId]});
      sendJson(response,200,{preserved:true});return;
    }
    const sourceAnalysis=subpath.match(/^sources\/([^/]+)\/analyze$/);
    if(sourceAnalysis && method==='POST'){
      const input=z.object({confirm:z.literal(true),regenerate:z.boolean().default(false),resume:z.boolean().default(false)}).strict().parse(await readJson(request));
      const sourceId=decodeURIComponent(sourceAnalysis[1]),source=store.getSource(sourceId);
      if(!source||source.project_id!==projectId){sendJson(response,404,{error:'SOURCE_NOT_FOUND'});return;}
      const latestTask=(statuses:string[])=>store.db.prepare(`SELECT task_id,status FROM knowledge_task_summaries
        WHERE project_id=? AND include_source_wiki=1 AND json_extract(source_ids,'$[0]')=?
        AND status IN (${statuses.map(()=>'?').join(',')}) ORDER BY created_at DESC,task_id DESC LIMIT 1`)
        .get(projectId,sourceId,...statuses) as {task_id:string;status:string}|undefined;
      const active=latestTask(['queued','running']);
      if(active){sendJson(response,200,active);return;}
      if(input.resume){
        const attempt=latestTask(['failed','interrupted','cancelled']);
        const previous=attempt&&knowledge.task(projectId,attempt.task_id);
        if(!previous){sendJson(response,409,{error:'SOURCE_RESUME_UNAVAILABLE'});return;}
        const [task]=agent.enqueue(projectId,{...previous.input,timeout_seconds:[900,1800].includes(previous.input.timeout_seconds)?3600:previous.input.timeout_seconds,regenerate:true},previous.task_id);
        sendJson(response,202,{task_id:task.task_id,status:task.status});return;
      }
      if(!input.regenerate && new MarkdownKnowledge(store).index(projectId).documents.some(d=>d.source_id===sourceId)){sendJson(response,409,{error:'SOURCE_ANALYSIS_CONFIRM_REQUIRED'});return;}
      const [task]=agent.enqueue(projectId,knowledgeTaskInputSchema.parse({kind:'literature-card',source_ids:[sourceId],title:source.title,include_source_wiki:true,regenerate:input.regenerate}));
      sendJson(response,202,{task_id:task.task_id,status:task.status});return;
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
    if(subpath==='abstract-library'&&method==='GET'){
      const tasks=knowledge.tasks(projectId).filter(task=>task.input.abstract_mode);
      sendJson(response,200,{sources:store.listSources(projectId,true).filter(source=>source.material_scope==='abstract').map(source=>{
        const candidates=tasks.filter(task=>task.input.source_ids[0]===source.source_id).sort((a,b)=>Number(['queued','running'].includes(b.status))-Number(['queued','running'].includes(a.status))||b.created_at.localeCompare(a.created_at));
        return {source,task:candidates[0]?{task_id:candidates[0].task_id,status:candidates[0].status,error:candidates[0].error}:undefined,has_note:Boolean(abstractText(store,projectId,source.source_id)),has_wiki:Boolean(abstractText(store,projectId,source.source_id,'wiki'))};
      })});return;
    }
    if(subpath==='abstract-library'&&method==='POST'){
      const input=z.object({title:z.string().trim().min(1).max(500),authors:z.array(z.string().trim().min(1).max(200)).max(200).default([]),publication_date:z.string().regex(/^[12]\d{3}(?:-(?:0[1-9]|1[0-2]))?$/).optional(),doi:z.string().trim().max(500).optional(),source_url:z.string().url().optional(),abstract:z.string().trim().min(1).max(30000)}).strict().parse(await readJson(request));
      const duplicate=store.listSources(projectId,true).find(source=>source.material_scope==='abstract'&&((input.doi&&source.doi===input.doi)||(source.title===input.title&&source.abstract===input.abstract)));
      if(duplicate){sendJson(response,200,{source:duplicate});return;}
      const source=sourceSchema.parse({...input,material_scope:'abstract',source_type:'markdown',source_id:makeId('source'),project_id:projectId,protocol_version:'v1',parse_status:'metadata_only',imported_at:now()});
      // Abstract originals never enter full-text FTS or full-text parsed directories.
      writeFileSync(abstractFile(store,projectId,source.source_id,'materials'),`# ${source.title}\n\n材料范围：仅摘要\nsource_id=${source.source_id}\n\n${source.abstract}\n`,{mode:0o600});
      store.createSources([source],new Map());sendJson(response,201,{source});return;
    }
    const abstractEdit=subpath.match(/^abstract-library\/(source_[A-Za-z0-9_-]+)$/);
    if(abstractEdit&&method==='PATCH'){
      const source=store.getSource(abstractEdit[1]);if(!source||source.project_id!==projectId||source.material_scope!=='abstract'){sendJson(response,404,{error:'SOURCE_NOT_FOUND'});return;}
      const input=z.object({title:z.string().trim().min(1).max(500),authors:z.array(z.string().trim().min(1).max(200)).max(200),publication_date:z.string().regex(/^[12]\d{3}(?:-(?:0[1-9]|1[0-2]))?$/).optional(),doi:z.string().trim().max(500).optional(),source_url:z.string().url().optional(),abstract:z.string().trim().min(1).max(30000)}).strict().parse(await readJson(request));
      const updated=sourceSchema.parse({...source,...input,publication_date:input.publication_date,doi:input.doi,source_url:input.source_url,material_scope:'abstract',source_type:'markdown',parse_status:'metadata_only'});writeFileSync(abstractFile(store,projectId,source.source_id,'materials'),`# ${updated.title}\n\n材料范围：仅摘要\nsource_id=${updated.source_id}\n\n${updated.abstract}\n`,{mode:0o600});store.db.prepare('UPDATE sources SET data=? WHERE source_id=?').run(JSON.stringify(updated),source.source_id);sendJson(response,200,{source:updated});return;
    }
    const abstractRoute=subpath.match(/^abstract-library\/(source_[A-Za-z0-9_-]+)\/(analyze|analyze-wiki|note|wiki)$/);
    if(abstractRoute){
      const source=store.getSource(abstractRoute[1]);if(!source||source.project_id!==projectId||source.material_scope!=='abstract'){sendJson(response,404,{error:'SOURCE_NOT_FOUND'});return;}
      if(abstractRoute[2]==='note'&&method==='GET'){sendJson(response,200,{text:abstractText(store,projectId,source.source_id)});return;}
      if(abstractRoute[2]==='wiki'&&method==='GET'){sendJson(response,200,{text:abstractText(store,projectId,source.source_id,'wiki')});return;}
      if(['analyze','analyze-wiki'].includes(abstractRoute[2])&&method==='POST'){
        z.object({confirm:z.literal(true)}).strict().parse(await readJson(request));
        if(abstractRoute[2]==='analyze-wiki'&&knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status)&&task.input.source_ids.includes(source.source_id))){sendJson(response,409,{error:'PROJECT_HAS_ACTIVE_TASKS'});return;}
        const tasks=agent.enqueue(projectId,knowledgeTaskInputSchema.parse({kind:'literature-card',abstract_mode:true,abstract_wiki_only:abstractRoute[2]==='analyze-wiki',source_ids:[source.source_id],title:source.title,regenerate:true}));sendJson(response,202,{tasks,task_id:tasks[0]?.task_id});return;
      }
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
  const knowledge = new KnowledgeStore(store.db,{
    task(task){
      const sources=task.input.include_source_wiki&&!task.input.abstract_mode?task.input.source_ids.slice(0,1):[];
      publishProjectChange(store,task.project_id,{tasks:true,sources});
    },
    event(id,message){
      if(!/^(Agent 版本：|PDF |复用已完成批次 |启动本机 |Markdown 已发布：)/.test(message))return;
      const row=store.db.prepare('SELECT project_id FROM knowledge_task_summaries WHERE task_id=?').get(id) as {project_id:string}|undefined;
      if(row)publishProjectChange(store,row.project_id,{tasks:true});
    }
  });
  const workspaces = new ProjectWorkspaces(store, knowledge);
  const agent = new KnowledgeAgent(store, knowledge);
  const experiments = new ExperimentService(store);
  const codeAgent = new CodeAgent(store, experiments,()=>agent.hasRunningTasks());
  agent.canStart=()=>!codeAgent.hasUnrestrictedWriter();
  codeAgent.onSettled=()=>{for(const project of store.listProjects())agent.resumeQueued(project.project_id);};
  const analysis = new LiteratureAnalysis(store, knowledge, agent);
  const exploration=new ResearchExploration(store,knowledge,agent);
  const files = new ProjectFiles(store,id=>workspaces.busy(id)||agent.isProjectBusy(id)||codeAgent.busy(id)||experiments.busyProject(id)||directoryRepairBusy(store,id)||knowledge.tasks(id).some(task=>["queued","running"].includes(task.status)), id=>workspaces.busy(id));
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
    void route(request, response, store, provider, staticRoot, knowledge, agent, experiments, codeAgent, analysis, exploration, workspaces, files).catch(onError).finally(()=>{
      if(tracked){const count=(workspaces.requests.get(tracked)??1)-1;if(count)workspaces.requests.set(tracked,count);else workspaces.requests.delete(tracked);}
    });
  });
  // Streaming datasets can reach 5 GiB; retain a bounded receive deadline for slow uploads.
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.on("close", () => { closeTaskStreams(store);closeProjectStreams(store);workspaces.close(); codeAgent.close(); experiments.close(); agent.close(); });
  return { server, store, closeConnections: () => {closeTaskStreams(store);closeProjectStreams(store);workspaces.close();experiments.terminals.close();} };
}

