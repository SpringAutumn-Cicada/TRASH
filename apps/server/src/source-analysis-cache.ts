import {publishProjectChange} from './project-updates.js';
import type {TrashStore} from '@trash/storage';

const ready=new WeakMap<TrashStore,Set<string>>();
export function sourceAnalysisReady(store:TrashStore,project:string){
 return ready.get(store)?.has(project)??false;
}
export function cacheSourceAnalysis(store:TrashStore,project:string){
 const projects=ready.get(store)??new Set<string>();
 projects.add(project);
 ready.set(store,projects);
}
export function invalidateSourceAnalysis(store:TrashStore,project:string){
 ready.get(store)?.delete(project);
 publishProjectChange(store,project,{wiki:true});
}
export function resetSourceAnalysis(store:TrashStore,project:string){
 ready.get(store)?.delete(project);
}
