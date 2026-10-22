# Thesis Research Agent & Science Hub

> 项目简称：`trash`
>
> 项目阶段：Phase 1 本地项目与文献工作台
> 用户界面：简体中文
> 文档版本：0.4

## 1. 项目简介

`trash` 是一个本地优先、面向科研项目的开源工作台。它通过研究方向模块组织文献调研、研究方案、实验执行、结果分析和论文写作；通过可插拔 Agent 适配器调用用户选择的 Agent；通过本地 Git 工作区和 SSH Runner 支持本机研究与远程实验。

首个研究方向模块为 APT 检测与溯源。MVP 的可验收成果为研究方案、实验报告和论文初稿。平台不承诺无人参与地完成可信科研结论，研究者负责确认研究问题、方案、结论和最终稿件。

项目简称 `trash` 带有对低质量科研产出的讽刺意味。该表达针对科研产出质量问题，不针对使用者或研究者。项目公开介绍应解释这一背景。

## 2. 核心目标

- 将研究过程组织为可暂停、可审查、可恢复的项目工作流。
- 让文献、方案、代码、数据、实验、结果和稿件版本相互关联。
- 通过模块支持不同研究方向、期刊格式和 Agent 的扩展。
- 在本地调用 Codex CLI，在用户配置的远程 SSH 主机上运行全量实验。
- 让生成的研究方案、实验报告和论文初稿能追溯到来源与运行证据。

## 3. 文档索引

| 文档 | 内容 |
|---|---|
| [产品需求与范围](docs/01-product-requirements.md) | 用户、场景、工作流、MVP、非目标与验收标准 |
| [总体架构](docs/02-architecture.md) | 分层架构、执行边界、模块关系与技术建议 |
| [研究方向模块规范](docs/03-research-module.md) | 研究模块职责、配置结构、APT 模块边界 |
| [Agent 与 Skill 接入规范](docs/04-agent-and-skills.md) | Agent 适配协议、Codex CLI、Skill 组织方式 |
| [数据模型与证据追溯](docs/05-data-and-evidence.md) | 核心实体、版本、证据关系与数据保留 |
| [SSH 远程实验规范](docs/06-remote-execution.md) | Git 基准、SSH 执行、初始化、产物回传 |
| [MVP 实施计划](docs/07-mvp-plan.md) | 阶段拆分、验收门槛、风险和未决项 |
| [启动提示词](启动提示词.md) | 可复制给后续 Codex 开发对话的完整指令 |

## 4. 已确认决策

| 编号 | 决策 |
|---|---|
| D1 | 开源 GitHub 项目；`trash` 是带讽刺意味的项目简称。 |
| D2 | 首要用户是项目创建者本人，其次是同学试用。 |
| D3 | MVP 聚焦 APT 检测与溯源；研究方向应以可插拔模块扩展。 |
| D4 | 本地工作台，通过 SSH 连接云服务器运行实验。 |
| D5 | 权限由用户配置；默认给 Agent 当前项目工作区完整权限。 |
| D6 | 接入公开文献检索，支持 Google Scholar 搜索入口；不做机构订阅集成；用户导入材料可进入 RAG。 |
| D7 | MVP 交付研究方案、实验报告、论文初稿；期刊能力可插拔。 |
| D8 | 本地部署；本地运行烟囱实验，全量实验默认走 SSH 远程主机。 |
| D9 | 先支持通用 SSH，确认 AutoDL 实际运行方式后再做专用适配。 |
| D10 | 研究模块首版支持配置、模板和指标接口；代码插件 SDK 后续开发。 |
| D11 | 使用 TypeScript 与 R2R 的工程经验。 |
| D12 | 期刊模块只负责格式、结构与投稿材料清单；投稿目标分析属于研究工作流。 |
| D13 | 所有代码必须纳入 Git；实验以 Git 提交为代码基准；大文件与数据集走独立同步或远程挂载，具体方案后续确认。 |
| D14 | 核心 Agent 也采用可插拔适配器；MVP 只围绕本机 Codex CLI 开发，Skill 使用 Codex 格式。 |
| D15 | 平台提供远程环境初始化脚本；先确保可连接 AutoDL。用户创建服务器时自行选择环境，脚本不得覆盖该环境。 |
| D16 | 首版回传日志、配置、指标、图表和报告；大型原始数据保留远程引用与校验信息。 |
| D17 | 首版在本机调用 Codex CLI。 |

## 5. MVP 不做的事

- 不承诺自动选题、自动证明创新性或无人参与地发表论文。
- 不在 MVP 实现多研究方向代码插件 SDK。
- 不在 MVP 实现 Claude、DeepSeek harness 等其他 Agent 适配器。
- 不把投稿目标推荐塞进期刊格式插件。
- 不建设 AutoDL 专用 API 集成；先用通用 SSH 流程。
- 不集成机构订阅、不批量抓取 Google Scholar、不自动下载受限全文。
- 不把大型数据集纳入 Git，也不在首版定死其传输技术。
- 不拆分微服务，不建设多租户 SaaS。

## 6. 开发原则

1. **项目数据是事实来源。** 对话只是交互记录，不代替结构化研究对象。
2. **结论关联证据。** 文献判断关联来源位置，实验判断关联运行和产物。
3. **主流程由平台控制。** Agent 提建议和产物，平台保存状态、版本和审批。
4. **执行器与 Agent 分离。** 本机 Codex 做研究辅助；SSH Runner 执行远程实验。
5. **先用配置验证模块边界。** MVP 不为了“可扩展”提前造任意代码插件系统。
6. **承认不确定性。** 未验证、证据不足、相互矛盾的内容必须能明确表达。

## 7. Codex Skill 参考

Codex Skill 采用目录形式，核心文件为含 YAML front matter 的 `SKILL.md`，可附带脚本、引用文档和模板。项目级 Skills 放在 `.codex/skills/<skill-name>/SKILL.md`。Skill 说明可复用的工作方法；实际项目数据与工具仍由平台提供。参考：[OpenAI Developers: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)。

## 8. 开发

需要 Node.js 22.12+ 与 pnpm 10。安装依赖后，可运行：

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

`pnpm dev` 构建并启动简体中文 localhost Web 工作台及本地 API（默认 `http://127.0.0.1:5173`）。工作台提供当前默认配色和蓝色科技风两种主题，选择保存在当前浏览器中。当前可创建持久化项目、导入 PDF/BibTeX/RIS/Markdown/公开网页、通过 OpenAlex 搜索文献，并按全文检索结果回到页码或段落定位；Google Scholar 仅打开用户触发的浏览器搜索。文献元数据和用户内容保留原文。项目数据默认写入操作系统用户数据目录下的 `trash` workspace，可通过 `TRASH_HOME` 覆盖。网页正文只在用户明确提交 URL 后抓取，拒绝私网目标并限制响应大小和跳转。全文检索使用 SQLite FTS5，向量检索尚未纳入本阶段。

项目对象协议位于 `packages/protocol`，当前协议版本为 `v1`。选型和 Phase 0 脚手架见 [ADR 0001](docs/adr/0001-phase-0-tooling-and-protocol.md)；Phase 1 持久化、导入和检索边界见 [ADR 0002](docs/adr/0002-phase-1-local-literature.md)。

