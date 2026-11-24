import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySourceAdaptation, restoreSourceAdaptation } from '../src/experiment/source-adaptation.js';
import { synchronizeRepairedSource } from '../src/experiment/remote-source-repair.js';
import { REPRO_ARCHIVE } from '../src/experiment/reproduction-archive.js';
import type { RemoteConnection } from '../src/experiment/ssh.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const temp=()=>mkdtempSync(join(tmpdir(),'trash-runtime-regression-'));
const localRemote={exec:async(args:string[],input?:string)=>execFileSync(args[0],args.slice(1),{input,encoding:'utf8',stdio:['pipe','pipe','pipe']})} as RemoteConnection;

test('source adaptation rejects ambiguous patches before mutation and supports guarded restore',()=>{
 const root=temp(),file=join(root,'load.py'),backup=join(root,'backup');
 try{const original='path="data"\npath="data"\n';writeFileSync(file,original);
 const patch={path:'load.py',sha256:hash(original),before:'path="data"',after:'path="bound"',reason:'path',evidence:[{path:'load.py',line_start:1,line_end:1}]};
 assert.throws(()=>applySourceAdaptation(root,backup,[patch],[{path:'load.py',sha256:hash(original),text:original}]),/AMBIGUOUS/);
 assert.equal(readFileSync(file,'utf8'),original);assert.equal(existsSync(join(backup,'changes.json')),false);
 applySourceAdaptation(root,backup,[{...patch,before:original,after:'path="bound"\n'}],[{path:'load.py',sha256:hash(original),text:original}]);
 assert.equal(readFileSync(file,'utf8'),'path="bound"\n');writeFileSync(file,'manual edit');assert.throws(()=>restoreSourceAdaptation(root,backup),/CODE_CHANGED/);
 writeFileSync(file,'path="bound"\n');restoreSourceAdaptation(root,backup);assert.equal(readFileSync(file,'utf8'),original);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('remote source synchronization backs up, resumes idempotently and rejects unrelated changes',async()=>{
 const root=temp();mkdirSync(join(root,'.venv','bin'),{recursive:true});
 // The controlled transport executes only the fixed Python program locally.
 const remote={exec:async(args:string[],input?:string)=>localRemote.exec(['python3',...args.slice(1)],input)} as RemoteConnection;
 const id='env_00000000-0000-4000-8000-000000000001';
 try{writeFileSync(join(root,'load.py'),'before');writeFileSync(join(root,'other.py'),'unchanged');
 const files=[{path:'wrapper/load.py',sha256:hash('after')},{path:'wrapper/other.py',sha256:hash('unchanged')}];
 const changes=[{path:'wrapper/load.py',original:'before',text:'after'}];
 const result=await synchronizeRepairedSource(remote,root,id,files,changes);assert.deepEqual(result.files,['wrapper/load.py']);
 assert.equal(readFileSync(join(root,'load.py'),'utf8'),'after');assert.equal(readFileSync(join(result.backup!,'wrapper/load.py.original'),'utf8'),'before');
 assert.deepEqual((await synchronizeRepairedSource(remote,root,id,files,changes)).files,[]);
 writeFileSync(join(root,'load.py'),'before');writeFileSync(join(root,'other.py'),'manual');
 await assert.rejects(synchronizeRepairedSource(remote,root,id,files,changes),/REMOTE_SOURCE_CHANGED/);assert.equal(readFileSync(join(root,'load.py'),'utf8'),'before');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('upload source projection equals analysis manifest while complete archive retains assets',()=>{
 const root=temp(),source=join(root,'code');mkdirSync(source);mkdirSync(join(source,'data'));
 try{writeFileSync(join(source,'train.py'),'print(1)');writeFileSync(join(source,'image.png'),'asset');writeFileSync(join(source,'data','raw.json'),'{}');
 const full=JSON.parse(execFileSync('python3',['-c',REPRO_ARCHIVE,'snapshot',source,join(root,'full.zip')],{encoding:'utf8'}));
 const analysis=JSON.parse(execFileSync('python3',['-c',REPRO_ARCHIVE,'analysis-snapshot',source,join(root,'analysis.zip')],{encoding:'utf8'}));
 assert.equal(full.files.length,3);assert.equal(analysis.files.length,1);assert.deepEqual(full.analysis_files,analysis.files);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('TAR validator handles compressed data and rejects traversal and links',()=>{
 const root=temp();
 const source=readFileSync('apps/server/src/experiment/dataset-upload.ts','utf8');
 const script=source.match(/const validateTar=String.raw`([\s\S]*?)`;/)![1];
 try{for(const kind of ['valid','traversal','link']){
 const path=join(root,kind+'.tar.gz');execFileSync('python3',['-c',`import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w:gz') as z:\n e=tarfile.TarInfo('../escape' if sys.argv[2]=='traversal' else 'data/train0.pkl')\n if sys.argv[2]=='link':\n  e.type=tarfile.SYMTYPE;e.linkname='/etc/passwd';z.addfile(e)\n else:\n  e.size=4;z.addfile(e,io.BytesIO(b'data'))`,path,kind]);
 if(kind==='valid'){const records=JSON.parse(execFileSync('python3',['-c',script,path],{encoding:'utf8'}));assert.deepEqual(records,[{path:'data/train0.pkl',sha256:hash('data')}]);}
 else assert.throws(()=>execFileSync('python3',['-c',script,path],{stdio:'pipe'}));
 }}finally{rmSync(root,{recursive:true,force:true});}
});

test('collector redacts bare and quoted credentials without corrupting model token expressions',()=>{
 const root=temp();try{const zip=join(root,'code.zip'),output=join(root,'input.json');execFileSync('python3',['-c',`import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('model.py','password=bare-secret\\napi_key="quoted-secret"\\ntoken_dim=64\\ntoken = torch.nn.Parameter(torch.zeros(1, 64))\\n')`,zip]);
 execFileSync('python3',['.agents/skills/trash_analyze_code_environment/scripts/collect_inputs.py',zip,output]);const packet=JSON.parse(readFileSync(output,'utf8'));const text=packet.files[0].text;
 assert.ok(!text.includes('bare-secret'));assert.ok(!text.includes('quoted-secret'));assert.ok(text.includes('token_dim=64'));assert.ok(text.includes('token = torch.nn.Parameter(torch.zeros(1, 64))'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('upload chunks survive service recreation and reject wrong offsets without losing bytes',async()=>{
 const { DatasetUploadSessions }=await import('../src/experiment/dataset-upload-sessions.js');
 const { Readable }=await import('node:stream');
 const root=temp();const service={store:{root},data:{profile:()=>({})}} as unknown as import('../src/experiment/service.js').ExperimentService;
 const id='00000000-0000-4000-8000-000000000001';
 const incoming=(text:string)=>Object.assign(Readable.from([Buffer.from(text)]),{headers:{'content-length':String(text.length)}}) as import('node:http').IncomingMessage;
 try{let sessions=new DatasetUploadSessions(service);sessions.create('project',{id,profile_id:'host',name:'trace',filename:'trace.tar.gz',size:6,extract:true,confirm:true});
 await sessions.chunk('project',id,0,incoming('abc'));assert.equal(sessions.get('project',id).offset,3);
 sessions=new DatasetUploadSessions(service);assert.equal(sessions.get('project',id).offset,3);assert.equal(sessions.get('project',id).extract,true);
 await assert.rejects(sessions.chunk('project',id,0,incoming('bad')),/UPLOAD_OFFSET_CONFLICT/);
 await sessions.chunk('project',id,3,incoming('def'));assert.equal(sessions.get('project',id).offset,6);
 assert.equal(readFileSync(join(root,'projects/project/dataset-upload-sessions',id,'file.part'),'utf8'),'abcdef');
 await sessions.cancel('project',id);assert.equal(sessions.get('project',id).status,'cancelled');assert.equal(sessions.busy('project'),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('dataset deletion refuses shared paths and interrupted upload ownership',async()=>{
 const { deleteDatasetFiles }=await import('../src/experiment/delete-dataset.js');let released=0;
 const dataset={dataset_id:'one',profile_id:'host',path:'/root/project/data/trace',transfer_status:'ready'};
 const records=[dataset,{...dataset,dataset_id:'two'}];
 const service={reproductions:{acquire:()=>()=>{released++;},list:()=>[]},data:{datasets:()=>records,runs:()=>[]},datasetUploads:{busy:()=>false},datasetUploadSessions:{busy:()=>false},deployments:{busyProject:()=>false},reproductionQueues:{list:()=>[]},workspaces:{get:()=>({root:'/root/project'})}} as unknown as import('../src/experiment/service.js').ExperimentService;
 await assert.rejects(deleteDatasetFiles(service,'project','one',dataset.path),/DATASET_PATH_SHARED/);
 dataset.transfer_status='interrupted';await assert.rejects(deleteDatasetFiles(service,'project','one',dataset.path),/DATASET_DELETE_UNSAFE/);assert.equal(released,2);
});

test('confusion matrix scores handle zero denominators and preferred metric direction',async()=>{
 const {calculateBinaryMetrics}=await import('@trash/protocol/browser');
 const result=calculateBinaryMetrics({tn:80,fp:20,fn:10,tp:90,negative_label:'normal',positive_label:'attack'});
 assert.equal(result.Precision,90/110);assert.equal(result.Recall,0.9);assert.equal(result.FPR,0.2);assert.equal(result['F1 score'],180/210);
 assert.equal(calculateBinaryMetrics({tn:0,fp:0,fn:0,tp:0,negative_label:'n',positive_label:'p'}).Precision,undefined);
});
