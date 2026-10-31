# 实验模块使用与交付记录

## 范围与状态

基于 ct_dev_test 的 5da6660，实现“代码—SSH 主机—计划—远端运行—产物—结果”首版。实验与文献 Agent 任务分开，Codex 不在 AutoDL 上运行。仅连接已创建并开机实例，不登录网站、不购买、不自动开关机、不自动修复代码。

**尚未测试、尚未验收**。本轮仅检查 Git/文件历史、读取源码及官方接口，安装 ssh2 与类型依赖并编写代码和回归用例。没有执行 lint、类型检查、测试、构建、浏览器验证或真实 SSH/AutoDL 连接。测试用例仅编写，未运行。未修改全局配置，不合并 main、不推送，不关闭或重启现有服务。

依赖安装遇到 store 路径不一致后，使用命令级 --store-dir 指向本来已安装的 store；未修改全局 pnpm 配置。添加依赖使用 --ignore-scripts，不自动运行原生编译。

## 操作流程

1. 进入项目“实验”，代码页填写已有本地 Git 仓库根目录，可配置编辑器可执行文件。读取 Git 状态、差异、历史与文件；预览限 1 MiB，二进制只显示信息。
2. 在本地编辑器或用户自己的 Agent 中修改代码、暂存文件；平台“确认提交暂存区”仅提交已暂存内容，不自动 git add、不推送。正式实验要求整个工作树干净，包括未跟踪文件。
3. 主机页填写实例的 SSH 主机、端口、用户名及专属目录。认证方式为会话密码、本地私钥路径或 SSH_AUTH_SOCK；不是 AutoDL 网站账户。
4. 先探测指纹，核对后点信任，再提供密码或私钥口令。字段提交后清空，本机服务重启后密码需重填。可以忘记会话凭据。
5. 点击环境诊断；选择的解释器需 Python 3.9+，远端需要 Linux、Git、tmux、Bash。诊断只读取环境和创建平台目录，不自动安装或修改基础环境。
6. 数据集作为远端路径引用保存；可检查可访问性。填写预期 SHA-256 才能核对并标为 verified；目录不自动遍历，可提供已有校验清单路径，SHA-256 此时表示清单文件的哈希，不代表平台逐文件复核全部数据。
7. 计划页建立 JSON 草稿，选择完整 commit、主机、解释器、数据、命令数组、配置、GPU 编号或 cpu、时限、指标及产物路径。默认两小时。env 仅用于非敏感变量，不要在命令、配置或代码历史填写凭据。
8. 预检查后确认计划版本，修改建立新版本。提交前再次核对完整清单与 Git 历史传输范围。每次提交使用幂等键，响应不确定时复用同一确认操作，不自动另建任务。
9. 若使用 preparation_script，先查看提交中的脚本，再单独授权环境准备。准备成功记录与计划版本关联；普通实验不隐式取得安装依赖权限。脚本必须幂等，环境应使用明确解释器和项目依赖，不能依赖 shell activate 对后续会话持续生效。
10. 运行页查看队列、状态、事件、增量日志、取消和重连；日志按钮每次读取最多 256 KiB，界面只保留最近约 1 MiB。状态每五秒刷新。取消需 Runner 确认，不把 SSH 断线当作停止。
11. 产物页查看下载或远端引用。合法指标与零退出码形成待审实验结果，点击查看结果进入既有结果页；未提供合法指标时显示结果待补充。

## 计划 JSON 示例

```json
{
  "title": "APT 基线运行",
  "purpose": "验证数据与实验脚本",
  "method": "baseline-a",
  "baseline": "",
  "evaluation_protocol": "固定测试集",
  "commit_sha": "替换为完整Git提交SHA",
  "profile_id": "替换为主机ID",
  "dataset_ids": [],
  "python": "/root/miniconda3/bin/python",
  "command": ["python", "train.py"],
  "env": {},
  "config": {"epochs": 1},
  "seed": 42,
  "gpu": "0",
  "timeout_seconds": 7200,
  "metrics_path": "outputs/metrics.json",
  "expected_metrics": [{"name": "f1", "unit": "ratio"}],
  "artifact_paths": ["outputs/report.md"]
}
```

脚本工作目录为独立的 code 目录；通过 TRASH_RUN_DIR、TRASH_OUTPUT_DIR、TRASH_CONFIG_PATH 读取运行目录、产物目录和配置路径。命令数组首项为 python/python3 时替换成计划指定的解释器。seed 保存在配置清单，不会自动改变训练框架随机状态，实验代码应自行读取并应用。

指标文件写入运行目录 outputs/metrics.json：

```json
{"metrics":[{"name":"f1","value":0.81,"unit":"ratio","condition":"test"}]}
```

示例数值仅说明格式。所有预期指标应恰好出现一次，单位一致，不接受未声明指标、null、NaN 或无穷值。计划配置、commit、数据版本、运行 ID 和附件清单随结果保存，平台不把运行成功当作科学结论正确。

## 数据与恢复

数据库升至 user_version=3，v2 升级前创建 workspace-before-v3-时间.sqlite 备份。新增仓库绑定、SSH 配置、环境快照、数据引用、计划版本、运行与事件表；密码、私钥口令和私钥内容不写库。

单个代码包最多 200 MiB；不自动同步 LFS、子模块、忽略数据。运行目录位于 profile.remote_root/project_id/run_id，包含 manifest、code.bundle、code、runner、logs、outputs、environment、status。代码和产物不会覆盖已有用户目录。

程序生成文件、日志与指标通过 SFTP 回传，默认单文件 20 MiB、总量 100 MiB。大文件只登记路径、大小和 SHA-256。stdout/stderr 单个 50 MiB 轮转，最多保留当前和上一份。远端程序自己打印的敏感信息仍可能留在远端日志，不能依靠展示层脱敏代替管理凭据。

本地关闭后远端 tmux 继续；重开后重新提供密码并重连，不重新启动相同运行。实例重启、释放或任务状态丢失时保留 unknown_remote_state，人工核对；本版不允许在状态未知时直接重复执行。

实验运行期间阻止项目、仓库绑定与主机删除。删除本地项目不删除绑定的本地代码仓库，也不清理远端实验文件。既有知识包仍只导出文献、知识和已登记结果，不包含实验主机认证或可恢复运行状态；需要保留工作区数据库备份以恢复运行管理。

## API

项目级 /api/v1/projects/:projectId 下：

- repository：GET/PUT；子路径 status、tree、file、history 为 GET，commit、editor 为 POST。
- ssh-profiles：GET/POST；:id DELETE；credentials PUT/DELETE；fingerprint、trust、diagnostics POST。
- datasets：GET/POST；:id/check POST。
- experiment-plans：GET/POST；:id/preflight、confirm、preparation POST，传 version；确认传 confirm=true。
- experiment-runs：GET/POST；:id GET；logs GET（stream/offset）；cancel、reconnect、retry、collect POST。
- experiment-artifacts/:runId/:artifactId GET：仅下载该运行已登记且属于项目的文件。

运行 POST 需要 plan_id、version、UUID idempotency_key、confirm=true，可选 preparation=true。准备与正式运行各自独立确认。日志、请求、导出不得包含密码；运行身份 token 不在普通 API 返回，但平台本地与远端 manifest 含运行身份，用于取消和恢复，应按研究资料保护。

## 待集中验收

- v1/v2 到 v3 迁移、旧数据兼容和删除关联清理。
- Git 目录边界、脏树、LFS/子模块拒绝、bundle commit 与哈希。
- 可控 SSH 服务覆盖认证、指纹变化、凭据生命周期、SFTP 和错误分类。
- 远端 Runner 超时、取消、轮转、SSH 响应丢失、幂等启动、断线与服务重启。
- 指标缺失/单位错误、回传超限、哈希错误、重复收集不重复登记。
- 浏览器完整流程和窄屏；用户提供授权实例后再做真实 AutoDL 小规模实验。

用户验收尚未进行，不声明任何上述场景通过。首版远程执行链路较长，必须经过集中验证后再用于长时间或高成本实验。


## 用户构建日志反馈修复

用户运行 pnpm dev 时反馈服务端编译失败：service.ts 的 manifest 显式 commit_sha 与计划展开重复（TS2783），ssh.ts 两处 hostVerifier 参数没有推断出类型（TS7006）。本次移除重复字段，由已校验计划提供 commit_sha；未设置 hostHash 时指纹回调接收原始 Buffer，因此显式标注两个参数类型。

基于 fb6bacf，仅修改上述两处实现和本记录；工作树初始干净，依赖目录存在。实际验证仅为读取用户失败日志、源码和本地 ssh2 类型声明。尚未运行类型检查、测试、构建或浏览器验证，用户重启验收待进行；不合并、不推送、不修改全局配置。
