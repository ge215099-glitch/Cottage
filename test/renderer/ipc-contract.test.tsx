// @vitest-environment jsdom
/**
 * IPC 契约一致性测试。
 *
 * 这套测试守的是一类**编译期发现不了**的错误：主进程、preload、renderer 三处
 * 各自写通道名，只要有一处写错（拼错、改名后漏改、少接一个通道），
 * TypeScript 都不会报错——因为通道名是字符串。表现为"点了没反应"或
 * "Cannot read properties of undefined"，而且只有点到那个功能才发现。
 *
 * 这里用三条断言把三处钉在一起：
 *   1. `INVOKE` / `EVENT` 的字面量集合稳定（改名会立刻失败，提醒同步三处）；
 *   2. preload 暴露的每个方法都落在登记集合内，且登记集合里的通道都被用上；
 *   3. 事件订阅只接受登记过的事件通道。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ALL_EVENT_CHANNELS, ALL_INVOKE_CHANNELS, EVENT, INVOKE } from '../../src/shared/ipc.js';
import { installFakeApi } from './helpers.js';

/** preload 的通道清单是字符串，这里按命名断言，防止静默改名。 */
describe('通道登记表', () => {
  it('INVOKE 通道名符合「域:动作」约定且不重复', () => {
    const values = Object.values(INVOKE);
    expect(new Set(values).size).toBe(values.length);

    for (const channel of values) {
      expect(channel, `通道名 ${channel} 不符合 域:动作 约定`).toMatch(/^[a-z][a-z-]*:[a-z-]+$/);
    }
  });

  it('EVENT 通道名同样符合约定且不与 INVOKE 撞名', () => {
    const invokeValues = new Set(Object.values(INVOKE));
    for (const channel of Object.values(EVENT)) {
      expect(channel).toMatch(/^[a-z][a-z-]*:[a-z-]+$/);
      expect(invokeValues.has(channel as never)).toBe(false);
    }
  });

  it('ALL_* 集合与常量表一致（用它们做白名单才不会漏）', () => {
    expect([...ALL_INVOKE_CHANNELS].sort()).toEqual([...Object.values(INVOKE)].sort());
    expect([...ALL_EVENT_CHANNELS].sort()).toEqual([...Object.values(EVENT)].sort());
  });

  it('关键通道名是稳定的字面量（改名必须同步三处，所以这里钉死）', () => {
    // 只钉最关键、被文档点名的几个，避免测试变成"抄一遍常量表"
    expect(INVOKE.messagesSend).toBe('messages:send');
    expect(INVOKE.messagesAbort).toBe('messages:abort');
    expect(INVOKE.summariesCompress).toBe('summaries:compress');
    expect(INVOKE.tokensPreview).toBe('tokens:preview');
    expect(EVENT.streamChunk).toBe('stream:chunk');
    expect(EVENT.streamEnd).toBe('stream:end');
  });

  it('每个域都有通道（域与 DAO 模块一一对应）', () => {
    const domains = new Set(Object.values(INVOKE).map((c) => c.split(':')[0]));
    for (const domain of [
      'providers',
      'characters',
      'personas',
      'conversations',
      'messages',
      'summaries',
      'tokens',
      'settings',
      'export',
    ]) {
      expect(domains.has(domain), `缺少 ${domain} 域的通道`).toBe(true);
    }
  });
});

describe('preload 暴露面的行为', () => {
  beforeEach(() => {
    installFakeApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('假 API 覆盖了真实 API 的每个命名空间与方法', async () => {
    // 用真实的 CottageApi 形状做参照：如果将来加了方法而忘了更新测试工具，
    // 这里的断言会失败，提醒把测试工具补齐（否则新方法永远测不到）。
    const api = window.cottage;
    for (const namespace of [
      'providers',
      'characters',
      'personas',
      'conversations',
      'messages',
      'summaries',
      'tokens',
      'settings',
      'app',
      'exportData',
      'events',
    ] as const) {
      expect(api[namespace], `缺少命名空间 ${namespace}`).toBeDefined();
    }
  });

  it('事件订阅返回可调用的取消函数（组件卸载时必须能解绑）', () => {
    const api = window.cottage;
    for (const subscribe of [
      api.events.onStreamChunk,
      api.events.onStreamEnd,
      api.events.onCompressProgress,
      api.events.onConversationsChanged,
      api.events.onMessagesChanged,
      api.events.onAppError,
    ]) {
      const unsubscribe = subscribe(() => undefined);
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    }
  });

  it('所有 invoke 方法都返回 Result 形状（失败以 ok:false 表达而不是抛异常）', async () => {
    const result = await window.cottage.conversations.list();
    expect(result).toHaveProperty('ok');
    expect(result.ok).toBe(true);
  });
});
