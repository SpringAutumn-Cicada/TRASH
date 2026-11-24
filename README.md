# TRASH

TRASH（Thesis Research Agent & Science Hub）是一个本地优先的科研工作台，将文献阅读、研究设计、实验和论文写作放在同一个项目中。通过本机 Codex CLI 提供 Agent 辅助，通过 SSH 连接 AutoDL 等远程主机运行实验。

研究资料保存在本地，文献结论可以回查原文，实验结果关联代码版本和运行产物。研究者可以查看过程、调整方案，并继续被中断的任务。

## 主要功能

- **文献阅读** — 导入 PDF、BibTeX、RIS、Markdown 和公开网页，检索文献与全文，结合页码或段落回查来源。
- **研究知识库** — 整理文献卡片、单篇论文 Wiki、主题综合和研究地图，为研究背景与方向探索积累依据。
- **方法设计** — 为自研实验整理研究假设、方法说明、流程图、代码映射和实验对照。
- **Agent 对话** — 按项目保留多个对话，可绑定论文代码仓库、选择权限和技能。支持并行处理、草稿保存、中断续跑及停止后编辑重发。
- **实验与复现** — 管理代码、数据集、运行方案和计算资源。通过 Git bundle 同步指定提交到远端，跟踪日志、指标、图表和其他产物。
- **实验协调** — 向多个论文对话询问进展或分派任务，汇总反馈，协调远端实验队列，并保存可检索的项目记忆。
- **项目文件与论文** — 浏览本地文件，预览 PDF 和图片，编辑研究笔记与论文稿件，通过回收站管理文件。

## 使用流程

1. 创建论文项目，选择本地工作区并填写研究问题。
2. 导入文献，阅读原文，整理卡片和 Wiki。
3. 在 Agent 对话中讨论方向、设计方法，并关联实验代码仓库。
4. 配置远程主机、数据集和运行方案，按代码提交运行实验。
5. 在实验协调中跟进各方向的任务，根据实际结果完善方案与论文。

Agent 生成的研究判断、引文和实验解读需要结合原始材料核对。平台保存来源、版本和运行记录，便于检查与修订。

## 本地启动

需要 Node.js 22.12+、pnpm 10 和 Git。Agent 功能还需要已登录的 Codex CLI、Python 3，以及用于隔离执行的 Linux bubblewrap（`bwrap`）。可在 Linux 或 WSL 环境中部署。

```sh
git clone https://github.com/SpringAutumn-Cicada/TRASH.git
cd TRASH
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 会先构建项目，再启动带热更新的工作台。主分支默认地址为 `http://127.0.0.1:22223`，实际地址以终端输出为准。使用构建后的界面可运行 `pnpm start`。

| 配置项 | 用途 |
|---|---|
| `TRASH_PORT` | 工作台监听端口 |
| `TRASH_HOME` | 平台数据库、设置和运行记录的保存目录 |
| `TRASH_CODEX_COMMAND` | Codex CLI 命令或可执行文件路径，默认为 `codex` |

默认平台数据目录随操作系统选择，Linux 下为 `~/.local/share/trash`。`paper_analyze` 开发分支默认使用端口 `22225` 和独立数据目录 `~/.local/share/trash-paper-analyze`。

远程实验需要在工作台配置 SSH 主机和远端工作区，再按实验要求准备 Python 环境、依赖与数据集。

## 数据与代码组织

论文项目可选择独立的本地目录，资料按用途整理。

```text
项目工作区/
├── literature/       文献材料
├── knowledge_base/   卡片与研究 Wiki
├── research/         研究笔记
├── code/
│   ├── papers/       自研实验代码
│   └── reproductions/ 文献复现代码
├── data/             数据集
├── experiments/      实验方案与记录
└── manuscripts/      论文稿件
```

AutoDL 工作区使用相同的代码分类，共用数据放在 `data/`，运行输出分别放在 `outputs/papers/` 和 `outputs/reproductions/`。代码同步使用完整 Git 提交 SHA，配置、数据与运行结果按实验记录关联。

平台数据库与设置保存在 `TRASH_HOME`。备份时应同时保留平台数据目录、项目工作区，以及项目引用的外部代码和数据。

## 项目文档

- [项目工作区](docs/143-paper-project-workspace.md)
- [项目文件](docs/144-project-files.md)
- [Agent 对话](docs/17-project-agent-chat.md)
- [实验模块](docs/12-experiment-module.md)
- [实验代码同步 Skill](.agents/skills/trash_git_sync/SKILL.md)

## 致谢与第三方资源

TRASH 的部分 Agent Skills 引自 Claude Scholar，并针对本项目的工作区、工具接口和权限规则进行了适配。感谢原作者 Gaorui Zhang 及项目贡献者。[Claude Scholar](https://github.com/Galaxy-Dawn/claude-scholar)

引入内容保存在 `vendor/claude-scholar/`，来源与固定版本见随附说明。Claude Scholar 采用 MIT 许可证，随附资源的独立许可证和来源说明保留在各自目录中。[引入说明](vendor/claude-scholar/README.md) · [许可证](vendor/claude-scholar/LICENSE)
