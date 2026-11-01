# 163 个累计提交集中验证

分支 ct_dev_test。Git 核对范围为 1dec0c2cd37e7dc0bc4e16f8ef23c37e08ae9bbd..bd1d0c6a85cc8447cad160418f0dfcf5313923e8，共 163 个提交、263 个变更文件，开始时无未提交改动。已核对根及祖先规范检索结果，无适用 AGENTS.md；依赖与 Chromium 已安装。完整 SHA、实际命令及最终退出码见同目录 141-focused-verification-results.json。

## 检查范围与既有记录

核对 docs/13-centralized-verification.md 中以前 13/73 个提交验证与遗留记录。本次按平台给出的 163 个实际待测集合重核当前快照，合并相同检查，没有逐提交重复跑历史版本。涉及公共协议、存储、服务端 API 与前端入口，因此检查其依赖闭包；文献解析包本次无变更，不重复运行其独立解析测试。

执行服务端项目引用类型检查（含依赖产物）、前端 noEmit、受影响 TS/TSX/测试 lint、协议/存储及服务端回归，以及选定的三个 Chromium 核心场景。没有执行全仓库测试或生产 Vite 构建。协议产物为项目引用检查的必要输出，不提交生成产物。

## 发现及修复

- 前端类型检查退出 2：实验数据内容联合类型没有准确缩窄，导致指标 string/object 混淆；改为按 dataset 字段选取实验结果类型。实验计划预检查引用了已移除的 diagnostic state，恢复该状态。
- lint 退出 1，共 16 项：未使用的导入/状态、无用正则转义、三元回调表达式。控制字符正则是路径安全检查，按已有项目惯例加精确文件级规则说明，不放宽安全校验或关闭全局规则。
- 本地回归首次 38 项中 2 项失败：裸 password 值未脱敏，补上完整凭据名的裸 dotenv/YAML 值脱敏，保持行号并避免误伤 token_dim/torch 参数表达式；分析测试夹具仍使用旧 -o 输出且没有新增报告字段，更新为 JSON 事件和适配报告，并实际验证本地应用、重新分析、指纹与恢复。
- 浏览器首轮 3 项中 2 项失败：用例使用已移除的实验结果导航、旧导入按钮。按当前功能设计更新，不回退产品。增加模式记忆及上传历史卡片交互时，修正测试标签定位过严和网络 mock 错拦页面导航等测试问题；新建记录有两个入口，显式使用顶部入口。

## 最后代码修改后的实际结果

| 实际完整命令 | 退出码 | 结果 |
| --- | --- | --- |
| pnpm exec tsc -b apps/server --pretty false | 0 | 公共依赖及服务端类型/声明生成检查 |
| pnpm --filter @trash/workbench typecheck | 0 | 前端 TS/TSX |
| pnpm exec eslint apps/server/src apps/server/tests apps/workbench/src apps/workbench/vite.config.ts packages/protocol/src packages/protocol/tests packages/storage/src packages/storage/tests tests playwright.config.ts | 0 | 受影响模块、配置和测试 |
| node --import tsx --test packages/protocol/tests/protocol.test.ts packages/storage/tests/storage.test.ts packages/storage/tests/knowledge.test.ts apps/server/tests/*.test.ts | 0 | 46/46 本地回归 |
| pnpm exec playwright test tests/e2e/project-literature.spec.ts --grep '项目功能导航\|两层导航\|文献复现' | 0 | 3/3 浏览器场景 |

JSON 文件的 commands 保存原始命令文本，Markdown 表格中 grep 的竖线仅为表格排版转义。

46 项包括协议校验、存储迁移/回滚/项目删除、知识与概览 API、实验幂等与提交、受控本地 SSH 与终端生命周期、Python Runner 的成功/损坏包/超时/取消、资源发现、凭据加密、报告任务完成/错误/取消/重启与适配恢复。

新增 runtime-fixes 回归覆盖补丁歧义写入前拒绝、备份及人工改动恢复保护、真实固定 Python 同步脚本的展开目录/备份/幂等/无关修改拒绝、全量上传与源码投影一致性、TAR.GZ 正常及穿越/链接拒绝、脱敏与模型 token 表达式、分片上传重建恢复及偏移保护、共享数据目录和中断记录删除保护、混淆矩阵计算与零分母。

三个浏览器场景覆盖跨页导航、数据实验记录编辑后关闭及应用内放弃确认、实验页签、目录弹窗及 inert、窄屏导航与焦点、项目删除；多份 ZIP 导入/切换/浏览/移除、处理方式与权重模式刷新记忆、源代码入口、历史上传成功卡片/重新上传按钮/展开 SHA-256。部分页面数据采用显式本地接口模拟，不伪装真实远端操作。

## 开发验证与用户验收

本轮集中验证计划内检查全部完成，无待修复失败。真实 AutoDL 可达性、真实模型分析质量、GPU 训练、5 GiB 实际网络上传和用户数据验收不属于本轮本地集中测试结论，未执行，也不宣称这些场景通过。SSH 使用隔离临时本地服务，Runner 使用临时仓库与微型 Python，浏览器使用独立 22224/临时工作区，未改动用户运行服务和远端数据。

非阻断输出：测试临时 git init 默认分支提示、Playwright FORCE_COLOR/NO_COLOR 提示，退出码仍为 0。没有修改全局 Git/Codex 配置。测试数据库、密钥、日志、trace 和构建产物不提交；保留忽略目录中的失败 trace 供本地排查。

最后一次代码/测试修改后五组命令均重新执行成功，随后仅补充本验证文档与机器记录。未重启用户服务、未合并、未推送、未关闭平台。
