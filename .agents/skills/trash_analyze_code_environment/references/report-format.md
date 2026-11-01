# 报告 JSON

根对象字段：schema_version:2、summary（中文概述）、requirements、commands、resources、issues、limitations（字符串数组）。另须包含 image_selection、agent_deployment 和 code_information；除这些字段外不添加字段。

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

{status:"ready"|"blocked",venv_path:".venv",prerequisites:string[],blockers:string[],runtime_notes:string[],steps:[{purpose,command,attribution,evidence}]}

steps 至少一项，按执行顺序给出完整 shell 命令。prerequisites 明确工作目录、匹配镜像/驱动、TRASH_PYTHON 绝对路径、联网和必要工具。venv 只能创建于代码根目录 .venv；每条安装使用 .venv/bin/python -m pip，不改变系统或 Conda base。不得输出自动执行入口；由调用者审核并执行。blocked 时不给依赖未知版本或地址的伪完整安装命令，列出缺失参数。steps 同样校验证据，部署策略推断用 inferred，证据指向促成该步骤的实际项目文件。

commands 保留训练/评估等参考命令；环境安装以 agent_deployment.steps 为准。两部分均不得声称已执行。

blockers 只记录使环境安装无法执行的事项；runtime_notes 记录实验数据/权重/缓存、未锁版本的兼容性、GPU 运行验证等提醒。包名映射明确但没有声明版本时允许输出无版本包名安装，不捏造版本；已有明确版本和构建必须保留。未运行实际安装或未联网确认可下载不是静态安装阻塞。status:ready 表示安装方案可尝试，不代表已验证；blocked 不代表放弃已经确定的步骤。旧版报告可能将运行提醒写入 blockers，部署 Agent 应基于材料重新分类。


## code_information（代码信息）

根对象：{datasets:[],run_plans:[],unresolved:string[]}。本次生成必须包含，历史报告缺少此字段仍可查看。各数组长度分别最多 80、40、100；未识别时用空数组并在 unresolved 解释，不填伪造数据。

datasets 每项严格为：{name,version,role,format,paths:string[],directory_structure,source,preprocessing,split,weights,manual_preparation:string[],attribution,evidence}。除数组及 attribution/evidence 外均为字符串，未知字符串明确填“未知”。role 区分原始数据、预处理产物与训练/验证/测试用途，paths 保留相对或绝对原路径。source 只有材料明确时才写地址。不要记录凭据、真实数据内容或编造数据集名称。

run_plans 每项严格为：{name,scope,status:"ready"|"blocked",parameters:string[],blockers:string[],steps:[],execution:对象（见下文自动执行协议）,attribution,evidence}。
steps 每项严格为：{stage:"prepare"|"preprocess"|"train"|"evaluate"|"collect"|"other",purpose,working_directory,entrypoint,command,inputs:string[],outputs:string[],metrics:string[],attribution,evidence}。各字符串数组最多 40 项（parameters/blockers 最多 80），每方案最多 60 步。未知工作目录/入口明写未知；无法形成明确命令时 command 留空，并在 blockers 说明，方案标 blocked。不得给未填占位符命令。顺序表示建议执行顺序，不代表执行记录；指标数组记录名称，不填想象的分数。

新增对象和每个步骤采用同样的证据规则，declared/inferred 至少一项有效引用。unresolved 记录关键未知和采集限制。原有 commands/resources 继续兼容保留，详细数据需求与运行方案以 code_information 为准。

## 自动执行协议（Skill 2.3.0）

每个 run_plans 项新增 execution（历史报告可缺省，新分析必须包含）：

```
execution: {
  dataset_runs: [{
    dataset_name: "必须精确对应 code_information.datasets 中的唯一 name",
    status: "ready 或 blocked", blockers: [],
    dataset_subdirectory: "", required_paths: [],
    mappings: [{path: "data/trace", subpath: ""}],
    steps: [{stage: "train", purpose: "用途", working_directory: ".",
      argv: ["python", "train.py", "--data", "{dataset}", "--output", "{output}"],
      env: {}, attribution: "inferred", evidence: []}],
    config: {}, evaluation_protocol: "源码明确的划分与评价口径",
    result: {mode: "json", root: "run", path: "outputs/metrics.json",
      metrics: [{name: "F1 score", unit: "ratio", key: "", label: "", scale: 1}],
      notes: "输出与采集依据", attribution: "inferred", evidence: []},
    attribution: "inferred", evidence: []
  }], attribution: "inferred", evidence: []
}
```

以上仅为字段示例，不是可照抄的实验方案，所有 evidence 必须填写实际依据。

- dataset_runs 对每个适用数据集分别列一项；没有适用数据集时为空并解释。必须覆盖该方案涉及的数据集；无法完整推导的也列出并标 blocked。不要用“全部数据集”代替明确名称。
- dataset_subdirectory 是所选平台数据根下的相对子目录，通常空。required_paths 是该子目录下必需文件/子目录的真实相对路径；不填通配符、伪造文件或未知占位符。
- mappings 为代码目录中的临时软链接，subpath 指向本次数据根下子路径。参数/已有环境变量/外部配置可传路径时 mappings 为空。多个映射不得重叠。不能覆盖真实目录；预处理产物应写运行输出目录，不能要求改写公共数据集。
- working_directory 相对用户选择的已部署代码根（不是 ZIP 容器前缀），根目录填 `.`。平台仅自动剥离 ZIP 唯一包裹目录；不能把这个包裹目录再次作为工作目录。若为多子项目，保留真实子项目目录。
- argv 是直接执行的参数数组，不是 shell 字符串。按每个阶段分别给出步骤，python/python3 由平台替换为当前 venv 解释器，PATH 也优先 venv。可执行仓库已有 bash 脚本，但不能用 bash/sh -c、eval、python -c 包装拼接命令；无法安全参数化的 shell 流程标 blocked，说明适配需求。
- 平台支持 argv/env/config 中的 `{dataset}`（本次绑定数据路径）、`{output}`（独立输出目录）、`{config}`（本次配置 JSON）、`{code}`（已部署代码根）、`{python}`（venv 解释器）。仅在源码支持相应参数/配置时使用；不包含用户需填写的占位符。不要发明 TRASH 环境变量会被现有代码读取的假设。不设置 PATH/PYTHONPATH/PYTHONHOME/VIRTUAL_ENV/CUDA_VISIBLE_DEVICES 或 TRASH_*，资源由平台管理。非敏感 env 按源码依据填写。
- config 用于源码确实支持的 JSON 配置入口，保留参数与数据划分，路径可用平台占位符；不注入凭据，不修改原配置文件。代码要求其他格式或必须修改源码而无法用外部配置/脚本参数适配时标 blocked，并写差异方案，不自动改源码。
- result.mode 为 json/csv/log/none。root:run 从独立运行目录读，root:code 从已部署代码根读；优先让命令输出到 `{output}`。path 是对应根内相对路径。stdout/stderr 用 root:run + logs/stdout.log 或 logs/stderr.log。
- json 为标准 `{metrics:[{name,value,unit,condition}],confusion_matrix?,evaluation?}` 时，metrics 的 key/label 留空。普通 JSON 的 key 可指定精确点分字段路径（如 scores.f1）；csv 可指定列名 key，取最后一行。不得假定没有依据的输出格式。json 支持保留标准混淆矩阵/评价对象，不从分数反推计数。
- log 的 label 是源码明确打印的完整字面量前缀（例如 `Test F1:`），平台读取紧随其后的数字，以最后一次出现为准，不接受任意正则或假想标签。日志包含多数据划分/多种聚合时标签必须能唯一定位最终目标分数；不能定位则 blocked，注明需采集适配。scale 仅做明确单位转换（百分数到 ratio 为 0.01），否则 1。
- result.metrics 声明实际能提取的指标，不要求代码输出它没有的 precision/recall。没有结构化文件且无法可靠解析日志用 none、path 空、metrics 空，notes 说明仅保存日志和产物；不要伪造输出。不阻止有完整命令的执行，但平台将明确提示结果待补充。
- ready 必须有明确 evaluation_protocol、完整非空 steps、无 blockers、所用输入可由数据绑定满足；未知权重、其他手工输入、需源码适配、存在输出污染风险时标 blocked。blocked 的未知字段留空，列出具体原因。
- execution、每个 dataset_run、step、result 都包含 attribution/evidence，沿用有效文件行号规则。上层文字方案 ready 不等于 dataset_run ready；平台只自动执行完整的 dataset_run。

可选断点恢复：只有源码明确实现 checkpoint 保存和加载时，dataset_run 可增加 `resume:{checkpoint_path:"outputs/实际检查点文件",steps:[与正常 steps 相同结构],attribution,evidence}`。checkpoint_path 相对上一次独立运行目录，恢复命令用 `{checkpoint}` 引用已有文件，并继续写本次 `{output}`。平台先验证文件存在；不复制、不删除旧结果。不支持、路径动态无法确定或只有权重无优化器/训练状态时，不宣称训练断点续跑，省略 resume 并在说明中写明限制。resume 与每个恢复步骤同样要求有效证据。普通运行步骤不得引用 `{checkpoint}`。

平台保留 `outputs/trash-collected-metrics.json` 作为归一化产物，result 不得把它当作原始来源。JSON 仅输出标准 confusion_matrix 时，result.metrics 可为空，由平台按真实计数派生指标；没有矩阵时至少声明一个实际可采集指标。除已有源码支持的 resume 步骤外，不使用 `{checkpoint}`。argv 的 Python 入口仅用 python/python3 或 `{python}`，不使用系统解释器绝对路径；原始报告命令仍可作为证据保留。

execution 可增加 `resource:{device:"cpu"|"gpu"|"unknown",notes:"资源依据或不确定性",attribution,evidence}`，新分析应尽量提供。依据实际 CUDA 调用、设备参数和 README 判断；未确定填 unknown，不推测显存或耗时。平台对 cpu 自动选择 CPU，其他情况使用可调整的默认 GPU 编号，超时为平台选项。
