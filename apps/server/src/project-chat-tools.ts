import { manuscriptDirectory } from './manuscript-layout.js';
import {bibliographyState,sourceContentHash} from './source-bibliography.js';
import { PdfReading } from "./pdf-reading.js";
import { ensureResearchDirectory, projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge } from "./markdown-knowledge.js";
import { stageChatSkills, type ChatSkillId } from "./project-chat-skills.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, renameSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
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

function manuscriptPath(projectRoot:string,workspace:string){
  if(!existsSync(join(projectRoot,'project.yaml')))return;
  const root=realpathSync(projectRoot);
  const target=join(root,manuscriptDirectory(root));
  if(!existsSync(target))return;
  if(!lstatSync(target).isDirectory())return;
  const alias=join(workspace,'manuscripts');
  try {
    if(!lstatSync(alias).isSymbolicLink())return target;
    const linked=resolve(dirname(alias),readlinkSync(alias));
    const physical=existsSync(alias)?realpathSync(alias):linked;
    if(physical===target)return 'manuscripts/';
    const oldTargets=[root,projectRoot].flatMap(base=>['manuscript','manuscripts']
      .flatMap(folder=>[join(base,folder),join(base,folder,'drafts')]));
    if(!oldTargets.includes(linked)&&!oldTargets.includes(physical))return target;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    symlinkSync(relative(workspace,target),alias,'dir');
    return 'manuscripts/';
  }
  const temporary=alias+'.'+randomUUID()+'.tmp';
  symlinkSync(relative(workspace,target),temporary,'dir');
  try { renameSync(temporary,alias); }
  finally { if(existsSync(temporary))unlinkSync(temporary); }
  return 'manuscripts/';
}

export function prepareChatWorkspace(store: TrashStore, projectId: string, taskId: string, selectedSkill?: ChatSkillId) {
  const path = projectRuntime(store.root,projectId,'agent-workspace','turns',taskId); mkdirSync(path, { recursive: true });
  const projectRoot=join(store.root,'projects',projectId);
  const manuscripts=manuscriptPath(projectRoot,path);
  let research:string|undefined;
  if(existsSync(join(projectRoot,'project.yaml'))){
    try {
      if(lstatSync(join(projectRoot,'research')).isDirectory())research=ensureResearchDirectory(store.root,projectId);
    }
    catch { /* Other chat workflows can still run when this output path is unavailable. */ }
  }
  writeFileSync(join(path, "project_snapshot.json"), JSON.stringify({ at:new Date().toISOString(),project:store.getProject(projectId),source_count:store.listSources(projectId).length,knowledge_count:new MarkdownKnowledge(store).index(projectId).documents.length,note:'仅项目概览，无知识正文。先 list/search 查询索引，再 get 按需读取；综合必须报告实际覆盖范围。' }),{mode:0o600});
  writeFileSync(join(path,'bibliography-baselines.json'),JSON.stringify(Object.fromEntries(store.listSources(projectId).map(source=>[source.source_id,{authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date,revision:bibliographyState(store,source.source_id).revision??0,content_hash:sourceContentHash(source)}]))),{mode:0o600});
  writeFileSync(join(path,'knowledge-reads.json'),'[]',{mode:0o600});
  writeFileSync(join(path, "project_tool.py"), `import os,sys,json,urllib.request,urllib.error
payload=json.load(sys.stdin)
request=urllib.request.Request(os.environ['TRASH_PROJECT_TOOL_URL'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['TRASH_PROJECT_TOOL_TOKEN']},method='POST')
try:
 operation=payload.get('operation')
 timeout=310+payload.get('timeout_seconds',120) if operation=='paper-code-run' else 7200 if operation in ('autodl-upload-file','autodl-upload-code') else 30
 with urllib.request.urlopen(request,timeout=timeout) as response: print(response.read().decode())
except urllib.error.HTTPError as error:
 print(error.read().decode());sys.exit(1)
`);
  stageChatSkills(path, selectedSkill);
  // Do not stage project-wide bodies. get creates only the requested working copy.
  writeFileSync(join(path, "PROJECT_TOOLS.md"), `# 当前论文项目工具
研究地图读取 map-skill/SKILL.md，大背景读取 background-skill/SKILL.md，多主题发现、主题比较及关系维护读取 synthesis-skill/SKILL.md；候选方向筛选读取 research-skill/SKILL.md，单篇生成读取 literature-skill/SKILL.md。简单问答无需发布，不自动串行执行全部技能。
用户明确要求起草或修订某个自研实验的方法设计时，读取 method-skill/SKILL.md。调用 {"operation":"method-experiments"} 确认当前项目中的目标，不凭实验名猜测目录 ID。匹配多个或无法定位时向用户确认。
使用 {"operation":"method-context","direction_id":"方向ID","scheme_id":"方案ID"} 获取方法正文和对应仓库。可选 source 为用户选定的 research/ 直属 Markdown 相对路径。按需阅读仓库。使用 {"operation":"method-draft","markdown":"完整候选正文","summary":"修改摘要","questions":[]} 将草稿送到该实验的方法设计页。该操作只保存候选正文，正式正文由用户审阅采用。需要先问关键问题时，直接在本轮回复中提出。普通方法讨论直接回复。
以 python3 project_tool.py 执行，stdin 传入 JSON，所有操作仅限当前项目。
需要用户在明确的备选方案间选择时，用 {"operation":"request-choice","title":"选择目标","description":"简述各项区别","options":[{"id":"first","label":"选择 A","primary":true},{"id":"second","label":"选择 B"}]}。可以提供 details 键值列表，以及每个选项的 detail。收到 waiting_for_user 后结束本轮，等用户在对话卡片中选择。平台会用已选结果开启同一会话的下一轮；提案工具本身没有执行选项。
绑定仓库有改动而用户要上传代码，且需要用户确认提交时，用 {"operation":"request-git-autodl-choice","message":"chore：改用本地与 AutoDL 部署"}。多个已连接实例时传入用户指定的 profile_id。如果用户还明确要求上传数据，可以附 data_files，每项为 {"source":{"scope":"project","path":"data/result.csv"},"destination":"data/result.csv"}，这时卡片才提供「这次只上传数据」。工具读取并记录待提交文件和目标，提案阶段不暂存、不提交、不上传。收到 waiting_for_user 后结束本轮。选择后由平台执行对应动作，续接时只汇报已有结果或在文件变化时重新提案。
code/papers/ 外的普通共享文件（包括 code/reproductions/ 下的复现代码）可以并行读取。写入用 {"operation":"stage-shared-file","path":"research/方案.md"} 获取本轮独立草稿，编辑返回的 draft，再用 {"operation":"publish-shared-file","path":"research/方案.md"} 发布。相同路径各轮可以同时起草，发布会核对起草时的版本。收到 VERSION_CONFLICT 时保留草稿并报告路径，本轮不重复覆盖。后续合并先读取最新正式文件，再与冲突草稿对照。稿件和其他共享文件也使用此流程。
code/papers/ 下的 Git 仓库按会话绑定。用 {"operation":"paper-code-list","path":"src"} 列出绑定仓库内目录，用 {"operation":"paper-code-read","path":"src/main.py"} 读其中源码，读取不占仓库锁。允许写入时，用 {"operation":"paper-code-run","argv":["git","apply","-"],"stdin":"补丁正文","timeout_seconds":120} 在绑定仓库内修改文件或执行命令。命令结束后释放仓库锁。共用 Git 元数据的工作树也会互斥。同一仓库有其他写入或执行操作时，请等待工具返回。查看和编辑内容时可先在本轮目录准备补丁，命令也可读取本轮目录中的文件；执行结果中的退出码和错误需要核对。
仅在用户明确要求上传到 AutoDL 时调用上传工具。{"operation":"autodl-targets"} 列出当前项目已连接的实例和各自已保存的远端工作区。仅有一个已连接实例时可以省略 profile_id；多个时使用用户指定实例的 profile_id，用户没有指定时先确认目标。普通文件示例 {"operation":"autodl-upload-file","source":{"scope":"project","path":"research/report.csv"},"destination":"outputs/papers/report.csv","confirm":true}。来源 scope 为 project（项目相对路径）、turn（本轮工作目录相对路径）、repository（绑定仓库相对路径）或 attachment（传入当前轮附件 id）。destination 为远端项目工作区相对路径，也接受该工作区内的绝对文件路径。上传当前绑定仓库的完整干净 Git 提交用 {"operation":"autodl-upload-code","confirm":true}，保存到远端 code/papers/ 对应目录。工具通过现有连接上传、校验并汇报路径，相同内容可复用；同名内容不同时保持远端文件。上传完成后报告实例、路径、校验结果，代码同时报告提交号。是否执行实验由用户另行指定。
summary、sources、source（id）读取项目和论文；
{"operation":"pdf-pages","id":"source_ID"} 获取原始 PDF 页数、页标、逐页文字和 hash；{"operation":"pdf-page","id":"source_ID","page":1} 渲染整页 PNG 返回 path，必须实际用图像工具查看 path；调用工具返回路径不代表已看图。小字图表可在请求中加 scale=4400 生成更大页面，仍不清楚则标记未核实。完整阅读必须覆盖全部页，不能只读文字即称已完整分析。
navigation 使用 page/limit/query 查询 Wiki 轻量索引（包含标题、别名和适用问题）；relations 使用 id 返回引用依据、相关主题、反向引用和断链；context 使用 query/length（最多16000字符）先返回匹配职责页和一跳知识关联、未读取的evidence_candidates。evidence 使用 id/offset/length 按条读取evidence/ev-*.md，返回source_id、hash、条件、原文定位、反向引用章节和实际读取范围；读取依据不等于重新核验PDF。evidence/get读取独立依据时附带同版本公共范围（最多16000字符）与verification声明；范围缺失、版本不同或超限时根据scope_status和scope_document另行读取，不能推定范围。跨论文背景先归纳候选共识，再按结论查支持与反例，关键数字或争议再查PDF。报告 omitted，不等于全库覆盖。修改前仍 get 获取完整工作副本和 hash。maintenance 返回不调用模型的结构检查，memory-log 按 page 查询实际操作历史。语义维护按问题读取证据；普通问答不自动写文件，用户要求整理、更新或记住研究知识时可以把有来源且可复用的认识补入已有页。
list 使用 kind、page、limit（最多50）分页读取索引；search 使用 kind、query 查询标题与正文，返回片段。get 使用 kind、id、offset、length（最多16000字符）按需读取正文，返回 total/next_offset 和 hash。返回不完整必须继续读取，不能声称已读全文。
Wiki是面向后续Agent的精简研究记忆；主题从文献开放发现，先提取比较、再关联项目，不能受项目题目限制。知识主题、候选线索、待验证假设分开，先读references/wiki.md。论文题录统一使用 idcard.md，正文知识使用 Wiki 与证据页；回答报告材料范围。全项目综合必须分批覆盖所有论文知识，并记录缺失项。每次 get 在 knowledge-draft 创建该文件完整工作副本，只有实际读取部分才算已阅读。新文档先写 knowledge_version: 2；Wiki level 为 single/summary/discovery/topic/hypothesis/overview，主题文件必须明确来源。
Wiki 按单篇/综合/方向用途先读取上文对应 skill，直接写 Markdown 到 knowledge-draft/knowledge_base/。论文入口为 papers/<source_id>/whoami.md，题录为 idcard.md，方法、结果和依据等职责页遵循 references/paper-wiki.md。全部为 kind: wiki-page，保留任务指定稳定ID和真实source_id。主题位于 topics/，假设 hypotheses/，发现 discoveries/，分批总结 summaries/，总览 overview.md。
先通过 get 记下原文件 hash（新文件为 null），写好后调用 {"operation":"publish","files":[{"path":"knowledge_base/papers/source_example/whoami.md","expected":null}]}。工具从工作副本读取 Markdown 原样提交，正文不要放进 JSON。更新先重新 get 并保留用户内容；Wiki 使用 references/wiki.md 的明确证据与关系写法，引用依据中的文件须实际 get/context 读取；导航链接不作为证据；冲突保留副本，不重试覆盖。不再生成或读取basic/key/detail旧卡片；使用whoami入口及同篇Wiki职责页。发布后平台回填标题和年月，人工修改冲突保留建议。
实验结果仍使用 write，kind=experiment-result，input 为原结构化记录及 base_version。不能编造结果。
不要修改正式知识目录、.trash、数据库、任务文件、原始论文或其他项目。
${research?`用户明确要求保存研究想法、候选假设、研究方案或讨论笔记时，将目标指定为 research/ 下的直属文件并使用共享文件草稿工具，文件名体现主题。普通讨论直接回复，用户没有要求保存时不写文件。保存后报告相对于项目根目录的路径。论文正文和修订稿走下方稿件规则，正式实验配置和结果放 experiments/，发布知识走前述 Wiki 流程。`:"研究笔记目录不可用。用户要求保存研究想法或方案时说明缺少可用的 research/ 目录，不要改存稿件目录。"}
${manuscripts?`论文架位于 ${manuscripts}。先确认本轮所指论文，已有论文按 paper.yaml 找到当前稿，正文和修订稿放该篇的 drafts/，图片放 figures/，公式源放 equations/，表格放 tables/，引文文件放 references/，交付文件放 exports/，一次性工作文件放 work/。新论文由论文页建立主目录，禁止自行指定或修改 paper.yaml。历史稿件按用户指明的路径处理。`:"项目尚未配置论文工作区，先请用户在项目配置中设置。"}Wiki发布后直接可用，无人工采纳步骤；保留未知事实和待验证假设，不自动删除或发起实验。写入不代替用户验收。
`);
  return path;
}

export async function projectChatTool(store: TrashStore, projectId: string, body: unknown, { workspace, writable }: { workspace: string; writable: boolean }) {
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
    const ledger=join(workspace,'knowledge-reads.json');
    for(const doc of result.documents)rememberRead(ledger,doc.path,doc.hash,0,doc.text.length,doc.text.length);
    if(writable)markdown.recordOperation(projectId,'query',result.documents.map(({id,path,hash})=>({id,path,hash})),`读取 ${result.documents.length} 页，${result.characters} 字符；遗漏 ${result.omitted.length} 页。`);
    return result;
  }
  if(value.operation==='publish'){
    if(!writable)experimentError('AGENT_READ_ONLY',403);if(!value.files)experimentError('INVALID_REQUEST',400);
    const files=value.files.map(file=>{markdown.locate(projectId,file.path);const draft=join(workspace,'knowledge-draft',file.path);let current=workspace;for(const part of ['knowledge-draft',...file.path.split('/')]){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())experimentError('KNOWLEDGE_PATH_INVALID',403);}if(lstatSync(draft).size>1024*1024)experimentError('KNOWLEDGE_FILE_INVALID',422);return {...file,text:readFileSync(draft,'utf8')};});
    if(!files.some(file=>/^knowledge_base\/papers\/[^/]+\/index\.md$/.test(file.path))&&files.some(file=>file.path.startsWith('literature/cards/')||/knowledge_base\/papers\/[^/]+\/(basic|detail|key)\.md$/.test(file.path))&&!['basic','detail','key'].every(type=>files.some(file=>file.path.endsWith(`-${type}.md`)||file.path.endsWith('/'+type+'.md'))))experimentError('CARD_PAIR_REQUIRED',400);
    const ledger=join(workspace,'knowledge-reads.json');let refs:ReadReceipt[]=[];try{refs=JSON.parse(readFileSync(ledger,'utf8'));}catch{/* No read dependencies. */}
    const index=markdown.index(projectId).documents;
    const evidence=new Set(files.flatMap(file=>(markdown.parse(projectId,file.path,file.text).links??[]).filter(l=>l.evidence).map(l=>l.path)));
    refs=[...new Map(refs.filter(ref=>evidence.has(ref.path)).map(ref=>[ref.path,ref])).values()];
    for(const path of evidence){if(files.some(file=>file.path===path))continue;const current=index.find(d=>d.path===path);if(!current)experimentError('DEPENDENCY_NOT_FOUND',404);const read=refs.find(ref=>ref.path===path);if(!read||current.hash!==read.hash)experimentError('VERSION_CONFLICT',409);if(!read.total||!read.ranges?.some(([start,end])=>start===0&&end>=read.total!))experimentError('EVIDENCE_NOT_FULLY_READ',422);}

    const baselines=JSON.parse(readFileSync(join(workspace,'bibliography-baselines.json'),'utf8'));for(const file of files.filter(f=>f.path.endsWith('-basic.md'))){const id=markdown.parse(projectId,file.path,file.text).source_id!;if(!baselines[id]||baselines[id].content_hash!==sourceContentHash(store.getSource(id)))experimentError('VERSION_CONFLICT',409);}
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
      const draft=join(workspace,'knowledge-draft',record.path);mkdirSync(join(draft,'..'),{recursive:true});
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
