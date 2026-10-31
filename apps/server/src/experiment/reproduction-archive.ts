// Python standard library only, used locally and remotely; no shell interpolation.
export const REPRO_ARCHIVE = String.raw`
import sys,os,json,zipfile,hashlib,stat,pathlib
mode,source,target=sys.argv[1:4]
LIMIT=200*1024*1024
MAXFILES=20000
def safe(name):
 p=pathlib.PurePosixPath(name)
 if not name or chr(92) in name or p.is_absolute() or '..' in p.parts or any(ord(c)<32 for c in name) or (p.parts and ':' in p.parts[0]): raise ValueError('UNSAFE_ARCHIVE_PATH')
 return p
if mode=='extract':
 os.makedirs(target,exist_ok=False)
 with zipfile.ZipFile(source) as z:
  entries=z.infolist()
  if len(entries)>MAXFILES or sum(i.file_size for i in entries)>LIMIT: raise ValueError('ARCHIVE_LIMIT')
  seen=set();total=0
  for i in entries:
   p=safe(i.filename)
   kind=stat.S_IFMT(i.external_attr>>16)
   if kind not in (0,stat.S_IFREG,stat.S_IFDIR) or i.flag_bits&1: raise ValueError('UNSUPPORTED_ARCHIVE_ENTRY')
   if '.git' in p.parts: continue
   name=str(p)
   if name in seen: raise ValueError('DUPLICATE_ARCHIVE_PATH')
   seen.add(name);out=pathlib.Path(target).joinpath(*p.parts)
   if i.is_dir(): out.mkdir(parents=True,exist_ok=True);continue
   out.parent.mkdir(parents=True,exist_ok=True)
   with z.open(i) as inp,open(out,'xb') as dest:
    while True:
     b=inp.read(1024*1024)
     if not b: break
     total+=len(b)
     if total>LIMIT: raise ValueError('ARCHIVE_LIMIT')
     dest.write(b)
   os.chmod(out,0o700 if i.external_attr>>16&0o111 else 0o600)
 print(json.dumps({'extracted':True}))
elif mode=='snapshot':
 records=[];total=0
 with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED) as z:
  for root,dirs,files in os.walk(source,followlinks=False):
   dirs[:]=sorted(d for d in dirs if d not in ['.git','__pycache__'])
   for d in dirs:
    if os.path.islink(os.path.join(root,d)): raise ValueError('SYMLINK_UNSUPPORTED')
   for name in sorted(files):
    path=os.path.join(root,name);rel=os.path.relpath(path,source).replace(os.sep,'/');safe(rel)
    if not stat.S_ISREG(os.lstat(path).st_mode): raise ValueError('SYMLINK_OR_SPECIAL_FILE')
    if (name=='.env' or name.startswith('.env.') and name!='.env.example' or name in ['id_rsa','id_ed25519','auth.json','credentials']): raise ValueError('SENSITIVE_FILE')
    h=hashlib.sha256();size=0;info=zipfile.ZipInfo.from_file(path,rel,strict_timestamps=False)
    info.compress_type=zipfile.ZIP_DEFLATED
    with open(path,'rb') as inp,z.open(info,'w') as out:
     while True:
      b=inp.read(1024*1024)
      if not b: break
      size+=len(b);total+=len(b)
      if total>LIMIT: raise ValueError('ARCHIVE_LIMIT')
      h.update(b);out.write(b)
    records.append({'path':rel,'size_bytes':size,'sha256':h.hexdigest()})
    if len(records)>MAXFILES: raise ValueError('ARCHIVE_LIMIT')
 if not records: raise ValueError('EMPTY_CODE_DIRECTORY')
 print(json.dumps({'files':records,'size_bytes':total}))
`;
