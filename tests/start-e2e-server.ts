import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const workspace = mkdtempSync(join(tmpdir(), "trash-e2e-"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts", "--dev"], {
  stdio: "inherit", env: { ...process.env, TRASH_HOME: workspace, TRASH_PORT: "22224" }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error); rmSync(workspace, { recursive: true, force: true }); process.exitCode = 1; });
child.on("exit", code => { rmSync(workspace, { recursive: true, force: true }); process.exitCode = code ?? 0; });
