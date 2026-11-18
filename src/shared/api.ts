/**
 * preload 暴露给 renderer 的 API 形状（技术方案第 4.1 节的"唯一跨边界通道"）。
 *
 * 三层含义：
 *   1. **白名单**：只有这里列出的方法存在，`ipcRenderer` 本身永不暴露。
 *   2. **结果类型**：所有调用返回 `Result<T>`，业务失败（Key 无效、无 provider…）
 *      以 `ok: false` 表达而不是抛异常——renderer 必须显式处理失败分支，
 *      否则"错误条 + 重试按钮"很容易被忘记写。
 *   3. **类型共享**：renderer 只 import 本文件的类型，因此它拿不到任何主进程实现。
 */
import type { ChangedEvent } from './ipc.js';
import type {
  AppDiagnostics,
  AppSettings,
  Character,
  CharacterExportFormat,
  CharacterExportResult,
  CharacterImportResult,
  CompressProgressEvent,
  CompressResult,
  Conversation,
  Message,
  NormalizedError,
  Persona,
  Provider,
  ProviderTestResult,
  StreamChunkEvent,
  StreamEndEvent,
  Summary,
  TokenPreview,
  UsageSummary,
} from './types.js';
import type {
  CharacterUpdatePayload,
  CompressPayload,
  ConversationPatchPayload,
  CreateConversationPayload,
  EditMessagePayload,
  ListCharactersPayload,
  PersonaInputPayload,
  ProviderInputPayload,
  SendMessagePayload,
  SettingsPatchPayload,
  TokensPreviewPayload,
  UsageSummaryPayload,
} from './schemas.js';

/** 统一返回：成功带数据，失败带已脱敏的 NormalizedError。 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: NormalizedError };

/** 取消订阅函数。 */
export type Unsubscribe = () => void;

export interface CottageApi {
  providers: {
    list(): Promise<Result<Provider[]>>;
    get(id: string): Promise<Result<Provider | null>>;
    create(input: ProviderInputPayload): Promise<Result<Provider>>;
    update(id: string, input: ProviderInputPayload): Promise<Result<Provider>>;
    delete(id: string): Promise<Result<boolean>>;
    /** 三态连接测试 + HTTP 状态 + 原始错误摘要（均已脱敏） */
    test(id: string): Promise<Result<ProviderTestResult>>;
    /** 从端点拉取模型列表并落库 */
    fetchModels(id: string): Promise<Result<Provider>>;
  };
  characters: {
    list(query?: ListCharactersPayload): Promise<Result<Character[]>>;
    get(id: string): Promise<Result<Character | null>>;
    import(card: unknown): Promise<Result<CharacterImportResult>>;
    /** 打开文件选择框导入；PNG 卡会解析出数据，并把图片本身存成卡面图 */
    importFile(): Promise<Result<CharacterImportResult | null>>;
    update(id: string, patch: CharacterUpdatePayload): Promise<Result<Character>>;
    delete(id: string): Promise<Result<{ ok: boolean; reason?: string }>>;
    /**
     * 导出为 v2/v3 卡（`raw_json` 为基底）。
     *
     * `format` 决定写出来的文件：`json` 是纯数据，`png` 是**原卡面图 + 数据**。
     * PNG 卡需要角色有卡面图，没有就报错而不是造一张图出来。
     */
    export(id: string, format?: CharacterExportFormat): Promise<Result<CharacterExportResult>>;
    tags(): Promise<Result<Array<{ tag: string; count: number }>>>;
  };
  personas: {
    list(): Promise<Result<Persona[]>>;
    create(input: PersonaInputPayload): Promise<Result<Persona>>;
    update(id: string, patch: Partial<PersonaInputPayload>): Promise<Result<Persona>>;
    delete(id: string): Promise<Result<{ ok: boolean; reason?: string }>>;
    setDefault(id: string): Promise<Result<Persona[]>>;
  };
  conversations: {
    list(): Promise<Result<Conversation[]>>;
    get(id: string): Promise<Result<Conversation | null>>;
    create(input: CreateConversationPayload): Promise<Result<Conversation>>;
    rename(id: string, title: string): Promise<Result<Conversation>>;
    setPinned(id: string, pinned: boolean): Promise<Result<Conversation>>;
    update(id: string, patch: ConversationPatchPayload): Promise<Result<Conversation>>;
    /** 删除前的统计：确认框要展示消息数与摘要段数（UI 文档 4.7） */
    stats(id: string): Promise<Result<{ messageCount: number; summaryCount: number }>>;
    remove(id: string): Promise<Result<{ messages: number; summaries: number }>>;
    /** 用开场白重开会话（保留角色与参数，清空历史） */
    restart(id: string, greeting?: string): Promise<Result<Conversation>>;
  };
  messages: {
    list(conversationId: string): Promise<Result<Message[]>>;
    send(input: SendMessagePayload): Promise<Result<{ streamId: string; userMessage: Message; assistantMessage: Message }>>;
    abort(conversationId: string): Promise<Result<boolean>>;
    edit(input: EditMessagePayload): Promise<Result<{ truncatedCount: number; invalidatedSummaries: number }>>;
    remove(messageId: string): Promise<Result<{ deleted: boolean; invalidatedSummaries: number }>>;
    removeFrom(conversationId: string, sortOrder: number): Promise<Result<{ deletedCount: number; invalidatedSummaries: number }>>;
    regenerate(messageId: string): Promise<Result<{ streamId: string }>>;
  };
  summaries: {
    list(conversationId: string): Promise<Result<Summary[]>>;
    compress(input: CompressPayload): Promise<Result<CompressResult>>;
    restore(summaryId: string): Promise<Result<{ from: number; to: number; unarchivedCount: number }>>;
    /** 预览"压缩最老 N 条"会省多少（不落库） */
    previewRange(conversationId: string, count: number): Promise<Result<{ from: number; to: number; ids: string[] }>>;
  };
  tokens: {
    /** 只读投影：主进程算完再给 renderer，renderer 不得自行计数作为权威值 */
    preview(input: TokensPreviewPayload): Promise<Result<TokenPreview>>;
  };
  usage: {
    /**
     * 用量统计（只读投影）。
     *
     * 数据源是每条 assistant 消息的 `metadata_json`，**不联网、不落新表**：
     * 所以它反映的是"本机用这个应用发过多少请求"，与账号后台的账单口径
     * （含其它客户端、赠金抵扣、缓存命中折扣）本来就不会完全一致。
     */
    summary(input?: UsageSummaryPayload): Promise<Result<UsageSummary>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    update(patch: SettingsPatchPayload): Promise<Result<AppSettings>>;
  };
  app: {
    diagnostics(): Promise<Result<AppDiagnostics>>;
  };
  exportData: {
    conversationMarkdown(conversationId: string): Promise<Result<{ path: string | null; content: string }>>;
    conversationJson(conversationId: string): Promise<Result<{ path: string | null; content: string }>>;
  };
  events: {
    onStreamChunk(handler: (event: StreamChunkEvent) => void): Unsubscribe;
    onStreamEnd(handler: (event: StreamEndEvent) => void): Unsubscribe;
    onCompressProgress(handler: (event: CompressProgressEvent) => void): Unsubscribe;
    onConversationsChanged(handler: (event: ChangedEvent) => void): Unsubscribe;
    onMessagesChanged(handler: (event: ChangedEvent) => void): Unsubscribe;
    onAppError(handler: (error: NormalizedError) => void): Unsubscribe;
  };
}

/** `window` 上的全局注入名。 */
export const API_GLOBAL = 'cottage' as const;

declare global {
  interface Window {
    cottage: CottageApi;
  }
}
