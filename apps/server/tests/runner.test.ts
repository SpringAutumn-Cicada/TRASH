import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { REMOTE_RUNNER } from "../src/experiment/runner.js";

test("Python runner fixes commit, records metrics, rejects damaged bundles and handles timeout/cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "trash-runner-test-"));
  const repo = join(root, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(repo); git("init", "-b", "main");
    writeFileSync(join(repo, "run.py"), "import os,json,pathlib\nprint('fixture-output',flush=True)\npathlib.Path(os.environ['TRASH_OUTPUT_DIR'],'metrics.json').write_text(json.dumps({'metrics':[{'name':'f1','value':0.81,'unit':'ratio','condition':'test'}]}))\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const commit = git("rev-parse", "HEAD");
    git("bundle", "create", join(root, "code.bundle"), "HEAD");
    const bundle = readFileSync(join(root, "code.bundle"));
    const fixture = (name: string, command: string[], timeout = 20) => {
      const dir = join(root, name); mkdirSync(join(dir, "runner"), { recursive: true });
      // Isolate the host lock from all user experiments.
      const runner = REMOTE_RUNNER.replace("'/tmp/trash-experiment-' + str(os.getuid()) + '.lock'", JSON.stringify(join(root, "host.lock")));
      writeFileSync(join(dir, "runner", "runner.py"), runner);
      writeFileSync(join(dir, "code.bundle"), bundle);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ run_id: randomUUID(), token: "fixture-token", bundle_sha256: createHash("sha256").update(bundle).digest("hex"), commit_sha: commit, python: "/usr/bin/python3", command, env: {}, config: { seed: 42 }, gpu: "cpu", timeout_seconds: timeout, metrics_path: "outputs/metrics.json", artifact_paths: [] }));
      return dir;
    };
    const execute = (dir: string, action = "run", ...args: string[]) => execFileSync("python3", [join(dir, "runner/runner.py"), action, dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const state = (dir: string) => JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    const good = fixture("good", ["python", "run.py"]);
    execute(good); assert.equal(state(good).state, "completed"); assert.equal(state(good).exit_code, 0);
    assert.equal(execFileSync("git", ["-C", join(good, "code"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), commit);
    assert.match(readFileSync(join(good, "logs/stdout.log"), "utf8"), /fixture-output/);
    const artifacts = JSON.parse(execute(good, "collect")) as { path: string; sha256: string }[];
    assert.ok(artifacts.some(a => a.path === "outputs/metrics.json" && a.sha256.length === 64));
    const before = readFileSync(join(good, "status.json"), "utf8"); execute(good); assert.equal(readFileSync(join(good, "status.json"), "utf8"), before);
    const damaged = fixture("damaged", ["python", "run.py"]); writeFileSync(join(damaged, "code.bundle"), "damaged"); execute(damaged);
    assert.equal(state(damaged).reason, "BUNDLE_HASH_MISMATCH");
    const timeout = fixture("timeout", ["python", "-c", "import time; time.sleep(30)"], 1); execute(timeout);
    assert.equal(state(timeout).reason, "timeout"); assert.equal(state(timeout).state, "failed");
    const cancelled = fixture("cancel", ["python", "-c", "import time; time.sleep(30)"]);
    const child = spawn("python3", [join(cancelled, "runner/runner.py"), "run", cancelled], { stdio: "ignore" });
    const exited = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`runner exit ${code}`))); });
    try {
      assert.throws(() => execute(cancelled, "cancel", "wrong-token"), /TOKEN_MISMATCH/);
      execute(cancelled, "cancel", "fixture-token"); await exited;
      assert.equal(state(cancelled).state, "cancelled");
    } finally { child.kill("SIGKILL"); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
