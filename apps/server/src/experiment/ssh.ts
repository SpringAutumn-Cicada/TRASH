import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type SFTPWrapper } from "ssh2";
import { ExperimentStore, experimentError } from "@trash/storage";
import type { SshProfile } from "@trash/protocol";
import { CredentialStore } from "./credential-store.js";
export const quote = (value:string):string => `'${value.replace(/'/g, `'"'"'`)}'`;
export function redact(value:string):string {return value.replace(/(Bearer\s+)[\w.-]+/gi,"$1[REDACTED]").replace(/\bsk-[\w-]+/g,"[REDACTED]").replace(/((?:password|passphrase|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]");}
function connectionFailure(error:Error):string {
  const detail=error as Error&{code?:string;level?:string};
  if(detail.level==='client-authentication')return 'SSH_AUTH_FAILED';
  if(detail.code==='ENOTFOUND'||detail.code==='EAI_AGAIN'||detail.level==='client-dns')return 'SSH_DNS_FAILED';
  if(detail.code==='ECONNREFUSED')return 'SSH_CONNECTION_REFUSED';
  if(detail.code==='ETIMEDOUT'||detail.level==='client-timeout')return 'SSH_CONNECTION_TIMEOUT';
  if(detail.code==='ECONNRESET'||detail.code==='EPIPE')return 'SSH_CONNECTION_RESET';
  if(detail.code==='ENETUNREACH'||detail.code==='EHOSTUNREACH')return 'SSH_HOST_UNREACHABLE';
  if(detail.level==='handshake')return 'SSH_HANDSHAKE_FAILED';
  return 'SSH_CONNECTION_FAILED';
}
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
      let settled=false;
      const finish=(code?:string)=>{if(settled)return;settled=true;clearTimeout(timer);this.clients.delete(client);client.destroy();if(code)reject(Object.assign(new Error(code),{statusCode:422}));else resolve(fingerprint!);};
      const timer=setTimeout(()=>finish('SSH_CONNECTION_TIMEOUT'),30000);
      client.on("error",error=>finish(fingerprint?undefined:connectionFailure(error)));
      client.on("close",()=>finish(fingerprint?undefined:'SSH_CONNECTION_CLOSED'));
      try{client.connect({host:profile.host,port:profile.port,username:profile.username,readyTimeout:30000,hostVerifier:(key:Buffer)=>{fingerprint=`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/,"")}`;this.observed.set(profile.profile_id,fingerprint);return false;}});}catch(error){finish(connectionFailure(error instanceof Error?error:new Error('SSH_CONNECTION_FAILED')));}

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
      const client=new Client();this.clients.add(client);let mismatch=false;let ready=false;let settled=false;
      const fail=(code:string)=>{if(settled)return;settled=true;this.clients.delete(client);client.destroy();reject(Object.assign(new Error(code),{statusCode:422}));};
      client.on("close",()=>{this.clients.delete(client);if(!ready)fail(mismatch?"SSH_FINGERPRINT_CHANGED":"SSH_CONNECTION_CLOSED");});
      client.on("error",error=>{if(!ready)fail(mismatch?"SSH_FINGERPRINT_CHANGED":connectionFailure(error));});
      client.once("ready",()=>{if(settled){client.destroy();return;}settled=true;ready=true;resolve(new RemoteConnection(client));});
      try{client.connect({host:profile.host,port:profile.port,username:profile.username,readyTimeout:30000,keepaliveInterval:10000,keepaliveCountMax:3,
        ...(profile.auth==="password"?{password:credentials.password}:profile.auth==="key"?{privateKey:key,passphrase:credentials.passphrase}:{agent:process.env.SSH_AUTH_SOCK}),
        hostVerifier:(raw:Buffer)=>{const fingerprint=`SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/,"")}`;mismatch=fingerprint!==profile.fingerprint;return !mismatch;}});}catch(error){fail(mismatch?'SSH_FINGERPRINT_CHANGED':connectionFailure(error instanceof Error?error:new Error('SSH_CONNECTION_FAILED')));}

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
  async upload(local:string,remote:string,onProgress?:(sent:number,total:number)=>void,signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)throw new Error("UPLOAD_CANCELLED");
    const sftp=await this.sftp();
    try{await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;signal?.removeEventListener("abort",abort);if(error)reject(error);else resolve();};
      const abort=()=>{sftp.destroy();};
      // Wait for this SFTP channel to close before deleting its partial files.
      sftp.once("close",()=>finish(new Error(signal?.aborted?"UPLOAD_CANCELLED":"SFTP_UPLOAD_FAILED")));
      sftp.on("error",()=>{if(!signal?.aborted)finish(new Error("SFTP_UPLOAD_FAILED"));});
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted){abort();return;}
      sftp.fastPut(local,remote,{step:(total:number,_chunk:number,size:number)=>{if(!signal?.aborted)onProgress?.(total,size);}},error=>{if(!signal?.aborted)finish(error?new Error("SFTP_UPLOAD_FAILED"):undefined);});
    });}finally{sftp.end();}
  }
  async write(remote:string,value:string):Promise<void>{const sftp=await this.sftp();try{await new Promise<void>((resolve,reject)=>sftp.writeFile(remote,value,{mode:0o600},error=>error?reject(new Error("SFTP_WRITE_FAILED")):resolve()));}finally{sftp.end();}}
  async consume(remote:string,maxBytes:number,onChunk:(chunk:Buffer)=>void,offset=0):Promise<number>{
    const sftp=await this.sftp();let handle:Buffer|undefined;let size=0;
    try{
      handle=await new Promise<Buffer>((resolve,reject)=>sftp.open(remote,"r",(error,value)=>error?reject(new Error("SFTP_READ_FAILED")):resolve(value)));
      while(size<maxBytes){
        const buffer=Buffer.alloc(Math.min(64*1024,maxBytes-size));
        const bytes=await new Promise<number>((resolve,reject)=>sftp.read(handle!,buffer,0,buffer.length,offset+size,(error,count)=>error?reject(new Error("SFTP_READ_FAILED")):resolve(count)));
        if(!bytes)break;size+=bytes;onChunk(buffer.subarray(0,bytes));
      }
      return size;
    }finally{
      if(handle)await new Promise<void>(resolve=>sftp.close(handle!,()=>resolve()));
      sftp.end();
    }
  }
  async read(remote:string,maxBytes:number,offset=0):Promise<Buffer>{
    if(maxBytes===0)return Buffer.alloc(0);
    const chunks:Buffer[]=[];
    await this.consume(remote,maxBytes,chunk=>chunks.push(chunk),offset);
    return Buffer.concat(chunks);
  }
}
