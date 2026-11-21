import { z } from "zod";
import { stageKnowledgeSkill } from "./markdown-knowledge.js";

const skills = {
  "trash-literature-wiki": { title: "单篇论文 Wiki", folder: "literature-skill" },
  "trash-literature-synthesis": { title: "文献主题综合", folder: "synthesis-skill" },
  "trash-research-exploration": { title: "研究方向探索", folder: "research-skill" },
  "trash-research-map": { title: "研究地图", folder: "map-skill" },
  "trash-research-background": { title: "研究背景", folder: "background-skill" },
  "trash-abstract-wiki": { title: "摘要 Wiki", folder: "abstract-skill" },
  "trash_analyze_code_environment": { title: "复现代码环境分析", folder: "code-environment-skill" }
} as const;

export const chatSkillId = z.custom<keyof typeof skills>(value =>
  typeof value === "string" && Object.hasOwn(skills, value)
);
export type ChatSkillId = z.infer<typeof chatSkillId>;
export const chatSkills = Object.entries(skills).map(([id, { title }]) => ({ id, title }));

export function stageChatSkills(directory: string, selected?: ChatSkillId) {
  for (const id of Object.keys(skills) as ChatSkillId[]) {
    if ((id === "trash-abstract-wiki" || id === "trash_analyze_code_environment") && id !== selected) continue;
    stageKnowledgeSkill(directory, id, skills[id].folder);
  }
}

export function chatSkillInstruction(id: ChatSkillId) {
  const { title, folder } = skills[id];
  return `用户为本轮指定「${title}」。使用 ${folder}/SKILL.md 作为本轮技能入口，按需读取同目录下的引用文件。维持本轮权限与项目边界。若技能需要当前对话未提供的专用任务输入或发布入口，说明缺少的内容，勿虚构输入或声称已发布。`;
}
