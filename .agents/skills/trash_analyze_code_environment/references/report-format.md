# 报告 JSON

根对象字段：schema_version:2、summary（中文概述）、requirements、commands、resources、issues、limitations（字符串数组）。另须包含 image_selection 和 agent_deployment；除这些字段外不添加字段。

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

## image_selection（面向人）

严格包含 framework、framework_version、python、cuda 四个字段。每个字段是 {value:string,attribution,evidence}，证据格式同上。例如框架名称 PyTorch，框架版本 2.1.0；数字仅作格式示例，不能套用。未知 value 填“未知”且 attribution:unknown。兼容组合无法确定时必须说明未知或冲突。

## agent_deployment（面向 Agent）

{status:"ready"|"blocked",venv_path:".venv",prerequisites:string[],blockers:string[],steps:[{purpose,command,attribution,evidence}]}

steps 至少一项，按执行顺序给出完整 shell 命令。prerequisites 明确工作目录、匹配镜像/驱动、TRASH_PYTHON 绝对路径、联网和必要工具。venv 只能创建于代码根目录 .venv；每条安装使用 .venv/bin/python -m pip，不改变系统或 Conda base。不得输出自动执行入口；由调用者审核并执行。blocked 时不给依赖未知版本或地址的伪完整安装命令，列出缺失参数。steps 同样校验证据，部署策略推断用 inferred，证据指向促成该步骤的实际项目文件。

commands 保留训练/评估等参考命令；环境安装以 agent_deployment.steps 为准。两部分均不得声称已执行。
