---
name: trash-literature-wiki
description: 在 TRASH 论文项目中读取完整论文材料，生成或修订单篇论文 Wiki、独立依据和论文内导航；不用于多篇论文综合、研究方向探索或关系维护。
---

# TRASH 单篇论文 Wiki

本 skill 只处理单篇完整论文的 Wiki 生成、重新分析和局部修订。输入包括论文原始材料、固定四页一批的图文阅读笔记、任务要求和输出目录；不读取旧版卡片或历史 Wiki 作为生成依据。摘要论文使用 `trash-abstract-wiki`，多篇论文综合和研究探索使用 `trash-literature-synthesis`。

## 输出范围

直接写任务指定 output 目录，不返回正文 JSON。单篇论文位于 `knowledge_base/papers/<source_id>/`，生成 `whoami.md`、`idcard.md`、`background.md`、`research_problem.md`、`contributions.md`、`method/method.md`、`results/results.md`、`limitations.md`、`insights.md` 和 `evidence.md`；仅在有独立知识价值时增加方法或实验子页。所有页面使用 `knowledge_version: 2`、`kind: wiki-page`、`level: single` 和任务指定的稳定 ID。

正文像论文作者组织研究，统一使用“本论文”或直接陈述，不使用第三方审阅口吻。固定九项知识导航和页面职责遵守 `references/paper-wiki.md`。方法只写理论方法、机制、公式、步骤和必要训练/推理；实验配置、数据划分、硬件和运行参数放入实验与结果，设置精简，重点写发现、结果和原文解释。原文明示的限制放入局限，整理者新增建议只能作为“延伸思考（待验证）”。

## 阅读与依据

完整阅读固定四页一批的页面图像和文字，覆盖实际提供的全部批次；缺页、图表或公式无法辨认时记录真实缺口。引用原文使用可打开的 PDF 页链接。独立依据保存为 `evidence/ev-*.md`，正文固定使用依据总览链接、条目标题以及 `**定位：**`、`**事实：**`、`**边界：**` 三个字段；`evidence.md` 只做目录。依据用于支撑具体数字、组件关系、条件和关键结论，不为数量拆页。

公共阅读范围和核验状态集中写入 `ev-reading-scope`，没有重新核验 PDF、代码或实验时必须如实标注。出处可追溯不等于事实已经独立验证。

## 生成流程

1. 核对论文材料、页数、哈希、阅读批次和缺口。
2. 写 `knowledge-plan.md`，确定研究目标、贡献类型、页面重点和必要依据。
3. 先生成职责页正文，再整理依据，最后生成 `whoami` 导航。
4. `evidence.md` 由平台发布前脚本生成；模型只写具体依据，不运行检查器或生成派生索引。
5. 在当前生成调用中回读方法链路、关键结果、条件、反例、作者归属和依据链接。
6. 检查路径、ID、相对链接、元数据和人工补充，只发布本任务目标文件。

结构校验不等于事实核验。不要补造论文没有提供的数字、机制、因果解释或实验结论。

## 确定性脚本

本 skill 附带 `scripts/`，用于减少机械文件操作和按需读取成本：

- `check_wiki_structure.py <wiki>`：检查固定页面、frontmatter、依据字段和页面角色；
- `check_wiki_links.py <wiki>`：检查九项导航、相对链接和依据返回链接；
- `build_evidence_index.py <wiki>`：根据 `evidence/ev-*.md` 重建轻量依据目录；
- `wiki_context_manifest.py <wiki> [-o <path>]`：生成供 Agent 分层检索的页面与依据索引。

脚本只处理可确定的结构、路径、元数据和索引，不判断论文事实、作者结论或研究价值。生成内容后可先用索引确定读取范围，再按需读取正文和依据。

详细页面职责、依据格式、信息密度和跨页面回读规则见 [references/paper-wiki.md](references/paper-wiki.md)。

平台将契约、脚本和规则一起装载并记录指纹。脚本索引保存在任务目录，不作为知识页发布。脚本和结构检查只能验证确定性格式，不验证论文结论。
