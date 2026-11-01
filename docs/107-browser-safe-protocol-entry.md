# 浏览器协议入口与启动构建修复

用户实际 pnpm dev 日志显示协议编译完成，但 Vite 构建失败于 packages/protocol/dist/index.js 的 node:crypto randomUUID 导入。新增评估功能将原本仅类型使用的协议根入口变成前端运行时依赖，导致 Node 专用模块进入浏览器打包。此前修正预览结果的索引类型并非这次日志对应的根因。

新增 @trash/protocol/browser 子路径，明确导出不依赖 Node 的实验结果校验器、指标定义与计算函数。评估编辑器和知识表单改为从该入口导入运行时代码；其他根入口的类型导入不变。原 Node 入口与 makeId 的行为保持原状，不添加浏览器 Node polyfill，不改生成的 dist，不修改全局配置。browser.ts 只引入 knowledge.ts、evaluation.ts 与 zod，静态查看没有 Node 模块依赖。

交付分支 ct_dev_test；开始工作树干净、依赖目录存在，已阅读相关文件历史，未发现仓库 AGENTS.md。用户提供的旧构建结果为失败，不能记为新版本通过。开发自验仅阅读依赖链与差异；按本轮规则未运行类型检查、测试、构建或浏览器。用户验收待执行。需要重新运行 pnpm dev，构建 browser.js 后启动服务，再刷新页面；本次未主动重启、合并或推送。
