import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {z} from 'zod';

export const reasoningEffort=z.enum(['none','minimal','low','medium','high','xhigh','max','ultra']);
const configSchema=z.object({
 model:z.string().nullish(),
 model_reasoning_effort:reasoningEffort.nullish(),
});
const modelsSchema=z.object({data:z.array(z.object({
 model:z.string(),
 isDefault:z.boolean(),
 defaultReasoningEffort:reasoningEffort,
 supportedReasoningEfforts:z.array(z.object({reasoningEffort})),
}))});

export async function readChatModelConfig(command:string,cwd?:string){
 const child=spawn(command,['app-server'],{cwd,stdio:['pipe','pipe','ignore']});
 const lines=createInterface({input:child.stdout});
 const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await new Promise<{
   model:string|null;
   reasoning_effort:z.infer<typeof reasoningEffort>|null;
   models:{id:string;efforts:z.infer<typeof reasoningEffort>[];default_effort:z.infer<typeof reasoningEffort>}[];
  }>((resolve,reject)=>{
   const fail=()=>reject(Object.assign(new Error('CHAT_MODEL_CONFIG_UNAVAILABLE'),{statusCode:503}));
   timer=setTimeout(fail,6500);
   child.once('error',fail);
   child.once('exit',fail);
   child.stdin.on('error',fail);
   let config:z.infer<typeof configSchema>|undefined,models:z.infer<typeof modelsSchema>['data']|undefined;
   lines.on('line',line=>{
    let reply:{id?:number;result?:unknown;error?:unknown};
    try{reply=JSON.parse(line);}catch{return;}
    if(reply.id===1){
     if(reply.error){fail();return;}
     send({method:'initialized'});
     send({id:2,method:'config/read',params:{includeLayers:false,cwd}});
     send({id:3,method:'model/list',params:{limit:100}});
    }
    if(reply.id===2){
     const parsed=z.object({config:configSchema}).safeParse(reply.result);
     if(!parsed.success){fail();return;}
     config=parsed.data.config;
    }
    if(reply.id===3){
     const parsed=modelsSchema.safeParse(reply.result);
     models=parsed.success?parsed.data.data:[];
    }
    if(!config||!models)return;
    const selected=config.model?models.find(item=>item.model===config?.model):models.find(item=>item.isDefault);
    resolve({model:config.model??selected?.model??null,
     reasoning_effort:config.model_reasoning_effort??selected?.defaultReasoningEffort??null,
     models:models.map(item=>({id:item.model,efforts:item.supportedReasoningEfforts.map(option=>option.reasoningEffort),default_effort:item.defaultReasoningEffort}))});
   });
   send({id:1,method:'initialize',params:{clientInfo:{name:'trash-workbench',version:'1'}}});
  });
 }finally{
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  child.kill();
 }
}
