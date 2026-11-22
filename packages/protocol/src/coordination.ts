import type { ChatDecision } from "./chat-decision.js";
export interface CoordinationMember {
  id:string; title:string; repository_id:string|null; repository:string; joined:boolean;
  status:string; task_id:string; decision?:ChatDecision;
}
export interface CoordinationJob {
  id:string; conversation:string; repository_id:string|null; title:string; instructions:string;
  expects_runs:boolean; after?:string; gate:"finish"|"success";
  status:"waiting"|"delivered"|"withdrawn"|"failed"; reason:string;
  task_id:string; origin:string; key:string; created_at:string;
}
export interface CoordinationMessage {id:string;prompt:string;response:string;status:string;error?:string;summary:boolean}
export interface CoordinationView {
  messages:CoordinationMessage[]; jobs:CoordinationJob[];
  conversations:CoordinationMember[];
}
