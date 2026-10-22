# 数据模型与证据追溯

- 文档版本：0.1
- 目标：定义项目中需要长期保存的事实、版本与引用关系

## 1. 数据原则

1. 文本、数据、实验、结果和判断使用独立对象管理。
2. 模型输出默认是候选内容，不自动成为已确认事实。
3. 每个来源保存稳定标识、原始文件哈希和可定位片段。
4. 每个实验绑定 Git commit、方案版本、数据引用和运行配置。
5. 论文主张尽可能建立到文献或实验的显式证据关系。
6. 大型远程文件可只保留引用，但引用必须包含校验信息和访问位置。

## 2. 实体清单

| 实体 | 关键字段 | 用途 |
|---|---|---|
| `Workspace` | id、root、配置、存储版本 | 本地工作区 |
| `ResearchProject` | id、title、moduleId/version、状态、Git 根目录 | 项目主对象 |
| `ResearchQuestion` | id、问题、假设、范围、状态、来源引用 | 研究问题和假设 |
| `Source` | id、类型、标题、作者、年份、URL/DOI、hash、导入时间 | 论文、数据集、网站或代码来源 |
| `SourceLocator` | sourceId、页码/章节/段落/URL 片段 | 精确定位引用 |
| `Claim` | id、文本、类别、状态、创建者 | 文献、实验或论文中的主张 |
| `EvidenceLink` | claimId、source/result/artifact ref、关系类型 | 主张到证据的可追溯链接 |
| `PlanVersion` | id、projectId、version、schema、status、approvedAt | 研究方案快照 |
| `DatasetRef` | id、版本、来源、位置、hash、许可说明 | 数据引用，不存放超大原始数据本体 |
| `ExperimentRun` | id、planVersionId、commitSha、config、target、status | 实验运行记录 |
| `RunEvent` | id、runId、time、type、payloadRef | 日志、状态与进度事件 |
| `Artifact` | id、kind、location、size、hash、retention | 报告、图表、日志或数据文件 |
| `MetricResult` | runId、metricId、value、unit、dimensions、artifactRef | 实验指标与分组 |
| `AnalysisVersion` | id、inputRefs、claims、status、author | 结果分析版本 |
| `ManuscriptVersion` | id、version、contentRef、journalModuleRef、status | 论文草稿和导出版本 |
| `WorkflowRun` | id、stage、inputRefs、outputRefs、status、attempt | 阶段执行记录 |
| `AgentRun` | id、adapterId/version、taskId、events、exitStatus | Agent 调用记录 |
| `Approval` | id、objectRef、decision、comment、actor、time | 人工确认记录 |

## 3. 标识与版本

- 数据库主键建议使用 UUIDv7/ULID 一类可分布式生成的 ID，格式在实现时统一。
- `projectId + moduleId + moduleVersion` 固定模块语义。
- 方案、分析和稿件通过不可变版本快照保存；编辑产生新版本。
- `ExperimentRun` 永不覆盖；重跑使用新 runId 并可标记替代关系。
- Agent Adapter、Skill、Runner 和模板均记录版本或内容哈希。
- 代码版本使用完整 Git commit SHA；分支名仅作为显示信息。

## 4. 来源与引用

来源至少记录：标题、作者、年份、公开标识（DOI、URL、arXiv 等）、采集时间、获取方式、文件 hash、解析状态和许可/使用备注（如已知）。PDF 的段落或页码定位应从解析结果取得；定位失败的摘要需标为无法精确引用。

RAG 响应必须携带 `sourceId`、`locator`、文本片段、检索方式和分数/排序信息。生成文本引用必须使用平台引用 ID，而不是让模型临时编造 BibTeX 或 DOI。

Google Scholar 记录只作为检索入口或用户导入来源；平台不批量抓取 Scholar 结果。文献全文若由用户导入，原文位置、文件哈希和导入者需要保存。

## 5. 实验记录

一个 `ExperimentRun` 最低需要：

- `projectId`、`planVersionId`、`moduleId/moduleVersion`。
- Git repository identity、commit SHA；最好在开始时检查工作树干净。
- 若允许 dirty tree，必须在任务快照中保存 diff 和未跟踪文件清单；MVP 更建议要求先提交。
- 数据集 ID/版本、远程路径、校验算法与 digest；不把数据路径当唯一身份。
- 本地或远程目标、SSH 主机别名（不保存私钥）、远端工作目录。
- 用户选择的环境标识、初始化脚本版本、Python/框架/CUDA 检测结果。
- 运行命令、参数、随机种子、资源参数和开始/结束时间。
- 日志、配置、指标、图表、报告的 Artifact ID 或远程引用。
- 状态、退出码、失败原因、取消者和重试关系。

## 6. 证据关系

示例链路：

```text
Paper Source + Page Locator ──supports──> Related-work Claim
Plan Version ──defines──> Experiment Run
Git Commit + Dataset Ref + Environment ──reproduce──> Experiment Run
Metric Result + Plot Artifact ──supports──> Result Claim
Result Claim + Literature Claim ──cited by──> Manuscript Paragraph
```

至少区分以下关系：`supports`、`contradicts`、`derived_from`、`cites`、`measured_by`、`generated_from`、`reviewed_by`。关系枚举首版可缩小，但不能只保存无语义的文件名字符串。

## 7. 状态模型

研究对象建议使用候选/审阅/确认状态，精确枚举在 API 协议阶段统一。例如：

- 方案：`draft`、`in_review`、`approved`、`rejected`、`superseded`。
- 实验：`queued`、`preparing`、`running`、`collecting`、`completed`、`failed`、`cancelled`、`disconnected`。
- 结论：`proposed`、`supported`、`contradicted`、`inconclusive`、`needs_evidence`。
- 文稿：`draft`、`reviewing`、`ready_for_export`、`exported`。

状态变化记录 actor、时间、原因和原状态。Agent 不允许直接把 Claim 改为 `supported`；至少需要结果校验或人工确认规则。

## 8. 存储与备份建议

- 元数据和工作流状态使用本地 SQLite；文献文本片段通过 FTS5 索引，并保留 PDF 页码、Markdown/网页段落及可用标题定位。向量索引不属于 Phase 1。
- 原始文献、实验附件和稿件保存在项目数据目录或 workspace-managed store。
- 向量索引视为可重建派生数据，不是事实来源；记录 embedding/model/index 版本。
- 远程大型数据只保存引用、大小、校验和与访问说明，避免应用退出后链接失效。
- 提供项目级导出包，包括结构化元数据、文档、必要附件、模块版本和远程数据清单。
- 备份与恢复策略要在首版持久化实现中提供基本文档与导出验证。

