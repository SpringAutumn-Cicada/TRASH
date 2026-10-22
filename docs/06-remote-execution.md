# SSH 远程实验规范

- 文档版本：0.1
- MVP 目标：通用 SSH，可运行在用户已创建的 AutoDL 主机

## 1. 设计目标

本地工作台负责编排和观察实验，远程主机运行实际代码。用户在 AutoDL 创建实例时选择操作系统、CUDA/Python 等基础环境；平台提供初始化脚本来检查和准备项目工作区，不擅自重建用户所选环境。

MVP 通过标准 SSH 能力连接远程主机，不依赖 AutoDL 专有 API。后续观察实际使用情况后再决定是否新增 AutoDL 专用 Adapter。

## 2. 核心约束

- 代码必须纳入 Git，运行基准使用 commit SHA。
- 不把 SSH 私钥、密码、访问令牌或敏感环境变量写入项目文件或日志。
- 远端执行路径、命令、环境和数据引用在提交前可见。
- 本地 Agent 权限和 SSH 远端权限彼此独立。
- 远程运行必须能断线重连；本地 UI 关闭不应让服务端实验失去追踪。
- 大型原始数据默认保留远程，不回传本地。

## 3. 连接配置

一个 SSH Profile 包含：

- 用户自定义名称和 `host`/`Host` 别名。
- SSH 用户、端口和连接超时。
- 可选远端项目根目录。
- 本地 SSH config/agent 使用方式，不复制私钥内容。
- 远端作业方式：前台、`tmux`/持久 shell 或适配器实现的后台 job；具体首选需通过 AutoDL 实测确认。
- 环境检查/初始化脚本版本。

连接探测至少检查 DNS/网络连通、SSH 认证、远程 shell、磁盘空间、用户目录和 Git 可用性。失败时将错误分类为网络、认证、主机配置或远端依赖问题。

## 4. 环境初始化脚本

脚本需幂等、可重复运行、可输出机器可读结果。步骤建议：

1. 创建平台指定的项目工作目录和任务目录。
2. 检查 `git`、Python、CUDA 可见性、磁盘空间和必要命令。
3. 读取当前用户选择环境的 Python/框架版本，不切换 CUDA 镜像、不覆盖系统 Python。
4. 对项目依赖提供可审阅安装计划；只有用户选择后才执行安装。
5. 检查项目数据路径或挂载点，但不自动删除已有数据。
6. 输出环境摘要 JSON，包括 OS、Python、关键框架版本、CUDA 状态、Git 版本、目录和初始化版本。

在 AutoDL 环境实测前，脚本的具体命令和 shell 假设不得写死。平台应显示检测结果，环境不满足项目声明时提示用户选择继续、调整配置或取消。

## 5. Git 版本固定

远程实验开始前：

1. 验证当前项目是 Git repository。
2. 读取并固定 commit SHA。
3. 检查工作树是否干净。MVP 推荐不允许 dirty tree 直接运行；用户需先提交变更。
4. 如果后续允许临时 patch，必须将 diff、未跟踪文件和 hash 纳入不可变任务快照。
5. 在远端检出准确 commit，不以分支最新 HEAD 代替 commit。
6. 记录远端 commit 校验结果。

Git LFS 或大型数据不自动假设已配置；大型文件的仓库策略另行设计，首版实验任务可引用远程数据目录或挂载点。

## 6. 任务协议

任务清单至少包含：

```json
{
  "task_id": "run_xxx",
  "project_id": "project_xxx",
  "module": { "id": "apt-provenance", "version": "0.1.0" },
  "plan_version_id": "plan_xxx",
  "git": {
    "repository": "local-repository-identity",
    "commit_sha": "full-commit-sha",
    "working_tree_clean": true
  },
  "dataset_refs": [],
  "environment_profile_id": "env_xxx",
  "remote_workdir": "configured-project-path",
  "command": [],
  "config_artifact_ref": "artifact_xxx",
  "resource_request": {},
  "collect": ["logs", "config", "metrics", "plots", "report"]
}
```

任务命令需以数组或等价的结构化形式保存，避免把任意拼接 shell 文本作为唯一可审计记录。确实需要 shell 脚本时，应保存脚本本身、hash、提交位置和用户确认记录。

## 7. 提交与运行步骤

1. 用户选定项目、方案、Git commit、SSH profile、环境配置和数据引用。
2. Workbench 执行本地预检查并展示计划。
3. 创建任务记录和唯一远端任务目录。
4. 通过 SSH 运行初始化检查。
5. 将代码按 commit 获取到远端；首版 Git 传输方案实现前确认（远端 fetch 或打包传输）。
6. 确认依赖与数据引用可用。
7. 用户确认后执行命令。
8. 远端 Runner 写入日志、状态、产物清单和退出码。
9. 本地轮询/流式获取事件，断线后允许重连。
10. 任务结束后校验并回传小型产物，登记大型数据远程引用。

Git 传输方式以及远端是否能访问本地仓库、GitHub 或其他仓库地址尚未确定，须在 AutoDL 实测后选择。不得将 Git 凭证以明文写入命令日志。

## 8. 产物回传

首版必须回传：

- stdout/stderr 或运行日志。
- 实验配置和环境摘要。
- 指标数据（结构化文件）。
- 图表文件及生成脚本/元数据（若有）。
- 实验报告或结果摘要。
- 远端文件清单、大小、MIME 类型、hash 和生成时间。

大型原始数据留在远程。平台保存：远端主机 Profile ID、远程路径、数据集/版本标识、字节数、校验算法和 digest、生成任务 ID、访问说明。引用不可依赖临时 hostname 或未持久化目录。

产物传输应幂等，断点续传能力可以后续增加；首版至少避免重复任务覆盖既有任务目录。

## 9. 任务状态与恢复

建议状态：`preflight`、`initializing`、`syncing`、`queued_remote`、`running`、`collecting`、`completed`、`failed`、`cancel_requested`、`cancelled`、`disconnected`、`unknown_remote_state`。

- SSH 断开时标记 `disconnected`，探测成功后按远端任务 ID 重新连接。
- 无法确认远端状态时标记 `unknown_remote_state`，不能自动新开同一任务造成重复计算。
- 用户取消时先发送取消请求，等待 Runner 确认；记录最终退出状态。
- 每次尝试有独立 attempt ID，不能覆盖之前日志。

## 10. 安全与诊断

- SSH 连接采用用户本机 SSH Agent 或配置引用。
- 对密钥、令牌、环境变量等进行日志脱敏。
- 远程脚本需使用项目目录和任务目录，避免意外操作其他目录。
- 展示完整主机别名、远端路径、commit、命令和数据源后再启动。
- 日志对大文件输出做截断或引用，防止本地日志无限增长。
- 保存初始化输出、Runner 版本和远端环境摘要，供复现和故障定位。

