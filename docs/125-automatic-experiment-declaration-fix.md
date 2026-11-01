# 修复自动实验接口声明生成失败

- 分支：ct_dev_test；开发基线：11e0ad7。
- 依据：读取用户本次失败构建留下的 apps/server/tsconfig.tsbuildinfo，发现 automatic-experiment.ts 的 TS4058：导出函数返回值使用 reproduction-queue 模块中未导出的 Queue，无法生成声明。没有重新执行编译。
- 修改：导出既有 Queue 接口，并为 createAutomaticExperiment 显式声明 Promise<Queue> 返回类型；保持原队列字段和执行逻辑。
- 开发自验：仅核对 Git、已安装依赖、既有编译诊断并审阅源码差异；依本轮用户规则未执行 lint、类型检查、测试、构建或浏览器验证，不宣称构建通过。
- 用户验收：尚未进行。待重新运行 pnpm dev，确认后端编译与启动结果。
- 生效方式：需要重新运行 pnpm dev 加载后端修改；本次没有重启服务、推送、合并或修改全局配置。
