import {bibliographyState,sourceContentHash} from './source-bibliography.js';
import { PdfReading } from "./pdf-reading.js";
import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge, stageKnowledgeSkill } from "./markdown-knowledge.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KnowledgeStore, experimentError, type TrashStore } from "@trash/storage";
import { knowledgeKindSchema, knowledgeWriteSchema } from "@trash/protocol";

type ReadReceipt={path:string;hash:string;ranges?:[number,number][];total?:number};
function rememberRead(ledger:string,path:string,hash:string,start:number,end:number,total:number){
 let reads:ReadReceipt[]=[];try{reads=JSON.parse(readFileSync(ledger,'utf8'));}catch{/* First read. */}
 const receipt=reads.find(read=>read.path===path&&read.hash===hash)??{path,hash,ranges:[],total};
 if(!reads.includes(receipt))reads.push(receipt);
 const ranges=[...(receipt.ranges??[]),[start,end] as [number,number]].filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]),merged:[number,number][]=[];
 for(const range of ranges){const previous=merged.at(-1);if(previous&&range[0]<=previous[1])previous[1]=Math.max(previous[1],range[1]);else merged.push([...range]);}
 receipt.ranges=merged;receipt.total=total;writeFileSync(ledger,JSON.stringify(reads),{mode:0o600});
}

export function prepareChatWorkspace(store: TrashStore, projectId: string) {
  const path = projectRuntime(store.root,projectId,'agent-workspace'); mkdirSync(path, { recursive: true });
  const projectRoot=join(store.root,'projects',projectId);
  if(existsSync(join(projectRoot,'project.yaml'))){
    const drafts=join(path,'manuscripts');
    if(!existsSync(drafts)){const draftRoot=join(projectRoot,'manuscript',...(readFileSync(join(projectRoot,'project.yaml'),'utf8').includes('format_version: 2')?['drafts']:[]));mkdirSync(draftRoot,{recursive:true});symlinkSync(draftRoot,drafts,'dir');}
  }
  writeFileSync(join(path, "project_snapshot.json"), JSON.stringify({ at:new Date().toISOString(),project:store.getProject(projectId),source_count:store.listSources(projectId).length,knowledge_count:new MarkdownKnowledge(store).index(projectId).documents.length,note:'仅项目概览，无知识正文。先 list/search 查询索引，再 get 按需读取；综合必须报告实际覆盖范围。' }),{mode:0o600});
  writeFileSync(join(path,'bibliography-baselines.json'),JSON.stringify(Object.fromEntries(store.listSources(projectId).map(source=>[source.source_id,{authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date,revision:bibliographyState(store,source.source_id).revision??0,content_hash:sourceContentHash(source)}]))),{mode:0o600});
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
navigation 使用 page/limit/query 查询 Wiki 轻量索引（包含标题、别名和适用问题）；relations 使用 id 返回引用依据、相关主题、反向引用和断链；context 使用 query/length（最多16000字符）先返回匹配职责页和一跳知识关联、未读取的evidence_candidates。evidence 使用 id/offset/length 按条读取evidence/ev-*.md，返回source_id、hash、条件、原文定位、反向引用章节和实际读取范围；读取依据不等于重新核验PDF。evidence/get读取独立依据时附带同版本公共范围（最多16000字符）与verification声明；范围缺失、版本不同或超限时根据scope_status和scope_document另行读取，不能推定范围。跨论文背景先归纳候选共识，再按结论查支持与反例，关键数字或争议再查PDF。报告 omitted，不等于全库覆盖。修改前仍 get 获取完整工作副本和 hash。maintenance 返回不调用模型的结构检查，memory-log 按 page 查询实际操作历史。语义维护按问题读取证据；普通问答不自动写文件，用户要求整理、更新或记住研究知识时可以把有来源且可复用的认识补入已有页。
list 使用 kind、page、limit（最多50）分页读取索引；search 使用 kind、query 查询标题与正文，返回片段。get 使用 kind、id、offset、length（最多16000字符）按需读取正文，返回 total/next_offset 和 hash。返回不完整必须继续读取，不能声称已读全文。
Wiki是面向后续Agent的精简研究记忆；主题从文献开放发现，先提取比较、再关联项目，不能受项目题目限制。知识主题、候选线索、待验证假设分开，先读references/wiki.md。论文题录统一使用 idcard.md，正文知识使用 Wiki 与证据页；回答报告材料范围。全项目综合必须分批覆盖所有论文知识，并记录缺失项。每次 get 在 knowledge-draft 创建该文件完整工作副本，只有实际读取部分才算已阅读。新文档先写 knowledge_version: 2；Wiki level 为 single/summary/discovery/topic/hypothesis/overview，主题文件必须明确来源。
Wiki 必须先读取 literature-skill/SKILL.md，直接写 Markdown 到 knowledge-draft/knowledge_base/。论文入口为 papers/<source_id>/whoami.md，题录为 idcard.md，方法、结果和依据等职责页遵循 references/paper-wiki.md。全部为 kind: wiki-page，保留任务指定稳定ID和真实source_id。主题位于 topics/，假设 hypotheses/，发现 discoveries/，分批总结 summaries/，总览 overview.md。
先通过 get 记下原文件 hash（新文件为 null），写好后调用 {"operation":"publish","files":[{"path":"knowledge_base/papers/source_example/whoami.md","expected":null}]}。工具从工作副本读取 Markdown 原样提交，正文不要放进 JSON。更新先重新 get 并保留用户内容；Wiki 使用 references/wiki.md 的明确证据与关系写法，引用依据中的文件须实际 get/context 读取；导航链接不作为证据；冲突保留副本，不重试覆盖。不再生成或读取basic/key/detail旧卡片；使用whoami入口及同篇Wiki职责页。发布后平台回填标题和年月，人工修改冲突保留建议。
实验结果仍使用 write，kind=experiment-result，input 为原结构化记录及 base_version。不能编造结果。
不要修改正式知识目录、.trash、数据库、任务文件、原始论文或其他项目。论文草稿可写 manuscripts/。Wiki发布后直接可用，无人工采纳步骤；保留未知事实和待验证假设，不自动删除或发起实验。写入不代替用户验收。
`);
  return path;
}

export async function projectChatTool(store: TrashStore, projectId: string, body: unknown, writable: boolean) {
  const value = z.object({ operation: z.enum(["summary", "sources", "source", "list", "search", "get", "write", "publish", "pdf-pages", "pdf-page", "navigation", "relations", "context", "maintenance", "memory-log", "evidence"]), page:z.number().int().positive().optional(),limit:z.number().int().min(1).max(50).optional(),query:z.string().max(500).optional(),offset:z.number().int().min(0).optional(),length:z.number().int().min(1).max(16000).optional(),scale:z.union([z.literal(2200),z.literal(4400)]).optional(),kind: knowledgeKindSchema.optional(), id: z.string().min(1).optional(), input: knowledgeWriteSchema.optional(), files:z.array(z.object({path:z.string(),expected:z.string().nullable()}).strict()).min(1).max(120).optional() }).strict().parse(body);
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
  if(value.operation==='navigation')return markdown.navigation(projectId,{page:value.page,limit:value.limit,q:value.query});
  if(value.operation==='relations')return markdown.relations(projectId,value.id??'');
  if(value.operation==='maintenance')return markdown.health(projectId);
  if(value.operation==='memory-log')return markdown.operations(projectId,value.page);
  if(value.operation==='context'){
    if(!value.query?.trim())experimentError('INVALID_REQUEST',400);
    const result=markdown.context(projectId,value.query,value.length??16000);
    const workspace=projectRuntime(store.root,projectId,'agent-workspace'),ledger=join(workspace,'knowledge-reads.json');
    for(const doc of result.documents)rememberRead(ledger,doc.path,doc.hash,0,doc.text.length,doc.text.length);
    if(writable)markdown.recordOperation(projectId,'query',result.documents.map(({id,path,hash})=>({id,path,hash})),`读取 ${result.documents.length} 页，${result.characters} 字符；遗漏 ${result.omitted.length} 页。`);
    return result;
  }
  if(value.operation==='publish'){
    if(!writable)experimentError('AGENT_READ_ONLY',403);if(!value.files)experimentError('INVALID_REQUEST',400);
    const files=value.files.map(file=>{markdown.locate(projectId,file.path);const draft=projectRuntime(store.root,projectId,'agent-workspace','knowledge-draft',file.path);let current=projectRuntime(store.root,projectId,'agent-workspace');for(const part of ['knowledge-draft',...file.path.split('/')]){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())experimentError('KNOWLEDGE_PATH_INVALID',403);}if(lstatSync(draft).size>1024*1024)experimentError('KNOWLEDGE_FILE_INVALID',422);return {...file,text:readFileSync(draft,'utf8')};});
    if(!files.some(file=>/^knowledge_base\/papers\/[^/]+\/index\.md$/.test(file.path))&&files.some(file=>file.path.startsWith('literature/cards/')||/knowledge_base\/papers\/[^/]+\/(basic|detail|key)\.md$/.test(file.path))&&!['basic','detail','key'].every(type=>files.some(file=>file.path.endsWith(`-${type}.md`)||file.path.endsWith('/'+type+'.md'))))experimentError('CARD_PAIR_REQUIRED',400);
    const ledger=projectRuntime(store.root,projectId,'agent-workspace','knowledge-reads.json');let refs:ReadReceipt[]=[];try{refs=JSON.parse(readFileSync(ledger,'utf8'));}catch{/* No read dependencies. */}
    const index=markdown.index(projectId).documents;
    const evidence=new Set(files.flatMap(file=>(markdown.parse(projectId,file.path,file.text).links??[]).filter(l=>l.evidence).map(l=>l.path)));
    refs=[...new Map(refs.filter(ref=>evidence.has(ref.path)).map(ref=>[ref.path,ref])).values()];
    for(const path of evidence){if(files.some(file=>file.path===path))continue;const current=index.find(d=>d.path===path);if(!current)experimentError('DEPENDENCY_NOT_FOUND',404);const read=refs.find(ref=>ref.path===path);if(!read||current.hash!==read.hash)experimentError('VERSION_CONFLICT',409);if(!read.total||!read.ranges?.some(([start,end])=>start===0&&end>=read.total!))experimentError('EVIDENCE_NOT_FULLY_READ',422);}

    const baselines=JSON.parse(readFileSync(projectRuntime(store.root,projectId,'agent-workspace','bibliography-baselines.json'),'utf8'));for(const file of files.filter(f=>f.path.endsWith('-basic.md'))){const id=markdown.parse(projectId,file.path,file.text).source_id!;if(!baselines[id]||baselines[id].content_hash!==sourceContentHash(store.getSource(id)))experimentError('VERSION_CONFLICT',409);}
    const records=markdown.commit(projectId,files,baselines);
    for(const record of records.filter(r=>r.kind==='wiki-page')){
      const declared=new Set((record.links??[]).filter(link=>link.evidence).map(link=>link.path));
      markdown.stamp(projectId,record.id,[...refs.filter(r=>declared.has(r.path)&&r.path!==record.path&&!records.some(output=>output.path===r.path)),...records.filter(output=>declared.has(output.path)&&output.path!==record.path).map(({path,hash})=>({path,hash}))],true);
    }
    return {records};
  }
  if(value.operation==='evidence'||value.kind&&value.kind!=='experiment-result'){
    if(value.operation==='list'||value.operation==='search')return markdown.query(projectId,{kind:value.kind,page:value.page,limit:value.limit??30,q:value.operation==='search'?value.query:undefined});
    if(value.operation==='get'||value.operation==='evidence'){
      const candidate=markdown.read(projectId,value.id??'');
      const evidence=value.operation==='evidence'||('page_role' in candidate&&candidate.page_role==='evidence')?markdown.evidence(projectId,value.id??''):undefined;
      const record=evidence?.record??markdown.read(projectId,value.id??''),offset=value.offset??0,length=value.length??12000;
      const workspace=projectRuntime(store.root,projectId,'agent-workspace'),draft=join(workspace,'knowledge-draft',record.path);mkdirSync(join(draft,'..'),{recursive:true});
      // Never overwrite an existing working copy: it may contain unsaved agent edits.
      if(!existsSync(draft))writeFileSync(draft,record.text,{mode:0o600});
      const ledger=join(workspace,'knowledge-reads.json');
      if(evidence?.material_scope){const scope=evidence.material_scope;rememberRead(ledger,scope.path,scope.hash,0,scope.text.length,scope.text.length);if(writable)markdown.recordOperation(projectId,'read-evidence-scope',[{id:scope.id,path:scope.path,hash:scope.hash}],`实际附带公共范围全文 ${scope.text.length} 字符；不代表重新核验PDF。`);}
      rememberRead(ledger,record.path,record.hash,offset,Math.min(record.text.length,offset+length),record.text.length);
      const {text,...metadata}=record;const end=Math.min(text.length,offset+length);
      if(writable)markdown.recordOperation(projectId,value.operation==='evidence'?'read-evidence':'read', [{id:record.id,path:record.path,hash:record.hash}],`实际返回字符 ${offset}–${end}/${text.length}；${end<text.length?'尚有未读内容':'已到末尾'}；不代表已核验PDF。`);
      return {record:{...metadata,text:text.slice(offset,end)},offset,total:text.length,next_offset:end<text.length?end:null,working_copy:draft,...(evidence?{source:evidence.source,material_scope:evidence.material_scope,scope_status:evidence.scope_status,scope_document:evidence.scope_document,verification:evidence.verification,citations:evidence.citations,note:evidence.note}:{})};
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
