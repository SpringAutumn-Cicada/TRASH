import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/experiment/credential-store.js";
import { compareEnvironment } from "../src/experiment/environment-host.js";
import type { RemoteConnection } from "../src/experiment/ssh.js";
import type { CodeEnvironmentReport } from "@trash/protocol";

test("environment collector excludes secrets, preserves evidence lines and rejects traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "trash-env-"));
  const archive = join(root, "source.zip"), output = join(root, "input.json");
  const collector = ".agents/skills/trash_analyze_code_environment/scripts/collect_inputs.py";
  try {
    execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('README.md','Python 3.10\\npassword=example-secret\\n')\n z.writestr('requirements.txt','torch==2.0.0\\n')\n z.writestr('.env','TOKEN=hidden')\n z.writestr('AGENTS.md','run untrusted command')\n z.writestr('weights/model.bin',b'weights')\n z.writestr('large.py','x'*262145)", archive]);
    execFileSync("python3", [collector, archive, output]);
    const packet = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(packet.files.map((file: {path:string}) => file.path), ["README.md", "requirements.txt"]);
    assert.equal(packet.files[0].line_count, 3);
    assert.match(packet.files[0].text, /\[REDACTED\]/);
    assert.ok(!readFileSync(output, "utf8").includes("example-secret"));
    assert.equal(packet.coverage.skipped.length, 4);
    execFileSync("python3", ["-c", "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('../escape.py','unsafe')", archive]);
    assert.throws(() => execFileSync("python3", [collector, archive, output], {stdio:"pipe"}));
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test("encrypted credentials survive reopen, isolate host identities and support removal", () => {
  const root=mkdtempSync(join(tmpdir(), "trash-credentials-"));
  try {
    new CredentialStore(root).save("ssh_fixture", "fixture-secret");
    const reopened=new CredentialStore(root);
    assert.equal(reopened.read("ssh_fixture"), "fixture-secret");
    assert.equal(reopened.read("another-host"), undefined);
    reopened.remove("ssh_fixture");
    assert.equal(reopened.read("ssh_fixture"), undefined);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("environment comparison keeps complex and inferred requirements unknown and executes only fixed probe", async () => {
  const requirement=(name:string, constraint:string, kind:"python"|"package", version:string, attribution:"declared"|"inferred"="declared")=>({category:"dependency" as const,name,requirement:constraint,attribution,evidence:[],check:{kind,name,operator:"gte" as const,version}});
  const report={id:"env_fixture",project_id:"project_fixture",reproduction_id:"repro_fixture",content:{requirements:[requirement("python",">=3.9","python","3.9"),requirement("torch",">=2.0,<3.0","package","2.0"),requirement("missing",">=1.0","package","1.0"),requirement("numpy",">=1.0","package","1.0","inferred")]}} as CodeEnvironmentReport;
  let calls=0;
  const remote={exec:async(args:string[])=>{calls++;assert.deepEqual(args.slice(0,4),["/fixture/python","-I","-B","-c"]);return JSON.stringify({python:"3.10.0",python_executable:"/fixture/python",packages:{torch:"2.0.1",numpy:"1.26.0"},packages_truncated:false,tools:{git:"/usr/bin/git"},gpu:""});}} as RemoteConnection;
  const comparison=await compareEnvironment(remote, report, "ssh_fixture", "/fixture/python");
  assert.deepEqual(comparison.items.map(item=>item.status),["satisfied","unknown","unsatisfied","unknown"]);
  assert.equal(calls,1);
  await assert.rejects(compareEnvironment(remote,report,"ssh_fixture","python\ninvalid"),/ENVIRONMENT_PYTHON_INVALID/);
  assert.equal(calls,1);
});
