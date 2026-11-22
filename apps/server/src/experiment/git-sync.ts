import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { autoDLDirectories, commitShaSchema, type ProjectRepository, type SshProfile } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { z } from "zod";
import { uploadAutoDLFile } from "./autodl-file-upload.js";
import type { UploadProgress } from "./experiment-code-upload.js";
import type { ExperimentService } from "./service.js";
import { assertExportableHistory, git } from "./repository.js";
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

const exportRemote=String.raw`
import hashlib, json, os, pathlib, subprocess, sys, tempfile
path, sha, base, packet = sys.argv[1:]
code = pathlib.Path(path)
if code.resolve() != code or not (code / '.git').is_dir() or (code / '.git').is_symlink():
    raise RuntimeError('REMOTE_GIT_CHECKOUT_INVALID')
if not (code / '.git' / 'trash-sync.json').is_file():
    raise RuntimeError('REMOTE_GIT_CHECKOUT_UNMANAGED')
def git(*args):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], env=env)
if git('-C', path, 'rev-parse', sha+'^{commit}').decode().strip() != sha:
    raise RuntimeError('REMOTE_GIT_COMMIT_MISMATCH')
git('-C', path, 'merge-base', '--is-ancestor', base, sha)
os.mkdir(packet, 0o700)
bundle = pathlib.Path(packet) / 'code.bundle'
with tempfile.TemporaryDirectory(prefix='bare-', dir=packet) as repo:
    git('init', '--bare', '--object-format='+('sha256' if len(sha)==64 else 'sha1'), repo)
    git('-C', repo, 'fetch', '--no-tags', path, sha)
    git('-C', repo, 'update-ref', 'refs/heads/trash-run', sha)
    git('-C', repo, 'bundle', 'create', str(bundle), 'refs/heads/trash-run')
size = bundle.stat().st_size
if size > 200 * 1024 * 1024:
    raise RuntimeError('CODE_BUNDLE_TOO_LARGE')
digest = hashlib.sha256()
with bundle.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
print(json.dumps(dict(sha256=digest.hexdigest(), size=size)))
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

  version(project:string,repo:ProjectRepository,id:string){
    return this.versions(project,repo).find(v=>v.id===id)??experimentError("GIT_SYNC_VERSION_NOT_FOUND",404);
  }

  async importCommit(project:string,repo:ProjectRepository,version:GitSyncVersion,commit:string,signal:AbortSignal){
    commitShaSchema.parse(commit);
    if(commit===version.commit)experimentError("GIT_SYNC_NO_REMOTE_CHANGES",409);
    const service=this.service;
    const expected={profile_id:version.profile_id,host:version.host,port:version.port,username:version.username,fingerprint:version.fingerprint};
    const checkTarget=()=>{
      signal.throwIfAborted();
      const current=service.data.profile(project,version.profile_id);
      if(service.workspaces.get(project,current.profile_id)?.root!==version.root||JSON.stringify(syncIdentity(current))!==JSON.stringify(expected))
        experimentError("WORKSPACE_CHANGED",409);
    };
    checkTarget();
    const remote=service.terminals.connection(project,version.profile_id);
    const temp=await mkdtemp(join(tmpdir(),"trash-return-bundle-"));
    const packet=posix.join(posix.dirname(version.path),"return-"+randomUUID());
    const location=posix.join(packet,"code.bundle");
    const local=join(temp,"code.bundle");
    const branch="trash-import/"+commit;
    const ref="refs/heads/"+branch;
    const readRef=async()=> (await git(repo.path,["rev-parse","--verify",ref]).catch(()=>"")).trim();
    try{
      const probe=JSON.parse(await remote.exec(["python3","-c",exportRemote,version.path,commit,version.commit,packet],undefined,180000));
      const {sha256,size}=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().positive().max(200*1024*1024)}).parse(probe);
      const file=openSync(local,"wx",0o600),hash=createHash("sha256");
      let received=0;
      try{
        await remote.consume(location,size+1,chunk=>{
          signal.throwIfAborted();
          hash.update(chunk);
          let offset=0;
          while(offset<chunk.length)offset+=writeSync(file,chunk,offset,chunk.length-offset);
          received+=chunk.length;
        });
      }finally{closeSync(file);}
      if(received!==size||hash.digest("hex")!==sha256)experimentError("BUNDLE_HASH_MISMATCH",409);

      const quarantine=join(temp,"objects");
      await git(temp,["init","--bare","--object-format="+(commit.length===64?"sha256":"sha1"),quarantine]);
      await git(quarantine,["bundle","verify",local]);
      if((await git(quarantine,["bundle","list-heads",local])).trim()!==commit+" refs/heads/trash-run")
        experimentError("REMOTE_GIT_COMMIT_MISMATCH",409);
      await git(quarantine,["-c","fetch.fsckObjects=true","fetch","--no-tags",local,"refs/heads/trash-run:refs/heads/trash-run"]);
      await git(quarantine,["merge-base","--is-ancestor",version.commit,commit]);
      await assertExportableHistory(quarantine,commit);
      const summary=await git(quarantine,["diff","--stat",version.commit,commit]);
      checkTarget();
      const prior=await readRef();
      if(prior&&prior!==commit)experimentError("GIT_SYNC_REVIEW_BRANCH_EXISTS",409);
      if(!prior){
        await git(repo.path,["fetch","--no-tags","--no-write-fetch-head",quarantine,"refs/heads/trash-run"]);
        checkTarget();
        try{await git(repo.path,["update-ref",ref,commit,"0".repeat(commit.length)]);}
        catch(error){if(await readRef()!==commit)throw error;}
      }
      return {branch,commit,baseline:version.commit,sha256,summary:summary.trim(),reused:!!prior};
    }finally{
      await remote.exec(["python3","-c","import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else None",packet]).catch(()=>{});
      await rm(temp,{recursive:true,force:true});
    }
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
