import {PaperWikiVersions} from './paper-wiki-versions.js';
import {researchExplorationIssues} from './research-exploration-format.js';
import {CliTurnResult} from './cli-turn-result.js';
import {readPaperChapters} from './chapter-reader.js';
import {paperWikiPaths,paperWikiOutputPaths,paperWikiPrompt,paperWikiIssues,paperCompatibility,paperWikiSelfCheck,type PaperWikiIssue} from './paper-wiki.js';
import {knowledgePath,knowledgeDocumentId} from '@trash/protocol';
import {migrationManifest,migrationPreview,migrateKnowledgeBase} from './knowledge-base-migration.js';
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

const taskSkill=(input:KnowledgeTaskInput)=>input.research_exploration&&['directions','evidence-plan'].includes(input.research_exploration)?'trash-research-exploration' as const:input.kind==='wiki-page'&&input.wiki_level!=='single'?'trash-literature-synthesis' as const:'trash-literature-wiki' as const;
const taskPromptVersion=(input:KnowledgeTaskInput,paperBundle:boolean)=>paperBundle?14:input.abstract_mode?10:14;
function researchPrompt(input:KnowledgeTaskInput,path:string){
 const skill=taskSkill(input),reference=skill==='trash-research-exploration'?'research-exploration':'synthesis';
 return `读取 literature-skill/SKILL.md、literature-skill/references/${reference}.md 和 input.json，使用 ${skill}，模式 ${input.research_exploration}。按对应模式结构输出，不套单篇模板。先用已提供的轻量正文与 material_index 筛选，再按需读取 output/ 中的来源工作副本；索引不代表已读。补读方法、结果或具体依据仅围绕当前判断，不固定读取全部材料。只写 output/${path}，frontmatter knowledge_version: 2、kind: wiki-page、level: ${input.wiki_level}、id: ${knowledgeDocumentId(path)}。不修改来源工作副本，不读PDF、历史任务或自动联网。研究条件在 input.project.research_constraints，缺项集中说明，不猜测；不要改变已选、暂缓或排除问题。summary 模式必须有“## 何时读取”“## 覆盖方向”“## 材料范围”“## 批次标识”，批次标识填写“${input.title}”。原始source_id、页ID和可解析相对链接逐层保留，关键判断就近引用，在“## 引用依据”说明实际使用来源与对应论点；未读取项列为缺口。材料缺口不等于领域空白，未补查最接近和近期工作不宣称新颖性成立。只给方向性最小验证，不设计完整实验或运行实验。利用本次已读材料自查，有具体疑点才补读相关片段，不全文回读、不增加审核调用或检查脚本。用户要求：${input.instructions}`;
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
    const kbRoot=new MarkdownKnowledge(this.store).root(projectId);
    if(!migrationManifest(kbRoot)){
      if(this.knowledge.tasks(projectId).some(task=>['queued','running'].includes(task.status)))requestError('PROJECT_HAS_ACTIVE_TASKS',409);
      migrateKnowledgeBase(kbRoot,migrationPreview(kbRoot).fingerprint);
    }
    if(retryOf){
      const all=this.knowledge.tasks(projectId);
      const descends=(candidate:KnowledgeTask)=>{const seen=new Set<string>();let id=candidate.attempt_of;while(id&&!seen.has(id)){if(id===retryOf)return true;seen.add(id);id=all.find(t=>t.task_id===id)?.attempt_of;}return false;};
      const successors=all.filter(descends).sort((a,b)=>Number(['queued','running'].includes(b.status))-Number(['queued','running'].includes(a.status))||b.created_at.localeCompare(a.created_at));
      if(successors[0]){this.onTaskRetried?.(projectId,retryOf,successors[0]);return [successors[0]];}
    }
    if(input.kind==='wiki-page'){
      const current=this.knowledge.tasks(projectId).find(task=>['queued','running'].includes(task.status)&&task.input.kind==='wiki-page'&&task.input.target_id===input.target_id&&task.input.title===input.title&&task.input.wiki_level===input.wiki_level&&task.input.instructions===input.instructions&&JSON.stringify(task.input.dependencies)===JSON.stringify(input.dependencies)&&JSON.stringify(task.input.source_ids)===JSON.stringify(input.source_ids));
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
      const sourceIds=part.kind==='literature-card'||paperBundle?part.source_ids:[];
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
      const previous=part.target_id?index.find(doc=>doc.id===part.target_id):part.kind==='literature-card'?index.find(doc=>doc.source_id===part.source_ids[0]&&doc.card_type==='detail'):undefined;
      if(part.target_id&&!previous)requestError('NOT_FOUND',404);
      const documents=[...new Set([...selected.map(d=>d.id),...(previous?[previous.id]:[])])].map(id=>markdown.read(projectId,id));
      const inputChars=documents.reduce((n,d)=>n+d.text.length,0);
      if(paperBundle&&inputChars>400000)requestError('KNOWLEDGE_INPUT_TOO_LARGE',422);
      if(part.research_exploration&&inputChars>50000)requestError("RESEARCH_INPUT_TOO_LARGE",422);
      if(inputChars>60000&&!paperBundle){
        if(part.kind!=='wiki-page'&&!paperBundle)requestError('KNOWLEDGE_INPUT_TOO_LARGE',422);
        // Wiki synthesis uses card evidence, not full documents. Keep frontmatter, headings and a bounded body.
        const budget=Math.max(8000,Math.floor(56000/Math.max(1,documents.length)));
        for(const doc of documents){
          if(doc.text.length<=budget)continue;
          const lines=doc.text.split('\n'),kept:string[]=[];let used=0;
          for(const line of lines){if(used+line.length+1>budget)break;kept.push(line);used+=line.length+1;}
          doc.text=kept.join('\n')+'\n\n> 内容已按综合预算压缩；原始卡片仍保留在文献库。';
        }
      }
      const referenceDocuments=!paperBundle&&part.kind==='wiki-page'&&part.source_ids.length?index.filter(d=>part.source_ids.includes(d.source_id??'')&&d.kind==='wiki-page'&&(d.group_status===undefined||d.group_status==='current')).map(d=>markdown.read(projectId,d.id)):[];
      const dependencies=[...new Map([...selected,...referenceDocuments].map(d=>[d.path,{id:d.id,path:d.path,hash:d.hash}])).values()];
      if(part.kind==='literature-card'&&sources[0])part={...part,title:sources[0].source.title};
      const targetPaths=part.kind==='literature-card'?[`literature/cards/idcard-${part.source_ids[0]}.md`,...(part.include_source_wiki?[`wiki/wiki-${part.source_ids[0]}.md`]:[])]:previous?[previous.path]:[];
      for(let i=0;i<targetPaths.length;i++)targetPaths[i]=knowledgePath(targetPaths[i],part.wiki_level);
      if(paperBundle){targetPaths.splice(0,targetPaths.length,...paperWikiPaths(part.source_ids[0]),...markdown.index(projectId,false,true).documents.filter(doc=>doc.source_id===part.source_ids[0]&&!paperCompatibility(doc.path.split(`/papers/${part.source_ids[0]}/`)[1]??'')&&doc.kind==='wiki-page').map(doc=>doc.path));}
      const expectedTargets=Object.fromEntries(targetPaths.map(path=>{const file=markdown.locate(projectId,path);return [path,existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null];}));
      const topicIndex=index.filter(doc=>doc.kind==='wiki-page'&&['topic','hypothesis'].includes(doc.level??''));
      const abstractBefore=part.abstract_mode?abstractText(this.store,projectId,part.source_ids[0],part.abstract_wiki_only?'wiki':'notes'):undefined;
      const snapshot={abstract_expected:abstractBefore===undefined?undefined:abstractBefore?createHash('sha256').update(abstractBefore).digest('hex'):null,topic_index:part.kind==='wiki-page'?topicIndex.slice(0,100).map(({id,title,level,summary,aliases})=>({id,title,level,summary,aliases})):undefined,topic_index_total:part.kind==='wiki-page'?topicIndex.length:undefined,project:this.store.getProject(projectId),sources,dependencies,previous,documents,reference_documents:referenceDocuments,expectedTargets,bibliography_baselines:Object.fromEntries(sources.map(({source})=>[source.source_id,{authors:source.authors,title:source.title,year:source.year,publication_date:source.publication_date,revision:bibliographyState(this.store,source.source_id).revision??0,content_hash:sourceContentHash(source)}])),base_version:0,prompt_version:taskPromptVersion(part,paperBundle),skill_hash:createHash('sha256').update(part.abstract_mode?abstractSkill():skillText(taskSkill(part))).digest('hex'),reading_rule_version:2};
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
  private readingAttempts(task: KnowledgeTask, includeHistoricalReadings=false): KnowledgeTask[] {
    const tasks=this.knowledge.tasks(task.project_id), result:KnowledgeTask[]=[], seen=new Set<string>();
    let id=task.attempt_of;
    while(id&&!seen.has(id)){seen.add(id);const prior=tasks.find(t=>t.task_id===id);if(!prior)break;
      if(Boolean(prior.input.abstract_mode)===Boolean(task.input.abstract_mode)&&prior.input.instructions===task.input.instructions&&(prior.snapshot as {reading_rule_version?:number}).reading_rule_version===2&&(task.snapshot as {reading_rule_version?:number}).reading_rule_version===2)result.push(prior);
      id=prior.attempt_of;
    }
    // Reading artifacts are reusable across completed analyses, not only retry ancestry.
    if(includeHistoricalReadings)for(const prior of tasks.filter(prior=>prior.task_id!==task.task_id&&prior.created_at<task.created_at&&prior.input.include_source_wiki&&!prior.input.abstract_mode&&prior.input.source_ids[0]===task.input.source_ids[0]&&prior.input.instructions===task.input.instructions&&(prior.snapshot as {reading_rule_version?:number}).reading_rule_version===(task.snapshot as {reading_rule_version?:number}).reading_rule_version).sort((a,b)=>b.created_at.localeCompare(a.created_at))){
      if(!seen.has(prior.task_id)){seen.add(prior.task_id);result.push(prior);}
    }
    return includeHistoricalReadings?result.sort((a,b)=>b.created_at.localeCompare(a.created_at)):result;
  }
  resumable(task:KnowledgeTask):boolean {
    if(!['failed','interrupted','cancelled'].includes(task.status))return false;
    const candidate={...task,attempt_of:task.task_id,snapshot:{...(task.snapshot as Record<string,unknown>),skill_hash:createHash('sha256').update(skillText(taskSkill(task.input))).digest('hex')}};
    const sourceId=task.input.source_ids[0];
    const draftPaths=task.input.kind==='literature-card'&&sourceId?[`literature/cards/idcard-${sourceId}.md`,...(task.input.include_source_wiki?[`wiki/wiki-${sourceId}.md`]:[])]:task.input.target_id?[`wiki/${task.input.target_id}.md`]:[];
    if(sourceId&&!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single'))draftPaths.splice(0,draftPaths.length,...paperWikiPaths(sourceId));
    const draftOutput=join(projectRuntime(this.store.root,task.project_id,'tasks',task.task_id),'output');
    if(existsSync(draftOutput)&&sourceId&&!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single'))draftPaths.splice(0,draftPaths.length,...paperWikiOutputPaths(draftOutput,sourceId,draftPaths));
    if(existsSync(draftOutput)&&this.inspectOutputs(task,draftOutput,draftPaths).valid.some(file=>(task.snapshot as {documents?:{path:string;text:string}[]}).documents?.find(doc=>doc.path===file.path)?.text!==file.text))return true;
    if(!sourceId)return false;
    for(const prior of this.readingAttempts(candidate))try{
      const directory=join(projectRuntime(this.store.root,task.project_id,'tasks',prior.task_id),'readings',sourceId);
      const state=JSON.parse(readFileSync(join(directory,'state.json'),'utf8')) as {version:number;blocks:{id:string;note_hash:string}[];pdf_hash:string};
      if(state.version!==2||new PdfReading(this.store).original(task.project_id,sourceId).hash!==state.pdf_hash)continue;
      if(state.blocks.some(block=>{const file=join(directory,block.id+'.md');return /^block-[a-f0-9]{20}$/.test(block.id)&&existsSync(file)&&!lstatSync(file).isSymbolicLink()&&createHash('sha256').update(readFileSync(file)).digest('hex')===block.note_hash;}))return true;
    }catch{/* Invalid checkpoints remain available but are not reused. */}
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
    const fields=['prompt_version','abstract_expected','sources','dependencies','expectedTargets','bibliography_baselines','skill_hash'];
    for(const prior of this.readingAttempts(task)){
      if(prior.input.kind!==task.input.kind||prior.input.include_source_wiki!==task.input.include_source_wiki)continue;
      const old=prior.snapshot as Record<string,unknown>, current=task.snapshot as Record<string,unknown>;
      if(fields.some(key=>JSON.stringify(old[key])!==JSON.stringify(current[key])))continue;
      const oldOutput=join(projectRuntime(this.store.root,task.project_id,'tasks',prior.task_id),'output');
      if(!existsSync(oldOutput))continue;
      const draftPaths=!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.wiki_level==='single')?paperWikiOutputPaths(oldOutput,task.input.source_ids[0],paths):paths;
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
        if(task.input.research_exploration){const errors=researchExplorationIssues(path,text,task.input.research_exploration);if(errors.length){issues.push({path,reason:errors.join('；'),unsafe:false});continue;}}
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
          }
          if((task.input.kind==='literature-card'||task.input.include_source_wiki||task.input.wiki_level==='single')&&doc.source_id!==task.input.source_ids[0])throw new Error('来源与指定论文不一致');
          if(!/^knowledge_version:\s*2\s*$/m.test(text.split(/---\r?\n/)[1]??''))throw new Error('缺少 knowledge_version: 2');
        }catch(error){issues.push({path,reason:`格式或必要字段不合格：${error instanceof Error?error.message:'未知格式错误'}`,unsafe:false});continue;}
        valid.push({path,text,hash:createHash('sha256').update(text).digest('hex')});
      }catch{issues.push({path,reason:'无法读取输出文件',unsafe:true});}
    }
    return {valid,issues};
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
      const snapshot=task.snapshot as {reference_documents?:ReturnType<MarkdownKnowledge['list']>['documents'];sources:{source:{source_id:string;source_type:string};segments:unknown[]}[];documents:ReturnType<MarkdownKnowledge['list']>['documents'];bibliography_baselines?:Record<string,{authors?:string[];title:string;year?:number;publication_date?:string;revision?:number;content_hash:string}>;expectedTargets?:Record<string,string|null>;dependencies?:{id:string;path:string;hash:string}[];previous?:ReturnType<MarkdownKnowledge['list']>['documents'][number]};
      const markdown=new MarkdownKnowledge(this.store);
      const source=task.input.source_ids[0];
      const id=task.input.kind==='literature-card'?`card-${source}`:snapshot.previous?.id??(task.input.wiki_level==='overview'?'wiki-project-overview':`wiki-${randomUUID()}`);
      const paperBundle=!task.input.abstract_mode&&(task.input.include_source_wiki||task.input.kind==='wiki-page'&&task.input.wiki_level==='single'&&task.input.source_ids.length===1);
      const paths=task.input.abstract_mode?(task.input.abstract_wiki_only?[`abstract-library/wiki/${source}.md`]:[`abstract-library/notes/${source}.md`,`abstract-library/wiki/${source}.md`]):task.input.kind==='literature-card'?[`literature/cards/idcard-${source}.md`]:[`wiki/${id}.md`];
      if(task.input.include_source_wiki)paths.push(`wiki/wiki-${source}.md`);
      for(let i=0;i<paths.length;i++)paths[i]=knowledgePath(paths[i],task.input.wiki_level);
      if(paperBundle)paths.splice(0,paths.length,...paperWikiPaths(source));
      const fulltextGeneration=!task.input.abstract_mode&&Boolean(task.input.include_source_wiki);
      // The database snapshot remains complete; model input contains no previous Wiki.
      const modelInput=fulltextGeneration?{
        project:(task.snapshot as {project?:unknown}).project,
        sources:snapshot.sources,
        instructions:task.input.instructions,
        outputs:paths.map(path=>({path,id:knowledgeDocumentId(path)})),
        output_scope:{required:true,additional:`knowledge_base/papers/${source}/{evidence/ev-*.md,method/<slug>.md,results/<slug>.md}`,description:'outputs是最低必需项，按技能补齐正文引用的依据与必要子页，不是全部允许输出'},
        reading_rule_version:(task.snapshot as {reading_rule_version?:number}).reading_rule_version,
        input_version:2
      }:snapshot.reference_documents?.length?{...(task.snapshot as object),reference_documents:undefined,material_index:(snapshot.reference_documents??[]).map(({id,path,title,source_id,stale})=>({id,path,title,source_id,stale}))}:task.snapshot;
      writeFileSync(join(directory,'input.json'),JSON.stringify(modelInput,null,2),{mode:0o600});
      const output=join(directory,'output');mkdirSync(output,{recursive:true});
      for(const doc of fulltextGeneration?[]:[...(snapshot.reference_documents??[]),...(snapshot.documents??[])]){const file=join(output,doc.path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,doc.text);}
      if(task.input.abstract_mode){mkdirSync(join(directory,'abstract-skill'),{recursive:true});writeFileSync(join(directory,'abstract-skill','SKILL.md'),abstractSkill(),{mode:0o600});}else stageKnowledgeSkill(directory,taskSkill(task.input));
      let prompt=`读取 literature-skill/SKILL.md 和 input.json，严格使用 trash-literature-wiki skill。模式：${task.input.kind}。${task.input.include_source_wiki?'单篇 Wiki 的一级标题必须与正式论文标题一致，不照抄旧文件名或任务标题。':task.input.wiki_level==='single'?'单篇 Wiki 沿用对应文献的正式论文标题；原始资料未核实时保留现有标题，不凭文件名猜测。':`主题/假设/总览 Wiki 标题为“${task.input.title}”，使用独立知识问题命名。`}直接生成 Markdown 文件到 output/ 下这些相对路径：${paths.join('、')}。frontmatter id 必须等于文件名去掉 .md，kind 为 wiki-page，knowledge_version: 2，Wiki level 为 ${task.input.wiki_level??'topic'}，source_id=${source??'不适用'}，不使用 card_type。不输出正文 JSON。其他文件仅供阅读，不修改。保留已有用户信息。idcard.md 严格按固定题录字段填写：标题、作者、期刊/会议、发表时间、源码状态及源码地址；没有源码写无。whoami.md 是本篇核心 Wiki 入口，必须在“知识导航”中单向链接 ./idcard.md；不编造月份，不联网自动核验仓库。Wiki 综合并拓展有来源的内容。用户要求：${task.input.instructions}。Wiki 面向后续Agent检索和推理，遵守references/wiki.md：单篇研究记忆800–1500字、主题正文600–1200字、总览400–800字为软目标，中间总结遵守本次指定预算；候选、假设和事实不能混淆，关键认识就近引用。关联主题用“## 关联知识”并说明支持/限制/对比/分歧；证据依赖用“## 引用依据”或“依据：”标记。普通相关链接不作证据。保留稳定ID和人工补充，先查 topic_index 同义主题。首先写“## 何时读取”，不要堆砌摘要或详细实验表格。完成后回读文件并报告路径。`;
      if(task.input.wiki_level==='summary')prompt+=` 本任务是分批总结，不是正式知识主题。忽略前文固定标题要求；一级标题根据实际输入内容命名，不能使用批次编号。内部批次名“${task.input.title}”仅写入“## 批次标识”。必须包含“## 何时读取”（一句内容概述）、“## 覆盖方向”（具体问题）、“## 材料范围”（实际覆盖ID、缺失及压缩限制）以及有出处的认识、分歧和线索。混合材料可用两三个方向概括，不虚构统一主题。总正文遵守本次3000字符预算；保留原始证据与稳定ID，不新增模型调用。`;
      if(task.input.abstract_mode)prompt=`读取 abstract-skill/SKILL.md 和 input.json，仅分析指定摘要。直接写两份 Markdown 到 output/${paths[0]} 和 output/${paths[1]}：第一份给人看的摘要解读，第二份给 Agent 的摘要 Wiki。一级标题使用提供的论文标题，必须标明 材料范围：仅摘要 和 source_id=${source}。两份文件按 abstract-skill/SKILL.md 的各自结构分别生成：notes 为人读卡片，wiki 为紧凑的Agent研究线索，不能复制相同正文或在卡片里嵌套摘要Wiki。只生成摘要Wiki，不生成全文卡片或正式主题Wiki；不生成源码栏目、待全文核验或补充全文流程。用户要求：${task.input.instructions}`;
      if(task.input.abstract_wiki_only)prompt=`读取 abstract-skill/SKILL.md 和 input.json。仅基于指定来源的原始摘要，按 Agent Wiki 章节生成 output/${paths[0]}。只生成这一份摘要 Wiki，不生成或修改人读卡片、原始资料或全文知识。一级标题使用论文标题，包含材料范围：仅摘要及 source_id=${source}。沿用摘要 Wiki 的紧凑结构、事实与推断区分和证据边界。用户要求：${task.input.instructions}`;
      prompt+='\n知识库统一使用 knowledge_base/。本次准确输出清单（优先于上文任何旧路径示例）：'+paths.map(path=>path+'，稳定ID='+knowledgeDocumentId(path)).join('；')+'。frontmatter id 使用此稳定ID，不使用 basic/key/detail/memory 这样的文件短名。所有相对链接根据实际新目录计算，引用 input.json 的真实 path。仅摘要文件仍按摘要规范，不添加全文frontmatter。';
      if(!paperBundle&&!task.input.abstract_mode&&task.input.kind==='wiki-page')prompt=`读取 literature-skill/SKILL.md、literature-skill/references/wiki.md 和 input.json，使用 trash-literature-synthesis。只写 output/${paths[0]}，frontmatter kind: wiki-page、knowledge_version: 2、level: ${task.input.wiki_level??'topic'}、id: ${knowledgeDocumentId(paths[0])}。按任务实际模式组织主题/发现/总结/总览，保留来源、稳定ID、人工内容和未覆盖主题入口；不写单篇题录，不按论文顺序复述。先用 material_index 筛选，按需读取 output/ 中的来源工作副本，不把索引当成已读；不修改来源。先核对topic_index，关键判断就近引用。summary 必须含“何时读取”“覆盖方向”“材料范围”“批次标识”（本次任务标题）。不固定全文回读或增加自查调用。用户要求：${task.input.instructions}`;
      if(task.input.research_exploration)prompt=researchPrompt(task.input,paths[0]);
      if(paperBundle)prompt=paperWikiPrompt(source,!task.input.include_source_wiki)+task.input.instructions;
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
      if(task.input.research_exploration)prompt=researchPrompt(task.input,paths[0]);
      if(paperBundle)prompt=paperWikiPrompt(source,!task.input.include_source_wiki)+task.input.instructions;
      if(fulltextGeneration)prompt+='\n本次从论文原始材料与批次笔记重新生成，不读取或沿用历史Wiki。已有版本由后台保留，当前任务期间的版本冲突由发布校验处理。';
      if(fulltextGeneration)writeFileSync(join(directory,'input.json'),JSON.stringify({...(modelInput as Record<string,unknown>),readings:readingResults},null,2),{mode:0o600});
      if(readingResults.length)prompt+='\n先完整读取本次全部固定四页批次笔记：'+JSON.stringify(readingResults)+'。在本次生成中综合全文，统一术语、实验条件和跨批次依据，再直接生成Wiki组；不单独生成paper-understanding.md，不额外调用整篇汇总。不要只读压缩摘要丢掉机制、数字或条件。依据页使用这些真实原文定位。已生成笔记不代表全部图表已核验。';
      writeFileSync(join(directory,'prompt.txt'),prompt);
      if(this.closed||this.knowledge.tasks(projectId).find(item=>item.task_id===task.task_id)?.status!=='running')return;
      if(Date.now()>=deadline)throw new Error('全文阅读超时；批次笔记已保留，未发布最终知识');
      this.restoreDrafts(task,output,paths);
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      if(fulltextGeneration)this.knowledge.event(task.task_id,task.attempt_of?'文档生成：继续本次失败链，仅恢复版本与规则匹配的合格草稿':'文档生成：重新分析从空输出开始，历史Wiki不作为输入；PDF笔记独立核验复用');
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      let repairIssues:PaperWikiIssue[]=[];
      const saveCheck=(result:ReturnType<KnowledgeAgent['inspectOutputs']>)=>{
        writeFileSync(join(directory,'output-check.json'),JSON.stringify({version:1,valid:result.valid.map(({path,hash})=>({path,hash})),issues:result.issues,repair_issues:repairIssues},null,2),{mode:0o600});
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
        try{await completion;}finally{clearTimeout(timer);preserveFiles(protectedFiles);if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));saveCheck(this.inspectOutputs(task,output,paths));}
        if(this.closed||task.status!=='running')throw new Error('任务已停止；草稿已保留');
      };
      const phase=(name:string,title:string)=>{const path=join(directory,'reading-progress.json');if(existsSync(path)){const current=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...current,phase:name,title,updated_at:new Date().toISOString()}),{mode:0o600});}};
      phase('wiki-generation','生成新版知识页与统一依据');
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
        const generationScope=paperBundle?`以下 output/ 相对路径是本次尚需完成的必需项，不是全部允许输出：${needed.join('、')}。同时按 skill 在 knowledge_base/papers/${source}/ 内生成正文引用所需的 evidence/ev-*.md，并按需增加 method/<slug>.md 和 results/<slug>.md；将新增页纳入本篇导航或依据目录，不生成其他论文文件。已恢复的合格草稿禁止修改；若其引用的目标缺失，应补齐目标。`:`本次只生成或修复以下 output/ 相对路径：${needed.join('、')}。其余已合格文件禁止修改。`;
        await runGeneration(prompt+'\n'+generationScope+'每份必须落盘，不以最终回复替代文件。单文件硬上限1048576字节，不嵌入图片base64，不复制整篇原文。',preserved);
      }else this.knowledge.event(task.task_id,'全部目标草稿已恢复；无需再次调用模型生成');
      phase('validation','校验知识页、导航与依据锚点');
      this.knowledge.event(task.task_id,'输出校验：逐项检查 Markdown 文件、大小、格式与来源');
      if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
      checked=this.inspectOutputs(task,output,paths);if(paperBundle)checked.issues.push(...paperWikiIssues(source,checked.valid,checked.issues.map(item=>item.path)));saveCheck(checked);
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
        this.knowledge.event(task.task_id,`自动补救（1/1）：${summary}。详细位置见 output-check.json`);
        const repairScope=paperBundle?`本轮补救范围优先于初次生成要求：只修改或补写以下 output/ 相对路径：${[...repairPaths].join('、')}。允许创建清单中被引用但缺失的本篇依据或子页；其必要的本篇引用目标也可补齐，遵守原有路径和数量限制。除已列出的依据目录外，其余合格文件禁止修改；仅为必要引用同步目录，不整组重写。`:`只修复以下文件：${JSON.stringify(issues)}。已有合格文件禁止修改。`;
        await runGeneration(prompt+'\n这是唯一一次输出补救。'+repairScope+`具体问题：${JSON.stringify(issues)}。缺失的补写，字段错误的修正，超限的压缩冗余并保留关键证据，不截断正文，不嵌入base64。不重新阅读PDF，使用已有材料或 readings/ 笔记。只核对修复内容与必要关联，不回读全部目标、来源或已保护草稿。`,good);
        if(paperBundle)paths.splice(0,paths.length,...paperWikiOutputPaths(output,source,paths));
        checked=this.inspectOutputs(task,output,paths);if(paperBundle)checked.issues.push(...paperWikiIssues(source,checked.valid,checked.issues.map(item=>item.path)));saveCheck(checked);
      this.knowledge.event(task.task_id,`文档生成：已就绪 ${checked.valid.filter(file=>!checked.issues.some(issue=>issue.path===file.path)).length}/${paths.length} 份（校验合格，尚未发布）`);
      }
      if(checked.issues.length)throw new Error('Markdown 输出校验失败；已保留工作副本：'+checked.issues.map(item=>`${item.path}：${item.reason}`).join('；'));
      const commits=checked.valid.map(({path,text})=>{
        const before=snapshot.documents?.find(doc=>doc.path===path);
        return {path,text,expected:snapshot.expectedTargets?.[path]??before?.hash??null};
      });
      if(commits.every(file=>snapshot.documents?.find(doc=>doc.path===file.path)?.text===file.text))throw new Error('输出未更新；未把已有文件误报为本次生成');
      if(paperBundle && commits.some(file=>markdown.parse(projectId,file.path,file.text).source_id!==source))throw new Error('生成文件来源与指定论文不一致');
      for(const ref of snapshot.dependencies??[]){const current=markdown.index(projectId).documents.find(d=>d.id===ref.id);if(!current||current.hash!==ref.hash)throw new Error('来源内容已变化，保留工作副本，请重新综合');}
      for(const result of readingResults)if(new PdfReading(this.store).original(projectId,source).hash!==result.hash)throw new Error('论文PDF已变化，保留工作副本，请重新分析');
      for(const [id,baseline] of Object.entries(snapshot.bibliography_baselines??{}))if(sourceContentHash(this.store.getSource(id))!==baseline.content_hash)throw new Error('论文原始内容已变化，保留工作副本，请重新分析');
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
      const records=markdown.commit(projectId,commits,snapshot.bibliography_baselines,{taskId:task.task_id,deferPaperVersion:paperBundle,fullPaperSource:paperBundle?source:undefined});
      for(const record of records.filter(r=>r.kind==='wiki-page'))markdown.stamp(projectId,record.id,[...(snapshot.dependencies??[]).filter(r=>!records.some(output=>output.id===r.id)&&(record.links??[]).some(l=>l.evidence&&l.path===r.path)).map(({path,hash})=>({path,hash})),...records.filter(r=>r.id!==record.id&&(record.links??[]).some(l=>l.evidence&&l.path===r.path)).map(({path,hash})=>({path,hash}))],true);
      if(paperBundle)new PaperWikiVersions(this.store,markdown,projectId,source).capture('完整论文分析',task.task_id);
      phase('completed','新版论文知识已发布');
      task.status="completed";task.output_id=(paperBundle?records.find(record=>record.path===`knowledge_base/papers/${source}/whoami.md`):undefined)?.id??records[0].id;task.output_version=1;this.knowledge.saveTask(task);this.knowledge.event(task.task_id,`Markdown 已发布：${records.map(record=>record.path).join('、')}`);

    }catch(error){if(task.status==="running" && !this.closed){task.status="failed";task.error=redact(error instanceof Error?error.message:"任务失败");this.knowledge.saveTask(task);this.knowledge.event(task.task_id,task.error);}}
    finally {this.reserved.delete(projectId);this.running.delete(projectId);if(!this.closed){try{this.onTaskSettled?.(projectId,task);}catch{/* The workflow records its own errors. */}void this.pump(projectId);}}
  }
}
