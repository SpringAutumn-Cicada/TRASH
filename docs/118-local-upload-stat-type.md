# 本机数据上传 Stats 类型修复

用户提供 pnpm dev 实际日志：前端构建完成，服务端在 dataset-upload.ts 第56行因 bigint 不能赋给 number 而构建失败。原 localInfo 使用 Awaited<ReturnType<typeof stat>>，Node stat 重载返回类型包含 BigIntStats，使 size 被推导为 number | bigint。实际调用没有 bigint:true，返回普通 Stats。本次明确导入 node:fs 的 Stats 类型并用于 localInfo，保持大小、时间与 inode 检查为原数字路径，不强制转换 bigint，也不修改上传行为。

分支 ct_dev_test；开始工作树干净、依赖存在，已读取相关代码和提交历史，未发现仓库 AGENTS.md。开发自验仅静态核对报错行与类型来源，按用户约定未运行 lint、类型检查、测试、构建或浏览器。用户旧构建失败不能作为本次修复通过记录，新构建结果待用户验收。需要重新运行 pnpm dev，成功启动后刷新页面；本次未主动重启、推送或合并。
