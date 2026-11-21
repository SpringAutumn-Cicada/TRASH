import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { experimentError } from "@trash/storage";
import type { ExperimentCatalogEntry } from "@trash/protocol";
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
  if (!info(path)) mkdirSync(path);
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

export function createExperiment(root: string, input: unknown): ExperimentCatalogEntry {
  const { title, id } = z.object({
    title: z.string().trim().min(1).max(120).refine(value => !/[\r\n]/.test(value)),
    id: z.string().uuid(),
  }).strict().parse(input);
  const direction_id = "unassigned";
  const scheme_id = `experiment_${id.toLowerCase()}`;
  const base = join(root, "experiments");
  const parent = join(base, direction_id);
  ensureDirectory(base);
  ensureDirectory(parent);
  const target = join(parent, scheme_id);
  if (info(target)) {
    const existing = listExperiments(root).find(item => item.direction_id === direction_id && item.scheme_id === scheme_id);
    if (existing?.title === title) return existing;
    return experimentError("FILES_EXISTS", 409);
  }
  const staging = join(parent, `.experiment-${randomUUID()}`);
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, "README.md"), `# ${title}\n\n## 验证问题\n\n## 对照与评价方式\n`, { flag: "wx" });
    renameSync(staging, target);
  } finally {
    if (info(staging)) rmSync(staging, { recursive: true });
  }
  return { direction_id, scheme_id, title };
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
