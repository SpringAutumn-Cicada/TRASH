import type { HostComputeResources, ExecutionResource } from '@trash/protocol';
import { experimentError } from '@trash/storage';
import type { RemoteConnection } from './ssh.js';
// Fixed read-only probe. No driver initialization, installation or workload is launched.
const PROBE='if ! command -v nvidia-smi >/dev/null 2>&1; then printf "TRASH_GPU_UNAVAILABLE\\n"; exit 0; fi; printf "TRASH_VISIBLE=%s\\n" "${CUDA_VISIBLE_DEVICES-TRASH_ALL}"; nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.free --format=csv,noheader,nounits';
export async function discoverComputeResources(remote:RemoteConnection):Promise<HostComputeResources>{
 const checked_at=new Date().toISOString();let output:string;
 try{output=await remote.exec(['sh','-c',PROBE],undefined,15000);}catch{return {checked_at,gpu_status:'failed',message:'无法读取 GPU 状态，请刷新或检查驱动和 SSH 连接；未假定存在 GPU 0。',gpus:[]};}
 if(output.includes('TRASH_GPU_UNAVAILABLE'))return {checked_at,gpu_status:'unavailable',message:'远端未提供 nvidia-smi，GPU 状态未知；CPU 是否可用以运行方案为准。',gpus:[]};
 const lines=output.trim().split(/\r?\n/),marker=lines.find(line=>line.startsWith('TRASH_VISIBLE='));
 if(marker===undefined)return {checked_at,gpu_status:'failed',message:'远端资源响应不完整，请刷新后重试。',gpus:[]};
 const visible=marker.slice('TRASH_VISIBLE='.length);
 const filters=visible==='TRASH_ALL'?undefined:visible.split(',').map(value=>value.trim()).filter(Boolean);
 const memory=(value:string)=>/^\d+(\.\d+)?$/.test(value)?Number(value):null;
 const gpus:HostComputeResources['gpus']=[];
 for(const line of lines){const fields=line.split(',').map(value=>value.trim());if(fields.length<5||!/^\d+$/.test(fields[0]))continue;
  const index=fields[0],uuid=fields[1];if(filters&&!filters.some(value=>value===index||value===uuid||uuid.startsWith(value)))continue;
  gpus.push({index,uuid,name:fields.slice(2,-2).join(', '),memory_total_mib:memory(fields.at(-2)!),memory_free_mib:memory(fields.at(-1)!)});
 }
 return {checked_at,gpu_status:gpus.length?'available':'unavailable',message:gpus.length?'显存为当前快照，不保证整个实验期间可用。':'未发现当前 SSH 环境可见的 GPU；请核对实例或可见设备设置。',gpus};
}
export function assertComputeSelection(resources:HostComputeResources,gpu:string,policy?:ExecutionResource){
 if(gpu==='cpu'){if(policy?.cpu_supported==='unsupported')experimentError('EXPERIMENT_CPU_UNSUPPORTED',409);return;}
 const ids=gpu.split(',');if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!resources.gpus.some(item=>item.index===id)))experimentError('GPU_UNAVAILABLE',409);
 if(ids.length>1&&!policy?.multi_gpu)experimentError('EXPERIMENT_MULTI_GPU_UNSUPPORTED',409);
}
