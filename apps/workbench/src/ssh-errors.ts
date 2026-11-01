// Keep connection diagnostics consistent across the shared dialog and page actions.
export const sshConnectionErrors:Record<string,string>={
 SSH_DNS_FAILED:'无法解析 SSH 主机域名，请检查后端所在系统的 DNS 和网络。',
 SSH_CONNECTION_REFUSED:'SSH 端口拒绝连接，请确认实例已开机，并核对 AutoDL 当前提供的地址与端口。',
 SSH_CONNECTION_TIMEOUT:'SSH 连接或握手等待超过 30 秒，请检查实例状态、后端网络与端口连通性。',
 SSH_CONNECTION_RESET:'SSH 连接被中途重置，请稍后重试，并检查实例状态或连接限制。',
 SSH_HOST_UNREACHABLE:'后端所在系统无法到达 SSH 主机，请检查网络路由、VPN 或防火墙。',
 SSH_HANDSHAKE_FAILED:'SSH 握手协商失败，请确认目标端口提供 SSH 服务并检查服务端算法兼容性。',
 SSH_CONNECTION_CLOSED:'SSH 在认证完成前被关闭，请检查实例 SSH 服务状态、连接限制以及地址与端口。',
};
