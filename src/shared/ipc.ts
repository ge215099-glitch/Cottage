/**
 * IPC 通道清单（技术方案 6.2）。
 *
 * 约定：
 *   - 通道名一律 `域:动作`，域与 DAO 模块一一对应，便于对照。
 *   - **只有登记在这里的通道才是合法的**；主进程拒绝未登记通道，
 *     而不是静默通过（验收项 4 的后半句）。
 *   - `INVOKE` 是请求/响应；`EVENT` 是主进程 → renderer 的单向推送。
 */

export const INVOKE = {
  /* Provider 与密钥 */
  providersList: 'providers:list',
  providersGet: 'providers:get',
  providersCreate: 'providers:create',
  providersUpdate: 'providers:update',
  providersDelete: 'providers:delete',
  providersTest: 'providers:test',
  providersFetchModels: 'providers:fetch-models',

  /* 角色卡 */
  charactersList: 'characters:list',
  charactersGet: 'characters:get',
  charactersImport: 'characters:import',
  charactersImportFile: 'characters:import-file',
  charactersUpdate: 'characters:update',
  charactersDelete: 'characters:delete',
  charactersExport: 'characters:export',
  charactersTags: 'characters:tags',

  /* 人设 */
  personasList: 'personas:list',
  personasCreate: 'personas:create',
  personasUpdate: 'personas:update',
  personasDelete: 'personas:delete',
  personasSetDefault: 'personas:set-default',

  /* 会话 */
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsRename: 'conversations:rename',
  conversationsSetPinned: 'conversations:set-pinned',
  conversationsUpdate: 'conversations:update',
  conversationsDelete: 'conversations:delete',
  conversationsStats: 'conversations:stats',
  conversationsRestart: 'conversations:restart',

  /* 消息与生成 */
  messagesList: 'messages:list',
  messagesSend: 'messages:send',
  messagesAbort: 'messages:abort',
  messagesEdit: 'messages:edit',
  messagesDelete: 'messages:delete',
  messagesDeleteFrom: 'messages:delete-from',
  messagesRegenerate: 'messages:regenerate',

  /* 摘要与压缩 */
  summariesList: 'summaries:list',
  summariesCompress: 'summaries:compress',
  summariesRestore: 'summaries:restore',
  summariesPreviewRange: 'summaries:preview-range',

  /* Token 预览（只读投影，不落库不联网） */
  tokensPreview: 'tokens:preview',

  /* 用量统计（只读投影，从消息元数据派生） */
  usageSummary: 'usage:summary',

  /* 设置与诊断 */
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  appDiagnostics: 'app:diagnostics',

  /*
   * 导出。注意域划分（技术方案 6.2 的通道表）：
   *   - 角色卡导出属于 `characters:*`（`INVOKE.charactersExport`），不在这里；
   *   - `export:*` 只放"会话导出"。
   * 这里曾经多出一个 `exportCharacterCard: 'export:character-card'`，它既没有 handler
   * 也没有任何调用方，与上表冲突——而 `registerIpc` 的"通道齐全"断言会在启动时直接抛错，
   * 于是整个应用起不来。别再往这里加角色卡导出。
   *
   * 这里还曾经有过 `exportPlainConfig: 'export:plain-config'`（换机用的明文配置包）。
   * 它已按需求整体移除：唯一会把明文 Key 写进文件的出口不存在了，密钥边界反而更窄。
   */
  exportConversationMarkdown: 'export:conversation-markdown',
  exportConversationJson: 'export:conversation-json',
} as const;

export const EVENT = {
  streamChunk: 'stream:chunk',
  streamEnd: 'stream:end',
  compressProgress: 'summaries:progress',
  conversationsChanged: 'conversations:changed',
  messagesChanged: 'messages:changed',
  /** 主进程未捕获异常 / 数据库失败，需要在 UI 可见（技术方案 3.2 纪律 2） */
  appError: 'app:error',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];
export type EventChannel = (typeof EVENT)[keyof typeof EVENT];

/** 全部合法通道的集合，用于"未登记通道一律拒绝"。 */
export const ALL_INVOKE_CHANNELS: ReadonlySet<string> = new Set(Object.values(INVOKE));
export const ALL_EVENT_CHANNELS: ReadonlySet<string> = new Set(Object.values(EVENT));

/** 变更通知的载荷：只带受影响的主键，让 renderer 走增量刷新（UI 文档 5.6）。 */
export interface ChangedEvent {
  ids?: string[];
  reason: 'created' | 'updated' | 'deleted' | 'refreshed';
}
