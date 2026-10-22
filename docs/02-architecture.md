# 总体架构

- 文档版本：0.1
- 目标：指导 MVP 的模块边界和本地/远程执行关系

## 1. 架构基线

采用 **TypeScript 模块化单体 + 本机 Codex CLI + SSH 远程 Runner**。首版不拆微服务，不把 Agent 执行放到远程实验服务器。UI、状态持久化、知识库、Agent 编排和远程任务控制部署在用户本机。Phase 1 具体使用 Vite + React、Node 本地 API、SQLite（better-sqlite3）和 FTS5。

本地 Web 工作台通过 `localhost` 提供界面，配套一个本地 TypeScript 服务。首版使用 Vite + React；项目元数据、文献来源、文本片段和 FTS5 索引存于 SQLite，项目文件另存于 workspace 文件目录。桌面壳暂不在 MVP 范围内。

## 2. 逻辑架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Local Workbench UI                                            │
│ Projects | Literature | Plan | Experiments | Results | Drafts │
└──────────────────────────────┬───────────────────────────────┘
                               │ local API / event stream
┌──────────────────────────────▼───────────────────────────────┐
│ TypeScript Workbench Service                                   │
│ Project Store | Workflow | Review Gates | Agent Orchestration │
└───────────────┬────────────────────┬─────────────────────────┘
                │                    │
       ┌────────▼────────┐   ┌───────▼──────────┐
       │ Research Modules│   │ Agent Adapters   │
       │ APT first       │   │ Codex CLI first  │
       └────────┬────────┘   └───────┬──────────┘
                │                    │ local process
                │                    ▼
                │             ┌──────────────┐
                │             │ Codex CLI    │
                │             │ local user   │
                │             └──────────────┘
                │
       ┌────────▼─────────┐
       │ Tools / Providers│ Literature, PDF, RAG,
       │ Local Runner     │ Git, rendering, metrics
       └────────┬─────────┘
                │ SSH task protocol
       ┌────────▼─────────┐
       │ Remote Runner    │
       │ AutoDL via SSH   │
       └────────┬─────────┘
                ▼
       Remote workspace, user-selected environment,
       experiment logs and large data references
```

## 3. 架构职责

### 3.1 Workbench UI

提供项目概览、阶段审阅、文献查看、方案编辑、实验提交与状态、结果可视化、稿件审阅。UI 只调用本地服务，不直接启动 Codex、SSH 或写数据库。

### 3.2 TypeScript Workbench Service

负责项目、工作流、版本、权限配置、审阅节点、任务调度、事件记录和导出。服务维护统一领域对象，不让研究模块或 Agent Adapter 独自保存项目状态。

### 3.3 Workflow Engine

初版可使用持久化状态机与后台任务表。状态变化、输入输出引用、失败信息和人工审批保存于本地数据库。复杂任务编排验证需求后再考虑独立工作流引擎。

### 3.4 Agent Orchestration

将阶段任务转为稳定的 `AgentTask`，选择配置的 Agent Adapter，准备工作区上下文、Skill、工具允许列表和输出 Schema，并收集结果。MVP 只实现 Codex CLI Adapter。

### 3.5 Tool Registry

工具是平台可审计的确定性操作，如解析文献、查询检索 Provider、执行本地 smoke test、提交 SSH 实验、读取日志、计算 APT 指标和生成图表。工具不能绕过用户配置的执行目标。

### 3.6 Research Module Registry

发现并校验本地配置型研究模块。模块定义流程、表单、结果类型、评价指标、文档模板和检查规则；不允许首版模块注入任意运行代码。

### 3.7 Runner

本地 Runner 执行允许的烟囱实验和文件操作。远程 Runner 通过系统 SSH 客户端连接主机，创建任务目录、验证环境、运行任务、收集轻量结果并保留远程大文件引用。

### 3.8 Knowledge Service

保存导入资料、元数据、文本解析结果、分块和向量索引。RAG 检索结果必须返回来源、页码/段落与匹配片段，不能只返回生成摘要。

## 4. 关键边界

1. **Agent 与 Runner 分离。** Codex 在本机处理项目任务；远程 SSH 主机运行实验命令，不承载 Codex 会话。
2. **模块不控制基础设施。** 研究模块定义实验输入和报告语义；Runner 控制 SSH、目录、命令和回传。
3. **项目状态由平台管理。** Agent 输出只是待校验产物，写入前经 Schema 校验并记录来源。
4. **本地与远程权限独立。** 工作区完整权限是用户默认选择，远程访问仍由 SSH 主机配置单独授权。
5. **MCP 是连接方式，不是领域内核。** 内部 API 使用稳定类型；将来可用 MCP 暴露或接入外部工具，不让 MVP 被协议适配拖慢。
6. **证据与文稿分离。** 文稿可以重写，底层来源、Git commit、实验运行和原始指标不可被文稿覆盖。

## 5. 推荐仓库结构

```text
trash/
  apps/
    workbench/                 # 本地 UI
    server/                    # 本地 TypeScript 服务
  packages/
    domain/                    # 项目、方案、实验、证据等领域类型
    protocol/                  # Agent/Runner 任务和事件 Schema
    workflow/                  # 持久化工作流与审阅状态
    agent-sdk/                 # Agent Adapter 接口
    agent-codex/               # Codex CLI Adapter
    research-runtime/          # 研究模块加载、校验和配置求值
    literature/                # Provider、解析、引用与 RAG
    experiment/                # Git 快照、Runner、产物管理
    storage/                   # 项目数据库与文件存储抽象
    document/                  # Markdown、引用和期刊模板
  modules/
    apt-provenance/            # 首个配置型研究模块
    journals/                  # 期刊模板模块
  .codex/
    skills/                    # Codex Skills
  runner/
    ssh/                       # SSH 远程执行与初始化脚本
  docs/
  testdata/
```

结构是建议，不等同于当前已有代码。启动开发时先检查 R2R 可复用模块和 license/dependency 状况，只迁移通用逻辑与协议，不能直接复制安全领域业务代码。

## 6. 技术选型方向

| 领域 | 方向 | 决策状态 |
|---|---|---|
| 主语言 | TypeScript | 已确认 |
| Agent | 本机 Codex CLI | 已确认 |
| Skill | Codex `.codex/skills/**/SKILL.md` | 已确认 |
| 远程连接 | 系统 SSH 客户端，先通用 SSH | 已确认 |
| 本地 UI | Vite + React localhost 工作台 | Phase 1 已采用 |
| 数据库 | SQLite + better-sqlite3 | Phase 1 已采用，FTS5 全文索引 |
| 文件存储 | 项目目录中的文件 + 元数据数据库 | 推荐 |
| 向量检索 | 项目级可替换索引实现 | 技术选型待定 |
| UI 框架 | Vite + React | Phase 1 已采用 |
| 打包方式 | 本地启动服务/开发态优先，安装包后续 | 待确认 |

## 7. 运行时主路径

1. UI 调用本地 API 创建 `workflow_run`。
2. Workflow 根据阶段和模块配置生成 `AgentTask` 或 `ExperimentTask`。
3. Agent Orchestrator 本机启动 Codex CLI，并将项目上下文、Skill 和目标文件范围传入。
4. Codex 输出结构化结果或文件变更；平台校验 Schema、记录事件并标注待审状态。
5. 用户确认研究方案后，平台创建实验任务。
6. Git 校验器确认代码提交基准；Runner 按目标选择本地或 SSH 执行。
7. Runner 产生事件和结果清单；Artifact Service 校验并登记回传文件或远程引用。
8. 结果分析和论文写作从已确认对象读取输入，输出新的可审查版本。

## 8. 故障恢复

- 本机 UI/服务重启后，从持久化任务状态恢复。
- 本地 Codex 进程中断时，记录最后事件和输出文件；允许用户重新运行任务，不假设可恢复私有会话。
- SSH 断线时，远程命令尽量在可重连会话中继续；Runner 通过任务 ID 重连并重新收集状态。
- 结果回传使用清单与校验和，重复回传需幂等。
- 远程主机不可达时保留任务为 `unknown_remote_state` 或 `disconnected`，不能误报失败或成功。

