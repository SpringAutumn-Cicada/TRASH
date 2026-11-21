import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type ExperimentStore, experimentError } from "@trash/storage";
import { repositoryInputSchema, type DiscoveredExperiment, type ExperimentCatalogEntry, type ProjectRepository } from "@trash/protocol";
import { git } from "./repository.js";
import { manuscriptId } from "../manuscript-layout.js";
import { assertExperimentScheme, experimentSchemes } from "./run-archive.js";

const directoryId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const relativeFile = z.string().trim().max(1024).refine(value =>
  value.split("/").every(part => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"))
);
export const experimentCodeSettings = z.object({
  repository_id: z.string().min(1).max(128).optional(),
  entrypoint: relativeFile.optional(),
  paper_id: manuscriptId.optional(),
}).strict();
const selection = z.object({ direction_id: directoryId, scheme_id: directoryId });
export const experimentCatalogUpdate = selection.extend({ code: experimentCodeSettings }).strict();

function info(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function ensureDirectory(path: string) {
  try { mkdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!info(path)?.isDirectory()) experimentError("FILES_NOT_DIRECTORY", 422);
}

export function listExperiments(root: string): ExperimentCatalogEntry[] {
  return experimentSchemes(root).map(scheme => {
    const folder = join(root, "experiments", scheme.direction_id, scheme.scheme_id);
    const heading = readFileSync(join(folder, "README.md"), "utf8").match(/^# ([^\r\n]+)/m)?.[1];
    const settingsPath = join(folder, ".experiment-code.json");
    const code = info(settingsPath)?.isFile()
      ? experimentCodeSettings.parse(JSON.parse(readFileSync(settingsPath, "utf8")))
      : {};
    const title = scheme.direction_id === "unassigned" && scheme.scheme_id.startsWith("experiment_")
      ? heading : heading?.replace(/ · 实验方案$/, "");
    return { ...scheme, title: title || scheme.scheme_id, ...code };
  });
}

export function discoverExperiments(
  root: string, repositories: ProjectRepository[], experiments: ExperimentCatalogEntry[],
  recycled: {id: string; path: string; kind: string}[],
): DiscoveredExperiment[] {
  const workspace = realpathSync(root);
  const code = join(workspace, "code");
  const papers = join(code, "papers");
  if (!info(code)?.isDirectory() || !info(papers)?.isDirectory()) return [];

  const excludedIds = new Set(experiments.map(entry => entry.repository_id));
  for (const entry of recycled) {
    if (entry.kind !== "directory" || !/^experiments\/[^/]+\/[^/]+$/.test(entry.path)) continue;
    const settings = join(workspace, ".trash", "recycle", entry.id, "content", ".experiment-code.json");
    if (!info(settings)?.isFile()) continue;
    try {
      const parsed = experimentCodeSettings.safeParse(JSON.parse(readFileSync(settings, "utf8")));
      if (parsed.success && parsed.data.repository_id) excludedIds.add(parsed.data.repository_id);
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const excludedPaths = new Set(repositories
    .filter(repo => repo.paper_id || excludedIds.has(repo.repository_id))
    .map(repo => repo.path));
  return readdirSync(papers, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || entry.name.startsWith(".") || /[\x00-\x1f\x7f\\]/.test(entry.name)) return [];
    const path = join(papers, entry.name);
    if (excludedPaths.has(path) || !info(path)?.isDirectory()) return [];
    const git = info(join(path, ".git"));
    const has_git = Boolean(git?.isDirectory() || git?.isFile());
    if (!has_git && !info(join(path, "README.md"))?.isFile()) return [];
    return [{ name: entry.name, path, has_git }];
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

export async function createExperiment(root: string, projectId: string, store: ExperimentStore, input: unknown) {
  const { title, id } = z.object({
    title: z.string().trim().min(1).max(120),
    id: z.string().uuid(),
  }).strict().parse(input);
  const direction_id = "unassigned";
  const scheme_id = `experiment_${id.toLowerCase()}`;
  const workspace = realpathSync(root);
  const base = join(workspace, "experiments");
  const parent = join(base, direction_id);
  const archive = join(parent, scheme_id);

  const existing = () => {
    if (!info(archive)) return;
    const experiment = listExperiments(workspace).find(item =>
      item.direction_id === direction_id && item.scheme_id === scheme_id
    );
    if (experiment?.title !== title) return experimentError("FILES_EXISTS", 409);
    const repository = experiment.repository_id ? store.repository(projectId, experiment.repository_id) : undefined;
    return { experiment, repository };
  };

  ensureDirectory(base);
  ensureDirectory(parent);
  const previous = existing();
  if (previous) return previous;
  if (title.startsWith(".") || title.endsWith(".") || Buffer.byteLength(title) > 255 ||
      /[<>:"/\\|?*\x00-\x1f\x7f]/.test(title) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(title)) {
    experimentError("EXPERIMENT_NAME_INVALID", 422);
  }

  const code = join(workspace, "code");
  const papers = join(code, "papers");
  ensureDirectory(code);
  ensureDirectory(papers);
  const path = join(papers, title);
  const assertCodeAvailable = () => {
    if (info(path) || store.repositories(projectId).some(repo => repo.path === path)) {
      experimentError("EXPERIMENT_CODE_EXISTS", 409);
    }
  };
  assertCodeAvailable();

  const codeStage = mkdtempSync(join(papers, ".experiment-"));
  let archiveStage: string | undefined;
  let ownsCode = false;
  let ownsArchive = false;
  try {
    try { await git(codeStage, ["init", "--initial-branch=main"]); }
    catch { return experimentError("EXPERIMENT_GIT_INIT_FAILED", 422); }
    writeFileSync(join(codeStage, "README.md"), `# ${title}\n`, { flag: "wx" });

    const retry = existing();
    if (retry) return retry;
    assertCodeAvailable();
    const repository: ProjectRepository = {
      ...repositoryInputSchema.parse({ path, name: title }),
      repository_id: `repo_${randomUUID()}`, project_id: projectId, bound_at: new Date().toISOString(),
    };
    const experiment = { direction_id, scheme_id, title, repository_id: repository.repository_id };
    const stagedArchive = (archiveStage = mkdtempSync(join(parent, ".experiment-")));
    writeFileSync(join(stagedArchive, "README.md"), `# ${title}\n\n## 验证问题\n\n## 对照与评价方式\n`, { flag: "wx" });
    writeFileSync(join(stagedArchive, ".experiment-code.json"),
      JSON.stringify({ repository_id: repository.repository_id }, null, 2) + "\n", { flag: "wx", mode: 0o600 });

    // Reserve both names exclusively before publishing either staged directory.
    store.db.transaction(() => {
      try { mkdirSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") experimentError("EXPERIMENT_CODE_EXISTS", 409);
        throw error;
      }
      ownsCode = true;
      mkdirSync(archive);
      ownsArchive = true;
      renameSync(codeStage, path);
      store.saveRepository(repository, false);
      renameSync(stagedArchive, archive);
    })();
    return { experiment, repository };
  } catch (error) {
    if (ownsArchive) rmSync(archive, { recursive: true });
    if (ownsCode) rmSync(path, { recursive: true });
    throw error;
  } finally {
    if (info(codeStage)) rmSync(codeStage, { recursive: true });
    if (archiveStage && info(archiveStage)) rmSync(archiveStage, { recursive: true });
  }
}

export function setExperimentCode(root: string, input: z.infer<typeof experimentCatalogUpdate>) {
  assertExperimentScheme(root, input.direction_id, input.scheme_id);
  const path = join(root, "experiments", input.direction_id, input.scheme_id, ".experiment-code.json");
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(input.code, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (info(temporary)) rmSync(temporary);
  }
}
