import type { ChatDecision } from "./chat-decision.js";
export interface CoordinationMember {
  id:string; title:string; repository_id:string|null; repository:string; joined:boolean;
  status:string; task_id:string; decision?:ChatDecision;
}
export interface CoordinationRun {
  id:string; title:string; host:string; status:string; created_at:string;
}
export interface CoordinationPlan {
  id:string; plan_id:string; version:number; title:string; commit:string; host:string; status:"pending"|"authorized"|"submitted"|"blocked"|"skipped";
  repository:string; command:string[]; gpu:string; datasets:string[]; preparation:boolean; key:string; info?:string;
  draft_hash?:string; has_result?:boolean; exit_code?:number; metric_values?:{name:string;value:number;unit?:string}[];
  approval_hash?:string; run_id?:string; run_status?:string; result_id?:string; metrics?:string; artifacts?:{path:string;id?:string}[];
}
export interface CoordinationJob {
  id:string; conversation:string; repository_id:string|null; title:string; instructions:string;
  feedback?:"answered"|"blocked"|"failed"|"withdrawn"; reply_task_id?:string;
  consultation?:boolean; parent_question?:string; target?:string; candidates?:string[];
  priority?:number; finished?:boolean; successful?:boolean;
  report?:string; report_status?:"progress"|"blocked"|"ready"; plans?:CoordinationPlan[]; worker_status?:string; worker_response?:string;
  expects_runs:boolean; after?:string; gate:"finish"|"success";
  status:"waiting"|"delivered"|"withdrawn"|"failed"|"settled"; reason:string;
  task_id:string; origin:string; key:string; created_at:string;
}
export interface CoordinationMessage {id:string;prompt:string;response:string;status:string;created_at:string;error?:string;summary:boolean; origin?:string; consultation_status?:"open"|"stopped"|"settled"}
export interface CoordinationView {
  hosts:{id:string;name:string;connected:boolean}[]; queue:CoordinationRun[];
  messages:CoordinationMessage[]; jobs:CoordinationJob[];
  conversations:CoordinationMember[];
}
