/**
 * 流式解析测试（技术方案 7.4）。
 *
 * 纪律：用**录制好的 SSE 字节序列**，绝不发真实网络请求（技术方案 11.3 规则 1）。
 * 重点验证最容易写坏的一条：**跨 chunk 截断**——真实网络下帧被切开是常态。
 */
import { describe, expect, it } from 'vitest';
import {
  createStreamState,
  flushStream,
  parseStreamChunk,
  type StreamEvent,
} from '../src/core/providers/stream.js';

/** 把一段文本按给定长度切成多块，模拟真实的 chunk 边界。 */
function chunkify(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 喂一串 chunk，收集全部事件。 */
function feed(chunks: string[], provider: 'openai' | 'anthropic'): StreamEvent[] {
  const state = createStreamState();
  const events: StreamEvent[] = [];
  for (const chunk of chunks) events.push(...parseStreamChunk(chunk, state, provider));
  events.push(...flushStream(state, provider));
  return events;
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is { type: 'text'; delta: string } => e.type === 'text')
    .map((e) => e.delta)
    .join('');
}

/* ------------------------------ OpenAI ------------------------------ */

/**
 * 注意每帧末尾都是 `\n\n`（帧尾换行 + 空行换行）：SSE 用**空行**结束一帧，
 * 所以少一个换行就不是完整帧、会被留在缓冲区里等下一次 chunk（这正是 `flush` 的用途）。
 * fixture 必须写成真实上游的形态，否则测的是"半截帧"这条另一条路径。
 */
const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":"「齿轮"},"index":0}]}',
  '',
  ': keep-alive',
  '',
  'data: {"choices":[{"delta":{"content":"不是坏了，"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":"是被人换过。」"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":820,"completion_tokens":42}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('OpenAI 兼容流式解析', () => {
  it('整段喂入时拼出完整文本并正常结束', () => {
    const events = feed([OPENAI_SSE], 'openai');
    expect(textOf(events)).toBe('「齿轮不是坏了，是被人换过。」');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('逐字节切开也不丢内容（跨 chunk 缓冲）', () => {
    const events = feed(chunkify(OPENAI_SSE, 1), 'openai');
    expect(textOf(events)).toBe('「齿轮不是坏了，是被人换过。」');
  });

  it('按任意长度切块结果一致', () => {
    const expected = textOf(feed([OPENAI_SSE], 'openai'));
    for (const size of [2, 3, 7, 13, 64, 200]) {
      expect(textOf(feed(chunkify(OPENAI_SSE, size), 'openai')), `块大小 ${size}`).toBe(expected);
    }
  });

  it('忽略心跳注释与多余空行', () => {
    const events = feed([OPENAI_SSE], 'openai');
    // ': keep-alive' 不应产出任何内容
    expect(events.filter((e) => e.type === 'text')).toHaveLength(3);
  });

  it('解析出用量', () => {
    const events = feed([OPENAI_SSE], 'openai');
    const usage = events.filter((e) => e.type === 'usage').pop() as
      | { type: 'usage'; promptTokens?: number; completionTokens?: number }
      | undefined;
    expect(usage?.promptTokens).toBe(820);
    expect(usage?.completionTokens).toBe(42);
  });

  it('收到 [DONE] 之后的内容被忽略（防流尾巴造成重复）', () => {
    const state = createStreamState();
    parseStreamChunk(OPENAI_SSE, state, 'openai');
    // 追加一段"迟到的"帧
    const late = parseStreamChunk('data: {"choices":[{"delta":{"content":"重复"}}]}\n\n', state, 'openai');
    expect(late).toEqual([]);
  });

  it('流中途的错误事件被转成 error，而不是当正常结束', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"开头"}}]}\n\n' +
      'data: {"error":{"type":"rate_limit_error","message":"Rate limit reached"}}\n\n';
    const events = feed([sse], 'openai');
    expect(textOf(events)).toBe('开头');
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error && error.type === 'error' ? error.error.retryable : false).toBe(true);
  });

  it('非 JSON 的畸形帧被忽略，不会中断整条流', () => {
    const sse =
      'data: 这不是 JSON\n\n' + 'data: {"choices":[{"delta":{"content":"仍然继续"}}]}\n\n' + 'data: [DONE]\n\n';
    expect(textOf(feed([sse], 'openai'))).toBe('仍然继续');
  });

  it('结束标记缺失时由 flush 兜底解析残留尾巴', () => {
    // 最后一帧没有结尾空行
    const sse = 'data: {"choices":[{"delta":{"content":"最后一帧"}}]}';
    expect(textOf(feed([sse], 'openai'))).toBe('最后一帧');
  });
});

/* ------------------------------ Anthropic ------------------------------ */

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1180,"output_tokens":1}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"「现在"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"也不能说。」"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":37}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

describe('Anthropic 流式解析', () => {
  it('event: + data: 成对解析，拼出完整文本', () => {
    const events = feed([ANTHROPIC_SSE], 'anthropic');
    expect(textOf(events)).toBe('「现在也不能说。」');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('逐字节切开也不丢内容', () => {
    expect(textOf(feed(chunkify(ANTHROPIC_SSE, 1), 'anthropic'))).toBe('「现在也不能说。」');
  });

  it('输入与输出用量分别从 message_start 与 message_delta 取得', () => {
    const events = feed([ANTHROPIC_SSE], 'anthropic');
    const usages = events.filter((e) => e.type === 'usage') as Array<{
      type: 'usage';
      promptTokens?: number;
      completionTokens?: number;
    }>;
    expect(usages.length).toBeGreaterThanOrEqual(2);
    expect(usages[0]!.promptTokens).toBe(1180);
    expect(usages[usages.length - 1]!.completionTokens).toBe(37);
  });

  it('ping 不产出内容', () => {
    const events = feed([ANTHROPIC_SSE], 'anthropic');
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
  });

  it('error 事件被转成 error', () => {
    const sse =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const events = feed([sse], 'anthropic');
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error && error.type === 'error' ? error.error.retryable : false).toBe(true);
  });

  it('message_stop 之后不再产出内容', () => {
    const state = createStreamState();
    parseStreamChunk(ANTHROPIC_SSE, state, 'anthropic');
    const late = parseStreamChunk(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"重复"}}\n\n',
      state,
      'anthropic',
    );
    expect(late).toEqual([]);
  });

  it('只有 data 行、没有 event 行时靠 data.type 识别（部分代理如此）', () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"靠 type 字段"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    expect(textOf(feed([sse], 'anthropic'))).toBe('靠 type 字段');
  });
});

/* --------------------- 思考型模型（reasoning_content） --------------------- */

/**
 * 这一组是实测事故的回归：deepseek-flash 这类思考型模型会在**同一帧**里同时给
 * `reasoning_content`（思考）与 `content`（正文），而思考 token 与正文共用输出额度。
 *
 * 事故形态：会话上限 1024，思考把额度吃满 → `content` 一直是空的、`finish_reason=length`，
 * 上游仍然以 200 正常收流。当时解析器把思考内容整个丢掉，于是"思考了一千个 token"
 * 与"上游什么都没回"在应用里长得一模一样。
 */
describe('思考型模型：思考内容与正文必须分开', () => {
  const OPENAI_THINKING_SSE = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning_content":"先想一下"}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"再想一下"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"「我在。」"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":34,"completion_tokens":127,"completion_tokens_details":{"reasoning_tokens":103}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('reasoning_content 只产出 reasoning 事件，绝不混进正文', () => {
    const events = feed([OPENAI_THINKING_SSE], 'openai');
    expect(textOf(events)).toBe('「我在。」');
    const reasoning = events
      .filter((e): e is { type: 'reasoning'; delta: string } => e.type === 'reasoning')
      .map((e) => e.delta)
      .join('');
    expect(reasoning).toBe('先想一下再想一下');
  });

  it('用量里带出思考 token（正文为空的现场证据）', () => {
    const events = feed([OPENAI_THINKING_SSE], 'openai');
    const usage = events.filter((e) => e.type === 'usage').pop();
    expect(usage).toEqual({
      type: 'usage',
      promptTokens: 34,
      completionTokens: 127,
      reasoningTokens: 103,
    });
  });

  it('只有思考、没有正文时，正文长度就是 0（不是"看起来没回答"）', () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"想了很久"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":521,"completion_tokens":1024,"completion_tokens_details":{"reasoning_tokens":1024}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const events = feed([sse], 'openai');
    expect(textOf(events)).toBe('');
    expect(events.filter((e) => e.type === 'reasoning')).toHaveLength(1);
  });

  it('Anthropic 的扩展思考（thinking_delta）同样不进正文', () => {
    const sse = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先推理"}}',
      '',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"结论"}}',
      '',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50,"output_tokens_details":{"thinking_tokens":40}},"delta":{"stop_reason":"end_turn"}}',
      '',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join('\n');
    const events = feed([sse], 'anthropic');
    expect(textOf(events)).toBe('结论');
    expect(
      events.filter((e) => e.type === 'reasoning').map((e) => (e.type === 'reasoning' ? e.delta : '')),
    ).toEqual(['先推理']);
    const usage = events.filter((e) => e.type === 'usage').pop();
    expect(usage && usage.type === 'usage' ? usage.reasoningTokens : undefined).toBe(40);
  });
});
