---
name: trash-abstract-wiki
description: 在 TRASH 摘要库中基于论文摘要生成给人阅读的摘要解读和给 Agent 检索的摘要 Wiki；不用于全文精读或正式主题综合。
---

# TRASH 摘要 Wiki

本 skill 只处理摘要库中没有完整 PDF 阅读材料的论文。仅使用 `input.json` 指定的标题、作者、发表信息、DOI、论文链接和原始摘要，生成两份不同用途的 Markdown：给人阅读的 `interpretation.md` 和给 Agent 检索的 `memory.md`。不读取全文、不生成 PDF 页码、不补充代码或实验流程。

人读卡片和 Agent Wiki 的章节、长度、事实与推断边界、摘要级证据标记及原始摘要链接，遵守本目录下原有摘要规则；两份文件不能直接复制成相同正文。摘要中的作者声称必须保持为作者声称，不能改写成已验证结果。

完成后分别回读两份文件，核对标题、source_id、摘要范围、数值限定和原始摘要相对链接。摘要 Wiki 不替代完整论文 Wiki；获得完整 PDF 后应改用 `trash-literature-wiki` 重新分析。
