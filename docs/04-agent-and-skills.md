# Agent 与 Skill 接入规范

- 文档版本：0.1
- MVP Agent：本机 Codex CLI
- MVP Skill：Codex 格式

## 1. 设计目标

平台核心 Agent 必须可替换。MVP 只实现 Codex CLI，但项目数据与工作流不得依赖 Codex 专有会话结构。后续可以增加 Claude、DeepSeek harness 或其他 Agent Adapter。

Agent Adapter 解决“如何调用 Agent”；Research Module 解决“某类研究如何组织”；Skill 解决“Agent 如何按一套步骤完成可复用任务”；Tool/Runner 执行确定性操作。四者不能混成一个插件。

## 2. 组件职责

### 2.1 Agent Adapter

- 探测 Agent 是否安装、版本和可调用能力。
- 准备任务工作目录、提示词、上下文引用、Skill 和输出 Schema。
- 启动、停止和监视 Agent 进程。
- 接收标准输出、标准错误、退出码和结构化事件（若可用）。
- 将 Agent 特定事件转换成平台通用事件。
- 返回文本、结构化结果、修改文件清单和错误信息。

### 2.2 Agent Orchestrator

- 根据项目配置选择 Adapter。
- 构造最小必要上下文，避免把整个项目文件无差别注入。
- 记录模型/Agent、版本、提示词版本、Skill 版本、工具列表和运行配置。
- 校验结果 Schema，区分草稿、待审和用户确认状态。
- 不将 Agent 的“成功”输出直接认定为科研阶段已完成。

### 2.3 Skill

Skill 提供步骤、规则、输出要求和可选的参考文档/脚本。Codex Skill 以含 YAML front matter 的 `SKILL.md` 为入口，项目级目录建议 `.codex/skills/<skill-name>/SKILL.md`。每个 Skill 应有清晰名称、描述、使用场景、输入、步骤、输出格式和失败/升级条件。

官方 Codex 示例也描述了 `SKILL.md` 与可选脚本/引用资源的组织方式，并建议针对触发和产物做小规模评估：[OpenAI Developers: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)。

## 3. AgentTask 通用协议草案

最终类型放在 `packages/protocol`，以下是字段要求，不是冻结的 TypeScript 实现：

```ts
interface AgentTask {
  protocolVersion: string;
  taskId: string;
  projectId: string;
  workflowRunId: string;
  purpose: string;
  instructions: string;
  workspace: {
    root: string;
    allowedReadPaths: string[];
    allowedWritePaths: string[];
  };
  contextRefs: string[];
  skillRefs: Array<{ id: string; version: string }>;
  allowedToolIds: string[];
  outputSchemaRef?: string;
  permissionProfileId: string;
  timeoutSeconds: number;
}
```

通用 Adapter 能力建议：`detect`、`startTask`、`streamEvents`、`cancelTask`、`collectArtifacts`、`getTaskStatus`。协议统一任务与产物语义，不要求所有 Agent 拥有相同内部事件。

通用事件至少覆盖：`task.started`、`assistant.message`、`tool.started`、`tool.output`、`artifact.created`、`approval.required`、`task.completed`、`task.failed`、`task.cancelled`。未知 Agent 原生事件可保留原始引用用于诊断，但核心流程只消费稳定事件。

## 4. Codex CLI Adapter

### 4.1 执行位置

Codex CLI 在本机运行，使用用户已配置的本地 Codex 环境。Codex 不在 AutoDL 上运行，不接管 SSH 会话。

### 4.2 工作区与权限

默认权限配置为当前项目工作区完整权限，用户可自定义。Adapter 必须把平台任务的工作区限制传给 Codex 支持的运行配置，并在任务启动前展示实际目录和权限策略。不得因默认工作区授权而隐式扩展到整个宿主机或远程主机。

具体 CLI 参数、输出事件版本和配置能力必须在实现时通过本机 Codex CLI `--help` 与当期官方文档确认，并封装在 Adapter 内；不得把未经验证的命令行参数写成跨版本协议。

### 4.3 结果收集

Adapter 应保存：任务 ID、实际命令参数（脱敏）、Codex 版本、开始/结束时间、退出码、stdout/stderr 或事件日志、涉及文件清单、结构化输出和错误。认证凭据不得记录。

### 4.4 失败处理

- CLI 未安装或版本不满足：任务不启动，显示检测结果和修复提示。
- 进程异常退出：记录退出码、stderr、最后事件和未完成阶段。
- 超时：按用户策略取消或继续等待，不静默丢弃进程。
- 非结构化输出：保留原始内容，并标为需人工解析；结构化输出失败不伪装成功。
- 同一任务重试：生成新的 task attempt，保留旧 attempt。

## 5. Skills 目录与约定

```text
.codex/skills/
  literature-synthesis/
    SKILL.md
    references/
    templates/
  apt-plan-review/
    SKILL.md
    references/
  experiment-analysis/
    SKILL.md
    scripts/
```

首批建议 Skills：

- `literature-synthesis`：基于项目来源生成文献矩阵和带定位的摘要。
- `apt-plan-review`：按 APT 模块 Schema 检查研究方案完整性，不替代创新性裁决。
- `experiment-analysis`：分析已登记的指标和图表，必须引用实验 ID 与结果字段。
- `manuscript-draft`：从已确认方案、结果和引用生成论文段落。
- `citation-audit`：检查引用存在性、正文引用与参考文献对应关系。

Skill 不应执行秘密外传、绕过平台 Runner 或修改项目外路径。Skill 内容视为指令输入的一部分，模块安装和更新应展示差异。

## 6. 其他 Agent 适配计划

扩展次序建议：

1. 在 Codex Adapter 稳定后补齐 Adapter 契约测试。
2. 评估 Claude、DeepSeek harness 等各自的运行方式、事件、Skill 和工具接口。
3. 新增独立 Adapter，不让 Agent 特性渗入研究模块协议。
4. 明确 Skill 可移植性：共享领域说明可以跨 Agent；Codex 原生 Skill 不能假设自动兼容其他 Agent。后续由适配器加载原生 Skill 或提供格式转换。
5. 每个 Adapter 声明支持的任务能力、文件权限、事件和取消语义。

## 7. 评估

每个 Skill 至少准备一组正例、边界例和负例，检查是否触发、是否使用正确来源、结构输出是否通过 Schema、是否修改允许路径外文件。Agent 评估重点应是行为与产物，不只比较最终自然语言质量。

