import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { autoDLDirectories, commitShaSchema, type ProjectRepository, type SshProfile } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { z } from "zod";
import { uploadAutoDLFile } from "./autodl-file-upload.js";
import type { UploadProgress } from "./experiment-code-upload.js";
import type { ExperimentService } from "./service.js";
import { ensureRemoteDirectory } from "./workspace.js";

const receiptSchema=z.object({path:z.string(),commit:commitShaSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes:z.number().int().positive(),reused:z.boolean(),verified:z.literal(true)});
type Receipt=z.infer<typeof receiptSchema>;
export type GitSyncVersion=Receipt & {
  id:string; repository_id:string; profile_id:string; root:string; host:string; port:number; username:string; fingerprint?:string; at:string;
};
export const syncIdentity=(profile:SshProfile)=>({
  profile_id:profile.profile_id,host:profile.host,port:profile.port,username:profile.username,fingerprint:profile.fingerprint
});

const materialize=String.raw`
import fcntl, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile
destination, sha, bundle, digest, size = sys.argv[1:]
target = pathlib.Path(destination)
parent = target.parent
def git(*args):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], env=env)
def verify(path):
    if path.is_symlink() or not (path / '.git').is_dir() or (path / '.git').is_symlink():
        raise RuntimeError('REMOTE_GIT_CHECKOUT_INVALID')
    if git('-C', str(path), 'rev-parse', 'HEAD').decode().strip() != sha:
        raise RuntimeError('REMOTE_GIT_COMMIT_MISMATCH')
    if git('-C', str(path), 'status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('REMOTE_GIT_TREE_DIRTY')
with os.fdopen(os.open(parent / '.sync-lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+b') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    reused = os.path.lexists(target)
    if reused:
        verify(target)
        marker = target / '.git' / 'trash-sync.json'
        if marker.is_symlink() or not marker.is_file():
            raise RuntimeError('REMOTE_GIT_CHECKOUT_UNMANAGED')
        info = json.loads(marker.read_text())
        digest, size = info['sha256'], info['size_bytes']
    elif not bundle:
        print('null')
        sys.exit(0)
    else:
        temp = pathlib.Path(tempfile.mkdtemp(prefix='.checkout-', dir=parent))
        try:
            h = hashlib.sha256()
            with open(bundle, 'rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != digest:
                raise RuntimeError('BUNDLE_HASH_MISMATCH')
            code = temp / 'code'
            git('init', '--object-format=' + ('sha256' if len(sha)==64 else 'sha1'), str(code))
            git('-C', str(code), 'bundle', 'verify', bundle)
            git('-C', str(code), 'fetch', '--no-tags', bundle, 'refs/heads/trash-run')
            git('-C', str(code), 'checkout', '--detach', sha)
            verify(code)
            (code / '.git' / 'trash-sync.json').write_text(json.dumps(dict(sha256=digest, size_bytes=int(size))))
            os.rename(code, target)
        finally:
            shutil.rmtree(temp)
    print(json.dumps(dict(path=destination, commit=sha, sha256=digest, size_bytes=int(size), reused=reused, verified=True)))
`;

export class GitSyncService {
  constructor(private service:ExperimentService){
    service.store.db.exec(`CREATE TABLE IF NOT EXISTS git_sync_versions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE, path TEXT NOT NULL, profile_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(project,path,profile_id))`);
  }

  versions(project:string,repo:ProjectRepository):GitSyncVersion[]{
    return (this.service.store.db.prepare(`SELECT data FROM git_sync_versions WHERE project=? AND json_extract(data,'$.repository_id')=?
      ORDER BY json_extract(data,'$.at') DESC`).all(project,repo.repository_id) as {data:string}[]).map(row=>JSON.parse(row.data));
  }

  async sync(project:string,repo:ProjectRepository,profile:SshProfile,root:string,sha:string,report:UploadProgress,signal:AbortSignal){
    commitShaSchema.parse(sha);
    if(!/^repo_[a-z0-9-]+$/i.test(repo.repository_id))experimentError("REPOSITORY_NOT_BOUND",404);
    const service=this.service;
    const remote=service.terminals.connection(project,profile.profile_id);
    const parent=posix.join(root,autoDLDirectories.paperCode,".git-versions",repo.repository_id);
    const path=posix.join(parent,sha);
    const checkTarget=()=>{
      signal.throwIfAborted();
      const current=service.data.profile(project,profile.profile_id);
      if(service.workspaces.get(project,profile.profile_id)?.root!==root||JSON.stringify(syncIdentity(current))!==JSON.stringify(syncIdentity(profile)))
        experimentError("WORKSPACE_CHANGED",409);
    };
    const materializeVersion=async(bundle="",digest="",size=0)=>{
      checkTarget();
      const result=JSON.parse(await remote.exec(["python3","-c",materialize,path,sha,bundle,digest,String(size)],undefined,180000));
      return result===null?null:receiptSchema.parse(result);
    };
    const record=(receipt:Receipt)=>{
      checkTarget();
      const prior=this.versions(project,repo).find(v=>v.path===path&&v.root===root&&JSON.stringify(syncIdentity(profile))===
        JSON.stringify({profile_id:v.profile_id,host:v.host,port:v.port,username:v.username,fingerprint:v.fingerprint}));
      const version={...receipt,...syncIdentity(profile),id:prior?.id??randomUUID(),repository_id:repo.repository_id,root,at:new Date().toISOString()};
      service.store.db.prepare("INSERT INTO git_sync_versions VALUES (?,?,?,?,?) ON CONFLICT(project,path,profile_id) DO UPDATE SET id=excluded.id,data=excluded.data")
        .run(version.id,project,path,profile.profile_id,JSON.stringify(version));
      return version;
    };
    checkTarget();
    report("checking");
    await service.repository.preflight(project,sha,repo.repository_id,false);
    await ensureRemoteDirectory(remote,parent);
    const prior=await materializeVersion();
    if(prior)return record(prior);

    report("snapshot");
    const bundle=await service.repository.bundle(project,sha,repo.repository_id);
    const temporary=posix.join(parent,"bundle-"+randomUUID()+".part");
    try{
      await uploadAutoDLFile(remote,root,JSON.stringify(syncIdentity(profile)),bundle.path,temporary,report,signal,checkTarget,bundle.sha256);
      report("extracting",bundle.size,bundle.size);
      const receipt=await materializeVersion(temporary,bundle.sha256,bundle.size);
      if(!receipt)experimentError("GIT_SYNC_CHECKOUT_FAILED",422);
      return record(receipt);
    }finally{
      await remote.exec(["rm","-f","--",temporary]).catch(()=>{});
      await bundle.cleanup();
    }
  }
}
