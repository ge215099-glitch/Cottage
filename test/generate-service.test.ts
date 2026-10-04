/**
 * 生成服务端到端测试（技术方案 6.1 的完整时序）。
 *
 * ## 为什么要有这个文件
 *
 * 在此之前，"发消息"这条链路是靠 `streamChat` 与 `assemble` 的**分段**测试拼出来的，
 * 但**编排本身**（`beginGeneration` + `runStream`）从未被验证过——而它恰好是
 * 最容易出错的地方：先组装还是先写库、Key 什么时候解密、事件什么时候推、
 * 出错时消息行有没有收尾。这些都属于"分开测都过、合起来不对"的典型。
 *
 * 而且它真的抓到了一个并发缺陷：同一会话里新流 abort 旧流之后，旧流仍会走完收尾
 * 并把内容写回去，覆盖掉新流的结果。修复见 `runStream` 里的 `isCurrent()`。
 *
 * ## 怎么在纯 Node 下测
 *
 * 三处外部依赖都被换掉了，且**不改变被测代码**：
 *   - `electron.safeStorage` → 用 `vi.mock` 换成内存实现（本模块只用到同步的两个方法）；
 *   - 网络的 `fetch` → 通过 `globalThis.fetch` 注入录制好的 SSE 字节流；
 *   - 数据库 → 用基于 `node:sqlite` 的内存驱动。
 *
 * 纪律（技术方案 11.3 规则 1/2）：**绝不发真实网络请求、绝不出现真实密钥**。
 *
 * ## 关于等待
 *
 * `beginGeneration` 是"启动后立刻返回"的设计，收尾由后台任务完成。
 * 所以断言前必须等它落地——用 `waitFor` 轮询而不是固定 `sleep`，
 * 否则会写出"在快的机器上过、慢的机器上挂"的测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存版 safeStorage：只是为了绕开"必须在 Electron 里才能加密"这一条。 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-backend',
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { createAppContext, type AppContext } from '../src/main/context.js';
import { beginGeneration } from '../src/main/services/generate.js';
import { EVENT } from '../src/shared/ipc.js';
import * as characters from '../src/main/db/dao/characters.js';
import * as conversations from '../src/main/db/dao/conversations.js';
import * as messages from '../src/main/db/dao/messages.js';
import * as providers from '../src/main/db/dao/providers.js';
import { encryptSecret } from '../src/main/secrets/index.js';
import { openMigratedDb } from './helpers/db.js';
import type { DatabaseDriver } from '../src/main/db/driver.js';
import type { NormalizedError, StreamChunkEvent, StreamEndEvent } from '../src/shared/types.js';

/** 测试用假密钥：形态像真实 Key，但显然是假的，且不出现在任何断言的输出里。 */
const FAKE_KEY = 'TEST-KEY-DO-NOT-USE-0000';

const T0 = 1_700_000_000_000;

/** 收集主进程推给 renderer 的事件。 */
interface EventLog {
  chunks: StreamChunkEvent[];
  ends: StreamEndEvent[];
  errors: NormalizedError[];
  others: Array<{ channel: string; payload: unknown }>;
}

function makeContext(db: DatabaseDriver, log: EventLog): AppContext {
  const ctx = createAppContext(db, ':memory:');
  ctx.emit = (channel, payload) => {
    if (channel === EVENT.streamChunk) log.chunks.push(payload as StreamChunkEvent);
    else if (channel === EVENT.streamEnd) log.ends.push(payload as StreamEndEvent);
    else if (channel === EVENT.appError) log.errors.push(payload as NormalizedError);
    else log.others.push({ channel, payload });
  };
  return ctx;
}

/** 轮询等待条件成立（避免固定 sleep 带来的机器差异）。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error(`等待超时：${label}`);
}

/** 造一个可用的 provider（密钥走真实加密路径，只是 safeStorage 被替换了）。 */
async function seedProvider(db: DatabaseDriver): Promise<string> {
  const apiKeyEnc = await encryptSecret(FAKE_KEY);
  return providers.createProvider(
    db,
    {
      name: '测试端点',
      type: 'openai',
      baseUrl: 'https://api.example.invalid/v1',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      compressionModel: 'deepseek-chat',
      enabled: true,
    },
    { apiKeyEnc, now: T0 },
  ).id;
}

/** 造角色 + 会话（含开场白），返回会话 id。 */
function seedConversation(db: DatabaseDriver, providerId: string | null): string {
  const charId = characters.importCharacter(
    db,
    {
      spec: 'chara_card_v3',
      data: {
        name: '管家',
        description: '老宅的管家。',
        first_mes: '「您比约定的时间早了十一分钟。」',
      },
    },
    T0,
  ).character.id;

  const conversation = conversations.createConversation(
    db,
    { title: '新对话', characterId: charId, personaId: null, providerId, model: providerId ? 'deepseek-chat' : '' },
    T0,
  );

  messages.insertMessage(
    db,
    { conversationId: conversation.id, role: 'assistant', content: '「您比约定的时间早了十一分钟。」' },
    T0,
  );
  return conversation.id;
}

const encoder = new TextEncoder();

/** 一帧 OpenAI 兼容的 content delta。 */
function deltaFrame(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

/**
 * 录制好的 SSE 响应：可注入若干段文本与用量，最后以 `[DONE]` 收尾。
 *
 * `signal` 传入时会模拟真实 `fetch` 的行为——**被 abort 时把流关掉**，
 * 这样上层的 `reader.read()` 会以 done 收尾，中断路径才走得完全。
 * 少了这一点，`streamChat` 的 promise 会一直挂着，"等收尾"的断言必然超时。
 */
function sseResponse(
  parts: string[],
  options: { usage?: { prompt: number; completion: number }; signal?: AbortSignal | null } = {},
): Response {
  const frames: Uint8Array[] = parts.map(deltaFrame);
  if (options.usage) {
    frames.push(
      encoder.encode(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: options.usage.prompt, completion_tokens: options.usage.completion },
        })}\n\n`,
      ),
    );
  }
  frames.push(encoder.encode('data: [DONE]\n\n'));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
    cancel() {
      /* 被取消：什么都不做，ReadableStream 已进入 closed */
    },
  });

  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      void stream.cancel().catch(() => undefined);
    });
  }
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 一个"发完首段就挂住"的响应，用来模拟真实的长回答。
 *
 * 为什么必须有它：用 `sseResponse` 测中断是测不出来的——那个流发完就 `close()`，
 * 于是生成在几毫秒内就正常结束了，`ctx.streams` 里的条目也被清掉，
 * abort 根本没机会生效（断言会得到 "expected undefined to be defined"）。
 * 这里保持流打开，只有 abort 才会把它取消，中断路径才真的被走到。
 */
function hangingResponse(firstPart: string, signal: AbortSignal | null): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(deltaFrame(firstPart));
      // 刻意不 close，也不再 enqueue：等 abort 来收
    },
  });

  signal?.addEventListener('abort', () => {
    try {
      controller?.close();
    } catch {
      /* 已关闭 */
    }
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let db: DatabaseDriver;
let log: EventLog;
let ctx: AppContext;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  db = openMigratedDb();
  log = { chunks: [], ends: [], errors: [], others: [] };
  ctx = makeContext(db, log);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

describe('一次成功的生成', () => {
  it('组装 → 请求 → 流式 → 落库 → 推事件，全链路走通', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    // 注入网络：顺便断言请求体确实是组装出来的 IR，而不是别的东西
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse(['「在。」', '他没有立刻带路。'], { usage: { prompt: 820, completion: 42 } });
    }) as unknown as typeof fetch;

    const started = await beginGeneration(ctx, { conversationId, userText: '东西还在原来的位置？' });

    // 立刻返回：用户消息与空的助手行都已落库
    expect(started.userMessage).not.toBeNull();
    expect(started.userMessage!.content).toBe('东西还在原来的位置？');
    expect(started.assistantMessage.status).toBe('streaming');

    await waitFor(() => log.ends.length > 0, 5_000, '流结束事件');

    // ---- 请求体：system 在前，本次输入在最后 ----
    expect(capturedBody).not.toBeNull();
    const sent = capturedBody!;
    expect(sent['model']).toBe('deepseek-chat');
    expect(sent['stream']).toBe(true);
    const sentMessages = sent['messages'] as Array<{ role: string; content: string }>;
    expect(sentMessages[0]!.role).toBe('system');
    expect(sentMessages[0]!.content).toContain('老宅的管家');
    expect(sentMessages[sentMessages.length - 1]!.content).toBe('东西还在原来的位置？');

    // ---- 落库：助手消息收尾为 done，内容与用量都在 ----
    const stored = messages.getMessage(db, started.assistantMessage.id)!;
    expect(stored.status).toBe('done');
    expect(stored.content).toBe('「在。」他没有立刻带路。');
    expect(stored.metadata.completionTokens).toBe(42);
    expect(stored.metadata.model).toBe('deepseek-chat');
    expect(typeof stored.metadata.elapsedMs).toBe('number');

    // ---- 事件：chunk 合并推送 + 一条 streamEnd ----
    expect(log.chunks.length).toBeGreaterThan(0);
    expect(log.chunks.map((c) => c.delta).join('')).toBe('「在。」他没有立刻带路。');
    expect(log.ends).toHaveLength(1);
    expect(log.ends[0]!.status).toBe('done');

    // ---- 无残留流 ----
    expect(ctx.streams.size).toBe(0);
  });

  it('首条消息会派生会话标题', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () => sseResponse(['好。'])) as unknown as typeof fetch;

    await beginGeneration(ctx, { conversationId, userText: '夜巡酒馆的第三夜要怎么走？' });
    await waitFor(() => log.ends.length > 0, 5_000, '流结束');

    const after = conversations.getConversation(db, conversationId)!;
    expect(after.title).not.toBe('新对话');
    expect(after.title.length).toBeLessThanOrEqual(19);
  });

  it('已存在的标题不会被首条消息覆盖', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);
    conversations.renameConversation(db, conversationId, '我自己起的名字');

    globalThis.fetch = (async () => sseResponse(['好。'])) as unknown as typeof fetch;
    await beginGeneration(ctx, { conversationId, userText: '随便说点什么' });
    await waitFor(() => log.ends.length > 0, 5_000, '流结束');

    expect(conversations.getConversation(db, conversationId)!.title).toBe('我自己起的名字');
  });
});

describe('失败路径：消息行必须收尾，不能残留「生成中」', () => {
  it('上游 401 → status=error，metadata 里带 NormalizedError', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"Invalid key"}}', { status: 401 })) as unknown as typeof fetch;

    const started = await beginGeneration(ctx, { conversationId, userText: '你好' });
    await waitFor(() => log.ends.length > 0, 5_000, '错误收尾');

    const stored = messages.getMessage(db, started.assistantMessage.id)!;
    expect(stored.status).toBe('error');
    expect(stored.metadata.error?.code).toBe('AUTH_FAILED');
    expect(log.ends[0]!.status).toBe('error');
    expect(log.ends[0]!.error?.code).toBe('AUTH_FAILED');
  });

  it('网络不可达 → 消息收尾为 error 且不残留 streaming', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed: ENOTFOUND');
    }) as unknown as typeof fetch;

    const started = await beginGeneration(ctx, { conversationId, userText: '你好' });
    await waitFor(() => log.ends.length > 0, 5_000, '错误收尾');

    expect(messages.getMessage(db, started.assistantMessage.id)!.status).toBe('error');
    const streaming = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'streaming'")
      .get();
    expect(Number(streaming?.n)).toBe(0);
  });

  it('未配置 Provider 时直接抛错，且不留下半截消息行', async () => {
    const conversationId = seedConversation(db, null);

    await expect(beginGeneration(ctx, { conversationId, userText: '你好' })).rejects.toThrow(/Provider/);
    expect(messages.listMessages(db, conversationId)).toHaveLength(1); // 只有开场白
  });

  it('会话不存在时抛可读错误', async () => {
    await expect(
      beginGeneration(ctx, { conversationId: 'cnv_不存在', userText: '你好' }),
    ).rejects.toThrow(/会话不存在/);
  });
});

describe('中断（验收项 10 的编排侧）', () => {
  it('abort 后状态为 interrupted，且已收到的部分内容保留', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    // 发一段后挂住，等 abort 来收（用 sseResponse 会秒结束，测不到中断）
    globalThis.fetch = (async (_url: string, init: RequestInit) =>
      hangingResponse('中断前收到的部分', init.signal as AbortSignal)) as unknown as typeof fetch;

    const started = await beginGeneration(ctx, { conversationId, userText: '继续' });
    // 等到落库了第一段内容再中断，否则测不到"保留部分内容"
    await waitFor(
      () => messages.getMessage(db, started.assistantMessage.id)!.content.includes('中断前收到的部分'),
      3_000,
      '第一段内容落库',
    );

    const active = ctx.streams.get(conversationId);
    expect(active).toBeDefined();
    active!.controller.abort();

    await waitFor(() => log.ends.length > 0, 5_000, '中断收尾');

    const stored = messages.getMessage(db, started.assistantMessage.id)!;
    expect(stored.status).toBe('interrupted');
    expect(stored.content).toBe('中断前收到的部分');
    expect(stored.metadata.interrupted).toBe(true);
    expect(log.ends[0]!.status).toBe('interrupted');
  });

  /**
   * 这是本文件抓到过的真实缺陷的回归测试。
   *
   * 缺陷现象：同一会话里第二次发送会先 abort 第一次的流，但第一次的流仍会走完收尾，
   * 把自己的残留内容与 `interrupted` 状态写回数据库——把第二次的结果覆盖掉。
   * 表现为"重新生成后内容还是旧的/空的"。
   */
  it('新一次发送取代旧流后，旧流不得覆盖新流的结果（回归）', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    let calls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1;
      return calls === 1
        ? // 第一次：发一段后挂住，等着被 abort
          hangingResponse('第一次的残留内容', init.signal as AbortSignal)
        : sseResponse(['第二次的结果']);
    }) as unknown as typeof fetch;

    const first = await beginGeneration(ctx, { conversationId, userText: '第一次' });
    await waitFor(
      () => messages.getMessage(db, first.assistantMessage.id)!.content.includes('第一次的残留内容'),
      3_000,
      '第一段内容落库',
    );
    const firstController = ctx.streams.get(conversationId)!.controller;

    const second = await beginGeneration(ctx, { conversationId, userText: '第二次' });
    expect(firstController.signal.aborted).toBe(true);
    expect(ctx.streams.get(conversationId)!.streamId).toBe(second.streamId);

    // 等第二次流结束（它是当前流，负责收尾）
    await waitFor(
      () => log.ends.some((e) => e.streamId === second.streamId),
      5_000,
      '第二次流收尾',
    );
    // 再给被取代的旧流一点时间"尝试"写回，确认它确实没有写
    await new Promise((resolve) => setTimeout(resolve, 150));

    const secondRow = messages.getMessage(db, second.assistantMessage.id)!;
    expect(secondRow.content).toBe('第二次的结果');
    expect(secondRow.status).toBe('done');

    // 被取代的那一行必须被清掉：留着会让它永远停在 streaming（验收项 10 禁止）
    expect(messages.getMessage(db, first.assistantMessage.id)).toBeNull();
    const leftover = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'streaming'")
      .get();
    expect(Number(leftover?.n)).toBe(0);
  });
});

describe('重新生成：就地替换，消息总数不变', () => {
  it('复用同一行助手消息，不新增候选', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () => sseResponse(['初次回答'])) as unknown as typeof fetch;
    const started = await beginGeneration(ctx, { conversationId, userText: '问题' });
    await waitFor(() => log.ends.length > 0, 5_000, '首次收尾');

    const countBefore = messages.listMessages(db, conversationId).length;

    globalThis.fetch = (async () => sseResponse(['重来一次的回答'])) as unknown as typeof fetch;
    const regen = await beginGeneration(ctx, {
      conversationId,
      userText: '问题',
      existingMessageId: started.assistantMessage.id,
    });
    expect(regen.assistantMessage.id).toBe(started.assistantMessage.id);

    await waitFor(
      () => log.ends.some((e) => e.streamId === regen.streamId && e.status === 'done'),
      5_000,
      '重新生成收尾',
    );

    expect(messages.listMessages(db, conversationId)).toHaveLength(countBefore);
    const replaced = messages.getMessage(db, started.assistantMessage.id)!;
    expect(replaced.content).toBe('重来一次的回答');
    expect(replaced.status).toBe('done');
  });

  it('重新生成期间该行先被重置为 streaming 且内容清空', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () => sseResponse(['初次回答'])) as unknown as typeof fetch;
    const started = await beginGeneration(ctx, { conversationId, userText: '问题' });
    await waitFor(() => log.ends.length > 0, 5_000, '首次收尾');

    // 让第二次的响应挂住，以便观察重置后的中间态
    globalThis.fetch = (async (_url: string, init: RequestInit) =>
      sseResponse([], { signal: init.signal as AbortSignal | null })) as unknown as typeof fetch;

    const regen = await beginGeneration(ctx, {
      conversationId,
      userText: '问题',
      existingMessageId: started.assistantMessage.id,
    });

    const mid = messages.getMessage(db, regen.assistantMessage.id)!;
    expect(mid.status).toBe('streaming');
    expect(mid.content).toBe('');

    // 收尾（空响应也会正常结束）
    await waitFor(() => log.ends.some((e) => e.streamId === regen.streamId), 5_000, '收尾');
  });
});

describe('密钥边界（验收项 2 的编排侧）', () => {
  it('Key 明文不出现在推送事件与数据库里', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    globalThis.fetch = (async () => sseResponse(['回答'])) as unknown as typeof fetch;
    await beginGeneration(ctx, { conversationId, userText: '你好' });
    await waitFor(() => log.ends.length > 0, 5_000, '收尾');

    expect(JSON.stringify([log.chunks, log.ends, log.others])).not.toContain(FAKE_KEY);

    const row = db
      .prepare<{ api_key_enc: string | null }>('SELECT api_key_enc FROM providers WHERE id = ?')
      .get(providerId);
    expect(row?.api_key_enc).toBeTruthy();
    expect(row?.api_key_enc).not.toContain(FAKE_KEY);

    // 落库的消息里也不能有
    expect(JSON.stringify(messages.listMessages(db, conversationId))).not.toContain(FAKE_KEY);
  });

  it('明文只出现在发往上游的鉴权头里（协议要求）', async () => {
    const providerId = await seedProvider(db);
    const conversationId = seedConversation(db, providerId);

    let seenAuth: string | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>)['authorization'] ?? null;
      return sseResponse(['回答']);
    }) as unknown as typeof fetch;

    await beginGeneration(ctx, { conversationId, userText: '你好' });
    await waitFor(() => log.ends.length > 0, 5_000, '收尾');

    expect(seenAuth).toBe(`Bearer ${FAKE_KEY}`);
  });
});
