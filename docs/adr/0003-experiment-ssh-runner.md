# ADR 0003：实验 SSH 连接与持久 Runner

状态：首版实现，尚未验证。

## 决策

采用 ssh2 在本机 Node 服务中处理密码、私钥、SSH Agent、SFTP 和远端命令。相较此前系统 SSH 客户端设想，此方案避免把密码拼入参数或落入 askpass 临时文件，同时统一文件传输与连接错误。认证字段仅在内存 Map 存放，不写入项目数据库，不修改系统 SSH/Codex 配置。

首次连接用 hostVerifier 获取 SHA-256 主机指纹并拒绝认证，用户核对后另行确认，之后只接受已信任指纹。指纹改变必须重新核对，活动任务期间不更换信任。

本地 git bundle 经 SFTP 传输，远端校验后检出完整 commit。Runner 使用 Python 3.9+、Linux 和 tmux，远端无需从 GitHub 拉取。Python Runner 源码作为版本化字符串随服务发布，上传后以独立 tmux 会话运行。

每次实验独立目录，状态文件原子替换，启动锁避免响应丢失后重复启动。远端使用当前 Unix 用户的 /tmp 锁串行执行平台实验；本地按主机、端口及用户名排队。取消只写绑定运行 token 的请求，由持有真实子进程的 Runner 终止其进程组，不依据历史 PID 杀进程。

## 限制

tmux 与用户级文件锁不能跨实例重启保活。主机不可达或状态过期时保留不确定状态，不声称任务失败或已取消。大代码包和大型数据不自动同步；代码包可能包含 Git 历史，执行确认页提示范围。

本次使用 --ignore-scripts 添加 ssh2 和类型依赖，未运行依赖构建脚本。实现未进行类型检查、测试、构建、浏览器验证或真实 SSH 验证。

参考：[ssh2 官方接口](https://github.com/mscdex/ssh2)、[AutoDL SSH 文档](https://www.autodl.com/docs/ssh/)。
