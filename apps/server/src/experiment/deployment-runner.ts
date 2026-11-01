// Fixed remote executor: subprocess groups are owned by this invocation; no shell commands.
export const DEPLOYMENT_RUNNER=String.raw`import sys,json,pathlib,subprocess,os,hashlib,time,signal,fcntl
p=json.load(sys.stdin)
job=pathlib.Path(p['job'])
action=p.get('action','run')
if action!='run':
 if not job.is_dir() or job.is_symlink():
  print(json.dumps({'pending':True}));sys.exit(0)
 identity=json.loads((job/'identity.json').read_text())
 assert identity['id']==p['id'],'部署身份不匹配'
 if action=='cancel':
  (job/'cancel').touch();print(json.dumps({'requested':True}));sys.exit(0)
 state=json.loads((job/'status.json').read_text())
 log=job/'install.log'
 if log.exists():
  with log.open('rb') as stream:
   stream.seek(max(0,log.stat().st_size-10000));state['log_tail']=stream.read(10000).decode('utf8',errors='replace')
 print(json.dumps(state));sys.exit(0)
job.mkdir(mode=0o700)
(job/'identity.json').write_text(json.dumps({'id':p['id']}))
state={'status':'installing','stage':'preflight','completed_units':0,'total_units':len(p['plan']['installs'])+3,'current':'核对 Python 与代码','resumed':False,'heartbeat':time.time()}
def atomic(path,value):
 temporary=path.with_name(path.name+'.tmp');temporary.write_text(json.dumps(value));temporary.replace(path)
def update(**values):
 state.update(values);state['heartbeat']=time.time();atomic(job/'status.json',state)
def cancelled():
 if (job/'cancel').exists(): raise InterruptedError('用户已取消部署；保留已完成依赖以便继续')
def stop(child):
 try: os.killpg(child.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: child.wait(timeout=8)
 except subprocess.TimeoutExpired:
  try: os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  child.wait()
def command(args,timeout=900):
 cancelled();start=time.monotonic()
 with (job/'install.log').open('ab') as log:
  child=subprocess.Popen(args,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   while child.poll() is None:
    cancelled()
    if time.monotonic()-start>timeout: raise TimeoutError('当前安装步骤超时，已停止本步骤，可继续部署')
    if time.monotonic()-started>1800: raise TimeoutError('部署超过三十分钟，已停止，可继续部署')
    if (job/'install.log').stat().st_size>2*1024*1024:
     log.truncate(0)
    update();time.sleep(0.5)
   cancelled()
   if child.returncode: raise RuntimeError('安装/检查命令退出码 '+str(child.returncode)+'；请查看安装日志')
  except BaseException:
   if child.poll() is None: stop(child)
   raise
update()
started=time.monotonic()
lock=None
try:
 root=pathlib.Path(p['directory']).resolve(strict=True)
 assert root.is_dir(),'部署目录不存在'
 expected=tuple(map(int,p['plan']['python_version'].split('.')))
 assert sys.version_info[:len(expected)]==expected,'Python 版本与报告要求不一致'
 env={k:v for k,v in os.environ.items() if not k.startswith('PIP_') and k not in ('PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','CONDA_PREFIX')}
 env.update({'PIP_CONFIG_FILE':os.devnull,'PIP_REQUIRE_VIRTUALENV':'true','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'})
 paths=[pathlib.PurePosixPath(item['path']) for item in p['files']]
 wrapper=paths[0].parts[0] if paths and all(len(path.parts)>1 and path.parts[0]==paths[0].parts[0] for path in paths) else None
 strip=bool(wrapper) and not all((root/path).is_file() for path in paths)
 for item in p['files']:
  cancelled();relative=pathlib.PurePosixPath(item['path'])
  if strip: relative=pathlib.PurePosixPath(*relative.parts[1:])
  file=(root/relative).resolve(strict=True)
  assert root in file.parents and file.is_file(),'快照路径无效'
  assert hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256'],'代码已变化，请重新分析上传'
 cancelled()
 lockpath=root/'.trash-venv.lock'
 assert not lockpath.is_symlink(),'锁文件不能是符号链接'
 lock=lockpath.open('a')
 try: fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: raise RuntimeError('此目录仍有部署进程，不能同时继续部署')
 checkpoint=root/'.trash-venv-checkpoint.json';target=root/'.venv'
 assert not checkpoint.is_symlink() and not target.is_symlink(),'环境路径不能是符号链接'
 owner=hashlib.sha256(json.dumps({'fingerprint':p['fingerprint'],'plan':p['plan'],'python':str(pathlib.Path(sys.executable).absolute())},sort_keys=True).encode()).hexdigest()
 saved=json.loads(checkpoint.read_text()) if checkpoint.exists() else None
 if saved: assert saved.get('owner')==owner,'已有环境属于另一份代码/安装计划/解释器，不能自动覆盖'
 else:
  assert not target.exists(),'.venv 并非当前部署创建，不自动接管已有环境'
  saved={'owner':owner,'environment_ready':False,'completed_groups':0};atomic(checkpoint,saved)
 state['resumed']=bool(saved.get('environment_ready') or target.exists())
 update(stage='venv',completed_units=1,current='恢复隔离环境' if state['resumed'] else '创建隔离环境')
 if not saved.get('environment_ready'):
  command([sys.executable,'-I','-m','venv',str(target)],180)
  saved['environment_ready']=True;atomic(checkpoint,saved)
 python=str(target/'bin'/'python')
 assert (target/'pyvenv.cfg').is_file() and pathlib.Path(python).is_file(),'环境不完整，不能继续'
 actual_prefix=subprocess.check_output([python,'-I','-c','import sys;print(sys.prefix)'],cwd=root,env=env,timeout=30).decode().strip()
 assert pathlib.Path(actual_prefix).resolve()==target.resolve(),'解释器未隔离到目标 venv，停止安装'
 def inventory():
  output=subprocess.check_output([python,'-I','-m','pip','freeze','--all'],cwd=root,env=env,timeout=30)
  return hashlib.sha256(output).hexdigest()
 if saved.get('completed_groups') and saved.get('inventory')!=inventory():
  saved['completed_groups']=0;atomic(checkpoint,saved)
 for index,group in enumerate(p['plan']['installs']):
  if index<saved.get('completed_groups',0):continue
  update(stage='packages',completed_units=index+2,current='安装 '+', '.join(group['packages'])[:500],group_index=index+1)
  args=[python,'-I','-m','pip','--isolated','install','--disable-pip-version-check']
  if group['index_url']:args+=['--index-url',group['index_url']]
  command(args+group['packages'])
  saved['completed_groups']=index+1;saved['inventory']=inventory();atomic(checkpoint,saved)
  update(completed_units=index+3)
 update(stage='checking',completed_units=state['total_units']-1,current='检查依赖一致性')
 command([python,'-I','-m','pip','check'],60)
 saved['inventory']=inventory();atomic(checkpoint,saved)
 update(status='completed',stage='completed',completed_units=state['total_units'],current='依赖安装及 pip check 已完成，尚未执行论文实验',venv=str(target))
except InterruptedError as error: update(status='cancelled',current=str(error))
except BaseException as error: update(status='failed',current=str(error))
finally:
 if lock:lock.close()
print(json.dumps(state))`;
