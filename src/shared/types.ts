/**
 * 跨进程共享的领域类型（`src/shared`）。
 *
 * 命名约定（技术方案 5.3）：**snake_case 落库，camelCase 出 DAO**，
 * 转换只在 DAO 内做一次，renderer 层永远只见到 camelCase。
 */

export type ProviderType = 'openai' | 'anthropic';

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  /**
   * 密钥以 safeStorage 密文落库（字段 `api_key_enc`），明文只存在于主进程内存。
   * 出 DAO 时**只暴露布尔量**——renderer 连掩码片段都拿不到（技术方案 6.4 规则 1）。
   */
  hasKey: boolean;
  models: string[];
  defaultModel: string;
  compressionModel: string;
  enabled: boolean;
  sortOrder: number;
  /**
   * 最近一次用它生成的时间（毫秒）；从未用过为 null。
   *
   * 由 `listProviders` 从消息元数据里派生，**不是 providers 表的列**——
   * 它描述的是"用过没有"，而那是消息的事实，没有第二个真相来源。
   */
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 新建/更新 Provider 的入参；`apiKey` 为 `undefined` 表示"不改动已存的 Key"。 */
export interface ProviderInput {
  id?: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  /** 显式清除已存密钥 */
  clearKey?: boolean;
  models: string[];
  defaultModel: string;
  compressionModel: string;
  enabled: boolean;
  sortOrder?: number;
}

/** 连接测试的三态（产品设计文档 3.1）。 */
export type ProviderTestOutcome = 'ok' | 'auth-failed' | 'unreachable';

export interface ProviderTestResult {
  outcome: ProviderTestOutcome;
  /** HTTP 状态码，不可达时为 null */
  httpStatus: number | null;
  /** 走通的探测方式，便于排查 */
  probe: 'models' | 'chat-completions' | 'messages';
  /** 上游错误摘要（已过 Key 脱敏） */
  message: string;
  /** 探测成功时顺带发现的模型列表 */
  models: string[];
  /** Linux 无密钥环时的降级警告（产品设计文档 3.1） */
  storageWarning: string | null;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
  favorite: boolean;
  /** 相对 userData 的头像路径 */
  avatarPath: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 角色卡导入结果。`rawJson` 无损保留，导出时作为基底（验收项 1）。 */
export interface CharacterImportResult {
  character: Character;
  /** 识别到的卡版本：'v2' | 'v3' | 'unknown' */
  specVersion: string;
  /** 原卡里 Cottage 不管理的顶层字段名，用于 UI 提示"这些字段会原样保留" */
  preservedFields: string[];
}

/**
 * 角色卡导出格式。
 *
 * 两种都是给别人用的交换格式，不是 Cottage 内部格式：
 *   - `json`：只有数据，任何工具都能读；
 *   - `png`：**原卡面图 + 数据**，SillyTavern 等应用直接可用。
 */
export type CharacterExportFormat = 'json' | 'png';

/** 角色卡导出结果。`path` 为 null 表示用户在保存对话框里取消了。 */
export interface CharacterExportResult {
  format: CharacterExportFormat;
  path: string | null;
  /** 实际导出的卡内容（UI 可用它展示"哪些第三方字段被原样保留"） */
  card: Record<string, unknown>;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatarPath: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaInput {
  id?: string;
  name: string;
  /** 省略时按空字符串落库 */
  description?: string;
  avatarPath?: string | null;
  isDefault?: boolean;
}

/** 会话级生成参数覆盖（产品设计文档 3.6-⑥）。 */
export interface GenerationParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.9,
  topP: 0.95,
  maxTokens: 1024,
};

export interface Conversation {
  id: string;
  title: string;
  characterId: string;
  personaId: string | null;
  providerId: string | null;
  model: string;
  params: GenerationParams;
  /** NULL = 未置顶；非空 = 置顶时刻（毫秒）。**写它不得触碰 updatedAt。** */
  pinnedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** 列表展示用的轻量统计，避免为每行单独查一次 */
  messageCount: number;
  summaryCount: number;
}

export type MessageRole = 'user' | 'assistant';

/** 消息状态机（技术方案 7.5/7.6）。 */
export type MessageStatus = 'streaming' | 'done' | 'interrupted' | 'error';

export interface MessageMetadata {
  providerId?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 其中用在思考上的输出 token（思考型模型；与正文共用输出额度） */
  reasoningTokens?: number;
  /** 上游的结束原因（finish_reason / stop_reason）——"正文为空"时它是关键证据 */
  stopReason?: string;
  /** 首 token 延迟（毫秒） */
  ttftMs?: number;
  /** 总时长（毫秒） */
  elapsedMs?: number;
  interrupted?: boolean;
  /** token 计数是否为精确值 */
  tokensExact?: boolean;
  /** 错误信息（脱敏后） */
  error?: NormalizedError;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: MessageMetadata;
  archived: boolean;
  status: MessageStatus;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Summary {
  id: string;
  conversationId: string;
  content: string;
  coversFrom: number;
  coversTo: number;
  tokenCount: number;
  level: number;
  providerId: string | null;
  model: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* 错误结构（技术方案 6.3）：统一 { code, message, retryable, httpStatus? } */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | 'UNREACHABLE'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CONTEXT_OVERFLOW'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'NO_PROVIDER'
  | 'NO_KEY'
  | 'DB_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_CHANNEL'
  | 'NOT_FOUND'
  | 'ABORTED'
  | 'UNKNOWN';

export interface NormalizedError {
  code: ErrorCode;
  /** 已脱敏的面向用户文案 */
  message: string;
  /** 是否可重试（UI 据此决定是否显示"重试"按钮） */
  retryable: boolean;
  httpStatus?: number;
}

/* ------------------------------------------------------------------ */
/* 只读投影：token 明细预览（tokens:preview，不落库不联网）            */
/* ------------------------------------------------------------------ */

export interface TokenPreview {
  segments: Array<{
    kind: string;
    label: string;
    tokens: number;
    exact: boolean;
    method: string;
    itemCount: number;
  }>;
  total: number;
  limit: number;
  /** 0–100 的整数，UI 直接渲染 */
  percent: number;
  anyEstimated: boolean;
  /** 自动压缩阈值（占用比例，默认 0.8） */
  autoCompressAt: number;
}

/* ------------------------------------------------------------------ */
/* 流式事件（main → renderer）                                        */
/* ------------------------------------------------------------------ */

export interface StreamChunkEvent {
  /** 流式请求的标识，用于并发安全地匹配 */
  streamId: string;
  conversationId: string;
  messageId: string;
  /** 自上次推送以来的增量文本 */
  delta: string;
}

export interface StreamEndEvent {
  streamId: string;
  conversationId: string;
  messageId: string;
  status: 'done' | 'interrupted' | 'error';
  metadata: MessageMetadata;
  error?: NormalizedError;
}

/** 压缩进度（主进程 → renderer），驱动右栏状态机。 */
export interface CompressProgressEvent {
  conversationId: string;
  done: number;
  total: number;
  phase: 'summarizing' | 'writing';
}

export interface CompressResult {
  from: number;
  to: number;
  tokensBefore: number;
  tokensAfter: number;
  summary: Summary;
}

/** 迁移与启动自检的结果，供设置页「关于 / 诊断」展示。 */
export interface AppDiagnostics {
  dbPath: string;
  userVersion: number;
  latestVersion: number;
  /** safeStorage 后端名；'basic_text' 表示密钥实际未受保护 */
  storageBackend: string;
  /** 非空时必须显著警告（产品设计文档 3.1） */
  storageWarning: string | null;
  platform: string;
  appVersion: string;
  electronVersion: string;
}

/* ------------------------------------------------------------------ */
/* 用量统计（只读投影：从消息元数据派生，不落新表、不联网）             */
/* ------------------------------------------------------------------ */

/**
 * 用量页的时间维度。
 *
 * `month` / `year` 指**自然月 / 自然年**（本地时区），不是"最近 30 天"；
 * `week` 是**含今天的最近 7 天**。三者都按本地日切分再聚合。
 */
export type UsageRangeKey = 'month' | 'week' | 'year' | 'all';

export interface AppSettings {
  /** 聊天默认 */
  chatProviderId: string | null;
  /** 压缩默认（可与聊天不同，产品设计文档 3.1） */
  compressionProviderId: string | null;
  autoCompressEnabled: boolean;
  autoCompressThreshold: number;
  /** 生成时按 Ctrl+Enter 发送而非 Enter */
  sendWithCtrlEnter: boolean;
  /** 右栏上次是否打开 */
  panelOpen: boolean;
  /** 右栏上次所在标签 */
  panelTab: string;
  theme: 'light' | 'dark' | 'system';
  requestTimeoutMs: number;
}
