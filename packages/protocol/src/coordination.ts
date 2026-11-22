import type { ChatDecision } from "./chat-decision.js";
export interface CoordinationMember {
  id:string; title:string; repository_id:string|null; repository:string; joined:boolean;
  status:string; task_id:string; decision?:ChatDecision;
}
export interface CoordinationView {
  conversations:CoordinationMember[];
}
