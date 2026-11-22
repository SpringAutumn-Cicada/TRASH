import { z } from "zod";
import { experimentError, type TrashStore } from "@trash/storage";
import type { CoordinationMember, CoordinationView } from "@trash/protocol";
import type { CodeAgent } from "./code-agent.js";
import type { ExperimentService } from "./experiment/service.js";

export class ExperimentCoordination {
  constructor(private store:TrashStore, private agent:CodeAgent, private experiments:ExperimentService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordination_members (
      project TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      conversation TEXT NOT NULL, PRIMARY KEY(project,conversation))`);
  }

  view(project:string):CoordinationView {
    const members=this.store.db.prepare("SELECT conversation FROM coordination_members WHERE project=?").all(project) as {conversation:string}[];
    const joined=new Set(members.map(row=>row.conversation));
    const history=this.agent.chatHistory(project);
    const repositories=this.experiments.data.repositories(project);
    const sessions=new Map<string,CoordinationMember>();
    for(const turn of [...history.tasks].reverse()) {
      const id=turn.conversation_id!;
      const repository_id=history.repository_bindings[id]??null;
      const repo=repositories.find(r=>r.repository_id===repository_id);
      const previous=sessions.get(id);
      sessions.set(id,{id,title:previous?.title??history.titles[id]??turn.instructions.slice(0,70),
        repository_id,repository:repo?.name??repo?.path??(repository_id?"仓库不可用":"未绑定仓库"),
        status:turn.status,task_id:turn.task_id,decision:turn.decision,joined:joined.has(id)});
    }
    return {conversations:[...sessions.values()]};
  }

  async action(project:string,body:unknown) {
    const input=z.object({action:z.literal("membership"),conversation:z.string().uuid(),joined:z.boolean()}).strict().parse(body);
    const session=this.view(project).conversations.find(s=>s.id===input.conversation);
    if(!session)experimentError("CHAT_SESSION_NOT_FOUND",404);
    if(input.joined)this.store.db.prepare("INSERT OR IGNORE INTO coordination_members VALUES (?,?)").run(project,session.id);
    else this.store.db.prepare("DELETE FROM coordination_members WHERE project=? AND conversation=?").run(project,session.id);
    return {ok:true};
  }
}
