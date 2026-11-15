# 单篇 Wiki 独立依据

仅独立依据文档省略论文名和论文总览。普通知识子页及依据目录保留论文全名、论文总览链接、当前页标题。论文入口仍为 `whoami.md`，由其链接轻量依据目录 `evidence.md`。题录仅引用自身字段需要的依据。

每条依据为 `evidence/ev-<slug>.md`，使用普通 Wiki frontmatter，另加 `page_role: evidence`、`pdf_hash: <SHA256或unknown>`。正文首行为 `[依据总览](../evidence.md)`，空一行后标题为文件名，正文使用 `**定位：**`、`**事实：**`、`**边界：**` 三个非空字段，不使用大号二级标题。保留影响解释的指标口径、选择规则和反例，不硬截字数。目录使用 `page_role: evidence-index`，当前页标题后仅列出全部依据链接，不写说明或条目简介。链接显示真实条目名，例如 `[ev-threat-model](./evidence/ev-threat-model.md)`。生成校验仍要求职责页完整、同篇路径和从入口可达；最多40个知识页和80个依据条目。

## 阅读和 Agent

阅读器保留文档链接和章节定位，不提供“返回上一阅读位置”按钮。每条依据首行通过“依据总览”返回本篇依据目录。反向引用返回当前来源文档、正文行号、章节锚点和引用文字，便于从其他入口追查。

项目工具新增 `evidence` 操作，支持 `id`、`offset`、`length`。它返回独立条目、论文标识、内容哈希及反向引用。`get` 同样可以读取条目。实际返回的区间合并登记在任务工作区，引用已有依据的发布须完整读取同一版本；目录项和检索片段不算已读。日志记录实际返回范围，不能据此声称模型已独立核验 PDF。

`context` 优先返回知识职责页及一跳知识关联，同时提供未读的 `evidence_candidates`；候选最多40项，并返回总数和省略数，更多条目可用分页索引和反向引用查找。跨论文背景先形成候选共识，再读取支撑与反例；关键数字、分歧或强结论再查看 PDF。该接口不会主动启动研究、重读全文或自动调用模型。原有研究方向探索任务仍仅能声称使用实际输入材料，不能声称查阅未提供的依据。

## 现有 Wiki 迁移

知识库“依据拆分”入口逐篇预览和执行。对应接口：

- `GET /api/v1/projects/<project>/markdown-knowledge/evidence-migration-preview?source_id=<source>`
- `POST /api/v1/projects/<project>/markdown-knowledge/evidence-migrate`，请求 `{source_id, expected: <预览指纹>, confirm: true}`。
- `GET /api/v1/projects/<project>/markdown-knowledge/evidence?id=<依据文档ID>`。

迁移展开引用式链接后拆分旧 `## ev-*` 内容，保留共同材料范围，改写同篇引用标签和路径，保留普通知识子页顶部的论文名和总览链接。旧正文保存在原文档版本历史中；不修改历史任务或重新核验原文。整个文件批次使用版本检查与已有事务日志，重复迁移不重复写入。迁移继承原有来源版本和过时依赖，不把改写链接当成重新核验或自动清除待更新状态。

存在活动任务、目标已有文件、重复标识、多个 PDF 版本、无法安全移除的前言、旧锚点不存在或外部页面仍依赖旧锚点时拒绝迁移，并在预览中说明。外部引用需先整理，不静默断链。首次先迁移一篇供人工验收，其他论文通过相同入口逐篇处理。

本轮按工作区约定执行必要构建与安全重启；不主动运行测试、lint、额外类型检查、浏览器或真实模型验证。构建和只读接口健康检查不代替阅读交互与内容质量的用户验收。

## 紧凑依据与公共范围

共同范围保存在 `ev-reading-scope.md`，条目用 frontmatter `scope_ref: ev-reading-scope` 关联；这条元数据关系也参与依赖失效检查。迁移生成 `verification: not-reverified`，缺失状态按 `unknown` 处理；`verified` 只表示记录方声明已复核，不是平台认证。迁移来源及状态不在每条正文反复解释，保留在元数据和历史记录。

`evidence` 及项目工具 `get` 读取依据时附带 `material_scope`（ID、版本哈希、正文、过时状态）、`verification`、`scope_status` 和 `scope_document`。只有同篇、PDF哈希一致且不为unknown的公共范围才能附带；最多16000字符，超限提供独立读取入口，不截断后冒充完整。缺失、版本不同、需单独读取分别返回missing、version-mismatch、requires-separate-read。公共范围本身返回self-contained。实际附带正文才登记读取区间，目录和状态不算已读取。

现有依据保持可读，不自动批量摘要。本次先手工整理PIDSMaker的ev-benchmark示例，保留稳定ID、路径、原文链接、指标口径与疑点；其余条目待示例验收后再逐步整理。旧正文保存在版本历史，不自动调用模型。

示例正文（省略frontmatter，原文URL示意）：

```markdown
[依据总览](../evidence.md)

# ev-benchmark

**定位：** [PDF第6页](<原PDF链接>)，表1、§4.1。

**事实：** 比较8个系统在8个数据集上的混淆矩阵、节点级Precision/Recall/MCC及ADP。ADP为精确率按节点、召回率按攻击计算的AUPRC；采用五次中的最佳种子/最佳ADP，非均值。R-CAID横杠表示运行超过24小时中止。

**边界：** 各列是否来自同次运行未说明；TP>0不能证明覆盖每场攻击。Orthrus H051的零TP/FP与ADP=1关系未完整解释，正文节点数范围与表格不一致。表中k/M及舍入值按原样保留。
```
