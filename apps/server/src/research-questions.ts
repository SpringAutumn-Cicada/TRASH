import {randomUUID} from 'node:crypto';
import {researchQuestionSchema,type ResearchProject,type ResearchQuestion} from '@trash/protocol';
import type {TrashStore} from '@trash/storage';

export function projectQuestions(project:ResearchProject):ResearchQuestion[]{
 if(project.research_questions)return project.research_questions;
 // Preserve an earlier explicit question; never invent one from the project title.
 return project.research_question.trim()?[{id:'question_legacy',title:project.research_question.slice(0,200),question:project.research_question,status:'selected',rationale:'原项目已填写的研究问题',evidence:[],created_at:project.created_at,updated_at:project.updated_at}]:[];
}
export function saveProjectQuestion(store:TrashStore,project:ResearchProject,input:{title:string;question:string;status:ResearchQuestion['status'];rationale:string;expected_updated_at:string;source_run_id?:string;source_candidate_id?:string;evidence?:{id:string;path:string}[]},id?:string){
 if(input.expected_updated_at!==project.updated_at)throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409});
 if(['paused','excluded'].includes(input.status)&&!input.rationale.trim())throw Object.assign(new Error('RESEARCH_REASON_REQUIRED'),{statusCode:422});
 const items=projectQuestions(project),old=id?items.find(q=>q.id===id):undefined;
 if(id&&!old)throw Object.assign(new Error('NOT_FOUND'),{statusCode:404});
 if(!id&&input.source_candidate_id&&items.some(q=>q.source_run_id===input.source_run_id&&q.source_candidate_id===input.source_candidate_id))throw Object.assign(new Error('RESEARCH_QUESTION_EXISTS'),{statusCode:409});
 const at=new Date().toISOString();
 const question=researchQuestionSchema.parse({...old,id:old?.id??'question_'+randomUUID(),title:input.title,question:input.question,status:input.status,rationale:input.rationale,evidence:old?.evidence??input.evidence??[],source_run_id:old?.source_run_id??input.source_run_id,source_candidate_id:old?.source_candidate_id??input.source_candidate_id,created_at:old?.created_at??at,updated_at:at});
 const next=old?items.map(q=>q.id===old.id?question:q):[...items,question];if(next.length>100)throw Object.assign(new Error('RESEARCH_QUESTIONS_LIMIT'),{statusCode:422});
 const updated={...project,research_questions:next,research_question:next.find(q=>q.status==='selected')?.question??'',research_stage:next.some(q=>q.status==='selected')?'focused':'exploration',updated_at:at};
 const result=store.db.prepare('UPDATE projects SET data=?,updated_at=? WHERE project_id=? AND updated_at=?').run(JSON.stringify(updated),at,project.project_id,project.updated_at);
 if(!result.changes)throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409});
 return {project:store.getProject(project.project_id),question};
}
