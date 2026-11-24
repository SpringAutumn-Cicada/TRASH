/* eslint-disable no-control-regex -- Reject control characters in filesystem paths and interpreter names. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { CodeEnvironmentReport, HostEnvironmentComparison } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import type { RemoteConnection } from "./ssh.js";

// Fixed read-only probe. Never imports the project or installed ML frameworks.
const PROBE=String.raw`import sys,os,json,platform,shutil,subprocess,importlib.metadata as metadata,ast
packages={}
for index,dist in enumerate(metadata.distributions()):
 if index>=3000: break
 name=dist.metadata.get('Name','')
 if name: packages[name.lower().replace('_','-').replace('.','-')]=dist.version

def command(args):
 try:
  result=subprocess.run(args,capture_output=True,text=True,timeout=12,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
  return result.stdout[:16000].strip() if result.returncode==0 else ''
 except (OSError,subprocess.TimeoutExpired): return ''

def torch_cuda():
 try:
  file=metadata.distribution('torch').locate_file('torch/version.py')
  if file.stat().st_size>65536: return None
  tree=ast.parse(file.read_text())
  for item in tree.body:
   targets=item.targets if isinstance(item,ast.Assign) else [item.target] if isinstance(item,ast.AnnAssign) else []
   if any(isinstance(t,ast.Name) and t.id=='cuda' for t in targets) and isinstance(item.value,ast.Constant): return item.value.value
 except Exception: pass
 return None

tools={name:shutil.which(name) for name in ['git','tmux','bash','gcc','g++','make','cmake','ninja','nvcc','unzip','sha256sum','conda']}
gpu=command(['nvidia-smi','--query-gpu=index,name,memory.total,memory.free,driver_version','--format=csv,noheader,nounits'])
print(json.dumps({'platform':platform.system(),'system_release':platform.release(),'python':platform.python_version(),'python_executable':sys.executable,'packages':packages,'packages_truncated':index>=3000 if 'index' in locals() else False,'tools':tools,'gpu':gpu,'driver_cuda_support':command(['nvidia-smi']),'cuda_toolkit':command(['nvcc','--version']),'framework_cuda':{'torch':torch_cuda()},'disk_free':shutil.disk_usage('/').free,'probe_note':'只读检查；GPU 可见不证明显存足够，CUDA 兼容性待人工核对，未导入框架或执行项目。'}))`;
const normalize=(value:string)=>value.toLowerCase().replace(/[-_.]+/g,"-");
// Only inspect known interpreter locations; never scan datasets or run project code.
const DISCOVER=String.raw`count=0
for candidate in "$(command -v python3 2>/dev/null)" "$(command -v python 2>/dev/null)" "$CONDA_PREFIX/bin/python" "$HOME/miniconda3/bin/python" "$HOME/anaconda3/bin/python" /root/miniconda3/bin/python /opt/conda/bin/python "$HOME"/miniconda3/envs/*/bin/python "$HOME"/anaconda3/envs/*/bin/python /opt/conda/envs/*/bin/python /usr/bin/python3; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  count=$((count+1)); [ "$count" -le 16 ] || break
  if command -v timeout >/dev/null 2>&1; then
    timeout 3 "$candidate" -I -B -c 'import sys,json,os,importlib.metadata; assert sys.version_info >= (3,8); print("TRASH_PYTHON:"+json.dumps({"path":os.path.abspath(sys.executable),"version":".".join(map(str,sys.version_info[:3]))}))' 2>/dev/null
  else
    "$candidate" -I -B -c 'import sys,json,os,importlib.metadata; assert sys.version_info >= (3,8); print("TRASH_PYTHON:"+json.dumps({"path":os.path.abspath(sys.executable),"version":".".join(map(str,sys.version_info[:3]))}))' 2>/dev/null
  fi
done
true`;
export async function discoverPythonInterpreters(remote:RemoteConnection){
 let output:string;
 try{output=await remote.exec(["bash","-lc",DISCOVER],undefined,60000,128*1024);}
 catch(error){if(error instanceof Error&&error.message==="SSH_COMMAND_TIMEOUT")experimentError("ENVIRONMENT_PYTHON_DISCOVERY_TIMEOUT",422);experimentError("ENVIRONMENT_PYTHON_DISCOVERY_FAILED",422);}
 const interpreters:{path:string;version:string}[]=[];
 for(const line of output.split(/\r?\n/)){
  if(!line.startsWith("TRASH_PYTHON:"))continue;
  try{const value=z.object({path:z.string().min(1).max(4096).refine(path=>path.startsWith("/")&&!/[\x00-\x1f]/.test(path)),version:z.string().regex(/^\d+\.\d+\.\d+$/)}).strict().parse(JSON.parse(line.slice("TRASH_PYTHON:".length)));if(!interpreters.some(item=>item.path===value.path))interpreters.push(value);}catch{/* Ignore unrelated startup output or malformed candidates. */}
 }
 if(!interpreters.length)experimentError("ENVIRONMENT_PYTHON_NOT_FOUND",422);
 return {interpreters,recommended:interpreters[0].path};
}
export async function resolveRemotePython(remote:RemoteConnection,signal:AbortSignal):Promise<string>{
 signal.throwIfAborted();
 const {interpreters}=await discoverPythonInterpreters(remote);
 for(const {path} of interpreters){
  signal.throwIfAborted();
  try{
   const output=await remote.exec([path,"-I","-B","-c",
    "import fcntl, hashlib, json, pathlib, shutil, subprocess, sys, tempfile; assert sys.version_info >= (3, 8); print('TRASH_PYTHON_READY')"],
    undefined,5000,16384);
   signal.throwIfAborted();
   if(output.split(/\r?\n/).includes("TRASH_PYTHON_READY"))return path;
  }catch(error){
   // A candidate may only work with environment variables set by the login shell.
   if(!(error instanceof Error&&error.message.startsWith("REMOTE_COMMAND_FAILED:")))throw error;
  }
 }
 experimentError("GIT_SYNC_PYTHON_UNUSABLE",422);
}

export async function compareEnvironment(remote:RemoteConnection,report:CodeEnvironmentReport,profile:string,python:string):Promise<HostEnvironmentComparison>{
 if(!python||/[\x00-\x1f]/.test(python))experimentError("ENVIRONMENT_PYTHON_INVALID",400);
 let environment:Record<string,unknown>;
 try{environment=z.object({python:z.string(),python_executable:z.string(),packages:z.record(z.string()),tools:z.record(z.string().nullable()),gpu:z.string(),packages_truncated:z.boolean()}).passthrough().parse(JSON.parse(await remote.exec([python,"-I","-B","-c",PROBE],undefined,90000,2*1024*1024)));}
 catch{experimentError("ENVIRONMENT_HOST_PROBE_FAILED",422);}
 const packages=environment.packages as Record<string,string>,tools=environment.tools as Record<string,string|null>;
 const items:HostEnvironmentComparison["items"]=report.content.requirements.map(requirement=>{
  const {check}=requirement;let actual="未知",status:"satisfied"|"unsatisfied"|"unknown"="unknown",reason="需要人工确认";
  if(check.kind==="python")actual=String(environment.python);
  if(check.kind==="package")actual=Object.entries(packages).find(([name])=>normalize(name)===normalize(check.name))?.[1]??"未检测到";
  if(check.kind==="tool")actual=Object.hasOwn(tools,check.name)?tools[check.name]??"未检测到":"未支持的工具检查";
  if(check.kind==="gpu")actual=environment.gpu?String(environment.gpu):"未检测到";
  const supported=check.kind==="python"||check.kind==="package"||check.kind==="gpu"||check.kind==="tool"&&Object.hasOwn(tools,check.name);
  const complex=/[,|*~^]|\bor\b|\band\b/i.test(requirement.requirement)||(requirement.requirement.match(/[<>]=?|==|!=/g)?.length??0)>1;
  if(requirement.attribution!=="declared")reason="源码推断或未知条件，需要人工确认";
  else if(requirement.category==="cuda"||check.kind==="other"||!supported)reason="CUDA、系统兼容性或未支持的条件不自动判定";
  else if(complex||check.operator==="unknown")reason="复杂或未知约束未自动比较";
  else if(actual==="未检测到"){
   status=check.kind==="package"&&environment.packages_truncated?"unknown":"unsatisfied";reason=status==="unknown"?"依赖列表被截断":"未检测到要求的依赖、工具或 GPU";
  }else if(check.operator==="present"){status="satisfied";reason=check.kind==="gpu"?"仅确认 GPU 可见；型号、显存和驱动兼容性仍待确认":"检测到指定组件";}
  else if((check.kind==="python"||check.kind==="package")&&/^\d+(\.\d+)*$/.test(actual)&&/^\d+(\.\d+)*$/.test(check.version)){
   const a=actual.split('.').map(Number),b=check.version.split('.').map(Number);let comparison=0;
   for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]??0)!==(b[i]??0)){comparison=(a[i]??0)>(b[i]??0)?1:-1;break;}}
   if(check.operator==="eq"&&a.length!==b.length){reason="版本精度不同，需要确认是否要求完整版本一致";}
   else{status=(check.operator==="eq"?comparison===0:check.operator==="gte"?comparison>=0:comparison<=0)?"satisfied":"unsatisfied";reason="按简单数字版本约束比较";}
  }else reason="预发布、本地构建版本或复杂版本语义待人工确认";
  return {name:requirement.name,expected:requirement.requirement,actual,status,reason};
 });
 return {id:`comparison_${randomUUID()}`,report_id:report.id,project_id:report.project_id,reproduction_id:report.reproduction_id,profile_id:profile,created_at:new Date().toISOString(),python:String(environment.python_executable),environment,items};
}
