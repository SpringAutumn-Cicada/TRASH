import { projectRuntime } from "./project-layout.js";
import { MarkdownKnowledge, skillText, stageKnowledgeSkill } from "./markdown-knowledge.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { KnowledgeStore, type TrashStore, type KnowledgeTask } from "@trash/storage";
import { type KnowledgeTaskInput } from "@trash/protocol";
import { requestError, type TaskRunner } from "./knowledge.js";

const redact = (s: string) => s.replace(/(Bearer\s+)[\w.-]+/gi,"$1[REDACTED]").replace(/\bsk-[\w-]+\b/g,"[REDACTED]").replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]");
export class KnowledgeAgent implements TaskRunner {
  onTaskSettled?: (projectId: string) => void;
  private running = new Map<string, { child: ChildProcess; task: KnowledgeTask }>();
  private closed = false;
  private reserved = new Set<string>();
  constructor(readonly store: TrashStore, readonly knowledge: KnowledgeStore, readonly cli: { command: string; prefix: string[] } = { command: process.env.TRASH_CODEX_COMMAND || "codex", prefix: [] }) {
    const rows = store.db.prepare("SELECT data FROM knowledge_tasks WHERE status IN ('queued','running')").all() as {data:string}[];
    for (const row of rows) { const task = JSON.parse(row.data) as KnowledgeTask; task.status="interrupted"; task.error="服务重启，任务已中断；请手动重试。"; knowledge.saveTask(task); }
  }
  enqueue(projectId: string, input: KnowledgeTaskInput, retryOf?: string): KnowledgeTask[] {
    if (this.closed) requestError("SERVER_STOPPING",409);
    if (input.kind === "literature-card" && !input.source_ids.length) requestError("SOURCES_REQUIRED");
    const inputs = input.kind === "literature-card" ? [...new Set(input.source_ids)].map(id=>({...input,source_ids:[id]})) : [input];
    const tasks = inputs.map(part => {
      const sourceIds=part.kind==='wiki-page'&&!part.source_ids.length?this.store.listSources(projectId).map(source=>source.source_id):part.source_ids;
      const sources = sourceIds.map(id=> {
        const source=this.store.getSource(id); if (!source || source.project_id!==projectId) requestError("SOURCE_NOT_FOUND",404);
        return {source,segments:this.store.listSourceSegments(id)};
      });
      const markdown=new MarkdownKnowledge(this.store);
      const documents=markdown.list(projectId).documents;
      const dependencies=part.dependencies.map(d=>documents.find(doc=>doc.id===d.object_id) ?? this.knowledge.get(projectId,d.kind,d.object_id,d.version) ?? requestError("DEPENDENCY_NOT_FOUND",404));
      const previous = part.target_id ? documents.find(doc=>doc.id===part.target_id) : part.kind === "literature-card" ? documents.find(doc=>doc.source_id===part.source_ids[0]&&doc.card_type==='detail') : undefined;
      if (part.target_id && !previous) requestError("NOT_FOUND",404);
      if (part.kind === "literature-card" && sources[0]) part = {...part,title:sources[0].source.title};
      const snapshot={project:this.store.getProject(projectId),sources,dependencies,previous,documents,base_version:0,prompt_version:2,skill_hash:createHash('sha256').update(skillText()).digest('hex')};
      const fingerprint=createHash("sha256").update(JSON.stringify({snapshot,input:{...part,regenerate:false}})).digest("hex");
      const existing=this.knowledge.tasks(projectId).find(t=>t.fingerprint===fingerprint && ["queued","running","completed"].includes(t.status));
      if (existing && !part.regenerate) return existing;
      return {task_id:`task_${randomUUID()}`,project_id:projectId,input:part,snapshot,fingerprint,status:"queued",created_at:new Date().toISOString(),...(retryOf?{attempt_of:retryOf}:{})} as KnowledgeTask;
    });
    // Validate the whole batch before persisting or starting any task.
    this.store.db.transaction(()=>{for(const task of tasks) this.knowledge.saveTask(task);})();
    void this.pump(projectId);
    return tasks;
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
    if(wasQueued){try{this.onTaskSettled?.(projectId);}catch{/* Workflow records its own errors. */}}
  }
  private terminate(child: ChildProcess): void {
    try { if(process.platform!=="win32" && child.pid) process.kill(-child.pid,"SIGTERM"); else child.kill("SIGTERM"); } catch { /* Process already exited. */ }
    const timer=setTimeout(()=>{try {if(process.platform!=="win32" && child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{/* Already exited. */}},3000); timer.unref();
  }
  close(): void {this.closed=true; for(const active of this.running.values()){active.task.status="interrupted";this.knowledge.saveTask(active.task);this.terminate(active.child);}}
  private async pump(projectId: string): Promise<void> {
    if(this.closed || this.running.has(projectId) || this.reserved.has(projectId))return;
    const task=this.knowledge.tasks(projectId).filter(t=>t.status==="queued").sort((a,b)=>a.created_at.localeCompare(b.created_at))[0];
    if(!task)return;
    // Reserve before filesystem work or process startup.
    task.status="running";this.knowledge.saveTask(task);this.reserved.add(projectId);
    const directory=projectRuntime(this.store.root,projectId,'tasks',task.task_id);
    let child: ChildProcess | undefined;
    try {
      mkdirSync(directory,{recursive:true});
      writeFileSync(join(directory,"input.json"),JSON.stringify(task.snapshot,null,2));
      const snapshot=task.snapshot as {sources:unknown[];documents:ReturnType<MarkdownKnowledge['list']>['documents'];previous?:ReturnType<MarkdownKnowledge['list']>['documents'][number]};
      const markdown=new MarkdownKnowledge(this.store);
      const source=task.input.source_ids[0];
      const id=task.input.kind==='literature-card'?`card-${source}`:snapshot.previous?.id??`wiki-${randomUUID()}`;
      const paths=task.input.kind==='literature-card'?[`literature/cards/${id}-detail.md`,`literature/cards/${id}-key.md`]:[`wiki/${id}.md`];
      const output=join(directory,'output');mkdirSync(output,{recursive:true});
      for(const doc of snapshot.documents??[]){const file=join(output,doc.path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,doc.text);}
      stageKnowledgeSkill(directory);
      const prompt=`读取 literature-skill/SKILL.md 和 input.json，严格使用 trash-literature-knowledge skill。模式：${task.input.kind}。直接生成 Markdown 文件到 output/ 下这些相对路径：${paths.join('、')}。frontmatter id 必须等于文件名去掉 .md，kind 为 ${task.input.kind}，卡片 source_id=${source??'不适用'}，两卡 card_type 分别为 detail/key。不输出正文 JSON。其他文件仅供阅读，不修改。保留已有用户信息。卡片必须一次完成两份，先详细后关键；Wiki 综合并拓展有来源的内容。用户要求：${task.input.instructions}。完成后回读文件并报告路径。`;
      writeFileSync(join(directory,'prompt.txt'),prompt);
      const cliVersion = await new Promise<string>((resolve,reject)=>execFile(this.cli.command,[...this.cli.prefix,"--version"],{timeout:10000,maxBuffer:65536},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
      writeFileSync(join(directory,"metadata.json"),JSON.stringify({adapter:"codex-cli",cli_version:cliVersion,prompt_version:2,skill:"trash-literature-knowledge",skill_hash:createHash("sha256").update(skillText()).digest("hex"),input_fingerprint:task.fingerprint,sandbox:"workspace-write"},null,2));
      if(this.closed)return;
      this.knowledge.event(task.task_id,`Agent 版本：${cliVersion}`);
      if(this.knowledge.tasks(projectId).find(t=>t.task_id===task.task_id)?.status!=="running")return;
      child=spawn(this.cli.command,[...this.cli.prefix,"exec","--sandbox","workspace-write","-c",'approval_policy="never"',"--skip-git-repo-check","--ephemeral","--json","--color","never","-C",directory,"-"],{cwd:directory,detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"]});
      this.running.set(projectId,{child,task});
      this.knowledge.event(task.task_id,"启动本机 Codex CLI；隔离任务目录直接写双卡片/Wiki Markdown，提示词版本 2。");
      let logBytes=0;
      const log=(chunk:Buffer)=>{if(!this.closed && logBytes<1024*1024){const message=redact(chunk.toString());logBytes+=Buffer.byteLength(message);this.knowledge.event(task.task_id,message);}};
      child.stdout?.on("data",log);child.stderr?.on("data",log);
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;if(child)this.terminate(child);},task.input.timeout_seconds*1000);
      const completion=new Promise<void>((resolve,reject)=>{child!.once("error",reject);child!.once("close",code=>code===0?resolve():reject(new Error(timedOut?"任务超时":`CLI 退出码 ${code}`)));});
      child.stdin?.on("error",()=>{});child.stdin?.end(prompt);
      try {await completion;}finally{clearTimeout(timer);}
      if(task.status!=="running")return;
      const commits=paths.map(path=>{
        const file=join(output,path);if(!existsSync(file)||lstatSync(file).isSymbolicLink()||!realpathSync(file).startsWith(realpathSync(output)+sep)||statSync(file).size>1024*1024)throw new Error('Markdown 输出缺失或过大；已保留工作副本');
        const text=readFileSync(file,'utf8');const before=snapshot.documents?.find(doc=>doc.path===path);
        return {path,text,expected:before?.hash??null};
      });
      if(commits.every(file=>snapshot.documents?.find(doc=>doc.path===file.path)?.text===file.text))throw new Error('输出未更新；未把已有文件误报为本次生成');
      const records=markdown.commit(projectId,commits);
      task.status="completed";task.output_id=records[0].id;task.output_version=1;this.knowledge.saveTask(task);this.knowledge.event(task.task_id,`Markdown 已保存待审：${records.map(record=>record.path).join('、')}`);

    }catch(error){if(task.status==="running" && !this.closed){task.status="failed";task.error=redact(error instanceof Error?error.message:"任务失败");this.knowledge.saveTask(task);this.knowledge.event(task.task_id,task.error);}}
    finally {this.reserved.delete(projectId);this.running.delete(projectId);if(!this.closed){try{this.onTaskSettled?.(projectId);}catch{/* The workflow records its own errors. */}void this.pump(projectId);}}
  }
}
