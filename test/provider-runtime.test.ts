/**
 * Provider 运行时测试（技术方案 7.4 / 7.5）。
 *
 * 纪律（技术方案 11.3 规则 1）：**永不发真实网络请求**。这里用注入的 `fetchImpl`
 * 返回构造好的 SSE 字节流，`sleepImpl` 用假时钟替代真实等待，
 * 时间相关断言一律用注入的 `nowImpl`，不写 `sleep`。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RATE_LIMIT_RETRIES,
  RETRY_BASE_DELAY_MS,
  streamChat,
  type StreamRequestOptions,
} from '../src/main/providers/runtime.js';
import type { RequestPlan } from '../src/core/providers/request.js';

const PLAN: RequestPlan = {
  url: 'https://api.example.invalid/v1/chat/completions',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { model: 'm', stream: true },
};

/** 从若干段文本造一个 SSE 字节流（每帧以空行结束）。 */
function sseStream(frames: string[], opts: { endWithDone?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = frames.map((f) => `${f}\n\n`);
  if (opts.endWithDone !== false) parts.push('data: [DONE]\n\n');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** 分多次 enqueue 的流，用来模拟真实的 chunk 切分。 */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 构造测试用的 options。 */
function options(overrides: Partial<StreamRequestOptions> = {}): StreamRequestOptions {
  return {
    timeoutMs: 60_000,
    providerType: 'openai',
    sleepImpl: async () => undefined,
    ...overrides,
  };
}

function openaiDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
}

describe('正常流式生成', () => {
  it('拼接出完整文本、统计用量与 TTFT，状态为 done', async () => {
    const deltas: string[] = [];
    let tick = 0;
    const outcome = await streamChat(
      PLAN,
      { onDelta: (d) => deltas.push(d) },
      options({
        fetchImpl: async () =>
          okResponse(
            sseStream([
              openaiDelta('「齿轮'),
              openaiDelta('不是坏了，'),
              openaiDelta('是被人换过。」'),
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 820, completion_tokens: 42 } })}`,
            ]),
          ),
        // 每次读时钟前进 10ms，便于断言 TTFT 与总时长是"算出来的"而不是猜的
        nowImpl: () => (tick += 10),
      }),
    );

    expect(outcome.status).toBe('done');
    expect(outcome.text).toBe('「齿轮不是坏了，是被人换过。」');
    expect(deltas.join('')).toBe(outcome.text);
    expect(outcome.promptTokens).toBe(820);
    expect(outcome.completionTokens).toBe(42);
    expect(outcome.ttftMs).toBeGreaterThan(0);
    expect(outcome.elapsedMs).toBeGreaterThan(0);
    expect(outcome.retryCount).toBe(0);
    expect(outcome.error).toBeUndefined();
  });

  it('跨 chunk 被切碎的帧也能正确拼接（真实网络下是常态）', async () => {
    const raw = `${openaiDelta('被切碎的')}\n\n${openaiDelta('内容')}\n\ndata: [DONE]\n\n`;
    const pieces = [raw.slice(0, 7), raw.slice(7, 23), raw.slice(23, 40), raw.slice(40)];

    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({ fetchImpl: async () => okResponse(chunkedStream(pieces)) }),
    );
    expect(outcome.text).toBe('被切碎的 内容'.replace(' ', ''));
  });

  it('上游不发 [DONE] 时由 flush 收尾，最后一段内容不丢', async () => {
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () => okResponse(chunkedStream([`${openaiDelta('最后一帧')}`])),
      }),
    );
    expect(outcome.text).toBe('最后一帧');
    expect(outcome.status).toBe('done');
  });

  it('Anthropic 协议也能正确解析', async () => {
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        providerType: 'anthropic',
        fetchImpl: async () =>
          okResponse(
            sseStream([
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"「现在"}}',
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"也不能说。」"}}',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":37}}',
              'event: message_stop\ndata: {"type":"message_stop"}',
            ]),
            // 注意：Anthropic 用 message_stop 结束，没有 [DONE]
          ),
      }),
    );
    expect(outcome.text).toBe('「现在也不能说。」');
    expect(outcome.completionTokens).toBe(37);
    expect(outcome.status).toBe('done');
  });
});

describe('429 限流：指数退避重试（验收项 12）', () => {
  it('尚未产出内容时最多自动重试 2 次，且间隔递增', async () => {
    const delays: number[] = [];
    let attempts = 0;

    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        sleepImpl: async (ms) => {
          delays.push(ms);
        },
        fetchImpl: async () => {
          attempts += 1;
          return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
        },
      }),
    );

    expect(attempts).toBe(MAX_RATE_LIMIT_RETRIES + 1);
    expect(outcome.retryCount).toBe(MAX_RATE_LIMIT_RETRIES);
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('RATE_LIMITED');
    expect(outcome.error?.retryable).toBe(true);
    // 指数退避：800 → 1600
    expect(delays).toEqual([RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2]);
  });

  it('重试后成功时状态为 done，retryCount 如实记录', async () => {
    let attempts = 0;
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) return new Response('rate limited', { status: 429 });
          return okResponse(sseStream([openaiDelta('重试后成功')]));
        },
      }),
    );
    expect(outcome.status).toBe('done');
    expect(outcome.text).toBe('重试后成功');
    expect(outcome.retryCount).toBe(1);
  });

  it('已产出内容后不再重试（重试会导致内容重复或回退）', async () => {
    const enqueued: string[] = [];
    let attempts = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const first = `${openaiDelta('已经产出的内容')}\n\n`;
        controller.enqueue(encoder.encode(first));
        enqueued.push(first);
        // 模拟"流中途远端报错并关闭"
        controller.enqueue(encoder.encode('data: {"error":{"message":"upstream boom"}}\n\n'));
        enqueued.push('error frame');
        controller.close();
      },
    });

    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () => {
          attempts += 1;
          return okResponse(stream);
        },
      }),
    );

    expect(attempts).toBe(1);
    expect(outcome.retryCount).toBe(0);
    expect(outcome.status).toBe('error');
    // 已经收到的内容必须保留
    expect(outcome.text).toBe('已经产出的内容');
  });
});

describe('失败矩阵（产品设计文档 3.7）', () => {
  it('401 → AUTH_FAILED，不可重试，且错误摘要经过脱敏', async () => {
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () =>
          new Response('{"error":{"message":"Invalid key sk-abcdefghijklmnopqrstuvwx"}}', {
            status: 401,
          }),
      }),
    );
    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('AUTH_FAILED');
    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.httpStatus).toBe(401);
    // 脱敏：上游回显的 Key 不得出现在错误文案里（验收项 3 的同源要求）
    expect(outcome.error?.message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(outcome.error?.message).toContain('已脱敏');
  });

  it('网络不可达 → UNREACHABLE，不自动重试', async () => {
    let attempts = 0;
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.example.invalid');
        },
      }),
    );
    expect(attempts).toBe(1);
    expect(outcome.error?.code).toBe('UNREACHABLE');
    expect(outcome.error?.retryable).toBe(false);
  });

  it('超时 → 按中断处理并保留已收到的内容', async () => {
    const encoder = new TextEncoder();
    // 这个流发完第一段后**永远不再产出**：靠 AbortSignal.timeout 把它掐掉。
    // cancel() 里必须真的把控制流收掉，否则 reader.read() 会挂到天荒地老。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${openaiDelta('超时前的内容')}\n\n`));
      },
      cancel() {
        // 被超时信号取消：这里什么都不用做，ReadableStream 已进入 closed 状态
      },
    });

    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      // 20ms 超时足够短；流在第一次 read 后就再也拿不到数据
      options({
        timeoutMs: 20,
        fetchImpl: async () => okResponse(stream),
      }),
    );

    expect(outcome.status).toBe('interrupted');
    expect(outcome.text).toBe('超时前的内容');
    expect(outcome.error?.code).toBe('ABORTED');
  });

  it('上游 500 → UPSTREAM_ERROR，可重试标记为 true（但不自动重试）', async () => {
    let attempts = 0;
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () => {
          attempts += 1;
          return new Response('internal error', { status: 500 });
        },
      }),
    );
    expect(attempts).toBe(1);
    expect(outcome.error?.code).toBe('UPSTREAM_ERROR');
    expect(outcome.error?.retryable).toBe(true);
  });

  it('上游报上下文超长 → CONTEXT_OVERFLOW，不可重试', async () => {
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({
        fetchImpl: async () =>
          new Response('{"error":{"message":"This model maximum context length is 20000 tokens"}}', {
            status: 400,
          }),
      }),
    );
    expect(outcome.error?.code).toBe('CONTEXT_OVERFLOW');
    expect(outcome.error?.retryable).toBe(false);
  });

  it('200 但没有 body → 明确报错，不当成空回答', async () => {
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({ fetchImpl: async () => new Response(null, { status: 200 }) }),
    );
    expect(outcome.status).toBe('error');
    expect(outcome.error?.message).toContain('流式响应');
  });
});

/**
 * 思考型模型（实测事故的运行时侧回归）。
 *
 * 关键点：思考内容**不能进 `text`**（那是消息正文，会落库、会当下一轮上下文），
 * 但要如实统计——正文为空时，"思考占了多少"是唯一的解释依据。
 */
describe('思考型模型：思考只计数，不进正文', () => {
  const thinkingFrames = [
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"想"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"了很久"}}]}',
    'data: {"choices":[{"delta":{"content":"正文"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":300,"completion_tokens_details":{"reasoning_tokens":280}}}',
  ];

  it('text 只有正文；思考长度与思考 token 分别统计', async () => {
    const reasoningDeltas: string[] = [];
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined, onReasoning: (d) => reasoningDeltas.push(d) },
      options({ fetchImpl: async () => okResponse(sseStream(thinkingFrames)) }),
    );

    expect(outcome.status).toBe('done');
    expect(outcome.text).toBe('正文');
    expect(reasoningDeltas.join('')).toBe('想了很久');
    expect(outcome.reasoningChars).toBe(4);
    expect(outcome.reasoningTokens).toBe(280);
    expect(outcome.stopReason).toBe('stop');
  });

  it('思考把输出额度吃满时：正文为空，但结局里有可解释的证据', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"一直想"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":521,"completion_tokens":1024,"completion_tokens_details":{"reasoning_tokens":1024}}}',
    ];
    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({ fetchImpl: async () => okResponse(sseStream(frames)) }),
    );

    // 上游是 200 正常收流，所以运行时**确实**会给出 done —— 判成失败是编排层的责任
    expect(outcome.status).toBe('done');
    expect(outcome.text).toBe('');
    expect(outcome.reasoningChars).toBe(3);
    expect(outcome.completionTokens).toBe(1024);
    expect(outcome.reasoningTokens).toBe(1024);
    expect(outcome.stopReason).toBe('length');
  });
});

describe('用户中断（验收项 10）', () => {
  it('abort 后状态为 interrupted，已收到内容保留', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`${openaiDelta('中断前收到的部分')}\n\n`));
        // 之后不再产出：靠 controller.abort() 结束
      },
    });

    const outcome = await streamChat(
      PLAN,
      {
        onDelta: () => {
          // 收到第一段就模拟用户点了停止
          controller.abort();
        },
      },
      options({
        signal: controller.signal,
        fetchImpl: async () => okResponse(stream),
      }),
    );

    expect(outcome.status).toBe('interrupted');
    expect(outcome.text).toBe('中断前收到的部分');
    expect(outcome.error?.code).toBe('ABORTED');
  });

  it('请求前就已中断时立刻收敛，不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    const outcome = await streamChat(
      PLAN,
      { onDelta: () => undefined },
      options({ signal: controller.signal, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(outcome.status).toBe('interrupted');
    expect(outcome.text).toBe('');
  });
});
