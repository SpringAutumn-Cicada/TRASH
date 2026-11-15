# 从研究领域到研究问题

新建项目需填写研究领域，研究问题可空；关注线索可选。阶段为 exploration 或 focused。已有项目不从标题补造研究领域或问题，使用探索前在项目配置中补填领域。原 research_question 若有内容，在多问题管理中作为既有已选问题保留。

## 使用流程

1. 开放阅读单篇论文，生成现有十页 Wiki。项目题目不限制提取，论文问题与项目问题分开。
2. 在文献库点击“探索研究方向”，选择已有全文 Wiki 的论文。仅此操作创建探索任务，不因导入论文自动创建研究方向探索。
3. 对输入较大的材料分组归纳，每组不超过40000字符；按需要逐层归纳，保留原始论文和知识页ID、证据路径、共识、分歧、反例及缺失范围。单页超预算或六轮仍不收敛时明确报错，不截断。
4. 输出候选方向、具体问题、文献依据、已有解法与反例、候选假设、最小验证、可行性、补充检索。材料不足可没有候选，不自动断言研究空白或新颖性。
5. 用户将结构及依据完整的方向加入候选问题，或在项目配置手动新增问题。管理 candidate、evidence-needed、selected、paused、excluded 五种状态，可同时选择多个。暂缓或排除需说明理由。保存使用项目版本检查，冲突不覆盖。
6. 从具体问题点击“定向补证据”，选择材料，生成检索及最小验证计划。补充论文并分析后可再次运行；本功能不自动联网、下载、运行实验或改变问题状态。

## 数据与入口

- 项目字段：research_area、research_interests、research_stage、research_questions。
- 多问题以 research_questions 为准。research_question 保留首个已选问题供旧消费者展示；不合并截断多个完整问题。
- GET/POST research-exploration，POST research-exploration/:id/resume 或 cancel；GET research-exploration/:id/candidates。
- GET/POST research-questions，PATCH research-questions/:id。问题保留候选来源和依据。
- 探索记录在项目 .trash/runtime/research-exploration 中，结果 Markdown 通过现有知识发布、版本及关系系统管理。
- 重启标记未完成探索为 interrupted，用户手动继续，不自动调用模型。已完成分组可复用，失败和停止任务保留日志。

## 交付验证边界

本次执行 pnpm build；未执行自动测试、lint、额外类型检查、浏览器或真实模型。结构检查与链接存在不代表观点正确。候选问题质量、分组证据传递及界面交互需用户验收。
