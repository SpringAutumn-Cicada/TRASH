import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { KnowledgeStore, experimentError, type TrashStore } from '@trash/storage';

const resultId=z.string().regex(/^knowledge_[A-Za-z0-9_-]+$/);
const citation=z.object({
  result_id:resultId,version:z.number().int().positive(),usage:z.string().trim().min(1).max(200)
});
const entry=citation.extend({id:z.string().uuid()});
const document=z.object({format_version:z.literal(1),entries:z.array(entry).max(200)});
type Citation=z.infer<typeof entry>;

export class ManuscriptEvidence {
  private knowledge:KnowledgeStore;
  constructor(store:TrashStore){this.knowledge=new KnowledgeStore(store.db);}
  private load(root:string,manuscriptPath:string){
    const file=join(root,manuscriptPath,'experiment-evidence.json');
    if(existsSync(file)&&!lstatSync(file).isFile())experimentError('FILES_SYMLINK',403);
    const bytes=existsSync(file)?readFileSync(file):null;
    if(bytes&&bytes.length>256*1024)experimentError('MANUSCRIPT_EVIDENCE_INVALID',422);
    const value=bytes?document.parse(JSON.parse(bytes.toString())):{format_version:1 as const,entries:[] as Citation[]};
    return {file,value,etag:bytes?createHash('sha256').update(bytes).digest('hex'):null};
  }
  private describe(result:NonNullable<ReturnType<KnowledgeStore['get']>>){
    const content=result.content;
    return {
      id:result.object_id,title:result.title,version:result.version,
      ...( 'external_run_id' in content?{run_id:content.external_run_id}:{} ),
      ...( 'dataset' in content?{dataset:content.dataset}:{} )
    };
  }
  versions(projectId:string,id:string){
    return {versions:this.knowledge.history(projectId,'experiment-result',resultId.parse(id)).map(result=>this.describe(result))};
  }
  read(projectId:string,root:string,paperPath:string){
    const {value,etag}=this.load(root,paperPath);
    return {etag,entries:value.entries.map(item=>{
      const result=this.knowledge.get(projectId,'experiment-result',item.result_id,item.version);
      return {...item,result:result?this.describe(result):null};
    }),results:this.knowledge.list(projectId,'experiment-result').map(result=>this.describe(result))};
  }
  update(projectId:string,root:string,paperPath:string,request:unknown){
    const expected=z.string().regex(/^[a-f0-9]{64}$/).nullable();
    const input=z.discriminatedUnion('action',[
      citation.extend({action:z.literal('add'),expected}).strict(),
      z.object({action:z.literal('remove'),entry_id:z.string().uuid(),expected}).strict()
    ]).parse(request);
    const {file,value,etag}=this.load(root,paperPath);
    if(etag!==input.expected)experimentError('VERSION_CONFLICT',409);
    if(input.action==='add'){
      const result=this.knowledge.get(projectId,'experiment-result',input.result_id,input.version);
      if(!result)experimentError('NOT_FOUND',404);
      if(value.entries.some(item=>item.result_id===input.result_id&&item.version===input.version&&item.usage===input.usage))return this.read(projectId,root,paperPath);
      if(value.entries.length>=200)experimentError('MANUSCRIPT_EVIDENCE_LIMIT',422);
      value.entries.push({id:randomUUID(),result_id:input.result_id,version:input.version,usage:input.usage});
    }else value.entries=value.entries.filter(item=>item.id!==input.entry_id);
    const temporary=file+'.'+randomUUID()+'.tmp';
    writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    try{renameSync(temporary,file);}
    finally{if(existsSync(temporary))unlinkSync(temporary);}
    return this.read(projectId,root,paperPath);
  }
}
