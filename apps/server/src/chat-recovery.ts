import type { syncIdentity } from "./experiment/git-sync.js";
import { gitRead } from "./git-upload-choice.js";

export type RemoteRecoveryTarget = { profile: ReturnType<typeof syncIdentity>; root: string };
export type RecoveryTarget =
  | { kind: "git-commit"; repository: string; ref: string; baseline: string; tree: string; message: string; files?: string[] }
  | { kind: "git-import"; repository: string; commit: string }
  | { kind: "experiment-plan"; repository: string; plan_id: string }
  | (RemoteRecoveryTarget & { kind: "file-upload"; path: string; sha256: string })
  | (RemoteRecoveryTarget & { kind: "git-sync"; repository: string; commit: string })
  | (RemoteRecoveryTarget & { kind: "code-upload"; repository: string; commit: string; path: string; snapshot_id?: string });

export type RecoveryOperation = { id: string; target: RecoveryTarget; result?: string; checked?: "missing" | "different" };

export async function matchingCommit(path: string, target: Extract<RecoveryTarget, {kind:"git-commit"}>, known?: string) {
  const ref=(await gitRead(path,["rev-parse","--symbolic-full-name","HEAD"])).trim();
  if (ref!==target.ref) return undefined;
  const commits=known ? [known] : (await gitRead(path,["rev-list","--ancestry-path","--max-count=32",target.baseline+"..HEAD"])).trim().split("\n").filter(Boolean);
  const entries=(object:string)=>gitRead(path,["--literal-pathspecs","ls-tree","-r","-z",object,"--",...(target.files??[])]);
  const matches=[];
  for (const sha of commits) {
    const proof=(await gitRead(path,["show","-s","--format=%P%n%T%n%s",sha])).trimEnd();
    const [parent,tree,message]=proof.split("\n");
    if (parent!==target.baseline||message!==target.message) continue;
    if (!target.files) {
      if (tree===target.tree) matches.push(sha);
      continue;
    }
    const changes=(await gitRead(path,["diff-tree","--no-commit-id","--no-renames","--name-only","-r","-z",sha])).split("\0").filter(Boolean);
    if (changes.length===target.files.length&&changes.every(file=>target.files!.includes(file))&&
      await entries(sha)===await entries(target.tree)) matches.push(sha);
  }
  return matches.length===1?matches[0]:undefined;
}
