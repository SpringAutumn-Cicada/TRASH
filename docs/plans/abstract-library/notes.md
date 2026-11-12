# 独立摘要库基础版本

第一阶段：新增 material_scope=abstract，旧来源默认保留原行为。摘要原文和解析资料分别存 abstract-library/materials、abstract-library/parsed，分析结果存 abstract-library/notes，历史结果按哈希存 abstract-library/history。不写全文检索段落，默认来源列表与全文自动整合排除摘要。独立项目 skill trash-abstract-literature，任务共用调度但使用 abstract_mode 隔离，摘要任务只输出一份初版解读，不生成全文卡片或正式主题。

提供摘要录入、独立列表、单篇分析、结果只读接口；重复摘要导入复用同 DOI 或同标题同摘要的记录。输入/输出范围与来源哈希检查保留，发布检查旧结果哈希并保留历史。没有迁移既有文献，也没有调用真实模型。后续字段与呈现细化、跨库关联及补充全文转入功能另行迭代，本轮不伪装为已支持。

开发自验：代码差异审阅、git diff --check，按分支授权构建成功（Vite大chunk提示）；未运行测试、lint、额外类型检查或浏览器验证。端到端模型分析待用户验收。
