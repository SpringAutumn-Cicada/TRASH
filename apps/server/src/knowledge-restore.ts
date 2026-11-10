import { MarkdownKnowledge } from "./markdown-knowledge.js";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { z } from "zod";
import { artifactSchema, researchProjectSchema, sourceSchema, sourceLocatorSchema, knowledgeKindSchema, reviewStatusSchema, parseKnowledge } from "@trash/protocol";
import type { KnowledgeVersion } from "@trash/protocol";
import type { TrashStore } from "@trash/storage";
import { requestError } from "./knowledge.js";

const bundleSchema=z.object({
  schema_version:z.literal(1),project:researchProjectSchema,
  markdown_files:z.array(z.object({path:z.string(),text:z.string().max(1024*1024)})).max(10000).default([]),
  sources:z.array(z.object({source:sourceSchema,segments:z.array(z.object({locator:sourceLocatorSchema,text:z.string(),source_id:z.string().optional(),ordinal:z.number().optional()})),details:z.string().optional()})),
  files:z.array(z.object({artifact:artifactSchema,bytes:z.string()})),
  records:z.array(z.object({object_id:z.string().regex(/^knowledge_[A-Za-z0-9-]+$/),project_id:z.string(),kind:knowledgeKindSchema,version:z.number().int().positive(),status:reviewStatusSchema,title:z.string(),content:z.unknown(),created_by:z.enum(["user","agent"]),created_at:z.string().datetime({offset:true})})),
  attachments:z.array(z.object({source_id:z.string(),artifact_id:z.string(),created_at:z.string()})),
  reviews:z.array(z.object({object_id:z.string(),version:z.number().int().positive(),decision:z.enum(["accepted","rejected"]),comment:z.string(),actor:z.string(),at:z.string()}))
});
export function restoreKnowledge(store: TrashStore, value: unknown) {
  const bundle=bundleSchema.parse(value), project=bundle.project, id=project.project_id;
  if(store.getProject(id))requestError("PROJECT_ALREADY_EXISTS",409);
  if(store.db.prepare("SELECT 1 FROM knowledge_versions WHERE project_id=?").get(id))requestError("PROJECT_ALREADY_EXISTS",409);
  if(bundle.records.some(record=>record.kind!=='experiment-result'))requestError('LEGACY_KNOWLEDGE_BUNDLE_UNSUPPORTED',409);
  const sources=new Set(bundle.sources.map(s=>s.source.source_id));
  const artifactIds=new Set(bundle.files.map(f=>f.artifact.artifact_id));
  const versions=new Set(bundle.records.map(r=>`${r.object_id}:${r.version}`));
  const records=bundle.records.map(r=>({...r,content:parseKnowledge(r.kind,r.content)})) as KnowledgeVersion[];
  for(const item of bundle.sources){if(item.source.project_id!==id || item.source.artifact_id && !artifactIds.has(item.source.artifact_id))requestError("INVALID_BUNDLE");}
  for(const record of records){
    if(record.project_id!==id || store.db.prepare("SELECT 1 FROM knowledge_versions WHERE object_id=?").get(record.object_id))requestError("INVALID_BUNDLE");
    if("source_id" in record.content && !sources.has(record.content.source_id))requestError("INVALID_BUNDLE");
    if("evidence" in record.content && record.content.evidence.some(e=>!sources.has(e.source_id)))requestError("INVALID_BUNDLE");
    if("dependencies" in record.content && record.content.dependencies.some(d=>!versions.has(`${d.object_id}:${d.version}`)))requestError("INVALID_BUNDLE");
  }
  for(const attachment of bundle.attachments)if(!sources.has(attachment.source_id)||!artifactIds.has(attachment.artifact_id))requestError("INVALID_BUNDLE");
  for(const review of bundle.reviews)if(!versions.has(`${review.object_id}:${review.version}`))requestError("INVALID_BUNDLE");
  const decoded=bundle.files.map(file=>{
    const bytes=Buffer.from(file.bytes,"base64");
    if(file.artifact.project_id!==id || bytes.length!==file.artifact.size_bytes || createHash("sha256").update(bytes).digest("hex")!==file.artifact.sha256)requestError("BUNDLE_HASH_MISMATCH");
    return {...file,bytes};
  });
  const created:string[]=[];
  try {
    store.db.transaction(()=>{
      store.db.prepare("INSERT INTO projects VALUES (?,?,?,?)").run(id,JSON.stringify(project),project.created_at,project.updated_at);
      for(const file of decoded){
        const saved=store.saveArtifact(id,file.artifact.name,file.artifact.media_type,file.bytes);
        const path=store.artifactFile(id,saved.artifact_id)!.path;created.push(path);
        const relative=path.slice(store.root.length+1);
        store.db.prepare("DELETE FROM managed_files WHERE artifact_id=?").run(saved.artifact_id);
        store.db.prepare("UPDATE artifacts SET artifact_id=?,data=? WHERE artifact_id=?").run(file.artifact.artifact_id,JSON.stringify(file.artifact),saved.artifact_id);
        store.db.prepare("INSERT INTO managed_files VALUES (?,?)").run(file.artifact.artifact_id,relative);
      }
      store.createSources(bundle.sources.map(s=>s.source),new Map(bundle.sources.map(s=>[s.source.source_id,s.segments])));
      for(const item of bundle.sources)if(item.details)store.db.prepare("INSERT INTO source_details VALUES (?,?)").run(item.source.source_id,item.details);
      for(const a of bundle.attachments)store.db.prepare("INSERT INTO source_attachments VALUES (?,?,?)").run(a.source_id,a.artifact_id,a.created_at);
      for(const r of records){
        store.db.prepare("INSERT INTO knowledge_versions VALUES (?,?,?,?,?,?)").run(r.object_id,r.version,id,r.kind,r.title,JSON.stringify(r));
        if(r.kind==="experiment-result" && "metrics" in r.content)for(const metric of r.content.metrics)if(typeof metric!=="string")store.db.prepare("INSERT INTO knowledge_metrics VALUES (?,?,?,?,?,?,?)").run(r.object_id,r.version,metric.name,metric.value,metric.unit,metric.condition,id);
      }
      const latest=new Map<string,KnowledgeVersion>();for(const r of records)if((latest.get(r.object_id)?.version??0)<r.version)latest.set(r.object_id,r);
      for(const r of latest.values()){
        const key="source_id" in r.content?r.content.source_id:"external_run_id" in r.content?r.content.external_run_id:undefined;
        if(key)store.db.prepare("INSERT INTO knowledge_keys VALUES (?,?,?,?)").run(id,r.kind,key,r.object_id);
      }
      for(const r of bundle.reviews)store.db.prepare("INSERT INTO knowledge_reviews VALUES (?,?,?,?,?,?)").run(r.object_id,r.version,r.decision,r.comment,r.actor,r.at);
      const markdown=new MarkdownKnowledge(store);
      for(const file of bundle.markdown_files){const path=markdown.locate(id,file.path);markdown.save(id,file.path,file.text,null);created.push(path);}
    })();
    return project;
  }catch(error){for(const path of created)rmSync(path,{force:true});throw error;}
}
