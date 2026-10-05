/**
 * 真实上游的思考型模型实测（**默认跳过**，与 `test/real-card.test.ts` 同一套规矩）。
 *
 * ## 为什么它必须存在
 *
 * 「思考 token 与正文共用输出额度」这件事**没法用假网络测出来**：假 SSE 里的
 * `reasoning_tokens` 是我们自己填的数字，它证明不了真实上游的行为。
 * 而这次的事故恰恰就是真实行为——`deepseek-flash` 这类混合推理模型先思考、后正文，
 * 上限被思考吃满时 `content` 为空、`finish_reason=length`，上游仍以 200 正常收流。
 *
 * 所以这里把那条真实形态钉成断言：解析器确实看得到 `reasoning_content`，
 * 空正文确实被判成失败，且文案确实指向"额度被思考吃满"。
 *
 * ## 怎么跑（需要真实 Key，会产生一次极小的请求费用）
 *
 * ```bash
 * COTTAGE_LIVE_KEY=<key> \
 * COTTAGE_LIVE_BASE_URL=https://api.deepseek.com \
 * COTTAGE_LIVE_MODEL=deepseek-flash \
 * npx vitest run test/live-reasoning.test.ts
 * ```
 *
 * 纪律：Key 只从环境变量读，**不出现在断言、快照、错误信息里**（本文件里也没有任何
 * 真实 Key 字面量，`scripts/verify-*.mjs` 的密钥形态正则会一并检查）。
 */
import { describe, expect, it } from 'vitest';

import { emptyCompletionError } from '../src/core/providers/errors.js';
import { streamChat, type StreamRequestOptions } from '../src/main/providers/runtime.js';
import type { RequestPlan } from '../src/core/providers/request.js';

const KEY = process.env['COTTAGE_LIVE_KEY'];
const BASE_URL = process.env['COTTAGE_LIVE_BASE_URL'] ?? 'https://api.deepseek.com';
const MODEL = process.env['COTTAGE_LIVE_MODEL'] ?? 'deepseek-flash';

/** 造一个最小的流式请求（不经过组装，只为了打真实的模型行为）。 */
function plan(maxTokens: number): RequestPlan {
  return {
    url: `${BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY ?? ''}` },
    body: {
      model: MODEL,
      stream: true,
      max_tokens: maxTokens,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
    },
  };
}

function options(): StreamRequestOptions {
  return { timeoutMs: 90_000, providerType: 'openai' };
}

describe.skipIf(!KEY)('真实上游：思考型模型（live）', () => {
  it('思考内容与正文分开：思考被单独统计，正文进 text', async () => {
    const outcome = await streamChat(plan(512), { onDelta: () => undefined }, options());

    expect(outcome.status).toBe('done');
    expect(outcome.text.trim().length).toBeGreaterThan(0);
    // 这条断言正是"这个模型是思考型"的证据；如果哪天模型不再输出思考，它会失败并提醒我们
    expect(outcome.reasoningChars + outcome.reasoningTokens).toBeGreaterThan(0);
    expect(outcome.reasoningTokens).toBeGreaterThan(0);
  }, 120_000);

  it('把输出上限压到很小：思考吃满额度 → 正文为空，并按失败给出可执行的解释', async () => {
    const outcome = await streamChat(plan(24), { onDelta: () => undefined }, options());

    // 上游是 200 正常收流的：运行时只如实汇报，判成失败是编排层的责任
    expect(outcome.status).toBe('done');
    expect(outcome.text).toBe('');

    const error = emptyCompletionError({
      ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
      contentChars: outcome.text.length,
      reasoningChars: outcome.reasoningChars,
      completionTokens: outcome.completionTokens,
      reasoningTokens: outcome.reasoningTokens,
    });

    expect(outcome.reasoningTokens + outcome.reasoningChars).toBeGreaterThan(0);
    expect(outcome.stopReason).toBe('length');
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toContain('思考');
    expect(error.message).toContain('上限');
  }, 120_000);
});
