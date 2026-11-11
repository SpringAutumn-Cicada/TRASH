# 恢复上一版文献列表

用户明确要求恢复上一版；开始时工作区干净，已检查Git近期提交、目标提交48262d9及AGENTS.md，依赖已安装。
使用git revert --no-commit 48262d9撤销该次布局提交，未使用reset或破坏性回退。恢复PDF格式图标、独立发表时间列、原状态和结果入口布局。原提交仍在Git历史中可恢复。
变更：literature.tsx、literature-ui.css恢复到6e2e7f5内容（针对这两个文件比较无差异）；撤销该布局提交附带的paper-catalog-layout记录，新增本恢复记录。其余基本信息卡片、源码和年月回填等功能保留，无用户文件或数据库修改。
实际验证：pnpm build成功（现有大包警告保留），git diff --cached --check无错误，健康接口200/ready。前端Vite热更新生效，无需重启。未运行测试、lint、额外类型检查或浏览器验证，视觉效果待用户确认。
