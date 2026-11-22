import { randomUUID,createHash } from "node:crypto";
import { mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { experimentError,type TrashStore } from "@trash/storage";
import type { CoordinationMemoryKind,CoordinationMemoryHeader,CoordinationMemoryPage,CoordinationMember } from "@trash/protocol";
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
      CREATE TABLE IF NOT EXISTS coordination_exports (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,path TEXT NOT NULL,written TEXT,pending TEXT,
      PRIMARY KEY(project,path));`);
  }
  list(project:string,q="",offset=0){
    const rows=this.store.db.prepare(`SELECT ${header} FROM coordination_pages WHERE project=? AND
      instr(lower(title||' '||body||' '||source||' '||id||' '||coalesce(repository,'')),lower(?))>0
      ORDER BY archived,updated DESC,id LIMIT 31 OFFSET ?`).all(project,q,offset) as CoordinationMemoryHeader[];
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
      this.enqueue(project,folders[page.kind]+"/"+page.id+".md",this.render(page));
      const links=(this.store.db.prepare(`SELECT ${header} FROM coordination_pages WHERE project=? ORDER BY archived,kind,title`).all(project) as CoordinationMemoryHeader[])
        .map(p=>"- ["+p.title.replace(/[\[\]\\]/g," ")+"]("+folders[p.kind]+"/"+p.id+".md)"+(p.archived?" · 已归档":""));
      this.enqueue(project,"index.md","# 协调项目记忆\n\n"+links.join("\n")+"\n");
    }).immediate();
    return this.page(project,id);
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
    return {...page,body:page.body.slice(query.offset,query.offset+6000),next_offset:page.body.length>query.offset+6000?query.offset+6000:null};
  }
}
