# 研究方向模块规范

- 文档版本：0.1
- 首个模块：APT 检测与溯源
- MVP 扩展方式：声明式配置、模板、指标接口

## 1. 目标与边界

研究方向模块把领域知识转换为平台可执行、可审查的流程配置。模块负责定义“研究这个领域需要哪些对象、步骤、输入输出和评价方式”，平台内核负责项目、任务状态、权限、版本、Agent 调度、Runner 和文件存储。

首版模块只包含配置、Schema、模板和声明式指标。不允许模块随意执行代码或改变平台权限。任意代码插件 SDK 留到后续版本。

## 2. 模块生命周期

1. 从本地模块目录发现模块。
2. 校验 `manifest.json`、平台兼容版本、Schema 和引用文件。
3. 向用户展示模块名称、版本、能力、依赖和限制。
4. 项目固定使用某个模块版本；升级需要用户确认。
5. 新版本通过迁移声明转换项目配置，或提示需要人工处理。
6. 模块卸载不删除项目生成的数据和产物。

## 3. 模块目录建议

```text
modules/apt-provenance/
  manifest.json
  schemas/
    research-question.schema.json
    plan.schema.json
    experiment.schema.json
    metrics.schema.json
  workflows/
    default.json
  templates/
    research-plan.md
    experiment-report.md
    manuscript-outline.md
  evaluators/
    metric-definitions.json
    review-checks.json
  references/
    domain-notes.md
```

首版仅允许清单引用模块目录中的文件，不接受任意外部路径。模板和规则须可预览、可校验、可追踪版本。

## 4. Manifest 示例

```json
{
  "schema_version": "1",
  "id": "apt-provenance",
  "name": "APT Detection and Provenance",
  "version": "0.1.0",
  "description": "Research workflow for APT detection and provenance analysis.",
  "platform_compatibility": ">=0.1.0 <0.2.0",
  "domain": ["cybersecurity", "apt", "provenance"],
  "workflow": "workflows/default.json",
  "schemas": {
    "research_question": "schemas/research-question.schema.json",
    "plan": "schemas/plan.schema.json",
    "experiment": "schemas/experiment.schema.json",
    "metrics": "schemas/metrics.schema.json"
  },
  "templates": [
    "templates/research-plan.md",
    "templates/experiment-report.md",
    "templates/manuscript-outline.md"
  ],
  "evaluators": [
    "evaluators/metric-definitions.json",
    "evaluators/review-checks.json"
  ]
}
```

Manifest 中所有路径应相对模块根目录解析，禁止 `..` 越界。MVP 校验 `schema_version`、必需字段、文件存在、JSON Schema 有效性、平台兼容范围和 ID 唯一性。

## 5. Workflow 配置

工作流是阶段和任务的有向图或简化 DAG。MVP 可以先支持顺序阶段、可选分支、人工确认门和失败重试，避免提供任意脚本表达能力。

阶段定义至少包含：

- `id`、`title`、`description`、`order`。
- 输入对象类型与必需字段。
- 产物类型与 Schema。
- 建议 Agent Task 类型和 Skill 列表。
- 可用工具 ID 列表。
- 是否需要人工确认及确认说明。
- 失败策略和重试限制。

建议默认 APT 流程：`question_and_literature` → `research_gap` → `plan` → `smoke_experiment` → `full_experiment` → `analysis` → `writing_and_review`。具体阶段可重跑，重跑需建立新运行记录，不覆盖旧结果。

## 6. APT 模块范围

### 6.1 研究问题与文献

表达 APT 检测和溯源中的研究目标、数据来源、威胁/行为范围、分析粒度、已有方法和潜在缺口。模块可提供文献矩阵字段，不替研究者判断创新性已被证明。

### 6.2 研究方案

至少容纳：

- 研究问题、假设与预期贡献。
- 数据集及其版本、授权/来源说明和切分方式。
- 方法组件、基线、对比组和消融设计。
- 检测与溯源任务的评价指标及统计方法。
- 运行资源、重复次数、随机种子和停止条件。
- 失败判据、有效性威胁和复现实验说明。

不同 APT 研究可以使用不同指标和数据集，因此字段需要可配置，不能把某篇论文的实验设定写成硬编码的普遍标准。

### 6.3 实验

APT 实验至少记录：数据引用、代码 commit、模块/方案版本、配置、环境描述、运行命令、随机种子、资源预算、日志、结果文件和运行状态。平台不把模型输出当作实验指标；指标通过模块定义的确定性计算接口或结果 Schema 检查。

### 6.4 结果分析

输出指标表、图表描述、对比与消融结果、失败样本或错误类型、假设支持度和局限。自动生成的解释必须关联到原始指标与实验记录，研究者确认后才能标为已采纳分析。

### 6.5 写作产物

提供研究方案、实验报告、论文大纲和初稿模板。期刊特定格式由 Journal Module 提供；APT 模块不绑定期刊，不负责投稿目标推荐。

## 7. 指标接口

MVP 首版通过声明式定义指标字段与来源，不支持任意插件代码。例如：

```json
{
  "id": "example_metric",
  "label": "Example metric",
  "value_type": "number",
  "unit": "ratio",
  "required": true,
  "source_artifact_type": "experiment.metrics",
  "aggregation": ["mean", "std"],
  "dimensions": ["dataset", "baseline", "seed"]
}
```

若指标计算需要自定义代码，应先由平台 Tool 实现并通过固定接口暴露；后续 SDK 再让模块作者提供经过签名/权限审查的 evaluator。不得在用户导入模块时静默执行模块代码。

## 8. Journal Module 边界

Journal Module 输入投稿目标分析阶段给出的期刊标识和稿件版本，输出格式、结构、篇幅、引用和投稿材料清单检查。模块不生成期刊推荐，不把目标期刊选择伪装为格式校验。期刊模板要标注来源、版本和最近核验日期。

## 9. 模块测试与验收

- Manifest 和所有 Schema 能通过校验。
- 模块目录不含路径逃逸和未声明资源。
- 一个示例项目可按模块阶段创建方案、实验与结果对象。
- 无效指标或不完整产物产生可定位的校验错误。
- 模块版本升级不会覆盖旧项目快照。
- 模板生成内容保留来源对象和实验引用。

