import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { ExperimentStore, TrashStore } from "@trash/storage";
import type { SshProfile } from "@trash/protocol";
import { SshService } from "../src/experiment/ssh.js";

test("controlled SSH requires observed fingerprint, verifies authentication and preserves argument boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "trash-ssh-test-"));
  const store = new TrashStore(root); const data = new ExperimentStore(store.db); const ssh = new SshService(data);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs1" }, publicKeyEncoding: { format: "pem", type: "pkcs1" } }).privateKey;
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    client.on("error", () => {});
    client.on("authentication", ctx => { if (ctx.method === "password" && ctx.username === "fixture" && ctx.password === "fixture-password") ctx.accept(); else ctx.reject(); });
    client.on("ready", () => client.on("session", accept => {
      accept().on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const child = spawn("/bin/sh", ["-c", info.command], { cwd: root });
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false }); stream.pipe(child.stdin);
        child.on("close", code => { stream.exit(code ?? 1); stream.end(); });
      });
    }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const project = store.createProject({ title: "SSH fixture", research_question: "Controlled fixture", module: { id: "apt-provenance", version: "0.1.0" } });
    const profile: SshProfile = { profile_id: "ssh_fixture", project_id: project.project_id, name: "Fixture", host: "127.0.0.1", port: address.port, username: "fixture", remote_root: join(root, "remote"), auth: "password", created_at: new Date().toISOString() };
    data.saveProfile(profile);
    await assert.rejects(ssh.connect(profile), /SSH_FINGERPRINT_REQUIRED/);
    assert.throws(() => ssh.confirm(profile, "unobserved"), /SSH_FINGERPRINT_NOT_OBSERVED/);
    const fingerprint = await ssh.probe(profile); assert.match(fingerprint, /^SHA256:/); ssh.confirm(profile, fingerprint);
    const trusted = data.profile(project.project_id, profile.profile_id);
    await assert.rejects(ssh.connect(trusted), /SSH_CREDENTIAL_REQUIRED/);
    ssh.setCredential(profile.profile_id, { password: "wrong" }); await assert.rejects(ssh.connect(trusted), /SSH_AUTH_FAILED/);
    ssh.setCredential(profile.profile_id, { password: "fixture-password" });
    await assert.rejects(ssh.connect({ ...trusted, fingerprint: "SHA256:changed" }), /SSH_FINGERPRINT_CHANGED/);
    const remote = await ssh.connect(trusted);
    try { assert.equal(await remote.exec(["printf", "%s", "a ' quote; $(touch should-not-exist)\nsecond"]), "a ' quote; $(touch should-not-exist)\nsecond"); }
    finally { remote.close(); }
    ssh.forget(profile.profile_id); await assert.rejects(ssh.connect(trusted), /SSH_CREDENTIAL_REQUIRED/);
  } finally { ssh.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
