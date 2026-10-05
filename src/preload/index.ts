/**
 * preload：contextBridge 白名单（技术方案 4.2 / 6.3）。
 *
 * 职责边界很窄，刻意如此：
 *   - **只做转发**，不含任何业务逻辑、不做缓存、不读文件。
 *   - 逐个方法显式暴露，**绝不暴露 `ipcRenderer` 本身**——否则 renderer 可以
 *     任意构造通道名，白名单就形同虚设。
 *   - 事件订阅返回取消函数，避免 renderer 卸载后回调泄漏。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { ALL_EVENT_CHANNELS, EVENT, INVOKE } from '@shared/ipc.js';
import { API_GLOBAL, type CottageApi, type Result, type Unsubscribe } from '@shared/api.js';
import type { ChangedEvent } from '@shared/ipc.js';
import type {
  AppDiagnostics,
  AppSettings,
  Character,
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
} from '@shared/types.js';
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
} from '@shared/schemas.js';

/** 统一 invoke 包装：把主进程的 Result 原样带回。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;
}

/**
 * 订阅主进程事件。
 *
 * 只接受登记在 `ALL_EVENT_CHANNELS` 里的通道名——虽然是内部调用，但
 * "白名单在唯一入口处校验"这条纪律不该有例外。
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  if (!ALL_EVENT_CHANNELS.has(channel)) {
    throw new Error(`未登记的事件通道：${channel}`);
  }
  const listener = (_event: unknown, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: CottageApi = {
  providers: {
    list: () => invoke<Provider[]>(INVOKE.providersList),
    get: (id) => invoke<Provider | null>(INVOKE.providersGet, id),
    create: (input: ProviderInputPayload) => invoke<Provider>(INVOKE.providersCreate, input),
    update: (id, input) => invoke<Provider>(INVOKE.providersUpdate, id, input),
    delete: (id) => invoke<boolean>(INVOKE.providersDelete, id),
    test: (id) => invoke<ProviderTestResult>(INVOKE.providersTest, id),
    fetchModels: (id) => invoke<Provider>(INVOKE.providersFetchModels, id),
  },
  characters: {
    list: (query?: ListCharactersPayload) => invoke<Character[]>(INVOKE.charactersList, query ?? null),
    get: (id) => invoke<Character | null>(INVOKE.charactersGet, id),
    import: (card: unknown) => invoke<CharacterImportResult>(INVOKE.charactersImport, card),
    importFile: () => invoke<CharacterImportResult | null>(INVOKE.charactersImportFile),
    update: (id, patch: CharacterUpdatePayload) => invoke<Character>(INVOKE.charactersUpdate, id, patch),
    delete: (id) => invoke<{ ok: boolean; reason?: string }>(INVOKE.charactersDelete, id),
    export: (id, format) =>
      invoke<CharacterExportResult>(INVOKE.charactersExport, id, format ?? 'json'),
    tags: () => invoke<Array<{ tag: string; count: number }>>(INVOKE.charactersTags),
  },
  personas: {
    list: () => invoke<Persona[]>(INVOKE.personasList),
    create: (input: PersonaInputPayload) => invoke<Persona>(INVOKE.personasCreate, input),
    update: (id, patch: Partial<PersonaInputPayload>) => invoke<Persona>(INVOKE.personasUpdate, id, patch),
    delete: (id) => invoke<{ ok: boolean; reason?: string }>(INVOKE.personasDelete, id),
    setDefault: (id) => invoke<Persona[]>(INVOKE.personasSetDefault, id),
  },
  conversations: {
    list: () => invoke<Conversation[]>(INVOKE.conversationsList),
    get: (id) => invoke<Conversation | null>(INVOKE.conversationsGet, id),
    create: (input: CreateConversationPayload) => invoke<Conversation>(INVOKE.conversationsCreate, input),
    rename: (id, title) => invoke<Conversation>(INVOKE.conversationsRename, id, title),
    setPinned: (id, pinned) => invoke<Conversation>(INVOKE.conversationsSetPinned, id, pinned),
    update: (id, patch: ConversationPatchPayload) =>
      invoke<Conversation>(INVOKE.conversationsUpdate, id, patch),
    stats: (id) =>
      invoke<{ messageCount: number; summaryCount: number }>(INVOKE.conversationsStats, id),
    remove: (id) =>
      invoke<{ messages: number; summaries: number }>(INVOKE.conversationsDelete, id),
    restart: (id, greeting?: string) => invoke<Conversation>(INVOKE.conversationsRestart, id, greeting ?? null),
  },
  messages: {
    list: (conversationId) => invoke<Message[]>(INVOKE.messagesList, conversationId),
    send: (input: SendMessagePayload) =>
      invoke<{ streamId: string; userMessage: Message; assistantMessage: Message }>(
        INVOKE.messagesSend,
        input,
      ),
    abort: (conversationId) => invoke<boolean>(INVOKE.messagesAbort, conversationId),
    edit: (input: EditMessagePayload) =>
      invoke<{ truncatedCount: number; invalidatedSummaries: number }>(INVOKE.messagesEdit, input),
    remove: (messageId) =>
      invoke<{ deleted: boolean; invalidatedSummaries: number }>(INVOKE.messagesDelete, messageId),
    removeFrom: (conversationId, sortOrder) =>
      invoke<{ deletedCount: number; invalidatedSummaries: number }>(
        INVOKE.messagesDeleteFrom,
        conversationId,
        sortOrder,
      ),
    regenerate: (messageId) => invoke<{ streamId: string }>(INVOKE.messagesRegenerate, messageId),
  },
  summaries: {
    list: (conversationId) => invoke<Summary[]>(INVOKE.summariesList, conversationId),
    compress: (input: CompressPayload) => invoke<CompressResult>(INVOKE.summariesCompress, input),
    restore: (summaryId) =>
      invoke<{ from: number; to: number; unarchivedCount: number }>(INVOKE.summariesRestore, summaryId),
    previewRange: (conversationId, count) =>
      invoke<{ from: number; to: number; ids: string[] }>(
        INVOKE.summariesPreviewRange,
        conversationId,
        count,
      ),
  },
  tokens: {
    preview: (input: TokensPreviewPayload) => invoke<TokenPreview>(INVOKE.tokensPreview, input),
  },
  settings: {
    get: () => invoke<AppSettings>(INVOKE.settingsGet),
    update: (patch: SettingsPatchPayload) => invoke<AppSettings>(INVOKE.settingsUpdate, patch),
  },
  app: {
    diagnostics: () => invoke<AppDiagnostics>(INVOKE.appDiagnostics),
  },
  exportData: {
    conversationMarkdown: (conversationId) =>
      invoke<{ path: string | null; content: string }>(
        INVOKE.exportConversationMarkdown,
        conversationId,
      ),
    conversationJson: (conversationId) =>
      invoke<{ path: string | null; content: string }>(INVOKE.exportConversationJson, conversationId),
    plainConfig: (confirmed) =>
      invoke<{ path: string | null; content: string }>(INVOKE.exportPlainConfig, confirmed),
  },
  events: {
    onStreamChunk: (handler) => subscribe<StreamChunkEvent>(EVENT.streamChunk, handler),
    onStreamEnd: (handler) => subscribe<StreamEndEvent>(EVENT.streamEnd, handler),
    onCompressProgress: (handler) => subscribe<CompressProgressEvent>(EVENT.compressProgress, handler),
    onConversationsChanged: (handler) => subscribe<ChangedEvent>(EVENT.conversationsChanged, handler),
    onMessagesChanged: (handler) => subscribe<ChangedEvent>(EVENT.messagesChanged, handler),
    onAppError: (handler) => subscribe<NormalizedError>(EVENT.appError, handler),
  },
};

// `contextIsolation: true` 下的唯一注入点。
contextBridge.exposeInMainWorld(API_GLOBAL, api);
