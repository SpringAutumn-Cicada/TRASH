import { PdfReading } from "./pdf-reading.js";
import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge, stageKnowledgeSkill } from "./markdown-knowledge.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, renameSync } from "node:fs";
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
  writeFileSync(join(path, "project_snapshot.json"), JSON.stringify({ at:new Date().toISOString(),project:store.getProject(projectId),source_count:store.listSources(projectId).length,knowledge_count:new MarkdownKnowledge(store).index(projectId).documents.length,note:'仅项目概览，无知识正文。先 list/search 查询索引，再 get 按需读取；综合必须报告实际覆盖范围。' }),{mode:0o600});
  writeFileSync(join(path,'knowledge-reads.json'),'[]',{mode:0o600});
  writeFileSync(join(path, "project_tool.py"), `import os,sys,json,urllib.request,urllib.error
payload=json.load(sys.stdin)
request=urllib.request.Request(os.environ['TRASH_PROJECT_TOOL_URL'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['TRASH_PROJECT_TOOL_TOKEN']},method='POST')
try:
 with urllib.request.urlopen(request,timeout=30) as response: print(response.read().decode())
except urllib.error.HTTPError as error:
 print(error.read().decode());sys.exit(1)
`);
  stageKnowledgeSkill(path);
  const oldDraft=join(path,'knowledge-draft');if(existsSync(oldDraft)){const preserved=projectRuntime(store.root,projectId,'tasks',`preserved-chat-draft-${Date.now()}`);mkdirSync(join(preserved,'..'),{recursive:true});renameSync(oldDraft,preserved);};
  // Do not stage project-wide bodies. get creates only the requested working copy.
  writeFileSync(join(path, "PROJECT_TOOLS.md"), `# 当前论文项目工具
以 python3 project_tool.py 执行，stdin 传入 JSON，所有操作仅限当前项目。
summary、sources、source（id）读取项目和论文；
{"operation":"pdf-pages","id":"source_ID"} 获取原始 PDF 页数、页标、逐页文字和 hash；{"operation":"pdf-page","id":"source_ID","page":1} 渲染整页 PNG 返回 path，必须实际用图像工具查看 path；调用工具返回路径不代表已看图。小字图表可在请求中加 scale=4400 生成更大页面，仍不清楚则标记未核实。完整阅读必须覆盖全部页，不能只读文字即称已完整分析。
list 使用 kind、page、limit（最多50）分页读取索引；search 使用 kind、query 查询标题与正文，返回片段。get 使用 kind、id、offset、length（最多16000字符）按需读取正文，返回 total/next_offset 和 hash。返回不完整必须继续读取，不能声称已读全文。
先索引后关键卡片，再按需详细卡片、Wiki、PDF；回答报告材料范围。全项目综合必须分批覆盖所有关键卡片，并记录缺失项。每次 get 在 knowledge-draft 创建该文件完整工作副本，只有实际读取部分才算已阅读。新文档先写 knowledge_version: 2；Wiki level 为 single/topic/overview，主题文件必须明确来源。
卡片或 Wiki 必须先读取 literature-skill/SKILL.md，直接写 Markdown 到 knowledge-draft/literature/cards/ 或 knowledge-draft/wiki/。每篇卡片同时生成 card-<source_id>-detail.md 和 card-<source_id>-key.md，frontmatter id 与文件名一致，kind=literature-card，source_id 保留真实来源，card_type 分别为 detail/key。Wiki 使用 wiki-<稳定ID>.md，kind=wiki-page。
先通过 get 记下原文件 hash（新文件为 null），写好后调用 {"operation":"publish","files":[{"path":"literature/cards/card-source-example-detail.md","expected":null},{"path":"literature/cards/card-source-example-key.md","expected":null}]}。工具从工作副本读取 Markdown 原样提交，正文不要放进 JSON。更新先重新 get 并保留用户内容；冲突保留副本，不重试覆盖。双卡片同时提交。
实验结果仍使用 write，kind=experiment-result，input 为原结构化记录及 base_version。不能编造结果。
不要修改正式知识目录、.trash、数据库、任务文件、原始论文或其他项目。论文草稿可写 manuscripts/。不自动删除、审核或发起实验。写入不代替用户验收。
`);
  return path;
}

export async function projectChatTool(store: TrashStore, projectId: string, body: unknown, writable: boolean) {
  const value = z.object({ operation: z.enum(["summary", "sources", "source", "list", "search", "get", "write", "publish", "pdf-pages", "pdf-page"]), page:z.number().int().positive().optional(),limit:z.number().int().min(1).max(50).optional(),query:z.string().max(500).optional(),offset:z.number().int().min(0).optional(),length:z.number().int().min(1).max(16000).optional(),scale:z.union([z.literal(2200),z.literal(4400)]).optional(),kind: knowledgeKindSchema.optional(), id: z.string().min(1).optional(), input: knowledgeWriteSchema.optional(), files:z.array(z.object({path:z.string(),expected:z.string().nullable()}).strict()).min(1).max(2).optional() }).strict().parse(body);
  const knowledge = new KnowledgeStore(store.db);
  if (value.operation === "summary") return { project: store.getProject(projectId) };
  if (value.operation === "sources") return { sources: store.listSources(projectId) };
  if (value.operation === "source") {
    const source = value.id && store.getSource(value.id);
    if (!source || source.project_id !== projectId) experimentError("SOURCE_NOT_FOUND", 404);
    return { source, segments: store.listSourceSegments(source.source_id) };
  }
  if(value.operation==='pdf-pages'||value.operation==='pdf-page'){
    if(!value.id)experimentError('INVALID_REQUEST',400);const pdf=new PdfReading(store);
    if(value.operation==='pdf-pages'){const doc=await pdf.document(projectId,value.id);return {source_id:doc.source_id,hash:doc.hash,pageCount:doc.pageCount,pages:doc.pages};}
    if(!value.page)experimentError('INVALID_REQUEST',400);const page=await pdf.page(projectId,value.id,value.page,value.scale??2200);return {...page,instruction:'必须使用图像查看工具实际打开 path 才能声称看过此页图像。',citation:`/api/v1/projects/${projectId}/sources/${value.id}/pdf-view?hash=${page.hash}#page=${value.page}`};
  }
  const markdown=new MarkdownKnowledge(store);
  if(value.operation==='publish'){
    if(!writable)experimentError('AGENT_READ_ONLY',403);if(!value.files)experimentError('INVALID_REQUEST',400);
    const files=value.files.map(file=>{markdown.locate(projectId,file.path);const draft=projectRuntime(store.root,projectId,'agent-workspace','knowledge-draft',file.path);let current=projectRuntime(store.root,projectId,'agent-workspace');for(const part of ['knowledge-draft',...file.path.split('/')]){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())experimentError('KNOWLEDGE_PATH_INVALID',403);}if(lstatSync(draft).size>1024*1024)experimentError('KNOWLEDGE_FILE_INVALID',422);return {...file,text:readFileSync(draft,'utf8')};});
    if(files.some(file=>file.path.startsWith('literature/cards/'))&&files.length!==2)experimentError('CARD_PAIR_REQUIRED',400);
    const ledger=projectRuntime(store.root,projectId,'agent-workspace','knowledge-reads.json');let refs:{path:string;hash:string}[]=[];try{refs=JSON.parse(readFileSync(ledger,'utf8'));}catch{/* No read dependencies. */}
    const index=markdown.index(projectId).documents;for(const ref of refs)if(index.find(d=>d.path===ref.path)?.hash!==ref.hash)experimentError('VERSION_CONFLICT',409);
    const records=markdown.commit(projectId,files);for(const record of records.filter(r=>r.kind==='wiki-page'))markdown.stamp(projectId,record.id,refs.filter(r=>r.path!==record.path));
    return {records};
  }
  if(value.kind&&value.kind!=='experiment-result'){
    if(value.operation==='list'||value.operation==='search')return markdown.query(projectId,{kind:value.kind,page:value.page,limit:value.limit??30,q:value.operation==='search'?value.query:undefined});
    if(value.operation==='get'){
      const record=markdown.read(projectId,value.id??''),offset=value.offset??0,length=value.length??12000;
      const workspace=projectRuntime(store.root,projectId,'agent-workspace'),draft=join(workspace,'knowledge-draft',record.path);mkdirSync(join(draft,'..'),{recursive:true});
      // Never overwrite an existing working copy: it may contain unsaved agent edits.
      if(!existsSync(draft))writeFileSync(draft,record.text,{mode:0o600});
      const ledger=join(workspace,'knowledge-reads.json');let reads:{path:string;hash:string}[]=[];try{reads=JSON.parse(readFileSync(ledger,'utf8'));}catch{/* First read. */}
      if(!reads.some(r=>r.path===record.path&&r.hash===record.hash))reads.push({path:record.path,hash:record.hash});writeFileSync(ledger,JSON.stringify(reads),{mode:0o600});
      const {text,...metadata}=record;return {record:{...metadata,text:text.slice(offset,offset+length)},offset,total:text.length,next_offset:offset+length<text.length?offset+length:null,working_copy:draft};
    }
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
