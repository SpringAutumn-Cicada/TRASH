const API = "/api/v1";
const errorMessages: Record<string, string> = {
  DIRECTION_NOT_FOUND: "请先建立对应的研究方向，方向 ID 必须一致。",
  SCHEME_NOT_FOUND: "请先在该方向下建立对应的实验方案。",
  FILES_WORKSPACE_MISSING: "项目目录尚不存在，请先在本地工作区中设置目录。",
  FILES_OUTSIDE_WORKSPACE: "文件路径超出当前项目工作区。",
  FILES_SYMLINK: "符号链接不支持直接操作，请在工作区中访问真实文件。",
  FILES_MANAGED_READONLY: "此文件或目录由平台管理，请通过文献、卡片或 Wiki 等对应模块维护。",
  FILES_CHANGED: "文件已被其他程序修改，当前编辑已保留，请先下载或复制内容后刷新核对。",
  FILES_BOUND_REPOSITORY: "此目录包含平台绑定的代码仓库，请先在实验模块调整绑定后再移动或删除。",
  FILES_EXISTS: "目标位置已有同名文件或文件夹，不会覆盖。",
  FILES_INVALID_MOVE: "不能将目录移动到自身或其子目录。",
  FILES_TOO_LARGE: "文件超过限制：在线文本编辑 2 MiB，单文件上传 50 MiB。",
  FILES_NOT_FILE: "此路径不是可操作的普通文件。",
  FILES_NOT_DIRECTORY: "此路径不是文件夹。",
  FILES_DIRECTORY_TOO_LARGE: "目录项目过多，请输入更具体的子目录。",

  WORKSPACE_MIGRATING: "项目正在迁移，请等待完成后再操作。",
  WORKSPACE_TARGET_EXISTS: "目标文件夹已存在或正在被其他迁移使用，请换一个文件夹名称。",
  WORKSPACE_INVALID_TARGET: "请选择平台内部存储之外的目录，或默认 workspaces 根目录。",
  WORKSPACE_NESTED: "目标目录不能位于已有项目工作区内部，也不能包含已有工作区。",
  WORKSPACE_NO_SPACE: "目标磁盘可用空间不足。",
  WORKSPACE_SOURCE_CHANGED: "迁移期间源文件发生变化，已保留原工作区，请停止外部编辑后重试。",
  WORKSPACE_PROJECT_MISMATCH: "目录中的项目标识不匹配，未修改绑定。",
  WORKSPACE_RESERVED_SYMLINK: "工作区保留目录存在不支持的符号链接，请先检查目录结构。",
  WORKSPACE_ORIGINALS_CONFLICT: "旧原文目录与新 originals 目录都有内容，请先整理后重试。",
  WORKSPACE_BACKUP_UNAVAILABLE: "当前备份不可清理，请刷新状态后重试。",
  WORKSPACE_BACKUP_IN_USE: "旧目录仍被其他项目使用，不能清理。",
  WORKSPACE_NOT_CONFIGURED: "项目目录尚不存在，请先设置并迁移工作区。",
  KNOWLEDGE_FILE_INVALID: "本地卡片或 Wiki 文件格式无效，请保留元数据和卡片栏目标题。",
  KNOWLEDGE_FILE_CONFLICT: "本地文件与平台版本冲突，已保留文件，请核对元数据及历史记录后处理。",
  KNOWLEDGE_FILE_MISSING: "本地卡片或 Wiki 文件缺失，请从版本历史恢复文件后重试。",

  INVALID_JSON: "请求内容无法识别，请检查输入后重试。",
  INVALID_REQUEST: "请求无效，请检查输入后重试。",
  PROJECT_FIELDS_REQUIRED: "请填写项目名称和研究问题。",
  PROJECT_NOT_FOUND: "未找到该项目。",
  PROJECT_TITLE_MISMATCH: "项目名称已变化，请刷新项目后再删除。",
  EXPERIMENT_ACTIVE: "项目有未结束的实验，请先取消并确认远端停止。",
  PROJECT_HAS_ACTIVE_TASKS: "项目还有活动任务或 SSH 终端，请先停止任务并断开终端。",
  SOURCE_RESUME_UNAVAILABLE: "没有可重试的分析任务，请刷新状态后重试。",
  SOURCE_ANALYSIS_CONFIRM_REQUIRED: "这篇论文已有生成内容，请刷新页面后确认重新生成。",
  KNOWLEDGE_MATERIALS_REQUIRED: "请先生成所选论文的关键卡片，再综合 Wiki。",
  KNOWLEDGE_INPUT_TOO_LARGE: "所选材料超过单次读取预算，请在文献页执行分层综合，或减少所选材料。",
  SOURCE_NOT_FOUND: "未找到该文献来源。",
  TASK_DELETE_FAILED_ONLY: "只能删除失败任务，请刷新任务状态后重试。",
  SOURCE_HAS_ACTIVE_TASKS: "这篇文献正被排队中或运行中的分析任务使用，请先停止对应任务；无需停止其他任务或断开 SSH。",
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

