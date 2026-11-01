import type { RemoteConnection } from './ssh.js';
const synchronize=String.raw`import sys,json,pathlib,hashlib,os,stat
root=pathlib.Path(sys.argv[1]).resolve();task=sys.argv[2];packet=json.load(sys.stdin)
assert root.is_dir() and task.startswith('env_') and all(c in 'env_0123456789abcdef-' for c in task)
def digest(data): return hashlib.sha256(data).hexdigest()
changes={item['path']:item for item in packet['changes']};pending=[];prefix=''
files=packet['files']
if files and not all((root/item['path']).is_file() for item in files):
 first=files[0]['path'].split('/')[0]+'/'
 if all(item['path'].startswith(first) and (root/item['path'][len(first):]).is_file() for item in files):prefix=first

for entry in packet['files']:
 rel=pathlib.PurePosixPath(entry['path'][len(prefix):]);target=root/rel
 assert not rel.is_absolute() and '..' not in rel.parts and target.resolve().is_relative_to(root) and not target.is_symlink(), 'REMOTE_SOURCE_PATH_UNSAFE'
 assert target.is_file(), 'REMOTE_SOURCE_MISSING: '+entry['path']
 current=target.read_bytes();actual=digest(current)
 if actual==entry['sha256']:continue
 change=changes.get(entry['path'])
 assert change is not None, 'REMOTE_SOURCE_CHANGED: '+entry['path']
 before=change['original'].encode('utf-8');after=change['text'].encode('utf-8')
 assert digest(after)==entry['sha256'] and actual==digest(before), 'REMOTE_SOURCE_CHANGED: '+entry['path']
 pending.append((entry['path'],target,before,after,stat.S_IMODE(target.stat().st_mode)))
backup=root/'.trash-directory-repair-backups'/task
if pending:
 assert backup.resolve().is_relative_to(root) and not backup.is_symlink(), 'REMOTE_BACKUP_PATH_UNSAFE'
 backup.mkdir(parents=True,exist_ok=True)
 manifest=[]
 for name,target,before,after,mode in pending:
  saved=backup/(name+'.original');assert saved.resolve().is_relative_to(backup.resolve()) and not saved.is_symlink(), 'REMOTE_BACKUP_PATH_UNSAFE'
  saved.parent.mkdir(parents=True,exist_ok=True)
  if saved.exists():assert saved.is_file() and saved.read_bytes()==before,'REMOTE_BACKUP_CONFLICT'
  else:
   with saved.open('xb') as stream:stream.write(before)
   os.chmod(saved,0o600)
  manifest.append(dict(path=name,before=digest(before),after=digest(after)))
 manifest_path=backup/'manifest.json';assert not manifest_path.is_symlink() and manifest_path.resolve().is_relative_to(backup.resolve()),'REMOTE_BACKUP_PATH_UNSAFE'
 existing=json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else []
 merged={entry['path']:entry for entry in existing+manifest}
 with manifest_path.open('w',encoding='utf-8') as stream:json.dump(list(merged.values()),stream,ensure_ascii=False)
 for name,target,before,after,mode in pending:
  assert target.resolve().is_relative_to(root) and not target.is_symlink() and target.read_bytes()==before,'REMOTE_SOURCE_CHANGED: '+name
  temp=target.with_name(target.name+'.trash-repair-'+task)
  assert not temp.exists() and not temp.is_symlink(),'REMOTE_REPAIR_TEMP_EXISTS'
  try:
   with temp.open('xb') as stream:stream.write(after)
   os.chmod(temp,mode);os.replace(temp,target)
  finally:
   if temp.exists():temp.unlink()
for entry in packet['files']:
 target=(root/entry['path'][len(prefix):]).resolve()
 assert target.is_relative_to(root) and target.is_file() and digest(target.read_bytes())==entry['sha256'],'REMOTE_SOURCE_VERIFY_FAILED'
print(json.dumps(dict(files=[name for name,*_ in pending],backup=str(backup) if pending else None),ensure_ascii=False))`;
export async function synchronizeRepairedSource(remote:RemoteConnection,directory:string,task:string,files:{path:string;sha256:string}[],changes:{path:string;original:string;text:string}[]):Promise<{files:string[];backup:string|null}>{
 const value=await remote.exec([directory.replace(/\/+$/,'')+'/.venv/bin/python','-c',synchronize,directory,task],JSON.stringify({files,changes}),300000);
 return JSON.parse(value) as {files:string[];backup:string|null};
}
