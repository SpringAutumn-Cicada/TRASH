import {StringDecoder} from 'node:string_decoder';

/** Interpret CLI JSONL independently of transport chunk boundaries. */
export class CliTurnResult {
 private decoder=new StringDecoder('utf8');
 private pending='';
 private completed=false;
 private terminalFailure='';
 private unknownFailure='';
 private reconnectWarning='';
 private invalidStream=false;
 constructor(private notify:(message:string)=>void){}
 push(chunk:Buffer){this.pending+=this.decoder.write(chunk);this.drain();}
 finish(){this.pending+=this.decoder.end();this.drain();if(this.pending.trim())this.line(this.pending);this.pending='';}
 private drain(){let newline:number;while((newline=this.pending.indexOf('\n'))>=0){this.line(this.pending.slice(0,newline));this.pending=this.pending.slice(newline+1);}if(this.pending.length>4*1024*1024){this.pending='';this.invalidStream=true;}}
 private line(line:string){
  let event:{type?:string;message?:string;error?:{message?:string}};
  try{event=JSON.parse(line);}catch{return;}
  if(!event||typeof event!=='object')return;
  const message=String(event.error?.message??event.message??'模型调用失败');
  if(event.type==='turn.failed'){this.completed=false;this.terminalFailure=message;}
  else if(event.type==='error'){
   if(/^Reconnecting\.\.\./i.test(message)){
    this.reconnectWarning=message;this.notify('连接状态：连接中断，正在重连');
   }else this.unknownFailure=message;
  }else if(event.type==='turn.completed'){
   this.completed=true;
   if(this.reconnectWarning){this.notify('连接状态：重连后模型调用已完成');this.reconnectWarning='';}
  }
 }
 failure(code:number|null,signal?:string|null):string|undefined{
  if(code!==0)return this.terminalFailure||this.unknownFailure||this.reconnectWarning||`模型进程异常退出（${signal??code}）`;
  if(this.terminalFailure)return this.terminalFailure;
  if(this.unknownFailure)return this.unknownFailure;
  if(this.invalidStream)return '模型事件流超限，无法确认完整结果';
  if(!this.completed)return this.reconnectWarning||'模型进程未返回turn.completed，结果尚未确认';
 }
}
