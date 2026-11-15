# 源码依据与实现边界

- project-workspace.ts 原先预建 research、exports 等根目录；新建项目版本 2 保留六类资料目录，文献子目录兼容原文存储。
- 原模块普遍直接 join(store.root,'projects',id,模块名)。统一 projectRuntime 路由新增运行记录到 .trash/runtime；检测到旧目录则继续使用，不改变已保存绝对路径。
- reproductions 含真实导入代码，旧目录保持可见，新项目落到 code/reproductions；不当缓存隐藏或删除。
- project-files.ts 的列表和搜索统一过滤根级内部记录；打开“显示内部与隐藏文件”可查看。raw/files 为原存储兼容目录，默认隐藏而不搬动。
- 新增研究目录创建 API 和文件模块表单。方向说明在 wiki/directions，下属代码和实验目录分开；方案和运行批次通过方向/方案 ID 约束层级。只创建资料骨架，不自动绑定或执行平台已有远端实验任务。
- direction 文档为普通 Markdown，可在文件模块编辑，不混入平铺的 Wiki 文件索引。
- 本轮没有修改任何实际论文项目目录，也没有构建、重启或测试；旧项目不会自动批量迁移。
