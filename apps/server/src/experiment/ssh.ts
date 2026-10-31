import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type SFTPWrapper } from "ssh2";
import { ExperimentStore, experimentError } from "@trash/storage";
import type { SshProfile } from "@trash/protocol";
import { CredentialStore } from "./credential-store.js";
export const quote = (value:string):string => `'${value.replace(/'/g, `'"'"'`)}'`;
export function redact(value:string):string {return value.replace(/(Bearer\s+)[\w.-]+/gi,"$1[REDACTED]").replace(/\bsk-[\w-]+/g,"[REDACTED]").replace(/((?:password|passphrase|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]");}
export class SshService {
  private credentials=new Map<string,{password?:string;passphrase?:string}>();
  private observed=new Map<string,string>();
  private clients=new Set<Client>();private closed=false;
  private saved:CredentialStore;
  constructor(readonly store:ExperimentStore,root:string) {this.saved=new CredentialStore(root);}
  private credential(id:string):{password?:string;passphrase?:string}{
    const current=this.credentials.get(id);if(current?.password)return current;
    const password=this.saved.read(id);const value={...current,...(password?{password}:{})};
    if(password)this.credentials.set(id,value);return value;
  }
  setCredential(id:string,value:{password?:string;passphrase?:string}):void{if(value.password)this.saved.save(id,value.password);this.credentials.set(id,{...this.credentials.get(id),...value});}
  passwordForEditing(profile:SshProfile):string|null{return profile.auth==="password"?this.credential(profile.profile_id).password??null:null;}
  forget(id:string):void{this.saved.remove(id);this.credentials.delete(id);this.observed.delete(id);}
  hasCredential(profile:SshProfile):boolean{return profile.auth==="agent"?Boolean(process.env.SSH_AUTH_SOCK):profile.auth==="key"?true:Boolean(this.credential(profile.profile_id).password);}
  close():void{this.closed=true;for(const client of this.clients)client.destroy();this.clients.clear();this.credentials.clear();this.observed.clear();}
  async probe(profile:SshProfile):Promise<string>{
    return new Promise((resolve,reject)=>{
      const client=new Client();this.clients.add(client);let fingerprint:string|undefined;
      const timer=setTimeout(()=>{client.destroy();reject(Object.assign(new Error("SSH_NETWORK_FAILED"),{statusCode:422}));},15000);
      client.on("error",()=>{if(!fingerprint)reject(Object.assign(new Error("SSH_NETWORK_FAILED"),{statusCode:422}));});
      client.on("close",()=>{clearTimeout(timer);this.clients.delete(client);if(fingerprint)resolve(fingerprint);else reject(Object.assign(new Error("SSH_NETWORK_FAILED"),{statusCode:422}));});
      client.connect({host:profile.host,port:profile.port,username:profile.username,readyTimeout:15000,hostVerifier:(key:Buffer)=>{fingerprint=`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/,"")}`;this.observed.set(profile.profile_id,fingerprint);return false;}});
    });
  }
  confirm(profile:SshProfile,fingerprint:string):void{if(this.observed.get(profile.profile_id)!==fingerprint)experimentError("SSH_FINGERPRINT_NOT_OBSERVED",409);if(this.store.runs().some(r=>r.profile_id===profile.profile_id&&this.store.active(r)))experimentError("EXPERIMENT_ACTIVE",409);this.store.saveProfile({...profile,fingerprint});this.observed.delete(profile.profile_id);}
  async connect(profile:SshProfile):Promise<RemoteConnection>{
    if(this.closed)experimentError("SERVER_STOPPING",409);
    if(!profile.fingerprint)experimentError("SSH_FINGERPRINT_REQUIRED",409);
    const credentials=this.credential(profile.profile_id);
    if(profile.auth==="password"&&!credentials.password)experimentError("SSH_CREDENTIAL_REQUIRED",409);
    const key=profile.auth==="key"?await readFile(profile.key_path??experimentError("SSH_KEY_REQUIRED")):undefined;
    if(profile.auth==="agent"&&!process.env.SSH_AUTH_SOCK)experimentError("SSH_AGENT_UNAVAILABLE",409);
    return new Promise((resolve,reject)=>{
      const client=new Client();this.clients.add(client);let mismatch=false;let ready=false;
      client.on("close",()=>{this.clients.delete(client);if(!ready)reject(Object.assign(new Error(mismatch?"SSH_FINGERPRINT_CHANGED":"SSH_CONNECTION_FAILED"),{statusCode:422}));});
      client.on("error",error=>reject(Object.assign(new Error(mismatch?"SSH_FINGERPRINT_CHANGED":("level" in error&&error.level==="client-authentication"?"SSH_AUTH_FAILED":"SSH_CONNECTION_FAILED")),{statusCode:422})));
      client.once("ready",()=>{ready=true;resolve(new RemoteConnection(client));});
      client.connect({host:profile.host,port:profile.port,username:profile.username,readyTimeout:15000,keepaliveInterval:10000,keepaliveCountMax:3,
        ...(profile.auth==="password"?{password:credentials.password}:profile.auth==="key"?{privateKey:key,passphrase:credentials.passphrase}:{agent:process.env.SSH_AUTH_SOCK}),
        hostVerifier:(raw:Buffer)=>{const fingerprint=`SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/,"")}`;mismatch=fingerprint!==profile.fingerprint;return !mismatch;}});
    });
  }
}
export class RemoteConnection {
  constructor(readonly client:Client) {}
  close():void{this.client.end();}
  exec(args:string[],input?:string,timeout=60000,maxBytes=8*1024*1024):Promise<string>{
    return new Promise((resolve,reject)=>{
      let settled=false;const finish=(error:Error|null,output="")=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(output);};
      const timer=setTimeout(()=>{this.client.destroy();finish(new Error("SSH_COMMAND_TIMEOUT"));},timeout);
      this.client.exec(args.map(quote).join(" "),(error,stream)=>{
        if(error){finish(new Error("SSH_COMMAND_FAILED"));return;}let stdout="",stderr="",size=0;
        stream.on("data",(data:Buffer)=>{size+=data.length;if(size>maxBytes){stream.close();finish(new Error("SSH_RESPONSE_TOO_LARGE"));}else stdout+=data.toString();});
        stream.stderr.on("data",(data:Buffer)=>{size+=data.length;stderr+=data.toString();if(size>maxBytes){stream.close();finish(new Error("SSH_RESPONSE_TOO_LARGE"));}});
        stream.on("error",()=>finish(new Error("SSH_COMMAND_FAILED")));
        stream.on("close",(code:number)=>finish(code===0?null:new Error(`REMOTE_COMMAND_FAILED: ${redact(stderr).slice(0,2000)}`),stdout));
        stream.end(input);
      });
    });
  }
  sftp():Promise<SFTPWrapper>{return new Promise((resolve,reject)=>this.client.sftp((error,sftp)=>error?reject(new Error("SFTP_FAILED")):resolve(sftp)));}
  async upload(local:string,remote:string):Promise<void>{const sftp=await this.sftp();try{await new Promise<void>((resolve,reject)=>sftp.fastPut(local,remote,error=>error?reject(new Error("SFTP_UPLOAD_FAILED")):resolve()));}finally{sftp.end();}}
  async write(remote:string,value:string):Promise<void>{const sftp=await this.sftp();try{await new Promise<void>((resolve,reject)=>sftp.writeFile(remote,value,{mode:0o600},error=>error?reject(new Error("SFTP_WRITE_FAILED")):resolve()));}finally{sftp.end();}}
  async read(remote:string,maxBytes:number,offset=0):Promise<Buffer>{
    if(maxBytes===0)return Buffer.alloc(0);
    const sftp=await this.sftp();try{return await new Promise<Buffer>((resolve,reject)=>{
      const stream=sftp.createReadStream(remote,{start:offset,end:offset+maxBytes-1});const chunks:Buffer[]=[];let size=0;
      stream.on("data",(data:Buffer)=>{size+=data.length;if(size>maxBytes){stream.destroy(new Error("REMOTE_FILE_TOO_LARGE"));return;}chunks.push(data);});
      stream.on("error",()=>reject(new Error("SFTP_READ_FAILED")));stream.on("end",()=>resolve(Buffer.concat(chunks)));
    });}finally{sftp.end();}
  }
}
