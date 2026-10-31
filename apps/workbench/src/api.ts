const API = "/api/v1";
const errorMessages: Record<string, string> = {
  INVALID_JSON: "请求内容无法识别，请检查输入后重试。",
  INVALID_REQUEST: "请求无效，请检查输入后重试。",
  PROJECT_FIELDS_REQUIRED: "请填写项目名称和研究问题。",
  PROJECT_NOT_FOUND: "未找到该项目。",
  PROJECT_TITLE_MISMATCH: "项目名称已变化，请刷新项目后再删除。",
  EXPERIMENT_ACTIVE: "项目有未结束的实验，请先取消并确认远端停止。",
  PROJECT_HAS_ACTIVE_TASKS: "项目还有排队或运行中的任务，请先取消任务并等待进程结束。",
  SOURCE_NOT_FOUND: "未找到该文献来源。",
  SOURCE_IN_USE: "该文献仍被卡片、Wiki、实验结果历史或合并记录引用，暂不能删除。",
  ANALYSIS_NO_READABLE_SOURCES: "文献暂没有可分析的正文或摘要，请先导入包含正文的文件。",
  CODE_AGENT_BUSY: "当前项目或仓库有 Agent 正在执行，请等待或停止后再操作。",
  NOT_FOUND: "未找到请求的内容。",
  REQUEST_TOO_LARGE: "文件或请求内容过大。",
  UNSUPPORTED_FILE_TYPE: "暂不支持此文件格式。",
  URL_REQUIRED: "请输入网页地址。",
  URL_SCHEME_OR_CREDENTIALS_NOT_ALLOWED: "网页地址必须使用公开的 HTTP 或 HTTPS 链接。",
  URL_HOST_NOT_PUBLIC: "出于安全限制，不能导入本地或内网地址。",
  WEBPAGE_NOT_HTML: "该地址未返回可导入的网页。",
  WEBPAGE_TOO_LARGE: "网页内容超过允许的大小。",
  WEBPAGE_REDIRECT_LIMIT: "网页跳转次数过多，无法导入。",
  QUERY_TOO_SHORT: "检索词至少需要 2 个字符。",
  INTERNAL_ERROR: "发生意外错误，请稍后重试。"
};

export function uiError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (errorMessages[cause.message]) return errorMessages[cause.message];
  if (cause.message.startsWith("OPENALEX_HTTP_")) return "OpenAlex 暂时无法响应，请稍后重试。";
  if (cause instanceof TypeError) return "无法连接本地工作台服务，请确认服务正在运行后重试。";
  return fallback;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "INTERNAL_ERROR");
  return payload;
}

