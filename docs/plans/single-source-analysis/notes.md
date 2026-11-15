# 单篇文献分析交付记录

- 分支：paper_analyze。保留先前中断工作并独立提交 7b849fc；本次未继续集中测试。
- 每行删除左侧新增微型分析按钮，排队/运行时禁用重复提交，分析完成提供三份结果链接，失败展示原因。已有输出需确认重新生成，旧版本保留历史。
- POST /api/v1/projects/:project/sources/:source/analyze 固定单来源，校验归属和重复活动任务；GET source-analyses 提供精简状态，不返回任务快照。
- include_source_wiki 模式只向任务快照及工作副本提供当前来源和当前来源已有知识文件，执行现有 PDF 全页图文阅读。三份 Markdown 原子发布，校验 source_id；任一输出缺失/格式无效/并发修改则不发布这批结果。
- 稳定路径：literature/cards/card-<source_id>-detail.md、literature/cards/card-<source_id>-key.md、wiki/wiki-<source_id>.md。
- 顶部入口改为“分析全部文献”；原有全项目流程保持。
- skill 明确支持单篇 Wiki；生成正文仍直接落地 Markdown。

## 实际验证

- pnpm build 成功，含必要的包编译和前端构建；Vite 提示现有主包超过 500 kB。
- git diff --check 无错误。
- 重启前核对进程签名 748412、工作区和数据目录，数据库没有活动知识任务或实验运行；只重启本分支 22225 服务，更新分支进程身份，保留日志。
- 启动入口 pnpm run dev 再次构建成功并监听 22225。
- 启动后 GET /api/v1/health 返回 200 / ready；当前项目 GET source-analyses 返回 200（3 个来源，0 个活动单篇任务）。
- 未执行测试、lint、额外类型检查、浏览器验收或真实模型调用。开发构建/健康检查不代表用户验收通过。

## 遗留

- 用户仍需点击单篇按钮验收完整真实 Agent 阅读、三份文档内容和视觉布局；本轮遵照“不测了”未执行。
- 元数据不含 PDF/正文的来源仍可能因材料缺失失败，失败原因显示在对应行。
