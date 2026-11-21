import { z } from "zod";

export const manuscriptId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const manuscriptTitle = z.string().trim().min(1).max(160);
export const manuscriptStatus = z.enum(["draft", "revision", "submitted"]);
export const manuscriptSection = z.enum(["drafts", "figures", "equations", "tables", "references", "exports", "work"]);
export const manuscriptDraftPath = z.string().max(4096).refine(value =>
  value.startsWith("drafts/") && !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && !part.startsWith("."))
);
export const manuscriptManifest = z.object({
  format_version: z.literal(1),
  title: manuscriptTitle,
  status: manuscriptStatus,
  current: manuscriptDraftPath.nullable()
}).strict();

// Keep the managed YAML file in YAML's JSON-compatible subset.
export const manuscriptDocument = (record: z.infer<typeof manuscriptManifest>) => JSON.stringify(record, null, 2) + "\n";
