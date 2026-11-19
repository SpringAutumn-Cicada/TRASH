import {isTopicBundle,topicPaths,topicOutputPaths,topicGroupIssues,topicPrompt,topicManifest} from './topic-wiki.js';
import {PaperWikiVersions} from './paper-wiki-versions.js';
import {researchExplorationIssues,RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS,RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS,RESEARCH_SUMMARY_HARD_MAX_CHARACTERS} from './research-exploration-format.js';
import {CliTurnResult} from './cli-turn-result.js';
import {readPaperChapters,hasReadingCheckpoint} from './chapter-reader.js';
import {paperWikiPaths,paperWikiOutputPaths,paperWikiPrompt,paperWikiIssues,paperCompatibility,paperWikiSelfCheck,paperWikiWorkFile,type PaperWikiIssue} from './paper-wiki.js';
import {knowledgePath,knowledgeDocumentId} from '@trash/protocol';
import {knowledgeFiles,migrationManifest,migrationPreview,migrateKnowledgeBase} from './knowledge-base-migration.js';
import {abstractSkill,abstractText,publishAbstract,publishAbstractWiki} from './abstract-library.js';
import {bibliographyState,sourceContentHash} from './source-bibliography.js';
import { PdfReading } from "./pdf-reading.js";
import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge, skillText, stageKnowledgeSkill } from "./markdown-knowledge.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, sep, posix } from "node:path";
import { KnowledgeStore, type TrashStore, type KnowledgeTask } from "@trash/storage";
import { type KnowledgeTaskInput } from "@trash/protocol";
import { requestError, type TaskRunner } from "./knowledge.js";

const researchSkills={map:'trash-research-map',background:'trash-research-background',synthesis:'trash-literature-synthesis',exploration:'trash-research-exploration'} as const;
const taskSkill=(input:KnowledgeTaskInput)=>input.research_skill?researchSkills[input.research_skill]:input.research_exploration==='research-map'?'trash-research-map' as const:input.research_exploration==='background'?'trash-research-background' as const:input.research_exploration&&['directions','evidence-plan'].includes(input.research_exploration)?'trash-research-exploration' as const:input.kind==='wiki-page'&&input.wiki_level!=='single'?'trash-literature-synthesis' as const:'trash-literature-wiki' as const;
const taskPromptVersion=(input:KnowledgeTaskInput,paperBundle:boolean)=>paperBundle?15:input.abstract_mode?10:isTopicBundle(input)?19:18;
function researchPrompt(input:KnowledgeTaskInput,path:string,topicEntry?:string){
 const skill=taskSkill(input),role=input.wiki_level==='summary'?'':skill==='trash-research-map'?'research-map':skill==='trash-research-background'?'research-background':input.research_exploration==='topic-discovery'?'topic-discovery':skill==='trash-literature-synthesis'?'topic-synthesis':'',reference=skill==='trash-research-exploration'?'、literature-skill/references/research-exploration.md':skill==='trash-literature-synthesis'?'、literature-skill/references/synthesis.md':'';
 const summaryMode=input.research_exploration==='summary'||input.research_exploration==='summary-working';
 const citationRule=summaryMode?`summary 使用 [S1]、[S2] 等短引用，并在文末的独立“## 引用依据”栏目下使用标准 Markdown 引用定义 `+"`[S1]: <可解析的原始Wiki相对路径>`"+` 为每个实际引用来源定义一次；多项引用写成 [S1]、[S2]，不得相邻写成 [S1][S2]。未引用的选中来源在材料范围用一次 source_id 标为未覆盖。完整路径、页ID、哈希和版本由后台索引保存，正文只保留影响主题判断的逐篇差异。目标约 ${RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS}–${RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS} 字符，硬上限 ${RESEARCH_SUMMARY_HARD_MAX_CHARACTERS} 字符；超限时压缩重复引用定义、完整目录和重复解释，不能截断有效论证。${input.research_exploration==='summary-working'?'本次只使用 dependencies 中的旧总结，不能补读原始论文；超出旧总结的细节列为材料缺口。':'后续精确机制、数字或争议回原始 Wiki 补读。'}`:'原始 source_id、页 ID 和可解析相对入口按核查需要保留，关键判断就近引用，在“## 引用依据”说明实际使用来源与对应论点。';
 return `读取 literature-skill/SKILL.md${reference} 和 input.json，使用 ${skill}，模式 ${input.research_exploration}。按对应模式结构输出，不套单篇模板。先用已提供的轻量正文与 material_index 筛选，再按需读取 output/ 中的来源工作副本；索引不代表已读。补读方法、结果或具体依据仅围绕当前判断，不固定读取全部材料。${topicEntry?topicPrompt(topicEntry,input.title):`只写 output/${path}`}，本次标题“${input.title}”，${topicEntry?'各页元数据按上述组协议填写。':`${role?`frontmatter page_role: ${role}，`:''}frontmatter knowledge_version: 2、kind: wiki-page、level: ${input.wiki_level}、id: ${knowledgeDocumentId(path)}。`}不修改来源工作副本，不读PDF、历史任务或自动联网。研究条件在 input.project.research_constraints，缺项集中说明，不猜测；不要改变已选、暂缓或排除问题。summary 模式必须有“## 何时读取”“## 覆盖方向”“## 材料范围”“## 批次标识”，批次标识填写“${input.title}”。当任务标题带日期和组次时，一级标题也使用该完整标题。${citationRule}未读取项列为缺口。材料缺口不等于领域空白，未补查最接近和近期工作不宣称新颖性成立。不设计完整实验或运行实验；主题总览可列待验证问题及最小核查，方向探索可拟定方向性最小验证。主题综合保留问题选择权给研究者。利用本次已读材料自查，有具体疑点才补读相关片段，不全文回读、不增加审核调用或检查脚本。用户要求：${input.instructions}`;
}
const redact = (s: string) => s.replace(/(Bearer\s+)[\w.-]+/gi,"$1[REDACTED]").replace(/\bsk-[\w-]+\b/g,"[REDACTED]").replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]");
export class KnowledgeAgent implements TaskRunner {
  onTaskRetried?: (projectId:string, previousId:string, task:KnowledgeTask)=>void;
  onTaskSettled?: (projectId: string, task?:KnowledgeTask) => void;
  private running = new Map<string, { child: ChildProcess; task: KnowledgeTask }>();
  private closed = false;
  private reserved = new Set<string>();
  constructor(readonly store: TrashStore, readonly knowledge: KnowledgeStore, readonly cli: { command: string; prefix: string[] } = { command: process.env.TRASH_CODEX_COMMAND || "codex", prefix: [] }) {
    const rows = store.db.prepare("SELECT data FROM knowledge_tasks WHERE status IN ('queued','running')").all() as {data:string}[];
    for (const row of rows) { const task = JSON.parse(row.data) as KnowledgeTask; task.status="interrupted"; task.error="服务重启，任务已中断；请手动重试。"; knowledge.saveTask(task); }
  }
  enqueue(projectId: string, input: KnowledgeTaskInput, retryOf?: string): KnowledgeTask[] {
    if (this.closed) requestError("SERVER_STOPPING",409);
    if(input.topic_preview&&(!isTopicBundle(input)||input.research_exploration!=='topic'))requestError('INVALID_REQUEST',400);
    const kbRoot=new MarkdownKnowledge(this.store).root(projectId);
    if(!migrationManifest(kbRoot)){
      if(this.knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status)))requestError('PROJECT_HAS_ACTIVE_TASKS',409);
      migrateKnowledgeBase(kbRoot,migrationPreview(kbRoot).fingerprint);
    }
    if(retryOf){
      const all=this.knowledge.tasks(projectId);
      const descends=(candidate:KnowledgeTask)=>{const seen=new Set<string>();let id=candidate.attempt_of;while(id&&!seen.has(id)){if(id===retryOf)return true;seen.add(id);id=all.find(t=>t.task_id===id)?.attempt_of;}return false;};
      const successors=all.filter(descends).sort((a,b)=>Number(['queued','running'].includes(b.status))-Number(['queued','running'].includes(a.status))||b.created_at.localeCompare(a.created_at));
      if(successors[0]){
        const latest=successors[0];
        if(['queued','running','completed'].includes(latest.status)){this.onTaskRetried?.(projectId,retryOf,latest);return [latest];}
        // Continue the latest stopped attempt rather than returning a stopped task forever.
        retryOf=latest.task_id;
      }
    }
    if(input.kind==='wiki-page'){
      const current=this.knowledge.tasks(projectId).find(task=>['queued','running'].includes(task.status)&&task.input.kind==='wiki-page'&&task.input.topic_preview===input.topic_preview&&task.input.target_id===input.target_id&&task.input.title===input.title&&task.input.wiki_level===input.wiki_level&&task.input.instructions===input.instructions&&JSON.stringify(task.input.dependencies)===JSON.stringify(input.dependencies)&&JSON.stringify(task.input.source_ids)===JSON.stringify(input.source_ids));
      if(current){if(retryOf)this.onTaskRetried?.(projectId,retryOf,current);return [current];}
    }
    if(input.abstract_wiki_only&&!input.abstract_mode)requestError('INVALID_REQUEST');
    if(input.abstract_mode&&(input.kind!=='literature-card'||input.source_ids.length!==1||input.include_source_wiki||input.dependencies.length||input.target_id))requestError('INVALID_REQUEST');
    if (input.kind === "literature-card" && !input.source_ids.length) requestError("SOURCES_REQUIRED");
    if (input.include_source_wiki && (input.kind !== 'literature-card' || input.source_ids.length !== 1 || input.dependencies.length || input.target_id)) requestError('INVALID_REQUEST',400);
    const active = (input.include_source_wiki||input.abstract_mode) && this.knowledge.tasks(projectId).find(t=>Boolean(t.input.abstract_mode)===Boolean(input.abstract_mode)&&(t.input.include_source_wiki||t.input.abstract_mode) && t.input.source_ids[0]===input.source_ids[0] && ['queued','running'].includes(t.status));
    if(active)return [active];
    const inputs = input.kind === "literature-card" ? [...new Set(input.source_ids)].map(id=>({...input,source_ids:[id]})) : [input];
    const tasks = inputs.map(part => {
      const paperBundle=!part.abstract_mode&&(part.include_source_wiki||part.kind==='wiki-page'&&part.wiki_level==='single'&&part.source_ids.length===1);
      const sourceIds=part.kind==='literature-card'||paperBundle||isTopicBundle(part)?part.source_ids:[];
      const sources = sourceIds.map(id=> {
        const source=this.store.getSource(id); if (!source || source.project_id!==projectId) requestError("SOURCE_NOT_FOUND",404);
        if((source.material_scope==='abstract')!==Boolean(part.abstract_mode))requestError('MATERIAL_SCOPE_MISMATCH',422);
        return {source,segments:part.abstract_mode||part.kind==='wiki-page'?[]:this.store.listSourceSegments(id)};
      });
      const markdown=new MarkdownKnowledge(this.store);
      const index=markdown.index(projectId).documents;
      const selected=paperBundle?index.filter(doc=>doc.source_id===part.source_ids[0]&&!paperCompatibility(doc.path.split(`/papers/${part.source_ids[0]}/`)[1]??'')&&doc.kind==='wiki-page'):part.kind==='literature-card'?index.filter(doc=>doc.source_id===part.source_ids[0]&&!paperCompatibility(doc.path.split(`/papers/${part.source_ids[0]}/`)[1]??'')&&doc.kind==='wiki-page'):part.dependencies.length?index.filter(doc=>part.dependencies.some(d=>d.object_id===doc.id)):index.filter(doc=>part.source_ids.includes(doc.source_id??'')&&doc.card_type==='key');
      if(part.kind==='wiki-page'&&!selected.length)requestError('KNOWLEDGE_MATERIALS_REQUIRED',422);
      const selectedIds=new Set(selected.map(d=>d.id));
      if(part.dependencies.some(d=>!selectedIds.has(d.object_id)))requestError('DEPENDENCY_NOT_FOUND',404);
      let previous=part.target_id?index.find(doc=>doc.id===part.target_id):part.kind==='literature-card'?index.find(doc=>doc.source_id===part.source_ids[0]&&doc.card_type==='detail'):undefined;
      if(part.target_id&&!previous)requestError('NOT_FOUND',404);
      if(isTopicBundle(part)&&previous?.topic_id&&previous.id!==previous.topic_id)previous=index.find(doc=>doc.id===previous!.topic_id);
      const retrySnapshot=retryOf?this.knowledge.tasks(projectId).find(t=>t.task_id===retryOf)?.snapshot as {topic_entry?:string}|undefined:undefined;
      const topicEntry=isTopicBundle(part)?previous?.id??retrySnapshot?.topic_entry??'wiki-'+randomUUID():undefined;
      const topicMembers=topicEntry?index.filter(doc=>doc.topic_id===topicEntry):[];
      if(topicEntry&&previous&&(previous.level!=='topic'||['topic-index','research-map','research-background'].includes(previous.page_role??'')))requestError('INVALID_TOPIC_TARGET',422);
      const preservedSources=[...topicMembers,...(previous?[previous]:[])].flatMap(doc=>(doc.links??[]).flatMap(link=>link.path.match(/^knowledge_base\/papers\/(source_[^/]+)\//)?.slice(1)??[]));
      const topicSources=[...new Set([...part.source_ids,...preservedSources])];
      const documents=[...new Set([...selected.map(d=>d.id),...(previous?[previous.id]:[]),...topicMembers.map(doc=>doc.id)])].map(id=>markdown.read(projectId,id));
      const inputChars=documents.reduce((n,d)=>n+d.text.length,0);
      if(paperBundle&&inputChars>400000)requestError('KNOWLEDGE_INPUT_TOO_LARGE',422);
      if(part.research_exploration&&inputChars>(part.research_exploration==='summary-working'?120000:50000))requestError("RESEARCH_INPUT_TOO_LARGE",422);
      if(inputChars>60000&&!paperBundle)requestError('KNOWLEDGE_INPUT_TOO_LARGE',422);
      const appendReferences=part.research_exploration==='topic-discovery'?part.topic_discovery_append?.reference_ids:undefined;
      if(appendReferences?.some(id=>!index.some(doc=>doc.id===id&&doc.kind==='wiki-page')))requestError('DEPENDENCY_NOT_FOUND',404);
      const referenceDocuments=!paperBundle&&part.kind==='wiki-page'&&part.source_ids.length&&part.research_exploration!=='summary-working'
        ?index.filter(d=>(!appendReferences||!selectedIds.has(d.id))&&(appendReferences?.includes(d.id)||((topicEntry?topicSources:part.source_ids).includes(d.source_id??'')&&d.kind==='wiki-page'&&(d.group_status===undefined||d.group_status==='current')))).map(d=>markdown.read(projectId,d.id)):[];
      if(part.research_topic_refs?.length){
        for(const ref of part.research_topic_refs){
          const entry=index.find(doc=>doc.id===ref.id&&doc.topic_id===doc.id&&doc.path===ref.path&&doc.hash===ref.hash);
          if(!entry)requestError('DIRECTION_SCOPE_CHANGED',409);
          if(part.research_exploration==='directions'&&!selectedIds.has(ref.id))referenceDocuments.push(markdown.readIndexed(projectId,entry));
        }
      }
      const dependencies=[...new Map([...selected,...referenceDocuments,...topicMembers].map(d=>[d.path,{id:d.id,path:d.path,hash:d.hash}])).values()];
      if(part.kind==='literature-card'&&sources[0])part={...part,title:sources[0].source.title};
      const targetPaths=part.kind==='literature-card'?[`literature/cards/idcard-${part.source_ids[0]}.md`,...(part.include_source_wiki?[`wiki/wiki-${part.source_ids[0]}.md`]:[])]:previous?[previous.path]:[];
      for(let i=0;i<targetPaths.length;i++)targetPaths[i]=knowledgePath(targetPaths[i],part.wiki_level);
      if(paperBundle){targetPaths.splice(0,targetPaths.length,...paperWikiPaths(part.source_ids[0]),...markdown.index(projectId,false,true).documents.filter(doc=>doc.source_id===part.source_ids[0]&&!paperCompatibility(doc.path.split(`/papers/${part.source_ids[0]}/`)[1]??'')&&doc.kind==='wiki-page').map(doc=>doc.path));}
      if(topicEntry)targetPaths.splice(0,targetPaths.length,...topicPaths(topicEntry));
      const expectedTargets=Object.fromEntries(targetPaths.map(path=>{const file=markdown.locate(projectId,path);return [path,existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null];}));
      const topicIndex=index.filter(doc=>doc.kind==='wiki-page'&&['topic','hypothesis'].includes(doc.level??'')&&(!doc.topic_id||doc.id===doc.topic_id)&&!['topic-index','research-map','research-background'].includes(doc.page_role??''));
      const abstractBefore=part.abstract_mode?abstractText(this.store,projectId,part.source_ids[0],part.abstract_wiki_only?'wiki':'notes'):undefined;
      const snapshot={topic_sources:topicEntry?topicSources:undefined,topic_entry:topicEntry,abstract_expected:abstractBefore===undefined?undefined:abstractBefore?createHash('sha256').update(abstractBefore).digest('hex'):null,topic_index:part.kind==='wiki-page'?topicIndex.slice(0,100).map(({id,title,level,page_role,summary,aliases})=>({id,title,level,page_role,summary,aliases})):undefined,topic_index_total:part.kind==='wiki-page'?topicIndex.length:undefined,project:this.store.getProject(projectId),sources,dependencies,previous,documents,reference_documents:referenceDocuments,expectedTargets,bibliography_baselines:Object.fromEntries(sources.map(({source})=>[source.source_id,{authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date,revision:bibliographyState(this.store,source.source_id).revision??0,content_hash:sourceContentHash(source)}])),base_version:0,prompt_version:taskPromptVersion(part,paperBundle),skill_hash:createHash('sha256').update(part.abstract_mode?abstractSkill():skillText(taskSkill(part))).digest('hex'),reading_rule_version:2};
      const fingerprint=createHash("sha256").update(JSON.stringify({snapshot,input:{...part,regenerate:false}})).digest("hex");
      const existing=this.knowledge.tasks(projectId).find(t=>t.fingerprint===fingerprint && ["queued","running","completed"].includes(t.status));
      if (existing && (!part.regenerate||["queued","running"].includes(existing.status))) return existing;
      return {task_id:`task_${randomUUID()}`,project_id:projectId,input:part,snapshot,fingerprint,status:"queued",created_at:new Date().toISOString(),...(retryOf?{attempt_of:retryOf}:{})} as KnowledgeTask;
    });
    // Validate the whole batch before persisting or starting any task.
    this.store.db.transaction(()=>{for(const task of tasks) this.knowledge.saveTask(task);})();
    if(retryOf)for(const task of tasks)this.onTaskRetried?.(projectId,retryOf,task);
    void this.pump(projectId);
    return tasks;
  }
  // Reading checkpoints depend on the PDF and reading rules, not changing library metadata.
  private readingAttempts(task: KnowledgeTask, includeHistoricalReadings=false): {task_id:string;created_at:string}[] {
    const result:{task_id:string;created_at:string}[]=[],seen=new Set<string>();
    const rule=(task.snapshot as {reading_rule_version?:number}).reading_rule_version;
    const byId=this.store.db.prepare(`SELECT s.task_id,s.created_at,abstract_mode,attempt_of,
      json_extract(t.data,'$.input.instructions') AS instructions,
      json_extract(t.data,'$.snapshot.reading_rule_version') AS rule
      FROM knowledge_task_summaries s JOIN knowledge_tasks t USING(task_id)
      WHERE s.project_id=? AND s.task_id=?`);
    let id=task.attempt_of;
    while(id&&!seen.has(id)){
      seen.add(id);
      const prior=byId.get(task.project_id,id) as {task_id:string;created_at:string;abstract_mode:number|null;attempt_of:string|null;instructions:string|null;rule:number|null}|undefined;
      if(!prior)break;
      if(Boolean(prior.abstract_mode)===Boolean(task.input.abstract_mode)&&(prior.instructions??undefined)===task.input.instructions&&prior.rule===2&&rule===2)result.push(prior);
      id=prior.attempt_of??undefined;
    }
    if(!includeHistoricalReadings||!task.input.source_ids[0])return result;
    // Reuse requires matching reading inputs, including for analyses outside this retry chain.
    const matching=this.store.db.prepare(`SELECT s.task_id,s.created_at FROM knowledge_task_summaries s
      JOIN knowledge_tasks t ON t.task_id=s.task_id WHERE s.project_id=? AND s.created_at<?
      AND s.task_id<>? AND s.include_source_wiki=1 AND coalesce(s.abstract_mode,0)=0
      AND json_extract(s.source_ids,'$[0]')=? AND json_extract(t.data,'$.input.instructions') IS ?
      AND json_extract(t.data,'$.snapshot.reading_rule_version') IS ?
      ORDER BY s.created_at DESC`).all(task.project_id,task.created_at,task.task_id,task.input.source_ids[0],task.input.instructions??null,rule??null) as typeof result;
    result.push(...matching.filter(prior=>!seen.has(prior.task_id)));
    return result.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }
  private resumeHints=new Map<string,{until:number;status:string;value:boolean}>();
  resumeHintFor(project:string,id:string,status:string):boolean {
    if(!['failed','interrupted','cancelled'].includes(status))return false;
    const cached=this.resumeHints.get(id);
    if(cached&&cached.status===status&&cached.until>Date.now())return cached.value;
    const task=this.knowledge.task(project,id);
    return task?this.resumeHint(task):false;
  }
  /** UI availability hint only; actual resume validates provenance and hashes before reuse. */
  resumeHint(task:KnowledgeTask):boolean {
    if(!['failed','interrupted','cancelled'].includes(task.status))return false;
    const cached=this.resumeHints.get(task.task_id);if(cached&&cached.status===task.status&&cached.until>Date.now())return cached.value;
    const base=projectRuntime(this.store.root,task.project_id,'tasks',task.task_id);
    let value=false;
    try{const check=JSON.parse(readFileSync(join(base,'output-check.json'),'utf8')) as {valid?:{path:string;hash:string}[]};const docs=(task.snapshot as {documents?:{path:string;hash:string}[]}).documents??[];value=Boolean(check.valid?.some(file=>!docs.some(doc=>doc.path===file.path&&doc.hash===file.hash)));}catch{/* No saved valid draft. */}
    if(!value&&/^source_[A-Za-z0-9_-]+$/.test(task.input.source_ids[0]??''))try{const state=JSON.parse(readFileSync(join(base,'readings',task.input.source_ids[0],'state.json'),'utf8')) as {version?:number;batches?:unknown[]};value=state.version===1&&Boolean(state.batches?.length);}catch{/* No saved reading checkpoint. */}
    if(this.resumeHints.size>1000)this.resumeHints.clear();this.resumeHints.set(task.task_id,{until:Date.now()+10000,status:task.status,value});return value;
  }
  resumable(task:KnowledgeTask):boolean {
    if(!['failed','interrupted','cancelled'].includes(task.status))return false;
    const candidate={...task,attempt_of:task.task_id,snapshot:{...(task.snapshot as Record<string,unknown>),skill_hash:createHash('sha256').update(skillText(taskSkill(task.input))).digest('hex')}};
    const sourceId=task.input.source_ids[0];
    const draftPaths=task.input.kind==='literature-card'&&sourceId?[`literature/cards/idcard-${sourceId}.md`,...(task.input.include_source_wiki?[`wiki/wiki-${sourceId}.md`]:[])]:task.input.target_id?[`wiki/${task.input.target_id}.md`]:[];
    if(sourceId&&!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single'))draftPaths.splice(0,draftPaths.length,...paperWikiPaths(sourceId));
    const draftOutput=join(projectRuntime(this.store.root,task.project_id,'tasks',task.task_id),'output');
    const topicEntry=(task.snapshot as {topic_entry?:string}).topic_entry;
    if(topicEntry){if(!existsSync(draftOutput))return false;return this.inspectOutputs(task,draftOutput,topicOutputPaths(draftOutput,topicEntry,[])).valid.some(file=>(task.snapshot as {documents?:{path:string;text:string}[]}).documents?.find(doc=>doc.path===file.path)?.text!==file.text);}
    if(existsSync(draftOutput)&&sourceId&&!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single'))draftPaths.splice(0,draftPaths.length,...paperWikiOutputPaths(draftOutput,sourceId,draftPaths));
    if(existsSync(draftOutput)&&this.inspectOutputs(task,draftOutput,draftPaths).valid.some(file=>(task.snapshot as {documents?:{path:string;text:string}[]}).documents?.find(doc=>doc.path===file.path)?.text!==file.text))return true;
    if(!sourceId)return false;
    const attempts=this.readingAttempts(candidate,true);
    if(!attempts.length)return false;
    let pdfHash:string;
    try{pdfHash=new PdfReading(this.store).original(task.project_id,sourceId).hash;}catch{return false;}
    for(const prior of attempts){
      const base=projectRuntime(this.store.root,task.project_id,'tasks',prior.task_id);
      if(hasReadingCheckpoint(base,sourceId,pdfHash,task.input.instructions))return true;
    }
    return false;
  }
  isProjectBusy(projectId: string): boolean {
    return this.running.has(projectId) || this.reserved.has(projectId);
  }
  cancel(projectId: string, taskId: string): void {
    const task=this.knowledge.tasks(projectId).find(t=>t.task_id===taskId) ?? requestError("NOT_FOUND",404);
    if (!["queued","running"].includes(task.status)) requestError("TASK_FINISHED",409);
    const wasQueued=task.status==="queued";
    task.status="cancelled"; this.knowledge.saveTask(task); this.knowledge.event(taskId,"用户取消任务");
    const active=this.running.get(projectId); if(active?.task.task_id===taskId) { active.task.status="cancelled"; this.terminate(active.child); }
    if(wasQueued){try{this.onTaskSettled?.(projectId,task);}catch{/* Workflow records its own errors. */}}
  }
  private terminate(child: ChildProcess): void {
    try { if(process.platform!=="win32" && child.pid) process.kill(-child.pid,"SIGTERM"); else child.kill("SIGTERM"); } catch { /* Process already exited. */ }
    const timer=setTimeout(()=>{try {if(process.platform!=="win32" && child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{/* Already exited. */}},3000); timer.unref();
  }
  close(): void {this.closed=true; for(const active of this.running.values()){active.task.status="interrupted";this.knowledge.saveTask(active.task);this.terminate(active.child);}}
  private async readBatch(task:KnowledgeTask,prompt:string,images:string[],directory:string,timeout:number){
    if(timeout<=1)throw new Error('全文阅读超时，未发布最终卡片');
    const child=spawn(this.cli.command,[...this.cli.prefix,'exec','--sandbox','workspace-write','-c','approval_policy="never"','-c','mcp_servers.node_repl.enabled=false','--skip-git-repo-check','--ephemeral','--json','--color','never','-C',directory,...images.flatMap(path=>['--image',path]),'-'],{cwd:directory,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    this.running.set(task.project_id,{child,task});
    const result=new CliTurnResult(message=>this.knowledge.event(task.task_id,redact(message)));
    child.stdout.on('data',(chunk:Buffer)=>result.push(chunk));
    let bytes=0;const log=(chunk:Buffer)=>{if(bytes>1024*1024)return;bytes+=chunk.length;this.knowledge.event(task.task_id,redact(chunk.toString()));};child.stdout.on('data',log);child.stderr.on('data',log);
    let timedOut=false;
    const completion=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{result.finish();const failure=timedOut?'PDF阅读超时；批次草稿已保留':result.failure(code,signal);if(failure){this.knowledge.event(task.task_id,'模型调用失败：'+redact(failure));reject(new Error(redact(failure)));}else resolve();});});
    const timer=setTimeout(()=>{timedOut=true;this.terminate(child);},timeout*1000);child.stdin.on('error',()=>{});child.stdin.end(prompt);try{await completion;}finally{clearTimeout(timer);}
    if(task.status!=='running'||this.closed)throw new Error('PDF 全文阅读已取消或中断');
  }
  private restoreDrafts(task:KnowledgeTask,output:string,paths:string[]) {
    if(!task.attempt_of)return; // A fresh reanalysis only reuses PDF readings, never Wiki drafts.
    const fields=['topic_sources','topic_entry','prompt_version','abstract_expected','sources','dependencies','expectedTargets','bibliography_baselines','skill_hash'];
    for(const attempt of this.readingAttempts(task)){
      const prior=this.knowledge.task(task.project_id,attempt.task_id);
      if(!prior||prior.input.kind!==task.input.kind||prior.input.include_source_wiki!==task.input.include_source_wiki)continue;
      const old=prior.snapshot as Record<string,unknown>, current=task.snapshot as Record<string,unknown>;
      if(fields.some(key=>JSON.stringify(old[key])!==JSON.stringify(current[key])))continue;
      const oldOutput=join(projectRuntime(this.store.root,task.project_id,'tasks',prior.task_id),'output');
      if(!existsSync(oldOutput))continue;
      const topicEntry=(task.snapshot as {topic_entry?:string}).topic_entry;
      const draftPaths=topicEntry?topicOutputPaths(oldOutput,topicEntry,paths):!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single')?paperWikiOutputPaths(oldOutput,task.input.source_ids[0],paths):paths;
      const checked=this.inspectOutputs(task,oldOutput,draftPaths);
      let recorded:Record<string,string>|undefined;
      try{const check=JSON.parse(readFileSync(join(oldOutput,'..','output-check.json'),'utf8')) as {valid:{path:string;hash:string}[]};recorded=Object.fromEntries(check.valid.map(file=>[file.path,file.hash]));}catch{/* Legacy drafts are independently validated. */}
      for(const draft of checked.valid){
        if(recorded&&recorded[draft.path]!==draft.hash)continue;
        const baseline=(old.documents as {path:string;text:string}[]|undefined)?.find(doc=>doc.path===draft.path);
        if(baseline?.text===draft.text)continue;
        const target=join(output,draft.path);
        // The new task directory is private; never follow an existing unsafe output.
        if(existsSync(target)&&(lstatSync(target).isSymbolicLink()||!realpathSync(target).startsWith(realpathSync(output)+sep)))continue;
        if(this.inspectOutputs(task,output,[draft.path]).valid.some(file=>file.text!==baseline?.text))continue;
        mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,draft.text,{mode:0o600});
        this.knowledge.event(task.task_id,`恢复合格草稿：${draft.path}（来自 ${prior.task_id}）`);
      }
    }
  }
  private inspectOutputs(task:KnowledgeTask, output:string, paths:string[]) {
    const markdown=new MarkdownKnowledge(this.store);
    const valid:{path:string;text:string;hash:string}[]=[], issues:{path:string;reason:string;unsafe:boolean}[]=[];
    for(const path of paths){
      const file=join(output,path);
      try{
        if(!existsSync(file)){issues.push({path,reason:'文件未生成',unsafe:false});continue;}
        if(lstatSync(file).isSymbolicLink()||!realpathSync(file).startsWith(realpathSync(output)+sep)||!statSync(file).isFile()){
          issues.push({path,reason:'输出路径不安全或不是普通文件',unsafe:true});continue;
        }
        const size=statSync(file).size;
        if(size>1024*1024){issues.push({path,reason:`文件超限：${size} 字节，上限 1048576 字节`,unsafe:false});continue;}
        const text=readFileSync(file,'utf8');
        if(!text.trim()){issues.push({path,reason:'文件为空',unsafe:false});continue;}
        if(task.input.research_exploration){const errors=researchExplorationIssues(path,text,task.input.research_exploration,task.input.source_ids,taskSkill(task.input)==='trash-literature-synthesis',task.input.topic_discovery_append?.source_ids);if(errors.length){issues.push({path,reason:errors.join('；'),unsafe:false});continue;}}
        if(task.input.abstract_mode){
          if(!/^#\s+.+/m.test(text)||!text.includes('材料范围：仅摘要')||!text.includes(task.input.source_ids[0])){issues.push({path,reason:'摘要结果缺少标题、材料范围或来源标识',unsafe:false});continue;}
          const headings=(path.startsWith('abstract-library/wiki/')||path.endsWith('/memory.md'))?['何时读取','摘要事实','研究线索','可能关联','证据边界','原始摘要入口']:['研究问题','方法概览','作者声称的贡献','摘要中的结果','研究线索','分析边界'];
          const actual=text.replace(/\r\n/g,'\n').split('\n').filter(line=>/^##\s+/.test(line)).map(line=>line.replace(/^##\s+/,'').trim());
          const missing=headings.filter(heading=>!actual.includes(heading));
          if(missing.length||actual.includes('摘要 Wiki')){issues.push({path,reason:`摘要产物结构不符合其用途：${missing.length?'缺少 '+missing.join('、'):'不应嵌套摘要 Wiki 章节'}`,unsafe:false});continue;}
          valid.push({path,text,hash:createHash('sha256').update(text).digest('hex')});continue;
        }
        try{
          const doc=markdown.parse(task.project_id,path,text);
          if(task.input.wiki_level==='summary'){
            if(doc.level!=='summary'||/^文献知识第\d+层分组\d+$/.test(doc.title)||!doc.coverage||!doc.directions||!doc.batch_label)throw new Error('分批总结需要内容标题、summary层级、覆盖方向、材料范围及批次标识');
            if(/^\d{4}-\d{2}-\d{2}：.+·第\d+组$/.test(task.input.title)&&(doc.title!==task.input.title||doc.batch_label!==task.input.title))throw new Error('一级标题与批次标识必须使用完整任务标题：'+task.input.title);
          }
          if((task.input.kind==='literature-card'||task.input.include_source_wiki||task.input.wiki_level==='single')&&doc.source_id!==task.input.source_ids[0])throw new Error('来源与指定论文不一致');
          if(!/^knowledge_version:\s*2\s*$/m.test(text.split(/---\r?\n/)[1]??''))throw new Error('缺少 knowledge_version: 2');
        }catch(error){issues.push({path,reason:`格式或必要字段不合格：${error instanceof Error?((error as Error & {detail?:string}).detail??error.message):'未知格式错误'}`,unsafe:false});continue;}
        valid.push({path,text,hash:createHash('sha256').update(text).digest('hex')});
      }catch{issues.push({path,reason:'无法读取输出文件',unsafe:true});}
    }
    return {valid,issues};
  }
  topicPreview(projectId:string,taskId:string){
    const task=this.knowledge.tasks(projectId).find(item=>item.task_id===taskId);
    if(!task?.input.topic_preview||task.status!=='completed'||!task.topic_draft)requestError('TOPIC_PREVIEW_NOT_READY',409);
    const snapshot=task.snapshot as {topic_entry?:string;topic_sources?:string[];dependencies?:{id:string;path:string;hash:string}[];expectedTargets?:Record<string,string|null>;bibliography_baselines?:Record<string,{content_hash:string}>};
    const entry=snapshot.topic_entry;
    if(!entry||!/^wiki-[A-Za-z0-9_-]+$/.test(entry))requestError('TOPIC_PREVIEW_NOT_READY',409);
    const allowed=topicPaths(entry),paths=task.topic_draft.files.map(file=>file.path);
    if(!paths.includes(allowed[0])||paths.some(path=>!allowed.includes(path)))requestError('TOPIC_PREVIEW_CHANGED',409);
    const output=join(projectRuntime(this.store.root,projectId,'tasks',taskId),'output');
    if(!existsSync(output)||lstatSync(output).isSymbolicLink())requestError('TOPIC_PREVIEW_CHANGED',409);
    const {valid,issues}=this.inspectOutputs(task,output,paths);
    if(issues.length||valid.some(file=>!task.topic_draft!.files.some(ref=>ref.path===file.path&&ref.hash===file.hash)))requestError('TOPIC_PREVIEW_CHANGED',409);
    return {task,snapshot,entry,files:valid};
  }
  publishTopicPreview(projectId:string,taskId:string){
    const {task,snapshot,entry,files}=this.topicPreview(projectId,taskId);
    const markdown=new MarkdownKnowledge(this.store);
    const manifest=topicManifest(markdown.root(projectId),entry);
    // Recover if the wiki transaction committed before the task and run records were saved.
    if(manifest?.task_id!==taskId){
      if(task.output_id)requestError('TOPIC_PREVIEW_CHANGED',409);
      const available=markdown.index(projectId).documents;
      if(snapshot.dependencies?.some(ref=>!available.some(doc=>doc.id===ref.id&&doc.path===ref.path&&doc.hash===ref.hash)))requestError('TOPIC_PREVIEW_CHANGED',409);
      if(Object.entries(snapshot.bibliography_baselines??{}).some(([id,baseline])=>sourceContentHash(this.store.getSource(id))!==baseline.content_hash))requestError('TOPIC_PREVIEW_CHANGED',409);
      const issues=topicGroupIssues(entry,files,snapshot.topic_sources??task.input.source_ids,available.map(doc=>doc.path),[],true);
      if(issues.length)requestError('TOPIC_PREVIEW_CHANGED',409);
      const writes=files.map(({path,text})=>({path,text,expected:snapshot.expectedTargets?.[path]??null}));
      markdown.commit(projectId,writes,{}, {taskId,fullTopicId:entry});
    }
    if(!task.output_id){
      task.output_id=entry;task.output_version=1;this.knowledge.saveTask(task);
      this.knowledge.event(taskId,'用户确认发布单主题试稿：'+entry);
    }
    return entry;
  }
  private async pump(projectId: string): Promise<void> {
    if(this.closed || this.running.has(projectId) || this.reserved.has(projectId))return;
    const task=this.knowledge.tasks(projectId).filter(t=>t.status==="queued").sort((a,b)=>a.created_at.localeCompare(b.created_at))[0];
    if(!task)return;
    // Reserve before filesystem work or process startup.
    task.status="running";this.knowledge.saveTask(task);this.reserved.add(projectId);
    let directory=projectRuntime(this.store.root,projectId,'tasks',task.task_id);
    let child: ChildProcess | undefined;
    try {
      mkdirSync(directory,{recursive:true});
      directory=realpathSync(directory);
      const snapshot=task.snapshot as {topic_sources?:string[];topic_entry?:string;reference_documents?:ReturnType<MarkdownKnowledge['list']>['documents'];sources:{source:{source_id:string;source_type:string};segments:unknown[]}[];documents:ReturnType<MarkdownKnowledge['list']>['documents'];bibliography_baselines?:Record<string,{authors?:string[];title:string;year?:number;publication_date?:string;revision?:number;content_hash:string}>;expectedTargets?:Record<string,string|null>;dependencies?:{id:string;path:string;hash:string}[];previous?:ReturnType<MarkdownKnowledge['list']>['documents'][number]};
      const markdown=new MarkdownKnowledge(this.store);
      const source=task.input.source_ids[0];
      const id=snapshot.topic_entry??(task.input.kind==='literature-card'?`card-${source}`:snapshot.previous?.id??(task.input.wiki_level==='overview'?'wiki-project-overview':`wiki-${randomUUID()}`));
      const paperBundle=!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.kind==='wiki-page'&&task.input.wiki_level==='single'&&task.input.source_ids.length===1);
      const paths=task.input.abstract_mode?(task.input.abstract_wiki_only?[`abstract-library/wiki/${source}.md`]:[`abstract-library/notes/${source}.md`,`abstract-library/wiki/${source}.md`]):task.input.kind==='literature-card'?[`literature/cards/idcard-${source}.md`]:[`wiki/${id}.md`];
      if(task.input.include_source_wiki)paths.push(`wiki/wiki-${source}.md`);
      for(let i=0;i<paths.length;i++)paths[i]=knowledgePath(paths[i],task.input.wiki_level);
      if(paperBundle)paths.splice(0,paths.length,...paperWikiPaths(source));
      const topicEntry=snapshot.topic_entry;
      if(topicEntry)paths.splice(0,paths.length,topicPaths(topicEntry)[0],...snapshot.documents.filter(doc=>doc.topic_id===topicEntry&&doc.id!==topicEntry).map(doc=>doc.path));
      const fulltextGeneration=!task.input.abstract_mode&&Boolean(task.input.include_source_wiki);
      // The database snapshot remains complete; model input contains no previous Wiki.
      const modelInput:Record<string,unknown>=fulltextGeneration?{
        project:(task.snapshot as {project?:unknown}).project,
        sources:snapshot.sources,
        instructions:task.input.instructions,
        outputs:paths.map(path=>({path,id:knowledgeDocumentId(path)})),
        output_scope:{required:true,additional:`knowledge_base/papers/${source}/{evidence/ev-*.md,method/<slug>.md,results/<slug>.md}`,description:'outputs是最低必需项，按技能补齐正文引用的依据与必要子页，不是全部允许输出'},
        reading_rule_version:(task.snapshot as {reading_rule_version?:number}).reading_rule_version,
        input_version:2
      }:snapshot.reference_documents?.length?{...(task.snapshot as object),reference_documents:undefined,material_index:(snapshot.reference_documents??[]).map(({id,path,title,source_id,stale})=>({id,path,title,source_id,stale}))}: {...(task.snapshot as Record<string,unknown>)};
      if(taskSkill(task.input)==='trash-literature-synthesis')Object.assign(modelInput,{source_scope:task.input.source_ids,material_versions:(snapshot.dependencies??[]).map(({path,hash})=>({path,hash})),coverage_note:'source_scope 是本次选择范围，索引不代表已读；summary 仅沉淀逐篇差异和短引用，完整来源身份由后台索引维护'});
      if(task.input.research_topic_refs?.length)Object.assign(modelInput,{
        research_topics:task.input.research_topic_refs,
        research_topic_note:'research_topics 是本轮范围。只引用本任务实际提供且已读取的主题正文和论文依据。',
      });
      if(task.input.topic_discovery_append)modelInput.topic_discovery_append=task.input.topic_discovery_append;
      if(topicEntry)Object.assign(modelInput,{topic_group:{entry_id:topicEntry,allowed:topicPaths(topicEntry),required:paths},outputs:paths.map(path=>({path,id:knowledgeDocumentId(path)}))});
      writeFileSync(join(directory,'input.json'),JSON.stringify(modelInput,null,2),{mode:0o600});
      const output=join(directory,'output');mkdirSync(output,{recursive:true});
      for(const doc of fulltextGeneration?[]:[...(snapshot.reference_documents??[]),...(snapshot.documents??[])]){const file=join(output,doc.path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,doc.text);}
      if(task.input.abstract_mode){mkdirSync(join(directory,'abstract-skill'),{recursive:true});writeFileSync(join(directory,'abstract-skill','SKILL.md'),abstractSkill(),{mode:0o600});}else stageKnowledgeSkill(directory,taskSkill(task.input));
      let prompt=`读取 literature-skill/SKILL.md 和 input.json，按本次任务协议输出，保留来源与人工内容。用户要求：${task.input.instructions}`;
      if(task.input.abstract_mode)prompt=`读取 abstract-skill/SKILL.md 和 input.json，仅分析指定摘要。直接写两份 Markdown 到 output/${paths[0]} 和 output/${paths[1]}：第一份给人看的摘要解读，第二份给 Agent 的摘要 Wiki。一级标题使用提供的论文标题，必须标明 材料范围：仅摘要 和 source_id=${source}。两份文件按 abstract-skill/SKILL.md 的各自结构分别生成：notes 为人读卡片，wiki 为紧凑的Agent研究线索，不能复制相同正文或在卡片里嵌套摘要Wiki。只生成摘要Wiki，不生成全文卡片或正式主题Wiki；不生成源码栏目、待全文核验或补充全文流程。用户要求：${task.input.instructions}`;
      if(task.input.abstract_wiki_only)prompt=`读取 abstract-skill/SKILL.md 和 input.json。仅基于指定来源的原始摘要，按 Agent Wiki 章节生成 output/${paths[0]}。只生成这一份摘要 Wiki，不生成或修改人读卡片、原始资料或全文知识。一级标题使用论文标题，包含材料范围：仅摘要及 source_id=${source}。沿用摘要 Wiki 的紧凑结构、事实与推断区分和证据边界。用户要求：${task.input.instructions}`;
      prompt+='\n知识库统一使用 knowledge_base/。本次准确输出清单（优先于上文任何旧路径示例）：'+paths.map(path=>path+'，稳定ID='+knowledgeDocumentId(path)).join('；')+'。frontmatter id 使用此稳定ID，不使用 basic/key/detail/memory 这样的文件短名。所有相对链接根据实际新目录计算，引用 input.json 的真实 path。仅摘要文件仍按摘要规范，不添加全文frontmatter。';
      if(!topicEntry&&!paperBundle&&!task.input.abstract_mode&&task.input.kind==='wiki-page')prompt=`读取 literature-skill/SKILL.md、literature-skill/references/wiki.md 和 input.json，使用 trash-literature-synthesis。只写 output/${paths[0]}，frontmatter kind: wiki-page、knowledge_version: 2、level: ${task.input.wiki_level??'topic'}、id: ${knowledgeDocumentId(paths[0])}。按任务实际模式组织主题/发现/总结/总览，保留来源、稳定ID、人工内容和未覆盖主题入口；不写单篇题录，不按论文顺序复述。先用 material_index 筛选，按需读取 output/ 中的来源工作副本，不把索引当成已读；不修改来源。先核对topic_index，关键判断就近引用。summary 必须含“何时读取”“覆盖方向”“材料范围”“批次标识”（本次任务标题）。不固定全文回读或增加自查调用。用户要求：${task.input.instructions}`;
      if(topicEntry||task.input.research_exploration)prompt=researchPrompt(task.input,paths[0],topicEntry);
      if(paperBundle)prompt=paperWikiPrompt(source,!task.input.include_source_wiki)+task.input.instructions;

      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='summary')prompt+=`\n中间总结只沉淀影响主题判断的内容：逐篇问题、关键机制、实质差异、成立条件及必要的分歧/反例/未知，再归纳共识。来源用 [S1]、[S2] 等短引用，并在文末为每个实际引用来源写一次 `+"`[S1]: <可解析的原始Wiki相对路径>`"+`；多项引用写成 [S1]、[S2]，不得相邻写成 [S1][S2]。未引用来源用一次 source_id 标为未覆盖。完整路径、页ID、哈希和版本由后台索引维护。目标约 ${RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS}–${RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS} 字符，硬上限 ${RESEARCH_SUMMARY_HARD_MAX_CHARACTERS} 字符；超限时压缩重复引用、目录及重复解释，不得截断有效论证。后续轮次重新压缩为最小有效记录。混合材料不得假称统一主题。`;
      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='summary-working')prompt+='\n本次只压缩 dependencies 中已有的旧工作总结，不读取或重新分析原始论文 Wiki、PDF、历史任务。保留原总结和历史版本，输出一份新的材料工作版：来源定义只出现一次，逐篇只留问题、关键机制、实质差异、成立条件及必要分歧/反例/未知，再归纳共识与候选问题。删除重复路径目录、重复解释和逐篇小型解读，硬上限 10000 字符；不能机械截断有效论证。';
      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='topic-discovery')prompt+='\n依据 references/synthesis.md 发现主题。来源覆盖只是材料索引，不能作为主要正文，也不能只输出来源覆盖表。必须输出可拆分的“## 知识主题：名称”“## 候选线索：名称”或“## 研究假设：名称”条目；每个条目至少说明共同问题、纳入边界、参与论文及具体贡献、机制或差异、与相邻主题区别和独立整理价值。正式知识主题必须链接至少两篇实际论文 Wiki，并由后台拆成独立主题 Wiki；材料不足留候选。核对已有主题问题边界，不能只看名称。判机制补读方法，判效果补读结果，相关材料可从来源副本按需读。';
      if(fulltextGeneration)prompt+='\n本次从论文原始材料与批次笔记重新生成，不读取或沿用历史Wiki。已有版本由后台保留，当前任务期间的版本冲突由发布校验处理。';
      writeFileSync(join(directory,'prompt.txt'),prompt);
      const cliVersion = await new Promise<string>((resolve,reject)=>execFile(this.cli.command,[...this.cli.prefix,"--version"],{timeout:10000,maxBuffer:65536},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
      writeFileSync(join(directory,"metadata.json"),JSON.stringify({adapter:"codex-cli",cli_version:cliVersion,prompt_version:taskPromptVersion(task.input,paperBundle),skill:task.input.abstract_mode?"trash-abstract-wiki":taskSkill(task.input),skill_hash:createHash("sha256").update(task.input.abstract_mode?abstractSkill():skillText(taskSkill(task.input))).digest("hex"),input_fingerprint:task.fingerprint,sandbox:"workspace-write"},null,2));
      if(this.closed)return;
      this.knowledge.event(task.task_id,`Agent 版本：${cliVersion}`);
      if(this.knowledge.tasks(projectId).find(t=>t.task_id===task.task_id)?.status!=="running")return;
      const deadline=Date.now()+task.input.timeout_seconds*1000;
      const readingResults=[];
      for(const material of task.input.abstract_mode||task.input.kind==='wiki-page'?[]:snapshot.sources??[]){
        if(material.source.source_type!=='pdf'){
          try{new PdfReading(this.store).original(projectId,material.source.source_id);}catch{continue;}
        }
        readingResults.push(await readPaperChapters({pdf:new PdfReading(this.store),project:projectId,source:material.source.source_id,directory,
          previousDirectories:this.readingAttempts(task,true).map(prior=>projectRuntime(this.store.root,projectId,'tasks',prior.task_id)),instructions:task.input.instructions,deadline,
          active:()=>!this.closed&&this.knowledge.tasks(projectId).find(item=>item.task_id===task.task_id)?.status==='running',
          event:text=>this.knowledge.event(task.task_id,text),read:(text,images,timeout)=>this.readBatch(task,text,images,directory,timeout)}));
      }
      prompt+='\n知识库统一使用 knowledge_base/。本次准确输出清单（优先于上文任何旧路径示例）：'+paths.map(path=>path+'，稳定ID='+knowledgeDocumentId(path)).join('；')+'。frontmatter id 使用此稳定ID，不使用 basic/key/detail/memory 这样的文件短名。所有相对链接根据实际新目录计算，引用 input.json 的真实 path。仅摘要文件仍按摘要规范，不添加全文frontmatter。';
      if(topicEntry||task.input.research_exploration)prompt=researchPrompt(task.input,paths[0],topicEntry);
      if(paperBundle)prompt=paperWikiPrompt(source,!task.input.include_source_wiki)+task.input.instructions;

      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='summary')prompt+=`\n中间总结只沉淀影响主题判断的内容：逐篇问题、关键机制、实质差异、成立条件及必要的分歧/反例/未知，再归纳共识。来源用 [S1]、[S2] 等短引用，并在文末为每个实际引用来源写一次 `+"`[S1]: <可解析的原始Wiki相对路径>`"+`；多项引用写成 [S1]、[S2]，不得相邻写成 [S1][S2]。未引用来源用一次 source_id 标为未覆盖。完整路径、页ID、哈希和版本由后台索引维护。目标约 ${RESEARCH_SUMMARY_TARGET_MIN_CHARACTERS}–${RESEARCH_SUMMARY_TARGET_MAX_CHARACTERS} 字符，硬上限 ${RESEARCH_SUMMARY_HARD_MAX_CHARACTERS} 字符；超限时压缩重复引用、目录及重复解释，不得截断有效论证。后续轮次重新压缩为最小有效记录。混合材料不得假称统一主题。`;
      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='summary-working')prompt+='\n本次只压缩 dependencies 中已有的旧工作总结，不读取或重新分析原始论文 Wiki、PDF、历史任务。保留原总结和历史版本，输出一份新的材料工作版：来源定义只出现一次，逐篇只留问题、关键机制、实质差异、成立条件及必要分歧/反例/未知，再归纳共识与候选问题。删除重复路径目录、重复解释和逐篇小型解读，硬上限 10000 字符；不能机械截断有效论证。';
      if(taskSkill(task.input)==='trash-literature-synthesis'&&task.input.research_exploration==='topic-discovery')prompt+='\n依据 references/synthesis.md 发现主题。来源覆盖只是材料索引，不能作为主要正文，也不能只输出来源覆盖表。必须输出可拆分的“## 知识主题：名称”“## 候选线索：名称”或“## 研究假设：名称”条目；每个条目至少说明共同问题、纳入边界、参与论文及具体贡献、机制或差异、与相邻主题区别和独立整理价值。正式知识主题必须链接至少两篇实际论文 Wiki，并由后台拆成独立主题 Wiki；材料不足留候选。核对已有主题问题边界，不能只看名称。判机制补读方法，判效果补读结果，相关材料可从来源副本按需读。';
      if(fulltextGeneration)prompt+='\n本次从论文原始材料与批次笔记重新生成，不读取或沿用历史Wiki。已有版本由后台保留，当前任务期间的版本冲突由发布校验处理。';
      if(fulltextGeneration)writeFileSync(join(directory,'input.json'),JSON.stringify({...(modelInput as Record<string,unknown>),readings:readingResults},null,2),{mode:0o600});
      if(readingResults.length)prompt+='\n先完整读取本次全部固定四页批次笔记：'+JSON.stringify(readingResults)+'。在本次生成中综合全文，统一术语、实验条件和跨批次依据，再直接生成Wiki组；不单独生成paper-understanding.md，不额外调用整篇汇总。不要只读压缩摘要丢掉机制、数字或条件。依据页使用这些真实原文定位。已生成笔记不代表全部图表已核验。';
      writeFileSync(join(directory,'prompt.txt'),prompt);
      if(this.closed||this.knowledge.tasks(projectId).find(item=>item.task_id===task.task_id)?.status!=='running')return;
      if(Date.now()>=deadline)throw new Error('全文阅读超时；批次笔记已保留，未发布最终知识');
      this.restoreDrafts(task,output,paths);
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(topicEntry)paths.splice(0,paths.length,...topicOutputPaths(output,topicEntry,paths));
      if(fulltextGeneration)this.knowledge.event(task.task_id,task.attempt_of?'文档生成：继续本次失败链，仅恢复版本与规则匹配的合格草稿':'文档生成：重新分析从空输出开始，历史Wiki不作为输入；PDF笔记独立核验复用');
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(topicEntry)paths.splice(0,paths.length,...topicOutputPaths(output,topicEntry,paths));
      let repairIssues:PaperWikiIssue[]=[];
      let repairChanges:{path:string;before:string|null;after:string|null}[]=[];
      const ignoredWorkFiles=new Set<string>();
      const workFiles=()=>paperBundle?knowledgeFiles(output,`knowledge_base/papers/${source}`).filter(paperWikiWorkFile):[];
      const saveCheck=(result:ReturnType<KnowledgeAgent['inspectOutputs']>)=>{
        for(const path of workFiles())if(!ignoredWorkFiles.has(path)){ignoredWorkFiles.add(path);this.knowledge.event(task.task_id,`发布收集：忽略工作文件 ${path}，文件保留、不发布`);}
        writeFileSync(join(directory,'output-check.json'),JSON.stringify({version:3,topic_id:topicEntry,repair_changes:repairChanges,ignored:workFiles().map(path=>({path,reason:'任务规划文件，保留在工作副本，不参与发布'})),navigation_deferred:paperBundle&&result.issues.some(issue=>issue.path===`knowledge_base/papers/${source}/whoami.md`),valid:result.valid.map(({path,hash})=>({path,hash})),issues:result.issues,repair_issues:repairIssues,resolved_issues:repairIssues.filter(issue=>!result.issues.some(current=>current.path===issue.path&&current.reason===issue.reason))},null,2),{mode:0o600});
      };
      const sourceCopies=[...(snapshot.reference_documents??[]),...snapshot.documents].filter(doc=>!topicEntry||!topicPaths(topicEntry).includes(doc.path));
      const baselinePaths=new Set(sourceCopies.map(doc=>doc.path));
      const unexpectedOutputs=()=>topicEntry?knowledgeFiles(output,'knowledge_base').filter(path=>!baselinePaths.has(path)&&!topicPaths(topicEntry).includes(path)).map(path=>({path,reason:'主题组之外的输出不允许发布，请移出 output/ 发布目录',unsafe:false})):[];
      const checkOutputs=()=>{
        const result=this.inspectOutputs(task,output,paths);
        const invalid=result.issues.map(issue=>issue.path);
        if(paperBundle)result.issues.push(...paperWikiIssues(source,result.valid,invalid));
        if(topicEntry){result.issues.push(...unexpectedOutputs());result.issues.push(...topicGroupIssues(topicEntry,result.valid,snapshot.topic_sources??task.input.source_ids,(snapshot.dependencies??[]).map(ref=>ref.path),invalid,true));}
        return result;
      };
      const runGeneration=async (instructions:string, protectedFiles:{path:string;text:string}[])=>{
        if(this.closed||task.status!=='running')throw new Error('任务已停止；草稿已保留');
        if(Date.now()>=deadline)throw new Error('生成阶段超时；草稿已保留，请继续分析');
        child=spawn(this.cli.command,[...this.cli.prefix,"exec","--sandbox","workspace-write","-c",'approval_policy="never"',"-c",'mcp_servers.node_repl.enabled=false',"--skip-git-repo-check","--ephemeral","--json","--color","never","-C",directory,"-"],{cwd:directory,detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"]});
        this.running.set(projectId,{child,task});
        let logBytes=0;
        const result=new CliTurnResult(message=>this.knowledge.event(task.task_id,redact(message)));
        const log=(chunk:Buffer)=>{if(!this.closed&&logBytes<1024*1024){const message=redact(chunk.toString());logBytes+=Buffer.byteLength(message);this.knowledge.event(task.task_id,message);}};
        child.stdout?.on('data',(chunk:Buffer)=>result.push(chunk));
        child.stdout?.on('data',log);child.stderr?.on('data',log);
        let timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;if(child)this.terminate(child);},Math.max(1,deadline-Date.now()));
        const completion=new Promise<void>((resolve,reject)=>{child!.once('error',reject);child!.once('close',(code,signal)=>{result.finish();const failure=timedOut?'生成阶段超时；草稿已保留':result.failure(code,signal);if(failure){this.knowledge.event(task.task_id,'模型调用失败：'+redact(failure));reject(new Error(redact(failure)));}else resolve();});});
        child.stdin?.on('error',()=>{});child.stdin?.end(instructions+(paperBundle?'\n\n'+paperWikiSelfCheck:''));
        try{await completion;}finally{clearTimeout(timer);preserveFiles(protectedFiles);if(topicEntry)for(const doc of sourceCopies){const target=join(output,doc.path);if(existsSync(target)&&(lstatSync(target).isSymbolicLink()||!realpathSync(target).startsWith(realpathSync(output)+sep)))throw new Error('来源工作副本路径异常：'+doc.path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,doc.text,{mode:0o600});}if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(topicEntry)paths.splice(0,paths.length,...topicOutputPaths(output,topicEntry,paths));saveCheck(checkOutputs());}
        if(this.closed||task.status!=='running')throw new Error('任务已停止；草稿已保留');
      };
      const phase=(name:string,title:string)=>{const path=join(directory,'reading-progress.json');if(existsSync(path)){const current=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...current,phase:name,title,updated_at:new Date().toISOString()}),{mode:0o600});}};
      phase('wiki-generation',topicEntry?'生成主题 Wiki 组':'生成新版知识页与统一依据');
      let checked=this.inspectOutputs(task,output,paths);
      // Pre-existing published files are reference material, not newly completed drafts.
      const preserved=checked.valid.filter(file=>snapshot.documents?.find(doc=>doc.path===file.path)?.text!==file.text);
      const needed=paths.filter(path=>!preserved.some(file=>file.path===path));
      const preserveFiles=(files:{path:string;text:string}[])=>{
        for(const file of files){
          const target=join(output,file.path);
          if(!existsSync(target)||lstatSync(target).isSymbolicLink()||!realpathSync(target).startsWith(realpathSync(output)+sep)||!statSync(target).isFile())throw new Error(`保留草稿路径异常：${file.path}`);
          writeFileSync(target,file.text,{mode:0o600});
        }
      };
      if(needed.length){
        this.knowledge.event(task.task_id,`文档生成：已就绪 ${preserved.length}/${paths.length} 份（已恢复合格草稿，尚未发布）`);
        const generationScope=topicEntry?`只完成本主题 Wiki 组入口和必要子页，允许路径见主题组协议。已恢复合格草稿禁止修改；必需项 ${needed.join('、')}。缺失的必要目标可补齐，不创建其他主题。`:paperBundle?`以下 output/ 相对路径是本次尚需完成的必需项，不是全部允许输出：${needed.join('、')}。同时按 skill 在 knowledge_base/papers/${source}/ 内生成正文引用所需的 evidence/ev-*.md，并按需增加 method/<slug>.md 和 results/<slug>.md；将新增页纳入本篇导航或依据目录，不生成其他论文文件。已恢复的合格草稿禁止修改；若其引用的目标缺失，应补齐目标。`:`本次只生成或修复以下 output/ 相对路径：${needed.join('、')}。其余已合格文件禁止修改。`;
        await runGeneration(prompt+'\n'+generationScope+'每份必须落盘，不以最终回复替代文件。单文件硬上限1048576字节，不嵌入图片base64，不复制整篇原文。',preserved);
      }else this.knowledge.event(task.task_id,'全部目标草稿已恢复；无需再次调用模型生成');
      phase('validation','校验知识页、导航与依据锚点');
      this.knowledge.event(task.task_id,'输出校验：逐项检查 Markdown 文件、大小、格式与来源');
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(topicEntry)paths.splice(0,paths.length,...topicOutputPaths(output,topicEntry,paths));
      checked=checkOutputs();saveCheck(checked);
      this.knowledge.event(task.task_id,`文档生成：已就绪 ${checked.valid.filter(file=>!checked.issues.some(issue=>issue.path===file.path)).length}/${paths.length} 份（校验合格，尚未发布）`);
      if(checked.issues.length&&!checked.issues.some(item=>item.unsafe)){
        const issues=checked.issues as PaperWikiIssue[];
        repairIssues=issues;saveCheck(checked);
        const repairPaths=new Set(issues.map(issue=>issue.path));
        // A new evidence target may also need adding to the existing index.
        if(paperBundle&&issues.some(issue=>issue.missing_target?.startsWith(`knowledge_base/papers/${source}/evidence/`)))repairPaths.add(`knowledge_base/papers/${source}/evidence.md`);
        const good=checked.valid.filter(file=>!repairPaths.has(file.path));
        const grouped=new Map<string,Set<string>>();
        for(const issue of issues){const files=grouped.get(issue.reason)??new Set<string>();files.add(issue.path);grouped.set(issue.reason,files);}
        const summary=[...grouped].map(([reason,files])=>`${reason}（${[...files].join('、')}）`).join('；');
        this.knowledge.event(task.task_id,`自动补救（1/1）：${summary}。仅定向修复 ${repairPaths.size} 个文件，保留有效正文；详细位置见 output-check.json`);
        const repairScope=(paperBundle||topicEntry)?`本轮补救范围优先于初次生成要求：只修改或补写以下 output/ 相对路径：${[...repairPaths].join('、')}。允许创建清单中被引用但缺失的当前组依据或子页；其必要的组内引用目标也可补齐，遵守原有路径和数量限制。除已列出的依据目录外，其余合格文件禁止修改；仅为必要引用同步目录，不整组重写。`:`只修复以下文件：${JSON.stringify(issues)}。已有合格文件禁止修改。`;
        const beforeRepair=new Map(knowledgeFiles(output,'knowledge_base').map(path=>[path,createHash('sha256').update(readFileSync(join(output,path))).digest('hex')]));
        const repairContext=topicEntry?`读取 literature-skill/SKILL.md、literature-skill/references/synthesis.md 和 input.json。当前仅定向修复主题组 ${topicEntry}，不重新生成全部主题。${topicPrompt(topicEntry,task.input.title)}`:paperBundle?`读取 literature-skill/SKILL.md、literature-skill/references/paper-wiki.md 和 input.json 中的路径、元数据要求。仅修复 source_id=${source} 的现有工作副本，当前是修复模式，不执行初次生成流程，不创建规划文件或其他任务。` : prompt;
        writeFileSync(join(directory,'repair-prompt.txt'),repairContext+'\n'+repairScope+'\n'+JSON.stringify(issues),{mode:0o600});
        await runGeneration(repairContext+'\n这是唯一一次输出补救。'+repairScope+`具体问题：${JSON.stringify(issues)}。优先修复明确根因：格式错误仅调整元数据、标题或链接，保留有效正文，不重新分析全文；不得删除有效页面、必要引用或关键论断来绕过校验。依据缺失只使用已读材料补齐，不编造数字、出处或核验状态；材料不足时如实记录缺口。缺失的补写，字段错误的修正，超限的压缩冗余并保留关键证据，不截断正文，不嵌入base64。不重新阅读PDF，使用已有材料或 readings/ 笔记。只核对修复内容与必要关联，不回读全部目标、来源或已保护草稿。`,good);
        repairChanges=[...new Set([...beforeRepair.keys(),...knowledgeFiles(output,'knowledge_base')])].map(path=>({path,before:beforeRepair.get(path)??null,after:existsSync(join(output,path))?createHash('sha256').update(readFileSync(join(output,path))).digest('hex'):null})).filter(file=>file.before!==file.after);
        this.knowledge.event(task.task_id,'补救实际修改：'+(repairChanges.map(file=>file.path).join('、')||'无文件变化'));
        if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(topicEntry)paths.splice(0,paths.length,...topicOutputPaths(output,topicEntry,paths));
        checked=checkOutputs();saveCheck(checked);
      this.knowledge.event(task.task_id,`文档生成：已就绪 ${checked.valid.filter(file=>!checked.issues.some(issue=>issue.path===file.path)).length}/${paths.length} 份（校验合格，尚未发布）`);
      }
      if(repairIssues.length)this.knowledge.event(task.task_id,`补救结果：初次 ${repairIssues.length} 项，当前剩余 ${checked.issues.length} 项；修改范围及已解决项见 output-check.json，工作副本 ${directory}；尚未发布`);
      if(checked.issues.length)throw new Error('Markdown 输出校验失败；剩余根因及工作副本见 '+join(directory,'output-check.json')+'：'+checked.issues.map(item=>`${item.path}：${item.reason}`).join('；'));
      const commits=checked.valid.map(({path,text})=>{
        const before=snapshot.documents?.find(doc=>doc.path===path);
        return {path,text,expected:snapshot.expectedTargets?.[path]??before?.hash??null};
      });
      if(commits.every(file=>snapshot.documents?.find(doc=>doc.path===file.path)?.text===file.text))throw new Error('输出未更新；未把已有文件误报为本次生成');
      if(paperBundle && commits.some(file=>markdown.parse(projectId,file.path,file.text).source_id!==source))throw new Error('生成文件来源与指定论文不一致');
      for(const ref of snapshot.dependencies??[]){const current=markdown.index(projectId).documents.find(d=>d.id===ref.id);if(!current||current.hash!==ref.hash)throw new Error('来源内容已变化，保留工作副本，请重新综合');}
      for(const result of readingResults)if(new PdfReading(this.store).original(projectId,source).hash!==result.hash)throw new Error('论文PDF已变化，保留工作副本，请重新分析');
      for(const [id,baseline] of Object.entries(snapshot.bibliography_baselines??{}))if(sourceContentHash(this.store.getSource(id))!==baseline.content_hash)throw new Error('论文原始内容已变化，保留工作副本，请重新分析');
      if(topicEntry&&task.input.topic_preview){
        task.topic_draft={files:checked.valid.map(({path,hash})=>({path,hash}))};
        phase('completed','单主题试稿已校验，等待确认发布');
        task.status='completed';this.knowledge.saveTask(task);
        this.knowledge.event(task.task_id,'试稿已通过主题 Wiki 组校验，尚未发布');
        return;
      }
      phase('publishing','核对版本并整组发布');
      this.knowledge.event(task.task_id,'发布阶段：全部输出校验合格，核对版本后整组发布');
      if(task.input.abstract_mode){
        if(task.input.abstract_wiki_only){
          const current=abstractText(this.store,projectId,source,'wiki');
          const expected=(task.snapshot as {abstract_expected:string|null}).abstract_expected;
          if((current?createHash('sha256').update(current).digest('hex'):null)!==expected)throw new Error('VERSION_CONFLICT');
          publishAbstractWiki(this.store,projectId,source,commits[0].text);
        }else{
          publishAbstract(this.store,projectId,source,commits[0].text,(task.snapshot as {abstract_expected:string|null}).abstract_expected);
          publishAbstractWiki(this.store,projectId,source,commits[1].text);
        }
        task.status='completed';task.output_id=`abstract-${source}`;task.output_version=1;this.knowledge.saveTask(task);this.knowledge.event(task.task_id,`Markdown 已发布：${paths[0]}（仅摘要，独立存放）`);return;
      }
      const records=markdown.commit(projectId,commits,snapshot.bibliography_baselines,{taskId:task.task_id,deferPaperVersion:paperBundle,fullPaperSource:paperBundle?source:undefined,fullTopicId:topicEntry});
      for(const record of records.filter(r=>r.kind==='wiki-page'&&!topicEntry))markdown.stamp(projectId,record.id,[...(snapshot.dependencies??[]).filter(r=>!records.some(output=>output.id===r.id)&&(record.links??[]).some(l=>l.evidence&&l.path===r.path)).map(({path,hash})=>({path,hash})),...records.filter(r=>r.id!==record.id&&(record.links??[]).some(l=>l.evidence&&l.path===r.path)).map(({path,hash})=>({path,hash}))],true);
      if(paperBundle)new PaperWikiVersions(this.store,markdown,projectId,source).capture('完整论文分析',task.task_id);
      phase('completed',topicEntry?'主题 Wiki 组已发布':'新版论文知识已发布');
      task.status="completed";task.output_id=(topicEntry?records.find(record=>record.id===topicEntry):paperBundle?records.find(record=>record.path===`knowledge_base/papers/${source}/whoami.md`):undefined)?.id??records[0].id;task.output_version=1;this.knowledge.saveTask(task);this.knowledge.event(task.task_id,`Markdown 已发布：${records.map(record=>record.path).join('、')}`);

    }catch(error){if(task.status==="running" && !this.closed){task.status="failed";task.error=redact(error instanceof Error?error.message:"任务失败");this.knowledge.saveTask(task);this.knowledge.event(task.task_id,task.error);}}
    finally {this.reserved.delete(projectId);this.running.delete(projectId);if(!this.closed){try{this.onTaskSettled?.(projectId,task);}catch{/* The workflow records its own errors. */}void this.pump(projectId);}}
  }
}
