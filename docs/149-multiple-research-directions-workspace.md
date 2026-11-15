# 多方向论文工作区目录

2026-11-10，paper_analyze，基线 f4b0afd。开始工作树干净，node_modules 已存在；读取 AGENTS.md、相关源码和近期历史。应用 expression-skill、daily-coding、planning-with-files，前端沿用现有文件模块风格。当前用户明确要求日常不主动构建，因此本轮不执行此前 AGENTS.md 默认自动构建/重启流程；未修改全局配置。

## 用户可见结构

新建论文项目目录格式标记为 2，保留 literature、wiki、code、data、experiments、manuscript 六类资料目录和 README.md。不再预建 research、根级 exports；资料子目录按用途创建，不覆盖已有文件。

文件模块新增“研究目录 · 方向 / 实验方案 / 运行批次”：

- 方向：wiki/directions/<方向ID>.md、code/directions/<方向ID>/、experiments/<方向ID>/。
- 实验方案：experiments/<方向ID>/<方案ID>/README.md。
- 运行批次：experiments/<方向ID>/<方案ID>/runs/<运行ID>/，包含 README.md 及 configs、results、figures、logs。
- 方向与方案必须先存在；ID 为小写字母数字、下划线或连字符，最多 64 字符；同路径不覆盖。中文名称进入说明文档。符号链接路径拒绝操作，创建前统一检查目标，失败仅回收本次新建的文件目录。

生成的说明保留研究问题、假设、证据、状态、评价条件、种子和代码版本等填写位置。共享文献、公共代码和数据引用使用，不重复复制。本次只实现资料目录层级；既有实验执行模块的数据模型未新增 direction_id/scheme_id，远端任务不会自动写入这些批次目录，需在运行说明中记录关联运行 ID，后续可单独接通。

## 内部路径收拢及兼容

新增 project-layout.ts 的 projectRuntime，集中路由知识任务、对话执行、环境分析/部署/修复、数据校验/上传会话、实验绑定、远端工作区、复现队列和结果运行记录。没有旧目录时，新记录写入 .trash/runtime/<模块>/；已存在旧目录时继续读写原目录，避免改变旧记录中的绝对路径。未批量移动、删除、重命名任何实际论文文件。

复现代码不是缓存：新建项目导入路径使用 code/reproductions，旧项目根级 reproductions 保留可见。聊天稿件链接适配隐藏运行目录，新项目指向 manuscript/drafts；旧链接继续兼容。项目根识别不再假设对话工作目录的上级就是项目根。

文件树和搜索默认隐藏已知内部根目录以及 . 开头项；开关改名“显示内部与隐藏文件”。历史 research、exports 若实际存在仍可见，不隐藏可能有用的用户资料；raw/files/project.yaml 为兼容内部项默认隐藏。真实目录中旧路径仍保留，界面简化不等于已迁移物理文件。

## 变更文件

新增 project-layout.ts、research-folders.tsx、本文及 plans/workspace-layout 下计划/笔记。修改工作区初始化、文件列表/搜索、文件页面样式与入口、API 错误提示、聊天与知识任务路径，并把 experiment 下相关模块的硬编码根路径替换为统一 helper。未修改协议、数据库 schema、依赖、全局配置、已有论文原文或实验结果。

## 实际验证与遗留

仅执行 Git 状态/历史、源码调用点和差异静态核对。未运行测试、lint、类型检查、构建、浏览器或真实模型调用，尚未测试。没有构建重启，旧进程尚未加载新 API。用户验收待进行：新建方向/方案/批次、同名冲突、旧目录可读性、内部文件显示、聊天写稿与原工作区迁移。

本轮不冒险重排旧项目。已有绝对路径兼容优先，完整物理迁移和实验任务自动关联留作单独迁移任务，避免把创建目录误报为实验执行能力。未推送、合并或关闭平台。
