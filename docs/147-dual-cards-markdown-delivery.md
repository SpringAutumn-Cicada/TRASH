# 双卡片与 Wiki 直接生成 Markdown 交付

2026-11-10，分支 paper_analyze，基线 9b3e650；起始工作树干净。核对近期提交、相关源码历史、项目规则和依赖，node_modules 已存在；未发现仓库 AGENTS.md，遵守用户提供的规范。沿用持久化计划，并应用 expression-skill、daily-coding、skill-creator、frontend-design；未调用子代理。

## 实现

- 项目级 `.agents/skills/trash-literature-knowledge/`：SKILL.md 与 cards/wiki 参考。详细卡片保留九栏目、数据集/基线/指标/证据和项目关联；关键卡片提炼四部分；Wiki 跨材料综合并区分事实、判断和假设。
- 知识任务显式加载该 skill，记录 hash 和提示词版本 2。按 source_id 一篇一次任务、详细/关键两个稳定路径；Wiki 一个主题文件。Agent 在隔离任务目录直接写 Markdown，平台原样提交文件，不再读取 output.json 正文或调用 knowledge.write 转文档。任务材料仍使用内部 JSON 快照，这不是正文输出协议。
- MarkdownKnowledge 从 literature/cards 与 wiki 扫描正文，简单 frontmatter 标识身份，不依赖旧数据库版本生成文件。按论文分组列表、关键/详细切换、全文搜索、手动刷新及周期扫描、Markdown 编辑、相对知识链接、历史快照和 hash 绑定审核。单篇坏文件单独提示。
- 原样文件提交包含 hash 冲突检查、临时文件、双文件提交前完整验证及恢复日志；任务失败保留隔离输出。关键卡片在配对内容变化后提示复核；Wiki 根据提交时记录的相对知识链接 hash 提示来源变化。
- 聊天 Agent 显式读取同一 skill，写 knowledge-draft/ 文件，再以路径和 expected hash 调用 publish；不通过工具 JSON 提交正文。聊天 publish 要求双卡成对。写入权限仍根据本轮 sandbox 判断。现有完整本机权限模式并非强制操作系统目录隔离，用户主动选择该模式时仍拥有其原有权限。
- 文献自动分析的后续 Wiki、项目概览和旧只读列表适配文件记录；旧卡片/Wiki 正文 JSON 写入口拒绝写入。实验结果保持结构化链路。知识包导出附带 Markdown 文件；恢复支持新文件包，旧卡片/Wiki 结构化包明确拒绝，避免悄悄恢复不可见旧记录。

文件位置：`literature/cards/card-<source_id>-detail.md`、`literature/cards/card-<source_id>-key.md`、`wiki/wiki-<稳定ID>.md`。frontmatter 字段为不加引号的简单 ID 标量；不支持任意复杂 YAML。历史/审核/配对与依赖状态放在 `.trash/markdown-*` 中。Markdown 正文直接可读，标题及顺序不再由旧九栏目解析器强制。

## 用户授权清理旧内容

用户明确要求全部删除旧卡片与旧 Wiki。清理仅本分支数据根 `/home/cicada/.local/share/trash-paper-analyze` 的项目，未触碰 ultra 或其他分支。脚本 `scripts/clear-legacy-knowledge.py` 是显式操作，不在启动时自动执行，也不会自动对新数据重复清理。

实际备份：`/home/cicada/.local/share/trash-paper-analyze/backups/legacy-knowledge-20261110-paper-analyze/`。含 SQLite 一致性备份、原文件副本及 manifest.json 原路径映射；未加入 Git。

清理前列明的实际论文根：`/home/cicada/paper/trash_apt_test/project_256f6807-adad-4ac9-af42-03ca81a0fa96` 和数据根内另一项目。移除旧格式 wiki/cards 文件及对应历史、同步状态、旧知识任务输出与分析状态；聊天历史不删，只移除会重新生成的旧知识快照。

实际结果：34 个旧 Wiki 对象、43 个版本，旧卡片原为 0；移除 2 个旧知识任务及 106 个文件/目录目标。清理后旧卡片/Wiki 数据库版本为 0。所有清理目标均有备份副本。操作后只读核对：项目 2→2、论文来源 2→2、附件记录 40→40、正文段落 19→19、实验结果版本 0→0。

恢复时先停用该项目知识写入，按 manifest 选择性恢复文件及对应记录；不要用旧全库直接覆盖现在的数据库，以免覆盖清理后新增内容。备份中可能含本地敏感数据，目录权限为 0700，数据库备份 0600。

## 实际验证与限制

开发自验仅源码/调用链/Git 差异静态核对，以及上述真实数据清理结果和备份存在性核对。按本轮明确规则，未运行测试、lint、类型检查、构建、浏览器、skill 验证器或真实模型调用，尚未测试。实际生成质量、UI、断电恢复、导出恢复等均待集中验证和用户验收，不能写通过。

未启动或重启服务、未合并、未推送、未修改全局配置或关闭平台。需要重启本分支服务加载新增后端接口；运行旧后端时前端会提示接口未加载。旧任务已清理，没有自动重新生成用户论文内容。

已知范围：每次扫描读文件建立内存列表，未新增全文检索数据库；前端每四秒刷新。来源变化提醒针对已记录的知识文件链接，不做任意外链或论文语义有效性推断。历史快照为通过平台提交产生的内容；外部编辑器直接修改可显示并使审核失效，但不承诺记录外部编辑的每次中间版本。旧知识 JSON 编辑器源码保留供旧组件兼容，卡片/Wiki 新入口不再使用它；文件模块将新知识目录保持只读预览，编辑使用卡片/Wiki 页面。

## 变更文件

新增三份 skill 文件、server MarkdownKnowledge、workbench Markdown 页面和样式、显式旧数据清理脚本、本交付记录。修改服务路由、知识生成/导出恢复、聊天工具与提示、文献自动分析、概览、前端路由和 Markdown 链接组件，以及任务计划/证据笔记。未修改协议/存储包全局 schema、依赖清单、全局配置、论文原文、聊天历史或实验数据；本地备份与数据不提交。
