# 原生文件框清晰度和初始目录优化

固定 PowerShell 脚本在创建任何 WinForms 窗口前请求 Per-Monitor V2 DPI awareness，旧系统或请求失败时尝试系统 DPI awareness，再启用视觉样式及 OpenFileDialog AutoUpgradeEnabled。设置均仅作用于本次选择器子进程，不改注册表、用户系统缩放、全局配置或浏览器 DPI。

WSL 默认继承的后端工作目录可能成为 Windows UNC 路径；在标准 /mnt/c 挂载可用时让 PowerShell 从 Windows System32 启动，脚本立即切换 Windows USERPROFILE，并明确将选择框起始位置设为 Windows 用户目录，避免默认枚举 WSL 项目目录。自定义挂载未找到时保留原进程 cwd，但脚本仍切到 USERPROFILE。增加 NoLogo/NonInteractive，保留 NoProfile 和 STA、置顶 owner、超时和取消。PowerShell/WinForms 冷启动及本次 DPI 类型加载仍存在开销，不能承诺与浏览器文件框一样快；本次没有实测性能或显示效果。

分支 ct_dev_test；开始工作树干净、依赖存在，已阅读相关历史和选择器代码，未发现仓库 AGENTS.md。开发自验仅静态审阅固定脚本与进程参数，未执行 lint、类型检查、测试、构建、PowerShell、浏览器或实际文件选择。用户验收待进行：高 DPI/多显示器、旧 Windows 回退、选择器打开时间、中文路径和取消。需要重启后端并刷新页面；本次未主动重启、合并或推送。
