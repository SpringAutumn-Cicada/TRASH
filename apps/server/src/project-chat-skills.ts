import { z } from "zod";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageKnowledgeSkill } from "./markdown-knowledge.js";

const trashSkills = {
  "trash-literature-wiki": { title: "单篇论文 Wiki", folder: "literature-skill" },
  "trash-literature-synthesis": { title: "文献主题综合", folder: "synthesis-skill" },
  "trash-research-exploration": { title: "研究方向探索", folder: "research-skill" },
  "trash-research-map": { title: "研究地图", folder: "map-skill" },
  "trash-research-background": { title: "研究背景", folder: "background-skill" },
  "trash-abstract-wiki": { title: "摘要 Wiki", folder: "abstract-skill" },
  "trash_analyze_code_environment": { title: "复现代码环境分析", folder: "code-environment-skill" }
} as const;

const scholarSkills = {
  "claude-scholar-paper-self-review": { title: "论文自审", folder: "paper-self-review" },
  "claude-scholar-citation-verification": { title: "引文核验", folder: "citation-verification" },
  "claude-scholar-review-response": { title: "审稿回复", folder: "review-response" }
} as const;
const skills = { ...trashSkills, ...scholarSkills };
const scholarRoot = fileURLToPath(new URL("../../../vendor/claude-scholar/skills/", import.meta.url));

export const chatSkillId = z.custom<keyof typeof skills>(value =>
  typeof value === "string" && Object.hasOwn(skills, value)
);
export type ChatSkillId = z.infer<typeof chatSkillId>;
export const chatSkills = Object.entries(skills).map(([id, { title }]) => ({
  id, title, group: Object.hasOwn(scholarSkills, id) ? "claude-scholar" : "trash"
}));

export function stageChatSkills(directory: string, selected?: ChatSkillId) {
  for (const id of Object.keys(trashSkills) as (keyof typeof trashSkills)[]) {
    if ((id === "trash-abstract-wiki" || id === "trash_analyze_code_environment") && id !== selected) continue;
    stageKnowledgeSkill(directory, id, trashSkills[id].folder);
  }
}

export function stageScholarChatSkill(directory: string, selected?: ChatSkillId) {
  if (!selected || !Object.hasOwn(scholarSkills, selected)) return;
  const { folder } = scholarSkills[selected as keyof typeof scholarSkills];
  const staged = mkdtempSync(join(directory, ".scholar-skill-"));
  const dispose = () => rmSync(staged, { recursive: true, force: true });
  try {
    cpSync(join(scholarRoot, folder), staged, { recursive: true });
    return { folder: staged, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function chatSkillInstruction(id: ChatSkillId, stagedFolder?: string) {
  const { title, folder } = skills[id];
  const scholarNote = stagedFolder
    ? "Claude Scholar 技能仅在本轮生效。把其临时目录当作只读资料。使用当前项目材料和可用工具，写入成果时沿用 TRASH 的工作区规则。外部工具或原始证据不可用时，说明缺失内容，并将未确认的引文或论断标为未核实。"
    : "";
  return `用户为本轮指定「${title}」。使用 ${stagedFolder ?? folder}/SKILL.md 作为本轮技能入口，按需读取同目录下的引用文件。维持本轮权限与项目边界。若技能需要当前对话未提供的专用任务输入或发布入口，说明缺少的内容，勿虚构输入或声称已发布。${scholarNote}`;
}
