import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { experimentError } from "@trash/storage";
import { z } from "zod";

const execute = promisify(execFile);
const safeText = (value: string) => !/[<>\x00-\x1f\x7f]/.test(value);
export const gitIdentityInput = z.object({
  name: z.string().trim().min(1).max(120).refine(safeText),
  email: z.string().trim().max(254).email().refine(safeText),
}).strict();
type GitIdentity = z.infer<typeof gitIdentityInput>;
export type ResolvedGitIdentity = {
  author: GitIdentity;
  committer: GitIdentity;
  source: "repository" | "platform" | "git";
};

export function gitIdentityEnv({ author, committer }: ResolvedGitIdentity) {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

async function gitConfig(path: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    return (await execute("git", ["-C", path, "-c", "user.useConfigOnly=true", ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 5000, maxBuffer: 65536,
    })).stdout;
  } catch (error) {
    if ([1, 128].includes(Number((error as NodeJS.ErrnoException).code))) return "";
    experimentError("GIT_IDENTITY_UNAVAILABLE", 503);
  }
}

function parseGitIdentity(output: string): GitIdentity | undefined {
  const match = /^(.+) <([^<>]+)> \d+ [+-]\d{4}$/.exec(output.trim());
  if (!match?.[1] || !match[2]) return;
  return { name: match[1], email: match[2] };
}

export class GitIdentitySettings {
  private readonly file?: string;
  constructor(root?: string) {
    if (root) this.file = join(root, "settings", "git-identity.json");
  }

  get(): GitIdentity | null {
    if (!this.file) return null;
    try {
      return gitIdentityInput.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      experimentError("GIT_IDENTITY_SETTINGS_UNAVAILABLE", 503);
    }
  }

  save(input: unknown): GitIdentity | null {
    const value = gitIdentityInput.nullable().safeParse(input);
    if (!value.success) experimentError("GIT_IDENTITY_INVALID", 400);
    if (!this.file) experimentError("GIT_IDENTITY_SETTINGS_UNAVAILABLE", 503);
    if (!value.data) {
      rmSync(this.file, { force: true });
      return null;
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(value.data) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
    return value.data;
  }

  async resolve(path: string): Promise<ResolvedGitIdentity | undefined> {
    const variables = (await gitConfig(path, ["config", "--show-scope", "--null", "--get-regexp", "^user\\.(name|email)$"])).split("\0");
    const repository = new Map<string, string>();
    for (let index = 0; index + 1 < variables.length; index += 2) {
      if (variables[index] !== "local" && variables[index] !== "worktree") continue;
      const entry = variables[index + 1];
      const delimiter = entry.indexOf("\n");
      if (delimiter >= 0) repository.set(entry.slice(0, delimiter), entry.slice(delimiter + 1).trim());
    }
    const name = repository.get("user.name");
    const email = repository.get("user.email");
    const local = name && email && safeText(name) && safeText(email) ? { name, email } : undefined;
    const configured = local ?? this.get();
    const source = local ? "repository" : configured ? "platform" : "git";
    const env = configured ? { ...process.env, ...gitIdentityEnv({ author: configured, committer: configured, source }) } : process.env;
    const [author, committer] = await Promise.all([
      gitConfig(path, ["var", "GIT_AUTHOR_IDENT"], env).then(parseGitIdentity),
      gitConfig(path, ["var", "GIT_COMMITTER_IDENT"], env).then(parseGitIdentity),
    ]);
    if (author && committer) return { author, committer, source };
  }

  async require(path: string) {
    return await this.resolve(path) ?? experimentError("GIT_IDENTITY_REQUIRED", 409);
  }
}
