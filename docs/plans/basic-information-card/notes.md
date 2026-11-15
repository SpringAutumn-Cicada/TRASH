# 基本信息卡片、源码信息及书目回填

分支paper_analyze，基线663ff99。初始工作区干净；已核对AGENTS.md、近期提交/相关代码历史、已安装本地依赖。按skill-creator的分层规则更新项目skill，详细规则新增references/basic.md，全局skill与配置未修改。

## 实现

- 每篇新增 literature/cards/card-<source_id>-basic.md，固定Markdown字段：标题、作者、期刊／会议、发表年月、DOI／论文链接、源码状态、官方源码地址、第三方实现地址、证据与备注。基本卡片与详细/关键三卡一起生成；含单篇Wiki时一次发布四份文件。卡片内容仍由Agent直接写Markdown，不把正文交平台JSON转换。
- 基本卡片校验日期YYYY或YYYY-MM、源码四状态、地址http/https及无凭证、来源绑定。未知填未核实；缺源码填未找到/无，不将第三方当官方。官方公开必须有地址；论文给链接但未访问须标链接未核验，本次不增加自动联网搜索。
- 日期回填仅在备注明确正式发表/在线发表依据时使用；预印本写备注，不冒充正式发表。不猜月份，已有完整年月不会被同年只有年份的结果降精度覆盖。Agent是否真实读对日期仍需验收。
- source-bibliography.ts：书目回填、人工字段保护、并发revision/启动基线、建议与历史。source_bibliography为独立可选辅助表，首次使用创建，不改全局配置。原始PDF名称及source_id不变；只自动回填标题和年月，其他信息留在基本卡片。
- sourceSchema与sourceDetails新增publication_date，保留兼容year。人工编辑记录字段保护和revision；旧source_details里有人工标题/日期时保守保护。分析期间元数据变化也只生成建议，用户可在文献信息填入建议并保存确认，保留历史。
- 文献列表显示发表时间、基本信息入口、信息待确认入口；分析完成后读取项目元数据刷新标题/日期。卡片正文增加基本信息切换；详情支持年月编辑、建议确认及变更记录。未额外增加源码管理页面。
- 原论文内容hash不含标题/年份/年月，生成后书目回填不立即使新卡片过期，后续自动分析复用也按内容hash判断。真实原文/其他来源信息变化仍会使任务冲突或内容待更新。已有旧hash卡片可能显示待更新，未批量改写旧内容。
- 单篇、批量、独立卡片生成以及对话publish入口同步三卡路径/规则，提示词版本6，分组综合仍主要读取关键卡片。已有双卡片仍可阅读/参与仅综合，补齐分析会补基本卡片。Markdown发布最多四文件，所有文件在写前校验，同来源三卡和可选单篇Wiki限制保留。

## 变更文件

项目skill的SKILL.md、references/cards.md、新增references/basic.md；
apps/server/src新增source-bibliography.ts，修改knowledge-agent.ts、markdown-knowledge.ts、project-chat-tools.ts、knowledge.ts、literature-analysis.ts、index.ts；
packages/protocol/src/index.ts、knowledge.ts；
apps/workbench/src/knowledge.tsx、literature.tsx、markdown-knowledge.tsx、literature-ui.css；本计划和记录。

## 实际验证

- pnpm build成功，包含既有构建需要的包编译和Vite打包；现有主包大于500kB警告仍存在。git diff --check无错误。
- 重启前只读确认无queued/running知识任务、无实验运行、无活动对话或全项目分析记录。核对旧进程656738签名586325、工作目录与分支数据目录，仅重启22225本分支；日志保留，branch-service.json更新PID/签名。
- pnpm run dev内置构建成功；health接口200/ready。
- source-analyses接口200（23个来源），均包含hasBasic/metadataPending字段；来源详情接口200，支持bibliography状态；卡片索引200（当前6份）。只读检查未输出文献正文或提交任何回填。
- 未执行测试、lint、额外类型检查、浏览器验证、真实模型分析或审核/元数据保存请求；未批量生成或改写旧卡片及书目。上述为开发构建/启动检查，不代表用户验收通过。

## 遗留及用户验收

需用户执行单篇分析，检查三卡和线索Wiki、真实标题/年月/源码识别、自动回填、人工保护、建议确认与日期展示。平台校验格式和来源，不保证模型对原文事实解读正确；仓库链接默认未联网核验。
已有文件不补生成，已有人工保存记录保守保护，可能需要用户确认建议。文件发布保留事务日志/历史，元数据回填独立存于本地数据库；跨文件与数据库的进程崩溃一致性未做专门故障注入测试，失败时应核对已发布文件及回填记录后重试。
