/**
 * 渲染层共享测试工具。
 *
 * 提供一个"假的 window.cottage"：组件测试里所有 IPC 都必须走它，
 * **不允许任何测试真的去调主进程**（技术方案 11.3 纪律 1 的同源要求）。
 */
import { vi } from 'vitest';
import type { CottageApi, Result } from '../../src/shared/api.js';
import type {
  AppDiagnostics,
  AppSettings,
  Character,
  Conversation,
  ErrorCode,
  Message,
  Persona,
  Provider,
  Summary,
  TokenPreview,
} from '../../src/shared/types.js';

export const T0 = 1_700_000_000_000;

/** 成功结果。 */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** 失败结果（用于测错误分支）。 */
export function fail<T>(message: string, code: ErrorCode = 'UNKNOWN'): Result<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

export function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'prv_1',
    name: '本地端点',
    type: 'openai',
    baseUrl: 'https://api.example.invalid/v1',
    hasKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    compressionModel: 'deepseek-chat',
    enabled: true,
    sortOrder: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'chr_1',
    name: '爱丽丝',
    description: '钟表店学徒，对时间异常敏感。',
    personality: '话不多。',
    scenario: '雨后的石板街。',
    firstMes: '「齿轮不是坏了，是被人换过。」',
    alternateGreetings: ['「你来晚了十一分钟。」'],
    mesExample: '',
    systemPrompt: '你扮演爱丽丝。',
    postHistoryInstructions: '',
    tags: ['奇幻'],
    favorite: false,
    avatarPath: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'per_1',
    name: 'ASMobbin',
    description: '',
    avatarPath: null,
    isDefault: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'cnv_1',
    title: '夜巡酒馆的第三夜',
    characterId: 'chr_1',
    personaId: null,
    providerId: 'prv_1',
    model: 'deepseek-chat',
    params: { temperature: 0.9, topP: 0.95, maxTokens: 1024 },
    pinnedAt: null,
    createdAt: T0,
    updatedAt: T0,
    messageCount: 2,
    summaryCount: 0,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    conversationId: 'cnv_1',
    role: 'assistant',
    content: '「您比约定的时间早了十一分钟。」',
    metadata: { model: 'deepseek-chat', elapsedMs: 1800, completionTokens: 42, tokensExact: true },
    archived: false,
    status: 'done',
    sortOrder: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: 'sum_1',
    conversationId: 'cnv_1',
    content: '人物关系：两人已相识。',
    coversFrom: 1,
    coversTo: 3,
    tokenCount: 180,
    level: 1,
    providerId: null,
    model: 'deepseek-chat',
    createdAt: T0,
    ...overrides,
  };
}

export function makeTokenPreview(overrides: Partial<TokenPreview> = {}): TokenPreview {
  return {
    segments: [
      { kind: 'system', label: 'system', tokens: 820, exact: true, method: 't', itemCount: 1 },
      { kind: 'fewShot', label: 'few-shot', tokens: 460, exact: true, method: 't', itemCount: 2 },
      { kind: 'summary', label: '摘要', tokens: 180, exact: true, method: 't', itemCount: 1 },
      { kind: 'history', label: '历史', tokens: 8940, exact: true, method: 't', itemCount: 86 },
      { kind: 'user', label: '本次输入', tokens: 200, exact: true, method: 't', itemCount: 1 },
    ],
    total: 10_600,
    limit: 20_000,
    percent: 53,
    anyEstimated: false,
    autoCompressAt: 0.8,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatProviderId: 'prv_1',
    compressionProviderId: null,
    autoCompressEnabled: true,
    autoCompressThreshold: 0.8,
    sendWithCtrlEnter: false,
    panelOpen: true,
    panelTab: 'context',
    theme: 'light',
    requestTimeoutMs: 60_000,
    ...overrides,
  };
}

export function makeDiagnostics(overrides: Partial<AppDiagnostics> = {}): AppDiagnostics {
  return {
    dbPath: 'C:/tmp/cottage.db',
    userVersion: 3,
    latestVersion: 3,
    storageBackend: 'dpapi',
    storageWarning: null,
    platform: 'win32',
    appVersion: '0.1.0',
    electronVersion: '34.3.3',
    ...overrides,
  };
}

export interface FakeApiOptions {
  conversations?: Conversation[];
  characters?: Character[];
  personas?: Persona[];
  providers?: Provider[];
  messages?: Message[];
  summaries?: Summary[];
  preview?: TokenPreview;
  settings?: AppSettings;
  diagnostics?: AppDiagnostics;
  /** 覆盖任意方法：`{ 'messages.send': async () => fail('x') }` */
  overrides?: Record<string, unknown>;
}

/**
 * 构造一个假的 `window.cottage`。
 *
 * 所有方法默认返回成功结果，便于聚焦被测行为；需要测错误分支时用 `overrides`。
 */
export function installFakeApi(options: FakeApiOptions = {}): {
  api: CottageApi;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};

  const method = (name: string, impl: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> => {
    const override = options.overrides?.[name];
    const fn = vi.fn((override as (...args: unknown[]) => unknown) ?? impl);
    spies[name] = fn;
    return fn;
  };

  const api = {
    providers: {
      list: method('providers.list', async () => ok(options.providers ?? [makeProvider()])),
      get: method('providers.get', async () => ok(makeProvider())),
      create: method('providers.create', async () => ok(makeProvider())),
      update: method('providers.update', async () => ok(makeProvider())),
      delete: method('providers.delete', async () => ok(true)),
      test: method('providers.test', async () =>
        ok({
          outcome: 'ok',
          httpStatus: 200,
          probe: 'models',
          message: '可达，鉴权通过',
          models: ['deepseek-chat'],
          storageWarning: null,
        }),
      ),
      fetchModels: method('providers.fetchModels', async () => ok(makeProvider())),
    },
    characters: {
      list: method('characters.list', async () => ok(options.characters ?? [makeCharacter()])),
      get: method('characters.get', async () => ok(makeCharacter())),
      import: method('characters.import', async () =>
        ok({ character: makeCharacter(), specVersion: 'v3', preservedFields: [] }),
      ),
      importFile: method('characters.importFile', async () => ok(null)),
      update: method('characters.update', async () => ok(makeCharacter())),
      delete: method('characters.delete', async () => ok({ ok: true })),
      // 默认"用户在保存对话框里点了取消"：path 为 null 但内容已生成
      export: method('characters.export', async (id: unknown, format: unknown) =>
        ok({
          format: format === 'png' ? 'png' : 'json',
          path: null,
          card: { name: '爱丽丝' },
        }),
      ),
      tags: method('characters.tags', async () => ok([{ tag: '奇幻', count: 1 }])),
    },
    personas: {
      list: method('personas.list', async () => ok(options.personas ?? [makePersona()])),
      create: method('personas.create', async () => ok(makePersona())),
      update: method('personas.update', async () => ok(makePersona())),
      delete: method('personas.delete', async () => ok({ ok: true })),
      setDefault: method('personas.setDefault', async () => ok([makePersona()])),
    },
    conversations: {
      list: method('conversations.list', async () => ok(options.conversations ?? [makeConversation()])),
      get: method('conversations.get', async () => ok(makeConversation())),
      create: method('conversations.create', async () => ok(makeConversation())),
      rename: method('conversations.rename', async () => ok(makeConversation())),
      setPinned: method('conversations.setPinned', async () => ok(makeConversation())),
      update: method('conversations.update', async () => ok(makeConversation())),
      stats: method('conversations.stats', async () => ok({ messageCount: 2, summaryCount: 1 })),
      remove: method('conversations.remove', async () => ok({ messages: 2, summaries: 1 })),
      restart: method('conversations.restart', async () => ok(makeConversation())),
    },
    messages: {
      list: method('messages.list', async () => ok(options.messages ?? [makeMessage()])),
      send: method('messages.send', async () =>
        ok({
          streamId: 'st_1',
          userMessage: makeMessage({ id: 'msg_u', role: 'user', content: '你好', sortOrder: 1 }),
          assistantMessage: makeMessage({ id: 'msg_a', content: '', status: 'streaming', sortOrder: 2 }),
        }),
      ),
      abort: method('messages.abort', async () => ok(true)),
      edit: method('messages.edit', async () => ok({ truncatedCount: 0, invalidatedSummaries: 0 })),
      remove: method('messages.remove', async () => ok({ deleted: true, invalidatedSummaries: 0 })),
      removeFrom: method('messages.removeFrom', async () => ok({ deletedCount: 1, invalidatedSummaries: 0 })),
      regenerate: method('messages.regenerate', async () => ok({ streamId: 'st_2' })),
    },
    summaries: {
      list: method('summaries.list', async () => ok(options.summaries ?? [])),
      compress: method('summaries.compress', async () =>
        ok({
          from: 1,
          to: 8,
          tokensBefore: 1200,
          tokensAfter: 180,
          summary: makeSummary(),
        }),
      ),
      restore: method('summaries.restore', async () => ok({ from: 1, to: 3, unarchivedCount: 3 })),
      previewRange: method('summaries.previewRange', async () => ok({ from: 1, to: 8, ids: [] })),
    },
    tokens: {
      preview: method('tokens.preview', async () => ok(options.preview ?? makeTokenPreview())),
    },
    settings: {
      get: method('settings.get', async () => ok(options.settings ?? makeSettings())),
      update: method('settings.update', async () => ok(options.settings ?? makeSettings())),
    },
    app: {
      diagnostics: method('app.diagnostics', async () => ok(options.diagnostics ?? makeDiagnostics())),
    },
    exportData: {
      conversationMarkdown: method('exportData.conversationMarkdown', async () =>
        ok({ path: null, content: '# 会话' }),
      ),
      conversationJson: method('exportData.conversationJson', async () =>
        ok({ path: null, content: '{}' }),
      ),
      plainConfig: method('exportData.plainConfig', async () => ok({ path: null, content: '{}' })),
    },
    events: {
      onStreamChunk: method('events.onStreamChunk', () => () => undefined),
      onStreamEnd: method('events.onStreamEnd', () => () => undefined),
      onCompressProgress: method('events.onCompressProgress', () => () => undefined),
      onConversationsChanged: method('events.onConversationsChanged', () => () => undefined),
      onMessagesChanged: method('events.onMessagesChanged', () => () => undefined),
      onAppError: method('events.onAppError', () => () => undefined),
    },
  } as unknown as CottageApi;

  Object.defineProperty(window, 'cottage', { value: api, writable: true, configurable: true });
  return { api, spies };
}

/** 让所有未决 Promise 落地（配合 vi.useFakeTimers 时用）。 */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}
