import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerResponse } from "node:http";
import ssh2 from "ssh2";
import { TrashStore, ExperimentStore } from "@trash/storage";
import type { SshProfile } from "@trash/protocol";
import { SshService } from "../src/experiment/ssh.js";
import { TerminalService } from "../src/experiment/terminal.js";

test("terminal shells share one SSH transport, survive viewer detach and close only explicitly",async()=>{
 const root=mkdtempSync(join(tmpdir(),"trash-terminal-")),store=new TrashStore(root),data=new ExperimentStore(store.db);
 const ssh=new SshService(data,root),terminals=new TerminalService(ssh);
 const key=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{format:"pem",type:"pkcs1"},publicKeyEncoding:{format:"pem",type:"pkcs1"}}).privateKey;
 let connections=0,shells=0;
 const server=new ssh2.Server({hostKeys:[key]},client=>{
  client.on("error",()=>{});
  client.on("authentication",context=>context.method==="password"&&context.password==="fixture"?context.accept():context.reject());
  client.on("ready",()=>{connections++;client.on("session",accept=>{
   const session=accept();session.on("pty",accept=>accept?.());session.on("window-change",accept=>accept?.());
   session.on("shell",accept=>{shells++;const channel=accept();channel.on("error",()=>{});channel.write("fixture ready\r\n");channel.on("data",chunk=>channel.write(chunk));});
  });});
 });
 try {
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
  const project=store.createProject({title:"Terminal",research_question:"Sessions",module:{id:"apt-provenance",version:"0.1.0"}}).project_id;
  const profile:SshProfile={profile_id:"ssh_fixture",project_id:project,name:"Fixture",host:"127.0.0.1",port:address.port,username:"fixture",remote_root:root,auth:"password",created_at:new Date().toISOString()};
  data.saveProfile(profile);ssh.confirm(profile,await ssh.probe(profile));ssh.setCredential(profile.profile_id,{password:"fixture"});
  const trusted=data.profile(project,profile.profile_id);
  assert.throws(()=>terminals.connection(project,profile.profile_id),/SSH_NOT_CONNECTED/);
  const first=await terminals.connect(project,trusted);const remote=terminals.connection(project,profile.profile_id);
  const second=await terminals.split(project,first.id,first.token);
  assert.equal(connections,1);assert.equal(shells,2);assert.equal(terminals.connection(project,profile.profile_id),remote);
  assert.throws(()=>terminals.input("another-project",first.id,first.token,"unsafe"),/TERMINAL_NOT_FOUND/);
  let output="";
  const viewer=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,writableLength:0,writeHead:()=>{},flushHeaders:()=>{},write:(text:string)=>{output+=text;},end:()=>{},destroy:()=>{}});
  terminals.attach(project,second.id,second.token,viewer as unknown as ServerResponse,0);
  terminals.input(project,second.id,second.token,"echo-fixture\n");
  for(let i=0;i<100&&!output.includes(Buffer.from("echo-fixture\n").toString("base64"));i++)await delay(10);
  assert.ok(output.includes(Buffer.from("echo-fixture\n").toString("base64")));
  viewer.emit("close");await delay(30);assert.equal(terminals.list(project).length,2);
  terminals.resize(project,second.id,second.token,80,24);
  terminals.remove(project,first.id,first.token);assert.equal(terminals.list(project).length,1);assert.equal(terminals.connection(project,profile.profile_id),remote);
  terminals.remove(project,second.id,second.token);assert.equal(terminals.list(project).length,0);
  assert.throws(()=>terminals.connection(project,profile.profile_id),/SSH_NOT_CONNECTED/);
 } finally {terminals.close();ssh.close();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});}
});
