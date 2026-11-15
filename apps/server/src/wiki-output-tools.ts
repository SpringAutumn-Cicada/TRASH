import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {join,resolve,sep} from 'node:path';
import {lstatSync,realpathSync,writeFileSync} from 'node:fs';

/** Deterministic preparation runs only against the task's unpublished output. */
export async function prepareWikiOutput(directory:string,source:string){
 if(!/^source_[A-Za-z0-9_-]+$/.test(source))throw new Error('Invalid Wiki source');
 const output=realpathSync(join(directory,'output'));
 const root=join(output,'knowledge_base','papers',source);
 let current=output;
 for(const part of ['knowledge_base','papers',source]){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Unsafe Wiki output path');}
 if(!realpathSync(root).startsWith(output+sep))throw new Error('Wiki output escapes task');
 // Execute maintained code, never the model-writable staged copy.
 const tools=fileURLToPath(new URL('../../../.agents/skills/trash-literature-wiki/scripts/',import.meta.url));
 const reports:{script:string;milliseconds:number;output:string}[]=[];
 for(const script of ['build_evidence_index.py','wiki_context_manifest.py']){
  const started=Date.now();
  const args=['-B',resolve(tools,script),root,...(script==='wiki_context_manifest.py'?['--output',join(directory,'wiki-context-manifest.json')]:[])];
  try{
   const stdout=await new Promise<string>((accept,reject)=>execFile('python3',args,{cwd:directory,timeout:30000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout,stderr)=>error?reject(new Error(`${script}: ${stdout}\n${stderr}\n${error.message}`)):accept(stdout)));
   reports.push({script,milliseconds:Date.now()-started,output:stdout});
  }catch(error){reports.push({script,milliseconds:Date.now()-started,output:String(error)});throw error;}
  finally{writeFileSync(join(directory,'wiki-tools-report.json'),JSON.stringify({version:1,reports},null,2),{mode:0o600});}
 }
}
