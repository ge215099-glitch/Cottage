/**
 * Provider 运行时：fetch + SSE（技术方案 7.4 / 7.5）。
 *
 * 本模块是**主进程的网络边界**：core 的适配器只负责"IR → 请求体"，
 * 真正发请求、读流、重试、超时、中断都在这里。
 *
 * 状态机（技术方案 7.5）：
 *
 * ```
 *   发起请求
 *      │
 *      ├── 尚未产出内容时失败 ─→ 429 则指数退避重试（最多 2 次）
 *      │                         其它错误直接收敛为 error
 *      ▼
 *   streaming ──用户停止 / 超时──→ interrupted（保留已收到的部分）
 *      │ 正常结束
 *      ▼
 *    done（写入 tokens / 时长 / TTFT）
 * ```
 *
 * **已产出内容之后绝不重试**：重试会导致内容重复或回退（技术方案 7.4）。
 */
import {
  createStreamState,
  flushStream,
  parseStreamChunk,
  type StreamEvent,
} from '@core/providers/stream.js';
import {
  normalizeFetchError,
  normalizeHttpError,
  summarizeUpstreamBody,
  redactSecrets,
} from '@core/providers/errors.js';
import type { RequestPlan } from '@core/providers/request.js';
import type { NormalizedError } from '@shared/types.js';

export interface StreamCallbacks {
  /** 每收到一段文本调用一次（调用方负责节流后再落库/推送） */
  onDelta(delta: string): void;
  /** 每收到一段**思考内容**调用一次（思考型模型；不是正文，默认不落库） */
  onReasoning?(delta: string): void;
  /** 收到用量更新（不保证每个上游都给） */
  onUsage?(usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number }): void;
  /** 首 token 延迟（毫秒） */
  onFirstToken?(ttftMs: number): void;
}

export interface StreamOutcome {
  status: 'done' | 'interrupted' | 'error';
  /** 累计产出的文本 */
  text: string;
  /**
   * 累计的**思考内容长度**（字符，不回传内容本身）。
   *
   * 只留长度就够诊断"为什么正文是空的"——把整段思考留在内存里没有用处，
   * 而且它绝不能进消息内容（那会污染对话与下一轮上下文）。
   */
  reasoningChars: number;
  promptTokens: number;
  completionTokens: number;
  /** 其中用在思考上的输出 token；上游不给时为 0 */
  reasoningTokens: number;
  ttftMs: number | null;
  elapsedMs: number;
  stopReason?: string;
  /** 429 实际发生的重试次数，便于 UI 显示"重试中 (1/2)" */
  retryCount: number;
  error?: NormalizedError;
}

export interface StreamRequestOptions {
  /** 超时（毫秒）；与用户中断信号合并 */
  timeoutMs: number;
  /** 用户中断信号（来自 messages:abort） */
  signal?: AbortSignal;
  providerType: 'openai' | 'anthropic';
  /** 注入便于测试；默认用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入便于测试：重试前的等待（默认 sleep） */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入便于测试：单调时钟 */
  nowImpl?: () => number;
}

/** 429 的最大自动重试次数（产品设计文档 3.7：指数退避重试 2 次）。 */
export const MAX_RATE_LIMIT_RETRIES = 2;

/** 退避基数：第 1 次等 800ms，第 2 次等 1600ms。 */
export const RETRY_BASE_DELAY_MS = 800;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 执行一次流式请求。
 *
 * **不抛异常**：所有失败都收敛成 `status: 'error'` 的返回值。这样调用方（IPC handler）
 * 只需要看返回值，不会因为漏了 try/catch 让未捕获异常打死主进程。
 */
export async function streamChat(
  plan: RequestPlan,
  callbacks: StreamCallbacks,
  options: StreamRequestOptions,
): Promise<StreamOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const now = options.nowImpl ?? (() => Date.now());

  const startedAt = now();
  let text = '';
  let reasoningChars = 0;
  let firstTokenAt: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let stopReason: string | undefined;
  let retryCount = 0;

  /** 统一收尾，避免每条分支各拼一次结果对象。 */
  const finish = (
    status: StreamOutcome['status'],
    error?: NormalizedError,
  ): StreamOutcome => {
    const elapsedMs = now() - startedAt;
    const outcome: StreamOutcome = {
      status,
      text,
      reasoningChars,
      promptTokens,
      completionTokens,
      reasoningTokens,
      ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      elapsedMs,
      retryCount,
    };
    if (stopReason !== undefined) outcome.stopReason = stopReason;
    if (error !== undefined) outcome.error = error;
    return outcome;
  };

  for (;;) {
    // 每次尝试都重新构造信号：一次尝试被超时打断后，下一次要拿到新的超时窗口。
    const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);

    // 进入下一次尝试前先看用户是否已经点了停止：已中断就不该再发请求。
    // （真实 fetch 对 aborted signal 会 reject，但"重试循环"要显式检查，
    //   否则 429 退避期间用户点了停止，还会多打一次上游。）
    if (options.signal?.aborted) {
      return finish('interrupted', { code: 'ABORTED', message: '请求已中断', retryable: false });
    }

    let response: Response;
    try {
      response = await doFetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
        signal,
      });
    } catch (err) {
      // 网络层失败：还没产出任何内容，可以安全重试（仅限特定错误）
      const normalized = normalizeFetchError(err, '请求失败');
      if (normalized.code === 'ABORTED') return finish('interrupted', normalized);
      return finish('error', normalized);
    }

    if (!response.ok) {
      const body = await safeReadText(response);
      const normalized = normalizeHttpError(response.status, body, '请求被拒绝');

      // 429：尚未产出内容时才允许退避重试（技术方案 7.4 最后一条）
      if (
        normalized.code === 'RATE_LIMITED' &&
        text.length === 0 &&
        retryCount < MAX_RATE_LIMIT_RETRIES
      ) {
        retryCount += 1;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1));
        continue;
      }
      return finish('error', normalized);
    }

    if (!response.body) {
      return finish('error', {
        code: 'UPSTREAM_ERROR',
        message: '上游没有返回可读的流式响应',
        retryable: false,
      });
    }

    // ---- 开始读流 ----
    const state = createStreamState();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // 中断/超时必须能立刻收敛，而不是等下一次 `read()` 返回。
    // 真实 fetch 在 signal 中止时会让 `read()` reject，但注入的假网络（测试）
    // 与部分代理实现不会——所以这里显式把 signal 接到 reader.cancel 上，
    // 让"停止生成"在任何实现下都能立刻生效。
    const abortReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abortReader, { once: true });

    try {
      for (;;) {
        if (signal.aborted) {
          return finish('interrupted', { code: 'ABORTED', message: '请求已中断', retryable: false });
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;

        const events = parseStreamChunk(chunk, state, options.providerType);
        const failed = applyEvents(events);
        if (failed) return finish('error', failed);
      }

      // 循环退出后必须**再确认一次是否被取消**：`reader.cancel()` 会让
      // `read()` 以 `done: true` 收尾，看起来和"上游正常结束"一模一样。
      // 少了这一步，用户点"停止"会得到 status='done'，UI 就不会显示"已中断"。
      if (signal.aborted) {
        return finish('interrupted', { code: 'ABORTED', message: '请求已中断', retryable: false });
      }

      const tailEvents = flushStream(state, options.providerType);
      const tailFailed = applyEvents(tailEvents);
      if (tailFailed) return finish('error', tailFailed);
    } catch (err) {
      // 读流中途失败（含被 abort 打断）：已产出的内容必须保留（产品设计文档 3.5）
      const normalized = normalizeFetchError(err, '读取流失败');
      if (normalized.code === 'ABORTED' || signal.aborted) {
        return finish('interrupted', { code: 'ABORTED', message: '请求已中断', retryable: false });
      }
      return finish('error', normalized);
    } finally {
      signal.removeEventListener('abort', abortReader);
      // 释放 reader；取消失败不影响结果
      void reader.cancel().catch(() => undefined);
    }

    /*
     * `finish_reason` 必须在结局里带上。
     *
     * OpenAI 兼容的流把它放在**帧的字段**上（`choices[0].finish_reason`），而 `[DONE]`
     * 那一帧本身不带它；如果上游干脆不发 `[DONE]`（直接断流，见 flushStream 的分支），
     * 就更没有"带 stop_reason 的 done 事件"可依赖。所以这里从解析器状态兜一次，
     * 而不是只信 done 事件的载荷——实测踩过：`stopReason` 一直是 undefined，
     * 于是"正文为空"时无法区分 `length`（额度用尽）与 `content_filter`（内容过滤）。
     */
    if (stopReason === undefined && state.stopReason !== undefined) {
      stopReason = state.stopReason;
    }
    return finish('done');
  }

  /** 把解析出的事件应用到累计状态；返回错误（若有）。 */
  function applyEvents(events: StreamEvent[]): NormalizedError | undefined {
    for (const event of events) {
      if (event.type === 'reasoning') {
        // 思考内容不进正文、不落库：只记长度，供"正文为空"时解释原因
        reasoningChars += event.delta.length;
        callbacks.onReasoning?.(event.delta);
        continue;
      }
      if (event.type === 'text') {
        if (firstTokenAt === null) {
          firstTokenAt = now();
          callbacks.onFirstToken?.(firstTokenAt - startedAt);
        }
        text += event.delta;
        callbacks.onDelta(event.delta);
        continue;
      }
      if (event.type === 'usage') {
        if (typeof event.promptTokens === 'number') promptTokens = event.promptTokens;
        if (typeof event.completionTokens === 'number') completionTokens = event.completionTokens;
        if (typeof event.reasoningTokens === 'number') reasoningTokens = event.reasoningTokens;
        callbacks.onUsage?.({
          promptTokens,
          completionTokens,
          ...(reasoningTokens ? { reasoningTokens } : {}),
        });
        continue;
      }
      if (event.type === 'done') {
        if (event.stopReason) stopReason = event.stopReason;
        continue;
      }
      if (event.type === 'error') {
        // 远端在流中途报错：转成错误，而不是当成正常结束
        return { ...event.error, message: redactSecrets(event.error.message) };
      }
    }
    return undefined;
  }
}

/** 读正文失败时不让异常冒出去（错误摘要本就是尽力而为）。 */
async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return summarizeUpstreamBody(text);
  } catch {
    return '';
  }
}
