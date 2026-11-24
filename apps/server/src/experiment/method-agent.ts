import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { experimentError, type TrashStore } from "@trash/storage";
import { ProjectFiles } from "../project-files.js";
import { experimentSelection, listExperiments } from "./catalog.js";
import type { ExperimentService } from "./service.js";

export const methodSkillId = "trash-experiment-method";
export const methodSkillDirectory = fileURLToPath(new URL(
  "../../../../.agents/skills/trash-experiment-method/", import.meta.url,
));

export const methodDraftInput = experimentSelection.extend({
  source: z.string().max(4096).regex(/^research\/[^/\\`\r\n\0]+\.md$/i).optional(),
  expected: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const methodDraftOutput = z.object({
  markdown: z.string().min(1).max(100000).refine(text => Boolean(text.trim()) && !text.includes("\0")).nullable(),
  summary: z.string().max(4000),
  questions: z.array(z.string().max(2000)).max(10),
}).strict();

export type MethodDraft = z.infer<typeof methodDraftOutput> & { expected: string };
export type MethodContext = ReturnType<typeof readMethodContext>;

export function readMethodContext(store: TrashStore, service: ExperimentService, project: string, input: z.infer<typeof methodDraftInput>) {
  const root = join(store.root, "projects", project);
  const { direction_id, scheme_id } = input;
  const experiment = listExperiments(root).find(item => item.direction_id === direction_id && item.scheme_id === scheme_id);
  if (!experiment) experimentError("SCHEME_NOT_FOUND", 404);
  const files = new ProjectFiles(store, () => false);
  const document = files.preview(project, `experiments/${direction_id}/${scheme_id}/README.md`);
  if (document.content === undefined || !document.etag) experimentError("METHOD_UNREADABLE", 422);
  if (input.expected && input.expected !== document.etag) experimentError("FILES_CHANGED", 409);
  const repository = service.data.repositories(project).find(item => experiment.repository_id
    ? item.repository_id === experiment.repository_id
    : Boolean(experiment.paper_id && item.paper_id === experiment.paper_id));
  let source: {path: string; content: string} | undefined;
  if (input.source) {
    const note = files.preview(project, input.source);
    if (note.content === undefined) experimentError("METHOD_SOURCE_UNREADABLE", 422);
    source = { path: input.source, content: note.content };
  }
  return { experiment, document, expected: document.etag, repository, source };
}
