// Uploaded as a versioned source file. No Python or remote command is executed during development.
export const RUNNER_VERSION = "2";
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

def collect():
    names = ['manifest.json', 'environment.json', 'status.json', 'config.json', 'logs/stdout.log', 'logs/stdout.log.1', 'logs/stderr.log', 'logs/stderr.log.1', M['metrics_path']] + M['artifact_paths']
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
status('waiting', runner_version='2')
host_lock = pathlib.Path('/tmp/trash-experiment-' + str(os.getuid()) + '.lock').open('a')
while True:
    try:
        fcntl.flock(host_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if (ROOT / 'cancel.json').exists():
            status('cancelled', exit_code=None)
            sys.exit(0)
        status('waiting', runner_version='2')
        time.sleep(2)
process = None
try:
    if digest(ROOT / 'code.bundle') != M['bundle_sha256']: raise RuntimeError('BUNDLE_HASH_MISMATCH')
    code = ROOT / 'code'
    if M.get('code_source') == 'reproduction':
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
    env = os.environ.copy()
    env.update(M['env'])
    env['TRASH_RUN_DIR'] = str(ROOT)
    env['TRASH_OUTPUT_DIR'] = str(ROOT / 'outputs')
    env['TRASH_CONFIG_PATH'] = str(ROOT / 'config.json')
    if M['gpu'] == 'cpu': env['CUDA_VISIBLE_DEVICES'] = ''
    else: env['CUDA_VISIBLE_DEVICES'] = M['gpu']
    atomic('config.json', M['config'])
    environment = json.loads((ROOT / 'environment.json').read_text()) if (ROOT / 'environment.json').exists() else {}
    environment.update(dict(python=sys.version, executable=sys.executable, platform=platform.platform(), commit_sha=head, runner_version='2', code_snapshot=M.get('code_snapshot')))
    atomic('environment.json', environment)
    argv = M['command']
    if argv[0] in ['python','python3']: argv = [M['python']] + argv[1:]
    if M.get('preparation'):
        script = (code / M['preparation_script']).resolve()
        if not script.is_relative_to(code.resolve()): raise RuntimeError('PREPARATION_PATH_INVALID')
        argv = ['bash',str(script)]
    process = subprocess.Popen(argv,cwd=str(code),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    started = time.time()
    def pump(source, name):
        path = ROOT / 'logs' / name
        with source:
            while True:
                block = source.read1(65536)
                if not block: break
                if path.exists() and path.stat().st_size + len(block) > 50*1024*1024:
                    os.replace(path, pathlib.Path(str(path) + '.1'))
                with path.open('ab') as output: output.write(block)
    threads = [threading.Thread(target=pump,args=(process.stdout,'stdout.log'),daemon=True),threading.Thread(target=pump,args=(process.stderr,'stderr.log'),daemon=True)]
    for thread in threads: thread.start()
    reason = None
    while process.poll() is None:
        status('running', pid=process.pid, started_at=started, runner_version='2', log_rotation=True)
        cancel = ROOT / 'cancel.json'
        if cancel.exists() and json.loads(cancel.read_text()).get('token') == TOKEN: reason = 'cancelled'
        if time.time() - started > M['timeout_seconds']: reason = 'timeout'
        if reason:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            break
        time.sleep(1)
    for thread in threads: thread.join(timeout=5)
    code = process.wait()
    status('cancelled' if reason == 'cancelled' else 'completed' if code == 0 and not reason else 'failed', exit_code=code, started_at=started, finished_at=time.time(), reason=reason)
    collect()
except Exception as error:
    if process and process.poll() is None:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
    status('failed', reason=str(error), finished_at=time.time())
    collect()
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
