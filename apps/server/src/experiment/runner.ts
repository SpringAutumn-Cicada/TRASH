// Uploaded as a versioned source file. No Python or remote command is executed during development.
export const RUNNER_VERSION = "4";
export const REMOTE_RUNNER = String.raw`import sys, os, json, time, hashlib, subprocess, signal, threading, pathlib, fcntl, shlex, platform
ROOT = pathlib.Path(sys.argv[2]).resolve()
ACTION = sys.argv[1]
M = json.loads((ROOT / 'manifest.json').read_text())
TOKEN = M['token']

def atomic(name, value):
    target = ROOT / name
    temporary = target.with_suffix(target.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False))
    os.replace(temporary, target)

def status(state, **extra):
    value = dict(run_id=M['run_id'], token=TOKEN, state=state, at=time.time(), **extra)
    atomic('status.json', value)
    return value

def safe_path(name):
    path = (ROOT / name).resolve()
    if not path.is_relative_to(ROOT) or path == ROOT:
        raise RuntimeError('ARTIFACT_PATH_INVALID')
    return path

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        while True:
            block = source.read(1024*1024)
            if not block: break
            h.update(block)
    return h.hexdigest()

def normalized_collection():
    spec=M.get('result_collection')
    if not spec: return
    target=ROOT/'outputs/trash-collected-metrics.json'
    # A failed re-collection must not leave an earlier normalized file in use.
    try:
        if target.exists(): target.unlink()
        if spec['mode']=='none':
            atomic('collection.json',dict(state='unavailable',reason=spec['notes']));return
        base=pathlib.Path(M['deployed_directory']).resolve() if spec['root']=='code' else ROOT
        source=(base/spec['path']).resolve()
        if not source.is_relative_to(base) or source==base or not source.is_file(): raise RuntimeError('METRICS_SOURCE_MISSING')
        if spec['root']=='code':
            baseline=json.loads((ROOT/'source-baseline.json').read_text())
            if baseline.get('mtime_ns')==source.stat().st_mtime_ns: raise RuntimeError('METRICS_SOURCE_UNCHANGED')
        if source.stat().st_size>20*1024*1024 and spec['mode']!='log': raise RuntimeError('METRICS_SOURCE_TOO_LARGE')
        with source.open('rb') as stream:
            if spec['mode']=='log':
                previous=baseline.get('size',0) if spec['root']=='code' else 0
                start=previous if source.stat().st_size>previous else 0
                stream.seek(max(start,source.stat().st_size-2*1024*1024,0))
            raw=stream.read(20*1024*1024)
        text=raw.decode('utf-8-sig',errors='replace' if spec['mode']=='log' else 'strict'); payload={}; values=[]
        if spec['mode']=='json': payload=json.loads(text)
        elif spec['mode']=='csv':
            import csv,io
            rows=list(csv.DictReader(io.StringIO(text)))
            if not rows: raise RuntimeError('METRICS_CSV_EMPTY')
        for metric in spec['metrics']:
            condition=''
            if spec['mode']=='log':
                import re
                matches=[]
                for line in text.splitlines():
                    at=line.find(metric['label'])
                    if at<0: continue
                    match=re.match(r'\s*([-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)',line[at+len(metric['label']):])
                    if match: matches.append(float(match.group(1)))
                if not matches: raise RuntimeError('METRIC_LABEL_MISSING: '+metric['name'])
                value=matches[-1]
            elif metric['key']:
                value=rows[-1] if spec['mode']=='csv' else payload
                keys=[metric['key']] if spec['mode']=='csv' else metric['key'].split('.')
                for key in keys: value=value[int(key)] if isinstance(value,list) else value[key]
            else:
                candidates=rows if spec['mode']=='csv' else payload.get('metrics',[])
                found=[item for item in candidates if item.get('name')==metric['name']]
                if len(found)!=1: raise RuntimeError('METRIC_MISSING_OR_AMBIGUOUS: '+metric['name'])
                if metric['scale']==1 and found[0].get('unit','')!=metric['unit']: raise RuntimeError('METRIC_UNIT_MISMATCH: '+metric['name'])
                value=found[0]['value'];condition=found[0].get('condition','')
            import math
            if isinstance(value,bool): raise RuntimeError('METRIC_NOT_NUMERIC')
            value=float(value)*metric['scale']
            if not math.isfinite(value): raise RuntimeError('METRIC_NOT_FINITE')
            values.append(dict(name=metric['name'],value=value,unit=metric['unit'],condition=condition))
        if not values and not (spec['mode']=='json' and isinstance(payload,dict) and payload.get('confusion_matrix')): raise RuntimeError('METRICS_EMPTY')
        result=dict(metrics=values)
        if spec['mode']=='json' and isinstance(payload,dict):
            for name in ['confusion_matrix','evaluation']:
                if name in payload: result[name]=payload[name]
        atomic('outputs/trash-collected-metrics.json',result)
        (ROOT/'outputs/source-metrics.txt').write_bytes(raw)
        atomic('collection.json',dict(state='collected',source_root=spec['root'],source_path=spec['path'],mode=spec['mode'],rules=spec['metrics']))
    except Exception as error:
        atomic('collection.json',dict(state='failed',reason=str(error)))

def collect():
    normalized_collection()
    if not M.get('result_collection') and M['metrics_path'].lower().endswith('.csv'):
        import csv
        source=safe_path(M['metrics_path'])
        if source.is_file() and source.stat().st_size<=20*1024*1024:
            with source.open(newline='',encoding='utf-8-sig') as file:
                rows=list(csv.DictReader(file))
            if len(rows)<=1000:
                try: atomic('outputs/collected-metrics.json',{'metrics':[{'name':row['name'],'value':float(row['value']),'unit':row.get('unit',''),'condition':row.get('condition','')} for row in rows]})
                except (KeyError,ValueError): pass
    names = ['collection.json','source-baseline.json','execution-progress.json','outputs/source-metrics.txt','outputs/trash-collected-metrics.json','outputs/collected-metrics.json','data-mappings.json', 'manifest.json', 'environment.json', 'status.json', 'config.json', 'logs/stdout.log', 'logs/stdout.log.1', 'logs/stderr.log', 'logs/stderr.log.1', M['metrics_path']] + M['artifact_paths']
    items = []
    for name in dict.fromkeys(names):
        try:
            path = safe_path(name)
            if path.is_file():
                info = path.stat()
                items.append(dict(path=name, size_bytes=info.st_size, sha256=digest(path)))
        except (OSError, RuntimeError):
            continue
    atomic('artifacts.json', items)

if ACTION == 'cancel':
    if len(sys.argv) < 4 or sys.argv[3] != TOKEN: raise RuntimeError('TOKEN_MISMATCH')
    atomic('cancel.json', dict(token=TOKEN))
    print(json.dumps(dict(requested=True)))
    sys.exit(0)
if ACTION == 'collect':
    collect()
    print((ROOT / 'artifacts.json').read_text())
    sys.exit(0)
if ACTION == 'launch':
    # A launch is idempotent even if the SSH response disappears.
    lock = (ROOT / 'launch.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    session = 'trash-' + M['run_id']
    if (ROOT / 'status.json').exists() or subprocess.run(['tmux','has-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
        print(json.dumps(dict(existing=True)))
    else:
        command = shlex.join([M['python'], str(ROOT / 'runner' / 'runner.py'), 'run', str(ROOT)])
        subprocess.run(['tmux','new-session','-d','-s',session,command],check=True)
        print(json.dumps(dict(started=True)))
    sys.exit(0)
if ACTION != 'run': raise RuntimeError('ACTION_INVALID')

run_lock = (ROOT / 'supervisor.lock').open('a')
try: fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
if (ROOT / 'status.json').exists():
    old = json.loads((ROOT / 'status.json').read_text())
    if old.get('state') in ['completed','failed','cancelled']: sys.exit(0)
(ROOT / 'logs').mkdir(exist_ok=True)
(ROOT / 'outputs').mkdir(exist_ok=True)
status('waiting', runner_version='4')
host_lock = pathlib.Path('/tmp/trash-experiment-' + str(os.getuid()) + '.lock').open('a')
while True:
    try:
        fcntl.flock(host_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if (ROOT / 'cancel.json').exists():
            status('cancelled', exit_code=None)
            sys.exit(0)
        status('waiting', runner_version='4')
        time.sleep(2)
process = None
links=[]
try:
    if digest(ROOT / 'code.bundle') != M['bundle_sha256']: raise RuntimeError('BUNDLE_HASH_MISMATCH')
    code = ROOT / 'code'
    if M.get('deployed_directory'):
        code=pathlib.Path(M['deployed_directory']).resolve()
        if not code.is_dir(): raise RuntimeError('DEPLOYED_DIRECTORY_MISSING')
        files=M['code_snapshot']['files']
        prefix=''
        if files and not all((code/item['path']).is_file() for item in files):
            first=files[0]['path'].split('/')[0]
            if all(item['path'].startswith(first+'/') for item in files): prefix=first+'/'
        for item in files:
            candidate=(code/item['path'][len(prefix):]).resolve()
            if not candidate.is_relative_to(code) or not candidate.is_file() or digest(candidate)!=item['sha256']: raise RuntimeError('DEPLOYED_CODE_HASH_MISMATCH')
        head=None
        for mapping in M.get('data_mappings',[]):
            dataset=next(d for d in M['datasets'] if d['dataset_id']==mapping['dataset_id'])
            base=pathlib.Path(dataset['path']).resolve()
            target=(base/M.get('dataset_subdirectory','')/mapping.get('subpath','')).resolve()
            if not target.is_relative_to(base): raise RuntimeError('DATASET_PATH_INVALID')
            if not target.exists(): raise RuntimeError('DATASET_NOT_FOUND')
            link=code/mapping['path']
            if not link.parent.resolve().is_relative_to(code) or not link.parent.is_dir(): raise RuntimeError('MAPPING_PARENT_INVALID')
            if link.is_symlink() and link.resolve()==target: continue
            if link.exists() or link.is_symlink(): raise RuntimeError('DATA_MAPPING_CONFLICT')
            link.symlink_to(target,target_is_directory=target.is_dir());links.append((link,target))
        atomic('data-mappings.json',M.get('data_mappings',[]))
    elif M.get('code_source') == 'reproduction':
        import zipfile,stat
        if code.exists(): raise RuntimeError('CODE_DIRECTORY_EXISTS')
        with zipfile.ZipFile(ROOT / 'code.bundle') as z:
            entries=z.infolist()
            if len(entries)>20000 or sum(i.file_size for i in entries)>200*1024*1024: raise RuntimeError('ARCHIVE_LIMIT')
            for i in entries:
                p=pathlib.PurePosixPath(i.filename)
                kind=stat.S_IFMT(i.external_attr>>16)
                if p.is_absolute() or '..' in p.parts or chr(92) in i.filename or kind not in (0,stat.S_IFREG,stat.S_IFDIR): raise RuntimeError('UNSAFE_ARCHIVE_PATH')
            z.extractall(code)
            for i in entries:
                if not i.is_dir(): os.chmod(code / i.filename,0o700 if i.external_attr>>16&0o111 else 0o600)
        for item in M['code_snapshot']['files']:
            if digest(code / item['path']) != item['sha256']: raise RuntimeError('SNAPSHOT_FILE_HASH_MISMATCH')
        head = None
    else:
        if not code.exists(): subprocess.run(['git','clone',str(ROOT / 'code.bundle'),str(code)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['git','-C',str(code),'checkout','--detach',M['commit_sha']],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        head = subprocess.check_output(['git','-C',str(code),'rev-parse','HEAD'],text=True).strip()
        if head != M['commit_sha']: raise RuntimeError('COMMIT_MISMATCH')
    dataset_root=pathlib.Path(M['datasets'][0]['path']).resolve() if len(M.get('datasets',[]))==1 else None
    data=(dataset_root/M.get('dataset_subdirectory','')).resolve() if dataset_root else None
    if data and (not data.is_relative_to(dataset_root) or not data.exists()): raise RuntimeError('DATASET_PATH_INVALID')
    for name in M.get('required_dataset_paths',[]):
        candidate=(data/name).resolve()
        if not candidate.is_relative_to(data) or not candidate.exists(): raise RuntimeError('DATASET_REQUIRED_PATH_MISSING: '+name)
    def expand(value):
        replacements={'{device}':'cpu' if M['gpu']=='cpu' else 'cuda','{gpu_count}':str(0 if M['gpu']=='cpu' else len(M['gpu'].split(','))),'{dataset}':str(data) if data else '', '{output}':str(ROOT/'outputs'),'{config}':str(ROOT/'config.json'),'{code}':str(code),'{python}':M['python'],'{weights}':M.get('model_source','') if M.get('model_input_kind')=='weights' else '', '{checkpoint}':M.get('checkpoint_source') or (M.get('model_source','') if M.get('model_input_kind')=='checkpoint' else '')}
        if isinstance(value,str):
            import re
            return re.sub(r'\{(?:dataset|output|config|code|python|checkpoint|weights|device|gpu_count)\}',lambda match:replacements[match.group(0)],value)
        if isinstance(value,list): return [expand(item) for item in value]
        if isinstance(value,dict): return {key:expand(item) for key,item in value.items()}
        return value
    if M.get('model_source') and not pathlib.Path(M['model_source']).is_file(): raise RuntimeError('MODEL_FILE_NOT_FOUND')
    if M.get('checkpoint_source') and not pathlib.Path(M['checkpoint_source']).is_file(): raise RuntimeError('CHECKPOINT_NOT_FOUND')
    spec=M.get('result_collection')
    if spec and spec['root']=='code' and spec['path']:
        source=(code/spec['path']).resolve()
        if not source.is_relative_to(code): raise RuntimeError('METRICS_SOURCE_PATH_INVALID')
        atomic('source-baseline.json',dict(mtime_ns=source.stat().st_mtime_ns if source.is_file() else None,size=source.stat().st_size if source.is_file() else 0))
    env = os.environ.copy()
    env.update(M['env'])
    env['PYTHONUNBUFFERED']='1'
    env['PATH']=str(pathlib.Path(M['python']).parent)+os.pathsep+env.get('PATH','')
    env['TRASH_DATASETS_JSON']=json.dumps(M.get('datasets',[]))
    if len(M.get('datasets',[]))==1: env['TRASH_DATASET_DIR']=str(data)
    env['TRASH_RUN_DIR'] = str(ROOT)
    env['TRASH_OUTPUT_DIR'] = str(ROOT / 'outputs')
    env['TRASH_CONFIG_PATH'] = str(ROOT / 'config.json')
    if M['gpu'] == 'cpu': env['CUDA_VISIBLE_DEVICES'] = ''
    else: env['CUDA_VISIBLE_DEVICES'] = M['gpu']
    atomic('config.json', expand(M['config']))
    environment = json.loads((ROOT / 'environment.json').read_text()) if (ROOT / 'environment.json').exists() else {}
    environment.update(dict(python=sys.version, executable=sys.executable, platform=platform.platform(), commit_sha=head, runner_version='4', code_snapshot=M.get('code_snapshot')))
    atomic('environment.json', environment)
    steps=M.get('execution_steps') or [dict(stage='other',purpose='执行实验',working_directory='.',argv=M['command'],env={})]
    if M.get('preparation'):
        script = (code / M['preparation_script']).resolve()
        if not script.is_relative_to(code.resolve()): raise RuntimeError('PREPARATION_PATH_INVALID')
        steps=[dict(stage='prepare',purpose='准备环境',working_directory='.',argv=['bash',str(script)],env={})]
    started=time.time(); reason=None; exit_code=0
    def pump(source,name):
        path=ROOT/'logs'/name
        with source:
            while True:
                block=source.read1(65536)
                if not block: break
                if path.exists() and path.stat().st_size+len(block)>50*1024*1024:
                    os.replace(path,pathlib.Path(str(path)+'.1'))
                with path.open('ab') as output: output.write(block)
    for index,step in enumerate(steps):
        if (ROOT/'cancel.json').exists(): reason='cancelled';break
        if time.time()-started>M['timeout_seconds']: reason='timeout';break
        cwd=(code/step['working_directory']).resolve()
        if not cwd.is_relative_to(code) or not cwd.is_dir(): raise RuntimeError('STEP_DIRECTORY_INVALID')
        argv=expand(step['argv'])
        if argv[0] in ['python','python3']: argv=[M['python']]+argv[1:]
        step_env=env.copy();step_env.update(expand(step.get('env',{})))
        progress=dict(step_index=index,step_total=len(steps),step_stage=step['stage'],step_purpose=step['purpose'])
        atomic('execution-progress.json',progress)
        with (ROOT/'logs/stdout.log').open('a') as log: log.write('\n[TRASH] '+str(index+1)+'/'+str(len(steps))+' '+step['purpose']+'\n')
        process=subprocess.Popen(argv,cwd=str(cwd),env=step_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        threads=[threading.Thread(target=pump,args=(process.stdout,'stdout.log'),daemon=True),threading.Thread(target=pump,args=(process.stderr,'stderr.log'),daemon=True)]
        for thread in threads: thread.start()
        while process.poll() is None:
            status('running',pid=process.pid,started_at=started,runner_version='4',log_rotation=True,**progress)
            cancel=ROOT/'cancel.json'
            if cancel.exists() and json.loads(cancel.read_text()).get('token')==TOKEN: reason='cancelled'
            if time.time()-started>M['timeout_seconds']: reason='timeout'
            if reason:
                os.killpg(process.pid,signal.SIGTERM)
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait()
                break
            time.sleep(1)
        for thread in threads: thread.join(timeout=5)
        exit_code=process.wait()
        if exit_code or reason: break
        atomic('execution-progress.json',dict(**{**progress,'step_index':index+1}))
    status('cancelled' if reason=='cancelled' else 'completed' if exit_code==0 and not reason else 'failed',exit_code=exit_code,started_at=started,finished_at=time.time(),reason=reason,step_index=index+1 if not exit_code and not reason else index,step_total=len(steps),step_stage=step['stage'],step_purpose=step['purpose'])
    collect()
except Exception as error:
    if process and process.poll() is None:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
    status('failed', reason=str(error), finished_at=time.time())
    collect()
finally:
    for link,target in reversed(links):
        if link.is_symlink() and link.resolve()==target: link.unlink()
`;
export const DIAGNOSTICS = String.raw`import os,sys,json,shutil,subprocess,platform
root=sys.argv[1]
if os.path.islink(root): raise RuntimeError('REMOTE_ROOT_SYMLINK')
os.makedirs(root,mode=0o700,exist_ok=True)
checks={}
for name in ['git','python3','tmux','bash']:
    checks[name]=shutil.which(name)
try:
    p=subprocess.run(['nvidia-smi','--query-gpu=index,name,memory.total','--format=csv,noheader'],capture_output=True,text=True,timeout=10)
    gpu=p.stdout.strip() if p.returncode==0 else ''
except (OSError,subprocess.TimeoutExpired): gpu=''
print(json.dumps(dict(platform=platform.system(),python=sys.version,python_executable=sys.executable,python_ok=sys.version_info>=(3,9),tools=checks,disk_free=shutil.disk_usage(root).free,root=os.path.realpath(root),gpu=gpu)))`;
