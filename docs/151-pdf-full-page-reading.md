# 原始 PDF 阅读器、全文图文批次与引用定位

分支 paper_analyze，业务基线 513855c。起始工作树干净，已读取 AGENTS.md、相关代码历史和项目规范；依赖已存在。使用 daily-coding、planning-with-files、既有前端样式及 trash-literature-knowledge skill 规则。遵守持久授权构建/重启，不自动运行测试或浏览器。

## 实现说明

- 文献详情改为展示原始 PDF.js 阅读器，旧纯文字索引折叠到独立详情。基于官方 PDFViewer 组件，包含文字层、注释链接层、连续页面、按需渲染、缩放/适合宽度、旋转、搜索、PDF 页序/原文页标、文档目录和懒加载缩略图。不是将提取文字重新排版。
- 前端直接依赖锁定 pdfjs-dist 6.4.299；worker 打包为本地资源，cmaps/standard_fonts/wasm 从受限的本机包资源接口读取，无 CDN。只增加本包依赖和锁文件引用，不修改全局配置。
- 新 PdfReading 服务读取当前项目原始 PDF（优先主原文，其次关联 PDF），对实际字节计算 hash。inspectPdf 保留每页文字与页标，包括无文字层的扫描页。缓存位于 .trash/cache/pdf/<hash>/。
- 本机已有 /usr/bin/pdftoppm，平台使用非 shell 的 execFile 按页输出 PNG，支持 400 像素缩略图、2200 像素分析页和 4400 像素放大页。缓存文件按 hash/页/尺寸区分，同页并发请求合并；缺少渲染器时明确返回 PDF_RENDERER_UNAVAILABLE，不安装或修改系统软件。
- 知识任务提示词版本 3，每四页一批，所有页面 PNG 通过真实 CLI --image 输入，各页文字同时提供。每批产出 Markdown 阅读笔记，pdf-reading.json 记录源文件 hash、总页数、各批页码和状态；所有批次有笔记后才综合生成双卡片/Wiki。非 PDF 资料继续使用原文字材料。
- 批次失败、无笔记、超时或取消，不发布最终内容；相同输入指纹的显式重试可复用旧任务已完成笔记。总超时包含图文批次及最后综合，生成面板新增 30–7200 秒可选超时，默认 3600。自动文献分析的原超时设置未擅自扩大。
- 聊天工具增加 pdf-pages、pdf-page，返回指定页 PNG 的本地路径和引用地址；Agent 必须实际使用图像工具打开路径。提供 path 不等于模型已看过图。小字图表可请求 scale=4400；不清楚必须标注未核实。
- 新引用格式：[PDF第N页，原文页标X，章节/图表说明](/api/v1/projects/<project>/sources/<source>/pdf-view?hash=<hash>#page=N)。跳转独立阅读器，按 PDF 页序定位；阅读器校验文件 hash，版本不符拒绝默默跳到新文件。旧自由文本 p./§/图号不自动猜测定位，尚无区域框选高亮。

## 实际操作与验证

原先 pnpm add 因环境 store 不一致失败；改为本命令指定已安装依赖的 store，离线元数据不足，再指定官方 npm registry 成功。未执行全局 pnpm config、未安装系统包。

pnpm build 完成：前端 Vite、服务端/依赖 TypeScript 构建成功。后续只因最终取消保护修改补跑服务端构建，成功；原启动入口重启时又完成构建。前端主包约 1659 kB，worker 约 1264 kB，有 >500 kB 分块建议，无构建错误。构建不是浏览器视觉或模型效果验收。

重启前知识任务为 0，未发现运行中聊天；核对旧 PID 88605 的签名、工作目录和独立进程组，只停止本分支服务。新管理 PID 104434，地址 http://127.0.0.1:22225，更新本地 branch-service.json，运行文件不提交。

只读启动检查：/api/v1/health 返回 200/ready；/pdf-reader 页面入口 200/text/html；本地 FoxitSerif.pfb 资源 200；现有来源的 pdf-view 引用路由 302，目标保留项目、来源及 hash。未读取或改写用户知识正文，未生成实际 PNG 作为验收样例，未调用模型。

未运行测试、lint、独立类型检查、浏览器/视觉验证或真实模型全文阅读。尚未验收：复杂 PDF 的视觉保真、图表理解准确率、长论文耗时、扫描页阅读效果、取消恢复、浏览器页码跳转与高 DPI 表现。未执行不得写通过。

## 限制

- 页面完整提供和笔记产生，不能证明每个图表/公式都被正确理解；状态使用 provided / notes-produced / reused-notes，最终 all-batches-noted，不伪称逐项核验。
- 没有新增专用 OCR，扫描页由视觉模型阅读；全文搜索仍依赖原文字层。没有实现区域裁剪或区域高亮；可先用 4400 整页放大。
- 全文图文阅读会增加模型调用数及耗时；每四页一轮，加一轮最终综合。多篇 Wiki 输入也会逐篇读取原 PDF，原任务超时不足会明确失败并保留笔记。
- Poppler 渲染器为当前主机已有系统依赖；其他主机需先具备 pdftoppm，缺失有明确错误，不自动降级成纯文字。
- 来源与 hash 为引用身份，章节/图号是说明文字，不自动核验其语义正确性。没有转换旧卡片的自由引用，也不自动重生成现有卡片/Wiki。

## 变更文件

新增 server/pdf-reading.ts、workbench/pdf-reader.tsx/css，修改文献包 PDF 元数据/静态资源导出、服务路由、知识任务/聊天工具、原文入口和 Markdown 链接处理、生成超时设置、项目 skill；修改前端 package.json 和 pnpm-lock.yaml，新增本记录和 docs/plans/pdf-reading 的计划/证据。未改用户原始 PDF、已有卡片/Wiki、实验数据、数据库 schema、全局配置、认证文件。未推送、合并或关闭平台。
