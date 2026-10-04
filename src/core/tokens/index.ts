/**
 * Token 计数（技术方案第 8 节）。
 *
 * | Provider 系                     | 方式                        | exact |
 * |--------------------------------|-----------------------------|-------|
 * | OpenAI 系（cl100k / o200k）     | gpt-tokenizer 精确计数       | true  |
 * | Anthropic / Gemini / DeepSeek  | 字符数加权估算               | false |
 *
 * 硬规则：**估算值绝不允许被当成精确值渲染**（产品设计文档 3.3 / UI 文档验收项 9）。
 * 所以返回值固定带 `exact` 与 `method`，UI 只能照着它填。
 */
import { encode } from 'gpt-tokenizer';
import type { PromptSpec, SegmentTokenDetail, TokenBreakdown, TokenCount } from '../types.js';
import { groupSegments } from '../prompt/assemble.js';

export interface TokenCountOptions {
  /** Provider 类型，决定走精确还是估算 */
  providerType: 'openai' | 'anthropic';
  /** 模型名，用于选编码与标注 */
  model: string;
  /** 模型上下文上限 */
  limit: number;
}

const OPENAI_ENCODING_RULES: Array<[RegExp, string]> = [
  [/^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt-4o)/i, 'o200k_base'],
  [/^(gpt-4|gpt-3\.5|text-embedding|davinci)/i, 'cl100k_base'],
];

/** 按模型名选 OpenAI 编码族；未知模型退回 cl100k_base（gpt-tokenizer 默认）。 */
export function selectOpenAiEncoding(model: string): string {
  for (const [re, name] of OPENAI_ENCODING_RULES) if (re.test(model)) return name;
  return 'cl100k_base';
}

/** 该 provider + 模型能否做精确计数。 */
export function canCountExactly(providerType: 'openai' | 'anthropic', model: string): boolean {
  if (providerType !== 'openai') return false;
  return OPENAI_ENCODING_RULES.some(([re]) => re.test(model));
}

/**
 * 权重估算（非 OpenAI 系）。
 *
 * 校准依据（技术方案 8 节表）：英文约 3.5–4.0 字符/token；CJK 另行加权。
 * 这里用"词 + 字符 + CJK"三段加权，CJK 单独按 ~1.5 字符/token 计。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const rest = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = rest.split(/\s+/).filter(Boolean).length;
  const ascii = rest.replace(/\s+/g, '').length;
  const estimate = cjk / 1.5 + words * 1.3 + ascii / 12;
  return Math.max(1, Math.round(estimate));
}

function exactTokens(text: string): number {
  if (!text) return 0;
  // gpt-tokenizer 的 encode 为同步纯 JS，不走 WASM、不联网。
  return encode(text).length;
}

/** 单段计数。 */
export function countText(text: string, opts: TokenCountOptions): TokenCount {
  if (canCountExactly(opts.providerType, opts.model)) {
    return {
      tokens: exactTokens(text),
      exact: true,
      method: `gpt-tokenizer/${selectOpenAiEncoding(opts.model)}`,
    };
  }
  return {
    tokens: estimateTokens(text),
    exact: false,
    method: `字符加权估算（${opts.providerType}）`,
  };
}

/**
 * 对组装结果做分段计数。
 *
 * **验收项 4/8：各分段之和必须等于合计。** 这里的实现方式是"先算各段、再求和"，
 * 而不是"各段相加后另算一个总量"，从结构上杜绝两者不一致。
 */
export function countPromptSpec(spec: PromptSpec, opts: TokenCountOptions): TokenBreakdown {
  const groups = groupSegments(spec);
  const segments: SegmentTokenDetail[] = groups.map((g) => ({
    kind: g.kind,
    label: g.label,
    count: countText(g.text, opts),
    itemCount: g.itemCount,
  }));

  const tokens = segments.reduce((sum, s) => sum + s.count.tokens, 0);
  const exact = segments.length > 0 && segments.every((s) => s.count.exact);
  const limit = opts.limit > 0 ? opts.limit : 1;

  return {
    segments,
    total: {
      tokens,
      exact,
      method: exact
        ? `gpt-tokenizer/${selectOpenAiEncoding(opts.model)}`
        : '字符加权估算（部分分段为估算）',
    },
    limit,
    ratio: Math.max(0, Math.min(1, tokens / limit)),
    anyEstimated: segments.some((s) => !s.count.exact),
  };
}

/** 超限判定：产品设计文档 3.3 要求"超过上限先压缩，仍超限则明确报错，不静默截断"。 */
export function exceedsLimit(breakdown: TokenBreakdown): boolean {
  return breakdown.total.tokens > breakdown.limit;
}

/** UI 展示用的百分比（四舍五入到整数）。 */
export function occupancyPercent(breakdown: TokenBreakdown): number {
  return Math.round(breakdown.ratio * 100);
}

/** 渲染 token 数字时的"约"前缀规则（UI 文档验收项 9）。 */
export function formatTokenCount(count: TokenCount): string {
  const n = count.tokens.toLocaleString('en-US');
  return count.exact ? n : `约 ${n}`;
}
