# 源码证据

- apps/server/src/knowledge-agent.ts：enqueue 按 source_id 拆分卡片；任务读取 input.json；内置 prompt_version=1；只读 codex exec 输出 output.json；parseKnowledge 后 knowledge.write 保存。
- apps/server/src/project-chat-tools.ts：聊天的 write 工具接受结构化 input，调用 KnowledgeStore.write；PROJECT_TOOLS.md 告知现有格式约束。
- packages/storage/src/knowledge-markdown.ts：现有文件为 metadata 单行 JSON frontmatter；卡片正文九栏目且解析依赖标题和顺序；文件名 knowledge ID；有发布日志和历史。
- packages/storage/src/knowledge.ts：主要先读数据库记录再对已登记文件 reconcile；现有逻辑并不等于扫描任意新建 Markdown 自动入库。写入和审核可以重新发布正文，迁移时须解除覆盖风险。
- apps/server/src/code-agent.ts：聊天工作目录 agent-workspace；现有工具提示与读写权限必须随方案调整；仅新增仓库 skill 不足以保证运行时加载。

边界：仅源码分析，没有读取或迁移真实论文数据。不得据此声称旧 JSON 链路报错均由 JSON 格式造成；会话、版本、权限、部署版本不同步也可能导致失败。

## 实施结果（2026-11-10）

用户修订为保留详细九栏目卡片，新增关键卡片，授权删除旧知识。实现文件主存储和双卡生成/展示，旧正文 JSON 写路由弃用。备份和清理实际结果见 docs/147-dual-cards-markdown-delivery.md；未测试、构建或真实调用模型。
