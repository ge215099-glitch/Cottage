/**
 * SSE 流式解析（技术方案 7.4）。
 *
 * 四条工程细节，每条都有对应测试：
 *   1. 按 `\n\n` 切帧，**保留未完成的尾巴**——跨 chunk 截断是常态，必须缓冲。
 *   2. 忽略心跳/注释行（`:` 开头），容忍上游多发空行。
 *   3. 远端在流中途返回错误事件时要能转成错误，而不是当成正常结束。
 *   4. 结束时机：`[DONE]` / `message_stop` / body 关闭，三者取先到者。
 *
 * 解析器是**增量且可跨 chunk 调用**的：状态放在 `StreamState` 里由调用方持有。
 */
import type { NormalizedError } from '@shared/types.js';

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; error: NormalizedError }
  | { type: 'ignored' };

export interface StreamState {
  /** 未完成的帧尾巴 */
  buffer: string;
  /** 已结束（收到 [DONE] / message_stop / error）——之后不再产出内容 */
  finished: boolean;
  /** 用量累计（Anthropic 在 message_start 给输入、message_delta 给输出） */
  promptTokens: number;
  completionTokens: number;
  stopReason?: string;
}

export function createStreamState(): StreamState {
  return { buffer: '', finished: false, promptTokens: 0, completionTokens: 0 };
}

interface SseFrame {
  event: string;
  data: string;
}

/**
 * 切帧：把缓冲区里**已经完整**的 SSE 帧切出来，半截的留在 `rest` 里等下一次 chunk。
 *
 * 实现刻意用**逐行扫描**而不是正则切分。SSE 的帧边界规则本身很简单——
 * "空行结束一帧"——但换行符归属极易算错（帧尾换行属这一帧、空行的换行属分隔符、
 * 多出来的空行要留给下一轮），一不留神就写成"每轮只前进一帧"或"每轮少算一个换行"
 * 这类偏移错误。逐行处理把它变成一眼可见的状态机：
 *
 * ```
 *   读一行 → 是空行？ 是 → 当前帧结束，产出（空帧则跳过）并开始新帧
 *                    否 → 追加进当前帧的原始文本
 *   循环结束 → 未结束的那一帧整体留在 rest 里
 * ```
 *
 * 末尾那个换行是否属于分隔符无需单独判断：空行只在**读到它自己的换行**时才成立，
 * 所以缓冲区以单个 `\n` 结尾时那一帧尚未结束，自然留在 rest 中等下一次。
 */

/** 把一例已完整的帧文本解析成 `{ event, data }`。 */
function parseFrameBlock(block: string): SseFrame {
  let event = '';
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith(':')) continue; // 空行与心跳注释
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      // 规范允许多个 data: 行，用 \n 拼接
      dataLines.push(line.slice(5).replace(/^ /, ''));
      continue;
    }
    // 其它字段（id: / retry: / 未知行）忽略
  }

  return { event, data: dataLines.join('\n') };
}

/**
 * 切帧：把缓冲区里**已经完整**的帧切出来，半截的留在 `rest` 里等下一次 chunk。
 *
 * 实现刻意用**逐行扫描**而不是正则切分。SSE 的帧边界规则本身很简单——
 * "空行结束一帧"——但换行符归属很容易算错（帧尾换行属这一帧、空行的换行属分隔符、
 * 多出来的空行要留给下一轮），一不留神就会出现"每轮只前进一帧"或"每轮少算一个换行"
 * 这类难查的偏移错误。逐行处理把这件事变成一眼可见的状态机：
 *
 * ```
 *   读一行 → 是空行？ 是 → 当前帧结束，产出（若为空帧则跳过）并开始新帧
 *                    否 → 追加到当前帧的原始文本
 *   循环结束 → 未结束的那一帧整体留在 rest 里
 * ```
 *
 * 最后一个换行是否属于分隔符无需判断：空行只在**读到它自己的换行**时才成立，
 * 因此缓冲区以单个 `\n` 结尾时，那一帧尚未结束，自然留在 rest 中等下一次。
 */
export function splitFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let lineStart = 0;
  let frameStart = 0;

  for (;;) {
    const nl = buffer.indexOf('\n', lineStart);
    if (nl === -1) break; // 最后一行没有换行，整段留给下一次

    const line = buffer.slice(lineStart, nl).replace(/\r$/, '');
    const nextLineStart = nl + 1;

    if (line === '') {
      // 空行 → 当前帧结束。[frameStart, lineStart) 是本帧的全部行。
      const frame = parseFrameBlock(buffer.slice(frameStart, lineStart));
      // 纯注释/空白块不产出事件：否则收尾后的下一次调用会凭空产出"空事件"，
      // 内容虽空，却会误导调用方的状态机。
      if (frame.data.length > 0 || frame.event) frames.push(frame);
      frameStart = nextLineStart;
    }

    lineStart = nextLineStart;
  }

  return { frames, rest: buffer.slice(frameStart) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容                                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析 OpenAI 兼容的增量帧。导出以便单独测试。
 *
 * OpenAI 的 SSE 只有 `data:` 行，没有 `event:`；结束标记是 `data: [DONE]`。
 * 上游错误可能出现在流中间，形如 `data: {"error": {...}}`。
 */
export function parseOpenAiFrame(frame: SseFrame, state: StreamState): StreamEvent[] {
  if (frame.data === '[DONE]') {
    state.finished = true;
    return [{ type: 'done' }];
  }

  const payload = safeJson(frame.data);
  if (!isRecord(payload)) return [{ type: 'ignored' }];

  const events: StreamEvent[] = [];

  if (isRecord(payload.error)) {
    state.finished = true;
    events.push({ type: 'error', error: errorFromPayload(payload.error, 'OpenAI 兼容端点返回错误') });
    return events;
  }

  if (isRecord(payload.usage)) {
    const p = Number(payload.usage.prompt_tokens ?? 0);
    const c = Number(payload.usage.completion_tokens ?? 0);
    state.promptTokens = p || state.promptTokens;
    state.completionTokens = c || state.completionTokens;
    events.push({ type: 'usage', promptTokens: state.promptTokens, completionTokens: state.completionTokens });
  }

  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = choice.delta;
      if (isRecord(delta) && typeof delta.content === 'string' && delta.content.length > 0) {
        events.push({ type: 'text', delta: delta.content });
      }
      // 少数端点把完整内容放在 message.content（非流式兜底）
      const message = choice.message;
      if (isRecord(message) && typeof message.content === 'string' && message.content.length > 0) {
        events.push({ type: 'text', delta: message.content });
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        state.stopReason = choice.finish_reason;
      }
    }
  }

  return events.length ? events : [{ type: 'ignored' }];
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解析 Anthropic 的增量帧。
 *
 * 事件序列：`message_start`（带输入用量）→ 若干 `content_block_delta`
 * → `message_delta`（带输出用量与 stop_reason）→ `message_stop`。
 * 另有 `ping` 与 `error`；后者必须转成错误而不是当正常结束。
 */
export function parseAnthropicFrame(frame: SseFrame, state: StreamState): StreamEvent[] {
  const payload = safeJson(frame.data);
  // 有的实现只发 data 里的 type 字段，event 行为空，因此 type 从两侧取
  const type = frame.event || (isRecord(payload) && typeof payload.type === 'string' ? payload.type : '');

  if (type === 'ping') return [{ type: 'ignored' }];

  if (type === 'error' || (isRecord(payload) && isRecord(payload.error))) {
    state.finished = true;
    const detail = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
    return [{ type: 'error', error: errorFromPayload(detail, 'Anthropic 返回错误') }];
  }

  if (!isRecord(payload)) return [{ type: 'ignored' }];

  switch (type) {
    case 'message_start': {
      const message = payload.message;
      if (isRecord(message) && isRecord(message.usage)) {
        state.promptTokens = Number(message.usage.input_tokens ?? 0) || state.promptTokens;
        state.completionTokens = Number(message.usage.output_tokens ?? 0) || state.completionTokens;
        return [{ type: 'usage', promptTokens: state.promptTokens, completionTokens: state.completionTokens }];
      }
      return [{ type: 'ignored' }];
    }
    case 'content_block_delta': {
      const delta = payload.delta;
      if (isRecord(delta)) {
        if (typeof delta.text === 'string' && delta.text.length > 0) {
          return [{ type: 'text', delta: delta.text }];
        }
        // 兼容部分代理把文本放在 thinking / partial_json
        if (typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
          return [{ type: 'text', delta: delta.partial_json }];
        }
      }
      return [{ type: 'ignored' }];
    }
    case 'message_delta': {
      const events: StreamEvent[] = [];
      if (isRecord(payload.usage)) {
        const out = Number(payload.usage.output_tokens ?? 0);
        if (out) state.completionTokens = out;
        events.push({ type: 'usage', promptTokens: state.promptTokens, completionTokens: state.completionTokens });
      }
      const delta = payload.delta;
      if (isRecord(delta) && typeof delta.stop_reason === 'string' && delta.stop_reason) {
        state.stopReason = delta.stop_reason;
      }
      return events.length ? events : [{ type: 'ignored' }];
    }
    case 'message_stop': {
      state.finished = true;
      return [{ type: 'done', stopReason: state.stopReason }];
    }
    default:
      return [{ type: 'ignored' }];
  }
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一段 chunk 喂进解析器，返回本次产出的全部事件。
 *
 * **可跨 chunk 调用**：未完成的帧留在 `state.buffer` 里等下一次。
 * 已结束（finished）后不再产出任何内容，避免上限流尾巴造成重复文本。
 */
export function parseStreamChunk(
  chunk: string,
  state: StreamState,
  providerType: 'openai' | 'anthropic',
): StreamEvent[] {
  if (state.finished) {
    // 已经收尾（[DONE] / message_stop / error）。此时把尾巴一并丢弃，
    // 否则迟到的帧会留在 buffer 里，下一次调用又被解析成内容 —— 那正是
    // "上游多发一点尾巴就造成文本重复"的来源。
    state.buffer = '';
    return [];
  }

  state.buffer += chunk;
  const { frames, rest } = splitFrames(state.buffer);
  state.buffer = rest;

  const out: StreamEvent[] = [];
  for (const frame of frames) {
    if (state.finished) break;
    const events =
      providerType === 'anthropic' ? parseAnthropicFrame(frame, state) : parseOpenAiFrame(frame, state);
    out.push(...events);
  }
  // 处理过程中若已收尾（例如本批里出现了 [DONE]），剩余未解析的帧一并丢弃。
  if (state.finished) state.buffer = '';
  return out;
}

/**
 * 流结束时调用：把残留尾巴再解析一次。
 *
 * 有些端点最后一帧不带结尾空行（`data: {...}` 直接断流），此时尾巴里是"缺分隔符的
 * 完整帧"。这里把它按帧内容解析出来，而不是丢掉——丢掉的代价是最后一段回答消失。
 */
export function flushStream(state: StreamState, providerType: 'openai' | 'anthropic'): StreamEvent[] {
  if (state.finished || !state.buffer.trim()) return [];

  const tail = state.buffer;
  state.buffer = '';

  const frames: SseFrame[] = [];
  // 先按正常切帧拿掉可能存在的完整帧，剩下的尾巴整体作为一帧尝试解析。
  const { frames: complete, rest } = splitFrames(tail);
  frames.push(...complete);
  if (rest.trim()) frames.push(parseFrameBlock(rest));

  const out: StreamEvent[] = [];
  for (const frame of frames) {
    if (state.finished) break;
    const events =
      providerType === 'anthropic' ? parseAnthropicFrame(frame, state) : parseOpenAiFrame(frame, state);
    out.push(...events);
  }
  return out;
}

function errorFromPayload(payload: unknown, fallback: string): NormalizedError {
  if (isRecord(payload)) {
    const message = typeof payload.message === 'string' ? payload.message : fallback;
    const type = typeof payload.type === 'string' ? payload.type : '';
    const retryable = /overloaded|rate_limit|timeout|unavailable/i.test(`${type} ${message}`);
    return {
      code: retryable ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      message,
      retryable,
    };
  }
  return { code: 'UPSTREAM_ERROR', message: fallback, retryable: false };
}
