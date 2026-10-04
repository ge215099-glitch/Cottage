/**
 * IR → 请求体 的序列化差异（技术方案 7.3）。
 *
 * 这里是"统一组装 + 分派序列化"的落点：`PromptSpec` 是 provider 无关的 IR，
 * 适配器**只做序列化与解析**——不组装、不摘要、不碰 DB、不发请求。
 * 因此每个适配器的测试方式是"对 IR → 请求体做断言"，而不是发真实请求。
 *
 * 两个适配器的关键差异：
 *
 * | 差异点       | OpenAI 兼容                    | Anthropic                                |
 * |-------------|-------------------------------|------------------------------------------|
 * | system      | `messages[0].role = 'system'` | 顶层 `system`，messages 内禁止 system 角色   |
 * | post_history| 作为一条 system 注入            | 合并进顶层 `system`                        |
 * | 消息交替     | 不强制                         | 要求 user/assistant 交替，连续同角色必须合并  |
 * | 流式协议     | `data:` + `data: [DONE]`      | `event:` + `data:` 成对                   |
 */
import type { PromptSpec } from '../types.js';

export type ProviderType = 'openai' | 'anthropic';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 序列化结果：URL、请求体与"我们实际发出的东西"。 */
export interface RequestPlan {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface BuildRequestConfig {
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  /** 是否要求上游回传 usage（OpenAI 需要显式打开） */
  includeUsage?: boolean;
}

/** 规范化 baseUrl：允许用户填 `https://host`、`https://host/v1` 或完整路径。 */
export function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(path)) return trimmed;
  // 已经带 /v1 的不要再拼一次
  if (/\/v\d+$/.test(trimmed) && path.startsWith('/v1/')) {
    return `${trimmed}${path.slice(3)}`;
  }
  return `${trimmed}${path}`;
}

/** 两种 provider 流式请求都需要的公共请求头。 */
const STREAM_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
};

/* ------------------------------------------------------------------ */
/* OpenAI 兼容                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把 IR 摊平成 OpenAI 的 messages 数组。
 *
 * 顺序保持 IR 的分段顺序，但 system 类分段要**归并到最前面**：
 * OpenAI 允许 system 出现在任意位置，但历史对话里夹一条 system 会被部分
 * 兼容端点拒绝，因此统一前置。
 */
export function toOpenAiMessages(spec: PromptSpec): ChatMessage[] {
  const systems: string[] = [];
  const rest: ChatMessage[] = [];

  for (const segment of spec.segments) {
    if (segment.role === 'system') {
      // system 与 post_history 都归到前置 system 区，按 IR 顺序拼接
      systems.push(segment.text);
      continue;
    }
    rest.push({ role: segment.role, content: segment.text });
  }

  const messages: ChatMessage[] = [];
  if (systems.length) messages.push({ role: 'system', content: systems.join('\n\n') });
  messages.push(...rest);
  return messages;
}

export function buildOpenAiRequest(spec: PromptSpec, cfg: BuildRequestConfig): RequestPlan {
  return {
    url: joinUrl(cfg.baseUrl, '/v1/chat/completions'),
    method: 'POST',
    headers: {
      ...STREAM_HEADERS,
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model: cfg.model,
      messages: toOpenAiMessages(spec),
      temperature: cfg.temperature,
      top_p: cfg.topP,
      max_tokens: cfg.maxTokens,
      stream: true,
      ...(cfg.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    },
  };
}

/** 探测用：`GET /v1/models` 不需要请求体。 */
export function buildOpenAiModelsRequest(
  cfg: Pick<BuildRequestConfig, 'baseUrl' | 'apiKey'>,
): RequestPlan {
  return {
    url: joinUrl(cfg.baseUrl, '/v1/models'),
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 IR 摊平成 Anthropic 的 messages 数组。
 *
 * 两条硬约束（这就是"不能把 IR 直接当请求体发出去"的原因）：
 *   1. `messages` 里**禁止 system 角色** → 所有 system 类分段合并进顶层 `system`
 *   2. 要求 user / assistant **交替** → 连续同角色必须合并成一条
 * 另外首条必须是 user，必要时补一条占位 user。
 */
export function toAnthropicMessages(spec: PromptSpec): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const segment of spec.segments) {
    if (segment.role === 'system') continue; // 由顶层 system 承载
    const role = segment.role;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${segment.text}`;
      continue;
    }
    messages.push({ role, content: segment.text });
  }

  // Anthropic 要求首条是 user：若历史以 assistant 开头（角色先开口），
  // 补一条极简 user 作为引导，而不是丢掉角色的开场白。
  if (messages.length && messages[0]!.role === 'assistant') {
    messages.unshift({ role: 'user', content: '（继续）' });
  }
  return messages;
}

/** 顶层 system：所有 system 类分段（含 post_history）按 IR 顺序拼接。 */
export function toAnthropicSystem(spec: PromptSpec): string {
  return spec.segments
    .filter((s) => s.role === 'system')
    .map((s) => s.text)
    .join('\n\n');
}

export function buildAnthropicRequest(spec: PromptSpec, cfg: BuildRequestConfig): RequestPlan {
  const system = toAnthropicSystem(spec);
  const messages = toAnthropicMessages(spec);

  return {
    url: joinUrl(cfg.baseUrl, '/v1/messages'),
    method: 'POST',
    headers: {
      ...STREAM_HEADERS,
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: cfg.model,
      // 无内容时不发 system：空串会被上游拒绝
      ...(system ? { system } : {}),
      messages,
      temperature: cfg.temperature,
      top_p: cfg.topP,
      max_tokens: cfg.maxTokens,
      stream: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

export function buildRequest(spec: PromptSpec, cfg: BuildRequestConfig): RequestPlan {
  return cfg.providerType === 'anthropic'
    ? buildAnthropicRequest(spec, cfg)
    : buildOpenAiRequest(spec, cfg);
}

/**
 * 连接测试的最小请求（产品设计文档 3.1 的分派策略）。
 *
 * OpenAI 兼容侧刻意**不假设**有 `/v1/models`：不少第三方兼容端点没实现它，
 * 而一个 1-token 的 `chat/completions` 探针同时证明了"鉴权通过"与"模型可用"。
 */
export function buildProbeRequest(
  cfg: Pick<BuildRequestConfig, 'providerType' | 'baseUrl' | 'apiKey' | 'model'>,
): RequestPlan {
  if (cfg.providerType === 'anthropic') {
    return {
      url: joinUrl(cfg.baseUrl, '/v1/messages'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: cfg.model || 'claude-3-5-haiku-latest',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
    };
  }
  return {
    url: joinUrl(cfg.baseUrl, '/v1/chat/completions'),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model: cfg.model || 'gpt-4o-mini',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    },
  };
}
