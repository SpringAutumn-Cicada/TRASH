import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverComputeResources, assertComputeSelection } from '../src/experiment/compute-resources.js';
import type { RemoteConnection } from '../src/experiment/ssh.js';
const remote=(output:string)=>({exec:async()=>output}) as unknown as RemoteConnection;
test('resource discovery respects visibility and does not assume GPU zero',async()=>{
 const resources=await discoverComputeResources(remote('TRASH_VISIBLE=2\n0, GPU-a, Hidden card, 24576, 23000\n2, GPU-b, Visible card, 49152, 32000\n'));
 assert.deepEqual(resources.gpus.map(item=>item.index),['2']);assert.equal(resources.gpus[0].memory_free_mib,32000);
 assert.throws(()=>assertComputeSelection(resources,'0'),/GPU_UNAVAILABLE/);assert.doesNotThrow(()=>assertComputeSelection(resources,'2'));
});
test('unknown GPU memory stays unknown; unsupported CPU and multi-GPU are rejected',async()=>{
 const resources=await discoverComputeResources(remote('TRASH_VISIBLE=TRASH_ALL\n1, GPU-a, Card A, 24576, N/A\n3, GPU-b, Card B, 24576, 16000\n'));
 assert.equal(resources.gpus[0].memory_free_mib,null);
 const policy={device:'gpu' as const,notes:'fixture',cpu_supported:'unsupported' as const,multi_gpu:false,attribution:'declared' as const,evidence:[]};
 assert.throws(()=>assertComputeSelection(resources,'cpu',policy),/EXPERIMENT_CPU_UNSUPPORTED/);
 assert.throws(()=>assertComputeSelection(resources,'1,3',policy),/EXPERIMENT_MULTI_GPU_UNSUPPORTED/);
 assert.doesNotThrow(()=>assertComputeSelection(resources,'1,3',{...policy,multi_gpu:true}));
});
test('driver failure returns unknown resources, not a fabricated GPU',async()=>{
 const broken={exec:async()=>{throw new Error('driver failed');}} as unknown as RemoteConnection;
 const resources=await discoverComputeResources(broken);assert.equal(resources.gpu_status,'failed');assert.deepEqual(resources.gpus,[]);
 assert.throws(()=>assertComputeSelection(resources,'0'),/GPU_UNAVAILABLE/);
});

test('an explicitly empty CUDA visibility mask does not expose hidden devices',async()=>{
 const resources=await discoverComputeResources(remote('TRASH_VISIBLE=\n0, GPU-hidden, Hidden card, 24576, 23000\n'));
 assert.deepEqual(resources.gpus,[]);assert.equal(resources.gpu_status,'unavailable');
});
