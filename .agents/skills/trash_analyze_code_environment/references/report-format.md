# 报告 JSON

根对象字段：schema_version:1、summary（中文概述）、requirements、commands、resources、issues、limitations（字符串数组）。除上述字段外不添加字段。

requirements 每项：
- category: system/python/framework/cuda/tool/dependency/other
- name: 人类可读要求名称
- requirement: 原始版本要求或说明
- attribution: declared/inferred/unknown
- evidence: [{path,line_start,line_end}]，路径必须来自 input.json.files，行号在文件范围内
- check: {kind:python/package/tool/gpu/other,name:string,operator:eq/gte/lte/present/unknown,version:string}

check 只表达可直接验证的简单条件。包名称必须为有依据的发行包名。复合范围、CUDA/驱动兼容、未知包名与不确定推断使用 kind:other、operator:unknown，不简化为“满足”。版本只填数字点分版本；复杂约束保留在 requirement。明确 GPU 要求可用 kind:gpu、operator:present，但不把可见 GPU 当作显存充足的证明。

commands 每项：{purpose,command,attribution,evidence}。不编造缺乏依据的完整安装方案。
resources 每项：{name,requirement,attribution,evidence}。issues 同 resources 结构，记录冲突或缺失项。

明确声明/源码推断必须有至少一个依据，未知可无依据。不得把安装成功、实验成功或硬件验证写入报告。报告身份、时间、Skill 版本和代码指纹由平台添加，不自行填写。
