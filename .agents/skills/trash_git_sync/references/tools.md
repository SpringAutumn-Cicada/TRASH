# 工具参数与结果

均使用本轮 `project_tool.py`，替换示例值。

## 确认本地提交

```json
{"operation":"request-git-commit-choice","message":"fix：修复实验运行重试","files":["path/to/code.py"]}
```

`files` 为本轮选中的仓库相对文件路径。绑定仓库的基线、文件变化、Git 身份由平台复核。有合并冲突、已暂存与工作区内容混杂等情况时，先明确要提交的版本。对应仓库还没有初始提交时，按用户授权先建立明确的基线。

## 独立同步

```json
{"operation":"autodl-targets"}
```

```json
{"operation":"git-sync-upload","profile_id":"ssh_…","root":"/root/autodl-tmp/project","commit":"完整的提交SHA","confirm":true}
```

```json
{"operation":"git-sync-versions"}
```

`profile_id` 和 `root` 用主机查询返回值。`confirm:true` 表示 Agent 已核对用户指定的同步内容。回执中的 `id` 用于导回远端修复，`path` 可用于人工运行。若同版本检出已存在但有跟踪文件改动，报告冲突，保留该目录。

## 计划与结果

`git-sync-plan` 接收稳定的 UUID `request_id` 和对象 `content`。复用同请求 ID 只重试同一份计划。协调派单使用 `coordination-draft` 的稳定 `key` 和同一 `content`。

`content` 至少填写 `title`、`purpose`、`method`、`evaluation_protocol`、`commit_sha`、`profile_id`、`dataset_ids`、`python`（远端绝对路径）、`command`（参数数组）、`gpu`（`cpu` 或设备编号）、`expected_metrics`（包含 `name`、`unit` 的数组）。按任务设置 `config`、`metrics_path`、`artifact_paths`、`seed` 和 `timeout_seconds`。

`source_config_path` 可指向 `experiments/` 下的 JSON 源文件，平台记录该文件哈希。把本次实际运行参数写入 `config`。原始配置文件哈希与 Runner 展开参数后写出的实际配置哈希是两个值。`input_revisions` 可记录已核实的提示版本、数据索引哈希、模型标识和依赖锁文件版本，每项为字符串。旧运行没有新回执时，报告实际缺失字段。

```json
{"operation":"git-sync-runs","plan_id":"plan_…"}
```

## 导回远端提交

```json
{"operation":"request-git-import-choice","version_id":"已同步版本的ID","commit":"远端完整的提交SHA"}
```

使用与部署基线有关联的远端提交。工具会返回审查分支和与部署基线相比的差异摘要。
