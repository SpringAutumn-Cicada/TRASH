# TRASH

TRASH（Thesis Research Agent & Science Hub）是一个本地优先的科研工作台。在同一个论文项目中管理文献、研究笔记、代码、实验记录和论文稿件。

## 主要功能

- **文献与知识库** — 导入 PDF 和参考文献，搜索全文，整理文献卡片与研究 Wiki，并回查原文。
- **项目文件与论文** — 在本地工作区管理研究资料，预览 PDF 和图片，编辑 Markdown 笔记与论文稿件。
- **Agent 对话** — 通过本机 Codex CLI 辅助文献分析、方法设计和写作。项目对话保留历史，支持中断后续跑。
- **实验与复现** — 管理自研实验和论文复现的代码、数据集与运行方案。通过 SSH 在 AutoDL 主机运行实验，记录 Git 版本、日志、指标和产物。
- **实验协调** — 将任务分派给项目内的 Agent 对话，汇总进展，协调远端实验队列。

## 本地启动

需要 Node.js 22.12+ 和 pnpm 10。

```sh
pnpm install
pnpm dev
```

打开终端显示的工作台地址。使用 Agent 功能前，需在本机安装并登录 Codex CLI。

更多操作说明见 [项目工作区](docs/143-paper-project-workspace.md)、[Agent 对话](docs/17-project-agent-chat.md) 和 [实验模块](docs/12-experiment-module.md)。
