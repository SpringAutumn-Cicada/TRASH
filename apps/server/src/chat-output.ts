export interface ChatOutput {id:string;kind:'message'|'tool';status:'running'|'completed'|'failed';text:string;title?:string;at:string}
// Only public assistant messages and tool activity are displayed; reasoning stays out of the transcript.
export function readChatOutput(event:unknown,previous:ChatOutput[],clean:(text:string)=>string):ChatOutput[]{
  if(!event||typeof event!=='object')return previous;
  const value=event as {type?:string;item?:{id?:string;type?:string;text?:string;command?:string;name?:string;tool?:string;status?:string;aggregated_output?:string;exit_code?:number|null}};
  if(!['item.started','item.updated','item.completed'].includes(value.type??'')||!value.item)return previous;
  const item=value.item;
  if(item.type!=='agent_message'&&!['command_execution','mcp_tool_call','file_change','web_search'].includes(item.type??''))return previous;
  if(typeof item.id!=='string')return previous;
  const done=value.type==='item.completed';
  const titles:Record<string,string>={command_execution:'执行命令',mcp_tool_call:'调用项目工具',file_change:'更新文件',web_search:'检索资料'};
  const entry:ChatOutput={id:item.id,kind:item.type==='agent_message'?'message':'tool',status:item.status==='failed'||(done&&typeof item.exit_code==='number'&&item.exit_code!==0)?'failed':done?'completed':'running',text:clean(item.type==='agent_message'?item.text??'':item.command??item.tool??item.name??'').slice(0,64000),title:titles[item.type??''],at:previous.find(entry=>entry.id===item.id)?.at??new Date().toISOString()};
  const budget=Math.max(0,1024*1024-previous.filter(value=>value.id!==entry.id).reduce((sum,value)=>sum+value.text.length,0));entry.text=entry.text.slice(0,budget);
  const result=[...previous],index=result.findIndex(entry=>entry.id===item.id);
  if(index>=0)result[index]=entry;else if(result.length<200)result.push(entry);
  return result;
}
