import { randomUUID,createHash } from "node:crypto";
import { mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { experimentError,type TrashStore } from "@trash/storage";
import type { CoordinationMemoryKind,CoordinationMemoryHeader,CoordinationMemoryPage,CoordinationMember,CoordinationJob } from "@trash/protocol";
import { ensureResearchDirectory } from "./project-layout.js";

const folders:Record<CoordinationMemoryKind,string>={direction:"directions",decision:"decisions",lesson:"lessons"};
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const header="id,kind,title,conversation,repository,revision,archived,updated,source";
function directory(path:string){
  try{mkdirSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  if(!lstatSync(path).isDirectory())experimentError("FILES_NOT_DIRECTORY",422);
  return path;
}
function diskText(path:string){
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isFile()||stat.size>2*1024*1024)experimentError("FILES_NOT_REGULAR",409);
  return readFileSync(path,"utf8");
}
function replace(path:string,text:string){
  const tmp=path+"."+randomUUID()+".tmp";
  try{writeFileSync(tmp,text,{flag:"wx",mode:0o600});renameSync(tmp,path);}
  finally{rmSync(tmp,{force:true});}
}
export const memoryEdit=z.object({id:z.string().uuid(),expected:z.number().int().nonnegative(),title:z.string().trim().min(1).max(180).regex(/^[^\r\n]+$/),
  body:z.string().trim().min(1).max(64000),archived:z.boolean().default(false),conversation:z.string().uuid().optional()});
export class CoordinationMemory {
  constructor(private store:TrashStore){
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordination_pages (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,
      title TEXT NOT NULL,conversation TEXT,repository TEXT,revision INTEGER NOT NULL,archived INTEGER NOT NULL,
      updated TEXT NOT NULL,source TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project,id));
      CREATE UNIQUE INDEX IF NOT EXISTS coordination_direction ON coordination_pages(project,conversation,COALESCE(repository,'')) WHERE kind='direction';
      CREATE TABLE IF NOT EXISTS coordination_page_versions (
      project TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(project,id,revision),FOREIGN KEY(project,id) REFERENCES coordination_pages(project,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS coordination_notes (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,origin TEXT NOT NULL,key TEXT NOT NULL,
      id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(project,origin,key));
      CREATE TABLE IF NOT EXISTS coordination_evidence (
      project TEXT NOT NULL,page TEXT NOT NULL,receipt TEXT NOT NULL,job TEXT NOT NULL,turn TEXT,observed TEXT NOT NULL,
      note TEXT NOT NULL,PRIMARY KEY(project,receipt),FOREIGN KEY(project,page) REFERENCES coordination_pages(project,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS coordination_evidence_page ON coordination_evidence(project,page,observed);
      CREATE TABLE IF NOT EXISTS coordination_exports (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,path TEXT NOT NULL,written TEXT,pending TEXT,
      PRIMARY KEY(project,path));`);
  }
  list(project:string,q="",offset=0){
    const rows=this.store.db.prepare(`SELECT ${header} FROM coordination_pages WHERE project=? AND
      (instr(lower(title||' '||body||' '||source||' '||id||' '||coalesce(repository,'')),lower(?))>0 OR EXISTS
      (SELECT 1 FROM coordination_evidence e WHERE e.project=coordination_pages.project AND e.page=coordination_pages.id AND instr(lower(e.note||' '||e.job||' '||e.turn),lower(?))>0))
      ORDER BY archived,updated DESC,id LIMIT 31 OFFSET ?`).all(project,q,q,offset) as CoordinationMemoryHeader[];
    return {pages:rows.slice(0,30).map(r=>({...r,archived:!!r.archived})),next_offset:rows.length>30?offset+30:null};
  }
  page(project:string,id:string,revision?:number):CoordinationMemoryPage{
    if(revision!==undefined){
      const row=this.store.db.prepare("SELECT data FROM coordination_page_versions WHERE project=? AND id=? AND revision=?").get(project,id,revision) as {data:string}|undefined;
      if(!row)experimentError("NOT_FOUND",404);
      return JSON.parse(row.data);
    }
    const page=this.store.db.prepare(`SELECT ${header},body FROM coordination_pages WHERE project=? AND id=?`).get(project,id) as CoordinationMemoryPage|undefined;
    if(!page)experimentError("NOT_FOUND",404);
    return {...page,archived:!!page.archived};
  }
  direction(project:string,conversation:string,repository:string|null){
    return this.store.db.prepare("SELECT id FROM coordination_pages WHERE project=? AND kind='direction' AND conversation=? AND repository IS ?").get(project,conversation,repository) as {id:string}|undefined;
  }
  save(project:string,data:z.infer<typeof memoryEdit>,kind:CoordinationMemoryKind,source:string,member?:Pick<CoordinationMember,"id"|"repository_id">){
    const {id,expected,title,body,archived}=data;
    this.store.db.transaction(()=>{
      const row=this.store.db.prepare("SELECT revision FROM coordination_pages WHERE project=? AND id=?").get(project,id) as {revision:number}|undefined;
      if(expected!==(row?.revision??0))experimentError("VERSION_CONFLICT",409);
      if(!row&&kind==="direction"&&member&&this.direction(project,member.id,member.repository_id))experimentError("VERSION_CONFLICT",409);
      this.store.db.prepare(`INSERT INTO coordination_pages VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project,id) DO UPDATE SET title=excluded.title,body=excluded.body,revision=excluded.revision,
        archived=excluded.archived,updated=excluded.updated,source=excluded.source`).run(project,id,kind,title,member?.id??null,member?.repository_id??null,expected+1,+archived,new Date().toISOString(),source,body);
      const page=this.page(project,id);
      this.store.db.prepare("INSERT INTO coordination_page_versions VALUES (?,?,?,?)").run(project,id,page.revision,JSON.stringify(page));
      this.enqueue(project,folders[page.kind]+"/"+page.id+".md",this.render(page)+this.renderEvidence(project,page.id));
      const links=(this.store.db.prepare(`SELECT ${header} FROM coordination_pages WHERE project=? ORDER BY archived,kind,title`).all(project) as CoordinationMemoryHeader[])
        .map(p=>"- ["+p.title.replace(/[\[\]\\]/g," ")+"]("+folders[p.kind]+"/"+p.id+".md)"+(p.archived?" · 已归档":""));
      this.enqueue(project,"index.md","# 协调项目记忆\n\n"+links.join("\n")+"\n");
    }).immediate();
    return this.page(project,id);
  }
  record(project:string,origin:string,body:unknown,job?:CoordinationJob){
    const input=z.object({kind:z.enum(["decision","lesson"]),key:z.string().trim().min(1).max(100),
      title:memoryEdit.shape.title,observation:z.string().trim().min(1).max(2200),scope:z.string().trim().min(1).max(1000),
      limitation:z.string().trim().min(1).max(1000),supersedes:z.string().uuid().optional()}).parse(body);
    const fingerprint=digest(JSON.stringify([input,job?.id]));
    return this.store.db.transaction(()=>{
      const old=this.store.db.prepare("SELECT id,fingerprint FROM coordination_notes WHERE project=? AND origin=? AND key=?").get(project,origin,input.key) as {id:string;fingerprint:string}|undefined;
      if(old){if(old.fingerprint!==fingerprint)experimentError("IDEMPOTENCY_CONFLICT",409);return {id:old.id};}
      if(input.supersedes)this.page(project,input.supersedes);
      const id=randomUUID(),source="协调请求 "+origin+(job?" · 成员任务 "+job.id+" · "+(job.reply_task_id??job.task_id):"");
      const sections=[input.kind==="decision"?"## 决策建议":"## 实验经验",input.observation,"## 适用范围",input.scope,"## 局限与反例",input.limitation];
      if(input.supersedes)sections.push("## 替代的记录",input.supersedes);
      this.save(project,{id,expected:0,title:input.title,archived:false,body:sections.join("\n\n")},input.kind,source,
        job?{id:job.conversation,repository_id:job.repository_id}:undefined);
      this.store.db.prepare("INSERT INTO coordination_notes VALUES (?,?,?,?,?)").run(project,origin,input.key,id,fingerprint);
      return {id};
    }).immediate();
  }
  evidence(project:string,id:string,offset=0){
    const rows=this.store.db.prepare("SELECT receipt,job,turn,observed,note FROM coordination_evidence WHERE project=? AND page=? ORDER BY observed DESC,rowid DESC LIMIT 11 OFFSET ?").all(project,id,offset) as {receipt:string;job:string;turn:string|null;observed:string;note:string}[];
    return {entries:rows.slice(0,10),next_offset:rows.length>10?offset+10:null};
  }
  remember(project:string,job:CoordinationJob,title:string){
    const text=(job.report??job.worker_response??"").trim();
    if(!job.conversation||!job.reply_task_id&&!job.task_id||!text||job.consultation&&!(job.feedback==="answered"||job.feedback==="blocked"))return;
    const versions=(job.plans??[]).map(p=>({commit:p.commit,plan:p.plan_id,version:p.version,run:p.run_id,result:p.result_id}));
    const note=[job.instructions.slice(0,320),text.slice(0,1000),...versions.slice(0,8).map(v=>JSON.stringify(v))].join("\n\n");
    const receipt=digest(JSON.stringify([job.id,job.conversation,job.repository_id,job.feedback??job.report_status,note]));
    this.store.db.transaction(()=>{
      if(this.store.db.prepare("SELECT 1 FROM coordination_evidence WHERE project=? AND receipt=?").get(project,receipt))return;
      const existing=this.direction(project,job.conversation,job.repository_id);
      const page=existing?this.page(project,existing.id):undefined;
      if(page?.archived)return;
      const id=page?.id??randomUUID();
      const observed=new Date().toISOString(),turn=job.reply_task_id??job.task_id;
      const source="成员回报 · "+job.id+" · "+turn;
      // Keep the human-maintained body independent of append-only, explicitly attributed observations.
      this.save(project,{id,title:page?.title??title,body:page?.body??"## 当前结论\n\n待结合下方成员回报核实。",expected:page?.revision??0,archived:false},"direction",source,{id:job.conversation,repository_id:job.repository_id});
      this.store.db.prepare("INSERT INTO coordination_evidence VALUES (?,?,?,?,?,?,?)").run(project,id,receipt,job.id,turn,observed,note);
      const current=this.page(project,id);
      this.enqueue(project,folders.direction+"/"+id+".md",this.render(current)+this.renderEvidence(project,id));
    }).immediate();
  }
  private renderEvidence(project:string,id:string){
    const rows=this.evidence(project,id).entries;
    return rows.length?"\n## 最近成员回报\n\n"+rows.map(r=>"### "+r.observed+" · "+r.job+"\n\n"+r.note+"\n\n原回复 "+r.turn).join("\n\n")+"\n":"";
  }
  private render(p:CoordinationMemoryPage){
    return "# "+p.title+"\n\n版本 "+p.revision+" · "+p.updated+(p.archived?" · 已归档":"")+"\n\n"+p.body+"\n\n来源："+p.source+"\n";
  }
  private enqueue(project:string,path:string,text:string){
    this.store.db.prepare(`INSERT INTO coordination_exports(project,path,pending) VALUES (?,?,?)
      ON CONFLICT(project,path) DO UPDATE SET pending=excluded.pending`).run(project,path,text);
  }
  // Reconcile the committed export journal. Preserve a separately edited Markdown file on conflict.
  flush(project:string){
    const rows=this.store.db.prepare("SELECT path,written,pending FROM coordination_exports WHERE project=? AND pending IS NOT NULL ORDER BY path").all(project) as {path:string;written:string|null;pending:string}[];
    const conflicts:string[]=[];
    for(const row of rows){
      const root=directory(join(ensureResearchDirectory(this.store.root,project),"coordination"));
      const [first,name]=row.path.split("/");
      const path=name?join(directory(join(root,first)),name):join(root,first);
      const old=diskText(path),current=old===null?null:digest(old),next=digest(row.pending);
      if(current!==next){
        if(current!==row.written){conflicts.push(row.path);continue;}
        replace(path,row.pending);
      }
      this.store.db.prepare("UPDATE coordination_exports SET written=?,pending=NULL WHERE project=? AND path=? AND pending=?").run(next,project,row.path,row.pending);
    }
    return conflicts;
  }
  read(project:string,body:unknown){
    const query=z.object({id:z.string().uuid().optional(),revision:z.number().int().positive().optional(),q:z.string().max(300).default(""),offset:z.number().int().nonnegative().default(0)}).parse(body);
    if(!query.id)return this.list(project,query.q,query.offset);
    const page=this.page(project,query.id,query.revision);
    return {...page,recent_evidence:this.evidence(project,page.id).entries.slice(0,3),body:page.body.slice(query.offset,query.offset+6000),next_offset:page.body.length>query.offset+6000?query.offset+6000:null};
  }
}
