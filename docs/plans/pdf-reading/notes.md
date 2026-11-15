# PDF 实施证据

- 原解析 packages/literature/src/index.ts 只提取 getTextContent；现新增 inspectPdf 保留全部页（含空文字页）、PDF页序及页标。
- 本机已有 /usr/bin/pdftoppm，平台用独立子进程按页渲染 PNG；未安装或配置全局软件。缺失时返回 PDF_RENDERER_UNAVAILABLE。
- 前端新增锁定版本 pdfjs-dist 6.4.299，使用官方 PDFViewer、文字层、注释层及 PDF worker；cmaps/字体/wasm 从本地包受限资源接口提供，不依赖 CDN。
- 初次 pnpm add 因环境 store 不同失败；指定现有 store 后离线元数据缺失，改为单条命令指定 npm 官方 registry 完成。没有修改全局配置；锁文件只新增 workbench 的 pdfjs-dist 引用。
- 专用任务四页一批，CLI --image 输入所有页面，批次 Markdown 笔记与 pdf-reading.json 记录提供范围；失败不发布最终文档，相同输入指纹重试可复用批次笔记。
- 引用通过 source_id/hash/PDF页序打开独立阅读器；章节和图号为附加说明，未实现区域框高亮或旧自由文字引用自动识别。
