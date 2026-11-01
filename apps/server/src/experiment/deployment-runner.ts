// Fixed remote executor: subprocess groups are owned by this invocation; no shell commands.
export const DEPLOYMENT_RUNNER=String.raw`import sys,json,pathlib,subprocess,os,hashlib,time,signal,fcntl,pty,termios,struct,re,codecs
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
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
def amount(number,unit):
 unit=unit.lower();power={'b':0,'kb':1,'kib':1,'mb':2,'mib':2,'gb':3,'gib':3,'tb':4,'tib':4}.get(unit,0)
 return int(float(number)*(1024 if 'i' in unit else 1000)**power)
def parse_package_line(text):
 text=ansi.sub('',text).strip()
 if not text:return
 info=state.setdefault('package_progress',{'phase':'resolving'})
 if text.startswith(('Collecting ','Processing ')):
  info={'phase':'resolving','package':text.split(' ',1)[1][:300]};state['package_progress']=info
 elif 'Downloading ' in text or 'Using cached ' in text:
  cached='Using cached ' in text;value=text.split('Using cached ' if cached else 'Downloading ',1)[1]
  filename=value.split(' ',1)[0].rsplit('/',1)[-1].split('?',1)[0]
  info={'phase':'cached' if cached else 'downloading','package':info.get('package',''),'filename':filename[:400]};state['package_progress']=info
  total=re.search(r'\((\d+(?:\.\d+)?)\s*([kMGT]?i?B)\)',text,re.I)
  if total:info['total_bytes']=amount(total[1],total[2])
 elif text.startswith('ERROR:'):
  info={'phase':'failed','detail':text[:1000]};state['package_progress']=info
 elif text.startswith('Installing collected packages:'):info={'phase':'installing'};state['package_progress']=info
 elif 'Building wheel for ' in text:info={'phase':'building','package':text.split('Building wheel for ',1)[1].split(' ',1)[0][:300]};state['package_progress']=info
 elif 'Preparing metadata' in text or 'Installing build dependencies' in text:info={'phase':'building'};state['package_progress']=info
 elif text.startswith('Successfully installed '):info={'phase':'installed'};state['package_progress']=info
 elif text.startswith('Requirement already satisfied:'):info={'phase':'satisfied','package':text.split(':',1)[1].strip().split(' ',1)[0][:300]};state['package_progress']=info
 progress=re.search(r'(\d+(?:\.\d+)?)\s*([kMGT]?i?B)?\s*/\s*(\d+(?:\.\d+)?)\s*([kMGT]?i?B)\b',text,re.I)
 if progress:
  info['phase']='downloading';info['downloaded_bytes']=amount(progress[1],progress[2] or progress[4]);info['total_bytes']=amount(progress[3],progress[4]);info['approximate']=True
  speed=re.search(r'(\d+(?:\.\d+)?)\s*([kMGT]?i?B)/s',text,re.I)
  if speed:info['speed_bytes_per_second']=amount(speed[1],speed[2])
  eta=re.search(r'eta\s+(\d+):(\d+):(\d+)',text,re.I)
  if eta:info['eta_seconds']=int(eta[1])*3600+int(eta[2])*60+int(eta[3])
 info['updated_at']=time.time();info['detail']=text[:1000]
def package_line(text):
 try:parse_package_line(text)
 except (ValueError,OverflowError,KeyError):pass
def command(args,timeout=900,track=False):
 cancelled();start=time.monotonic();master,slave=pty.openpty();child=None
 try:
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,200,0,0))
  child=subprocess.Popen(args,cwd=root,env={**env,'PYTHONUNBUFFERED':'1','TERM':'xterm','COLUMNS':'200'},stdout=slave,stderr=slave,start_new_session=True)
 except BaseException:
  os.close(master);raise
 finally:os.close(slave)
 decoder=codecs.getincrementaldecoder('utf8')(errors='replace');pending='';finished=None;last_update=0
 try:
  os.set_blocking(master,False)
  with (job/'install.log').open('ab') as log:
   while True:
    cancelled();now=time.monotonic()
    if now-start>timeout:raise TimeoutError('当前安装步骤超时，已停止本步骤，可继续部署')
    if now-started>1800:raise TimeoutError('部署超过三十分钟，已停止，可继续部署')
    try:data=os.read(master,65536)
    except BlockingIOError:data=None
    except OSError:data=b''
    if data:
     text=ansi.sub('',decoder.decode(data));log.write(text.encode('utf8'));log.flush()
     if track:
      pending+=text;lines=re.split(r'[\r\n]',pending);pending=lines.pop()[-4000:]
      for line in lines:package_line(line)
    if now-last_update>=0.5:
     if track and pending:package_line(pending)
     update();last_update=now
    if (job/'install.log').stat().st_size>2*1024*1024:log.seek(0);log.truncate(0)
    if child.poll() is not None:
     if finished is None:finished=now
     if data==b'' or now-finished>2:break
    if not data:time.sleep(0.05)
   if track and pending:package_line(pending)
   cancelled()
   if child.returncode:raise RuntimeError('安装/检查命令退出码 '+str(child.returncode)+'；请查看安装日志')
   update()
 except BaseException:
  if child and child.poll() is None:stop(child)
  raise
 finally:os.close(master)

update()
started=time.monotonic()
lock=None
try:
 root=pathlib.Path(p['directory']).resolve(strict=True)
 assert root.is_dir(),'部署目录不存在'
 update(current='使用远端 Python '+sys.version.split()[0]+' · '+sys.executable+'；报告版本仅供参考')
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
 if saved:
  if saved.get('owner')!=owner:
   previous_owners=[hashlib.sha256(json.dumps({'fingerprint':p['fingerprint'],'plan':previous,'python':str(pathlib.Path(sys.executable).absolute())},sort_keys=True).encode()).hexdigest() for previous in p.get('previous_plans',[])]
   assert saved.get('owner') in previous_owners,'已有环境属于另一份代码/安装计划/解释器，不能自动覆盖'
   backup=root/('.trash-venv-checkpoint-before-repair-'+p['id']+'-'+str(time.time_ns())+'.json')
   atomic(backup,saved);saved={**saved,'owner':owner,'completed_groups':0};atomic(checkpoint,saved)
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
 constraints=[]
 for install in p['plan']['installs']:
  for spec in install['packages']:
   match=re.match(r'^([A-Za-z0-9_.-]+)(?:\[[^]]+\])?(.*)$',spec)
   if match and re.search(r'[<>=!~]',match[2]):constraints.append(match[1]+match[2])
 constraints_file=job/'constraints.txt'
 if constraints:constraints_file.write_text('\n'.join(sorted(set(constraints)))+'\n')
 installed_probe="""import sys,json,importlib.metadata as metadata
try:
 from pip._vendor.packaging.requirements import Requirement
except ImportError:
 try:from packaging.requirements import Requirement
 except ImportError:Requirement=None
result={'satisfied':[],'pending':[]}
for spec in json.load(sys.stdin):
 try:
  if Requirement is None:raise ValueError('no requirement parser')
  requirement=Requirement(spec)
  if requirement.url or requirement.extras:raise ValueError('requires pip resolution')
  if requirement.marker and not requirement.marker.evaluate():
   result['satisfied'].append({'spec':spec,'version':'当前环境不适用'});continue
  version=metadata.version(requirement.name)
  if requirement.specifier and not requirement.specifier.contains(version,prereleases=True):raise ValueError('version mismatch')
  result['satisfied'].append({'spec':spec,'version':version})
 except Exception:result['pending'].append(spec)
print(json.dumps(result))"""
 for index,group in enumerate(p['plan']['installs']):
  if index<saved.get('completed_groups',0):continue
  update(stage='packages',completed_units=index+2,current='安装 '+', '.join(group['packages'])[:500],group_index=index+1)
  probe=json.loads(subprocess.check_output([python,'-I','-c',installed_probe],input=json.dumps(group['packages']).encode(),cwd=root,env=env,timeout=30))
  cancelled();pending=probe['pending'];satisfied=probe['satisfied']
  if satisfied:
   detail='跳过已满足依赖：'+', '.join(item['spec']+'（'+item['version']+'）' for item in satisfied)
   state['package_progress']={'phase':'satisfied','detail':detail[:1000],'updated_at':time.time()}
   with (job/'install.log').open('ab') as log:log.write((detail+'\n').encode('utf8'))
   update(current=detail[:500])
  if pending:state['package_progress']={'phase':'resolving','detail':'仅安装尚未满足的依赖；已满足 '+str(len(satisfied))+' 项','updated_at':time.time()}
  args=[python,'-I','-m','pip','--isolated','install','--disable-pip-version-check','--progress-bar','on']
  if constraints:args+=['--constraint',str(constraints_file)]
  if group['index_url']:args+=['--index-url',group['index_url']]
  for address in group.get('extra_index_urls',[]):args+=['--extra-index-url',address]
  for address in group.get('find_links',[]):args+=['--find-links',address]
  if pending:
   update(current='安装尚未满足的依赖：'+', '.join(pending)[:450])
   command(args+pending,track=True)
   state['package_progress']={'phase':'installed','detail':'当前安装组已完成；跳过已满足依赖 '+str(len(satisfied))+' 项','updated_at':time.time()}
  saved['completed_groups']=index+1;saved['inventory']=inventory();atomic(checkpoint,saved)
  update(completed_units=index+3)
 update(stage='checking',completed_units=state['total_units']-1,current='检查依赖一致性')
 command([python,'-I','-m','pip','check'],60)
 saved['inventory']=inventory();atomic(checkpoint,saved)
 update(status='completed',stage='completed',completed_units=state['total_units'],current='依赖安装及 pip check 已完成，尚未执行论文实验',venv=str(target))
except InterruptedError as error: update(status='cancelled',current=str(error))
except BaseException as error:
 info=state.get('package_progress',{})
 if info.get('phase')!='failed':state['package_progress']={'phase':'failed','detail':str(error)[:1000],'updated_at':time.time()}
 update(status='failed',current=str(error)+'（Python '+sys.version.split()[0]+' · '+sys.executable+'）')
finally:
 if lock:lock.close()
print(json.dumps(state))`;
