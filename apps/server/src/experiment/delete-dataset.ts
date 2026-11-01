import { posix } from 'node:path';
import { experimentError } from '@trash/storage';
import type { ExperimentService } from './service.js';
export async function deleteDatasetFiles(service:ExperimentService,project:string,id:string,expectedPath:string){
 const release=service.reproductions.acquire(project);
 try{
 const dataset=service.data.datasets(project).find(item=>item.dataset_id===id)??experimentError('DATASET_NOT_FOUND',404);
 if(dataset.path!==expectedPath)experimentError('DATASET_PATH_CHANGED',409);
 if(service.datasetUploads.busy(project)||service.datasetUploadSessions.busy(project)||service.deployments.busyProject(project))experimentError('DATASET_BUSY',409);
 if(service.data.runs(project).some(run=>service.data.active(run)&&run.plan.datasets.some(item=>item.dataset_id===id)))experimentError('EXPERIMENT_ACTIVE',409);
 if(service.reproductionQueues.list(project).some(queue=>['running','paused'].includes(queue.status)&&queue.items.some(item=>service.data.plan(project,item.plan_id,item.version).content.dataset_ids.includes(id))))experimentError('EXPERIMENT_ACTIVE',409);
 // Failed imports may point to directories which existed before the upload; never treat those as owned.
 if(dataset.transfer_status&&dataset.transfer_status!=='ready')experimentError('DATASET_DELETE_UNSAFE',409);
 const target=posix.normalize(dataset.path),workspace=service.workspaces.get(project,dataset.profile_id);
 if(!dataset.path.startsWith('/')||dataset.path.split('/').includes('..')||/[\x00-\x1f]/.test(dataset.path)||target.split('/').filter(Boolean).length<3)experimentError('DATASET_DELETE_UNSAFE',409);
 if(!workspace||!target.startsWith(posix.join(workspace.root,'datasets')+'/'))experimentError('DATASET_DELETE_UNSAFE',409);
 const protectedPaths=['/','/root','/home','/tmp','/var','/usr','/etc','/opt','/mnt','/root/autodl-tmp',...(workspace?[workspace.root,...['datasets','reproductions','experiments','outputs'].map(name=>posix.join(workspace.root,name))]:[])];
 if(protectedPaths.some(path=>path===target||path.startsWith(target+'/')))experimentError('DATASET_DELETE_UNSAFE',409);
 const related=service.data.datasets(project).filter(item=>item.dataset_id!==id&&item.profile_id===dataset.profile_id);
 if(related.some(item=>{const path=posix.normalize(item.path);return path===target||path.startsWith(target+'/')||target.startsWith(path+'/');}))experimentError('DATASET_PATH_SHARED',409);
 if(service.reproductions.list(project).some(code=>code.uploads?.some(upload=>upload.profile_id===dataset.profile_id&&(upload.path===target||upload.path.startsWith(target+'/')||target.startsWith(upload.path+'/')))))experimentError('DATASET_DELETE_UNSAFE',409);
 const remote=service.terminals.connection(project,dataset.profile_id),sftp=await remote.sftp();let missing=false;
 try{let path='';const parts=target.split('/').filter(Boolean);for(let index=0;index<parts.length;index++){path+='/'+parts[index];const info=await new Promise<import('ssh2').Stats|undefined>((resolve,reject)=>sftp.lstat(path,(error,value)=>{if(!error)resolve(value);else if(Number((error as Error&{code?:number}).code)===2)resolve(undefined);else reject(error);}));if(!info){missing=true;break;}if(info.isSymbolicLink()||(index<parts.length-1&&!info.isDirectory()))experimentError('DATASET_DELETE_UNSAFE',409);}}
 finally{sftp.end();}
 if(!missing)await remote.exec(['rm','-rf','--one-file-system','--',target],undefined,1800000);
 // Remove registration only after remote deletion succeeded (or the path was already absent).
 service.store.db.prepare('DELETE FROM experiment_datasets WHERE project_id=? AND dataset_id=?').run(project,id);
 return {deleted:true,files_deleted:!missing,path:target};
 }finally{release();}
}
