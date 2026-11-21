import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExperimentRun } from '@trash/protocol';
import { experimentError } from '@trash/storage';

const validId=(id:string)=>/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
function info(path:string){
  try{return lstatSync(path);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
function directories(path:string){
  return info(path)?.isDirectory()
    ? readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&validId(entry.name)).map(entry=>entry.name)
    : [];
}
export function experimentSchemes(root:string){
  const base=join(root,'experiments');
  return directories(base).flatMap(direction_id=>directories(join(base,direction_id))
    .filter(scheme_id=>info(join(base,direction_id,scheme_id,'README.md'))?.isFile())
    .map(scheme_id=>({direction_id,scheme_id})));
}
export function assertExperimentScheme(root:string,direction:string,scheme:string){
  if(!experimentSchemes(root).some(item=>item.direction_id===direction&&item.scheme_id===scheme))experimentError('SCHEME_NOT_FOUND',404);
}
function directory(path:string) {
  if(!info(path))mkdirSync(path);
  if(!info(path)?.isDirectory())experimentError('RUN_ARCHIVE_CONFLICT',409);
}
function writeOwned(path:string,data:unknown,runId:string){
  const file=info(path);
  if(file&&(!file.isFile()||JSON.parse(readFileSync(path,'utf8')).run_id!==runId))experimentError('RUN_ARCHIVE_CONFLICT',409);
  const temporary=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  try{renameSync(temporary,path);}
  finally{if(info(temporary))unlinkSync(temporary);}
}
export function saveRunArchive(root:string,run:ExperimentRun){
  const {direction_id,scheme_id}=run.plan.content;
  if(!direction_id||!scheme_id)return;
  assertExperimentScheme(root,direction_id,scheme_id);
  const relative=`experiments/${direction_id}/${scheme_id}/runs/${run.run_id}`;
  const base=join(root,'experiments',direction_id,scheme_id,'runs'),path=join(root,relative);
  directory(base);
  const owner=info(join(path,'run.json'));
  if(info(path)&&(!info(path)?.isDirectory()||(!owner&&readdirSync(path).length)))experimentError('RUN_ARCHIVE_CONFLICT',409);
  directory(path);
  const activity=`/api/v1/projects/${run.project_id}/experiment-runs/${run.run_id}`;
  writeOwned(join(path,'run.json'),{
    run_id:run.run_id,direction_id,scheme_id,plan_id:run.plan.plan_id,plan_version:run.plan.version,
    status:run.status,created_at:run.created_at,updated_at:run.updated_at,
    method_sha256:run.plan.method_sha256,
    method_snapshot_api:run.plan.method_sha256 && `/api/v1/projects/${run.project_id}/experiment-method-snapshots/${run.plan.method_sha256}`,
    code:run.plan.reproduction
      ? {reproduction_id:run.plan.reproduction.reproduction_id,snapshot_id:run.plan.reproduction.snapshot_id,sha256:run.plan.reproduction.sha256}
      : {repository_id:run.plan.repository.repository_id,commit:run.plan.content.commit_sha},
    result_id:run.result_id,retry_of:run.retry_of,preparation:run.preparation,
    run_api:activity,logs_api:activity+'/logs'
  },run.run_id);
  for(const folder of ['configs','results','figures','logs'])directory(join(path,folder));
  writeOwned(join(path,'configs','run-config.json'),{
    run_id:run.run_id,seed:run.plan.content.seed,command:run.plan.content.command,config:run.plan.content.config,
    datasets:run.plan.datasets.map(item=>({id:item.dataset_id,name:item.name,version:item.version,sha256:item.sha256}))
  },run.run_id);
  writeOwned(join(path,'results','index.json'),{
    run_id:run.run_id,result_id:run.result_id,artifacts:run.artifacts.map(item=>({
      name:item.path,sha256:item.sha256,downloaded:item.downloaded,
      uri:item.artifact_id?`/api/v1/projects/${run.project_id}/experiment-artifacts/${run.run_id}/${item.artifact_id}`:undefined
    }))
  },run.run_id);
  return relative;
}
