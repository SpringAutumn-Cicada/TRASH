import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge, stageKnowledgeSkill, markdownVersions } from "./markdown-knowledge.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KnowledgeStore, experimentError, type TrashStore } from "@trash/storage";
import { knowledgeKindSchema, knowledgeWriteSchema } from "@trash/protocol";

export function prepareChatWorkspace(store: TrashStore, projectId: string) {
  const path = projectRuntime(store.root,projectId,'agent-workspace'); mkdirSync(path, { recursive: true });
  const projectRoot=join(store.root,'projects',projectId);
  if(existsSync(join(projectRoot,'project.yaml'))){
    const drafts=join(path,'manuscripts');
    if(!existsSync(drafts)){const draftRoot=join(projectRoot,'manuscript',...(readFileSync(join(projectRoot,'project.yaml'),'utf8').includes('format_version: 2')?['drafts']:[]));mkdirSync(draftRoot,{recursive:true});symlinkSync(draftRoot,drafts,'dir');}
  }
  const knowledge = new KnowledgeStore(store.db);
  writeFileSync(join(path, "project_snapshot.json"), JSON.stringify({ at: new Date().toISOString(), project: store.getProject(projectId), sources: store.listSources(projectId).slice(0, 200), cards: markdownVersions(store,projectId,"literature-card").slice(0, 100), wiki: markdownVersions(store,projectId,"wiki-page").slice(0, 100), results: knowledge.list(projectId, "experiment-result").slice(0, 100), note: "截取的本轮初始快照，完整最新内容请使用平台工具查询。" }), { mode: 0o600 });
  writeFileSync(join(path, "project_tool.py"), `import os,sys,json,urllib.request,urllib.error
payload=json.load(sys.stdin)
request=urllib.request.Request(os.environ['TRASH_PROJECT_TOOL_URL'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['TRASH_PROJECT_TOOL_TOKEN']},method='POST')
try:
 with urllib.request.urlopen(request,timeout=30) as response: print(response.read().decode())
except urllib.error.HTTPError as error:
 print(error.read().decode());sys.exit(1)
`);
  stageKnowledgeSkill(path);
  const markdown=new MarkdownKnowledge(store);const documents=markdown.list(projectId).documents;
  for(const doc of documents){const draft=join(path,'knowledge-draft',doc.path);mkdirSync(join(draft,'..'),{recursive:true});writeFileSync(draft,doc.text,{mode:0o600});}
  writeFileSync(join(path, "PROJECT_TOOLS.md"), `# 当前论文项目工具
以 python3 project_tool.py 执行，stdin 传入 JSON，所有操作仅限当前项目。
summary、sources、source（id）读取项目和论文；list/get 使用 kind 和 id 读取知识。
卡片或 Wiki 必须先读取 literature-skill/SKILL.md，直接写 Markdown 到 knowledge-draft/literature/cards/ 或 knowledge-draft/wiki/。每篇卡片同时生成 card-<source_id>-detail.md 和 card-<source_id>-key.md，frontmatter id 与文件名一致，kind=literature-card，source_id 保留真实来源，card_type 分别为 detail/key。Wiki 使用 wiki-<稳定ID>.md，kind=wiki-page。
先通过 list/get 记下原文件 hash（新文件为 null），写好后调用 {"operation":"publish","files":[{"path":"literature/cards/card-source-example-detail.md","expected":null},{"path":"literature/cards/card-source-example-key.md","expected":null}]}。工具从工作副本读取 Markdown 原样提交，正文不要放进 JSON。更新先重新 get 并保留用户内容；冲突保留副本，不重试覆盖。双卡片同时提交。
实验结果仍使用 write，kind=experiment-result，input 为原结构化记录及 base_version。不能编造结果。
不要修改正式知识目录、.trash、数据库、任务文件、原始论文或其他项目。论文草稿可写 manuscripts/。不自动删除、审核或发起实验。写入不代替用户验收。
`);
  return path;
}

export function projectChatTool(store: TrashStore, projectId: string, body: unknown, writable: boolean) {
  const value = z.object({ operation: z.enum(["summary", "sources", "source", "list", "get", "write", "publish"]), kind: knowledgeKindSchema.optional(), id: z.string().min(1).optional(), input: knowledgeWriteSchema.optional(), files:z.array(z.object({path:z.string(),expected:z.string().nullable()}).strict()).min(1).max(2).optional() }).strict().parse(body);
  const knowledge = new KnowledgeStore(store.db);
  if (value.operation === "summary") return { project: store.getProject(projectId) };
  if (value.operation === "sources") return { sources: store.listSources(projectId) };
  if (value.operation === "source") {
    const source = value.id && store.getSource(value.id);
    if (!source || source.project_id !== projectId) experimentError("SOURCE_NOT_FOUND", 404);
    return { source, segments: store.listSourceSegments(source.source_id) };
  }
  const markdown=new MarkdownKnowledge(store);
  if(value.operation==='publish'){
    if(!writable)experimentError('AGENT_READ_ONLY',403);if(!value.files)experimentError('INVALID_REQUEST',400);
    const files=value.files.map(file=>{markdown.locate(projectId,file.path);const draft=projectRuntime(store.root,projectId,'agent-workspace','knowledge-draft',file.path);let current=projectRuntime(store.root,projectId,'agent-workspace');for(const part of ['knowledge-draft',...file.path.split('/')]){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())experimentError('KNOWLEDGE_PATH_INVALID',403);}if(lstatSync(draft).size>1024*1024)experimentError('KNOWLEDGE_FILE_INVALID',422);return {...file,text:readFileSync(draft,'utf8')};});
    if(files.some(file=>file.path.startsWith('literature/cards/'))&&files.length!==2)experimentError('CARD_PAIR_REQUIRED',400);
    return {records:markdown.commit(projectId,files)};
  }
  if(value.kind&&value.kind!=='experiment-result'){
    const documents=markdown.list(projectId).documents.filter(doc=>doc.kind===value.kind);
    if(value.operation==='list')return {records:documents};
    if(value.operation==='get')return {record:documents.find(doc=>doc.id===value.id)??experimentError('NOT_FOUND',404)};
    experimentError('MARKDOWN_DIRECT_WRITE_REQUIRED',409);
  }
  if (!value.kind) experimentError("INVALID_REQUEST");
  if (value.operation === "list") return { records: knowledge.list(projectId, value.kind) };
  if (value.operation === "get") {
    if (!value.id) experimentError("INVALID_REQUEST");
    return { record: knowledge.get(projectId, value.kind, value.id) ?? experimentError("NOT_FOUND", 404) };
  }
  if (!writable) experimentError("AGENT_READ_ONLY", 403);
  if (!value.input) experimentError("INVALID_REQUEST");
  return { record: knowledge.write(projectId, value.kind, value.input, "agent") };
}
