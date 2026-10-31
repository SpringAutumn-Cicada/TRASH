# SFTP 读取异常导致进程退出

分支 ct_dev_test，基线 6e63c87。开始工作树干净，已核对近期提交、SFTP 读取相关历史和依赖目录，未发现仓库 AGENTS.md。

用户日志明确为 ssh2 SFTP cleanupRequests 触发 ReadStream 未处理 error（No response from server），导致 Node 退出。源码存在在 ReadStream end/异步迭代完成后立即 sftp.end 的路径；数据结束不等于远端文件句柄 CLOSE 已完成，关闭通道可能让待处理读/关闭请求失败。未实机复现，不认定导致远端关闭的唯一原因。

移除上传校验和远端文件读取中的 SFTP ReadStream，统一通过 RemoteConnection.consume 显式 open/read/close。每块最多 64 KiB，按偏移依次读取，所有请求错误通过 Promise 传递；finally 等待文件句柄关闭回调后才结束 SFTP 通道，避免 ReadStream 的异步错误无人接收。上传校验读取最多预期文件大小加一字节，同时检查长度和 SHA-256；普通日志/产物读取沿用原偏移和长度上限。没有添加全局 uncaughtException 忽略异常。

开发自验仅 Git 状态、历史、源码阅读；未运行 lint、类型检查、测试、构建、浏览器验证或真实 SSH 操作，尚未测试，用户验收未执行。待集中验证：完整/空文件、长度及哈希不匹配、读途中 SSH 断开、关闭句柄失败、日志与产物读取、失败后平台进程存活。根因及修复效果仍需实机验证。

需重新启动 TRASH 加载后端修复；本轮未重启或关闭平台，未修改全局配置、未合并或推送。
