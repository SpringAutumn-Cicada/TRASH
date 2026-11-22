import { posix } from "node:path";
import { autoDLDirectories, autoDLPaperDirectory } from "@trash/protocol";
import { experimentError } from "@trash/storage";
import { git } from "./repository.js";
import type { ExperimentService } from "./service.js";
import { ensureRemoteDirectory } from "./workspace.js";
import { matchesHashes, remoteDirectoryExists } from "./workspace-migration.js";

export type UploadProgress = (stage: string, sent?: number, total?: number) => void;

export async function uploadExperimentCode(service: ExperimentService, project: string, input: {
  profile_id: string;
  repository_id?: string;
  request_id: string;
}, notify?: UploadProgress, signal?: AbortSignal) {
  service.data.profile(project, input.profile_id);
  const workspace = service.workspaces.get(project, input.profile_id) ?? experimentError("WORKSPACE_REQUIRED", 409);
  const remote = service.terminals.connection(project, input.profile_id);
  const release = service.reproductions.acquire(project);
  const operation = service.reproductions.beginUpload(project, "experiment-code", input.request_id);
  let finalizing = false;
  const cancel = () => { if (!finalizing) operation.cancel(); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const report: UploadProgress = (stage, sent = 0, total = 0) => {
    if (operation.signal.aborted) experimentError("UPLOAD_CANCELLED", 409);
    finalizing = ["verifying", "extracting", "saving", "completed"].includes(stage);
    service.reproductions.report(project, "experiment-code", input.request_id, stage, sent, total);
    notify?.(stage, sent, total);
  };
  try {
    report("snapshot");
    const repo = service.repository.bound(project, input.repository_id);
    const commit = (await git(repo.path, ["rev-parse", "HEAD"])).trim();
    await service.repository.preflight(project, commit, repo.repository_id);
    const name = autoDLPaperDirectory(repo);
    const parent = posix.join(workspace.root, autoDLDirectories.paperCode);
    const destination = posix.join(parent, name);
    await ensureRemoteDirectory(remote, parent);
    if (await remoteDirectoryExists(remote, destination)) {
      const previous = workspace.experiment_uploads?.filter(item => item.path === destination).at(-1);
      if (previous?.commit === commit) {
        const snapshot = service.reproductions.snapshotInfo(project, previous.snapshot_id);
        report("preparing", 0, snapshot.size_bytes);
        if (await matchesHashes(remote, destination, snapshot.files).catch(() => false)) {
          report("completed", snapshot.size_bytes, snapshot.size_bytes);
          return { path: destination, snapshot, commit, reused: true, verified: true };
        }
      }
      experimentError("REPRODUCTION_REMOTE_TARGET_EXISTS", 409);
    }
    report("snapshot");
    const snapshot = await service.reproductions.sourceSnapshot(project, repo.path, name, commit);
    await service.repository.preflight(project, commit, repo.repository_id);
    if ((await git(repo.path, ["rev-parse", "HEAD"])).trim() !== commit) experimentError("GIT_TREE_DIRTY", 409);
    const deployed = await service.reproductions.deploy(remote, project, snapshot, parent, report, operation.signal, name);
    service.workspaces.recordExperimentUpload(project, input.profile_id, workspace.root, {
      name, path: deployed.path, commit, snapshot_id: snapshot.snapshot_id, at: new Date().toISOString(),
    });
    return { ...deployed, commit, reused: false, verified: true };
  } catch (error) {
    service.reproductions.report(project, "experiment-code", input.request_id, operation.signal.aborted ? "cancelled" : "failed");
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    operation.finish();
    release();
  }
}
