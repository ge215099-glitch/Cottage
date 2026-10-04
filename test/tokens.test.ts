/**
 * Token 计数测试（产品设计文档 7 验收项 5，技术方案第 8 节）。
 *
 * 验收原文："Token 明细各项之和等于总量；估算项被标记为估算。"
 * UI 侧还有一条硬要求："不允许把估算当精确展示"（UI 文档验收项 9）。
 */
import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '../src/core/prompt/assemble.js';
import {
  canCountExactly,
  countPromptSpec,
  countText,
  estimateTokens,
  exceedsLimit,
  formatTokenCount,
  occupancyPercent,
  selectOpenAiEncoding,
} from '../src/core/tokens/index.js';
import type { CharacterCard } from '../src/core/types.js';

const NOW = 1_700_000_000_000;

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: '爱丽丝',
    description: '钟表店学徒。',
    personality: '话不多。',
    scenario: '雨后的石板街。',
    firstMes: '',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '你扮演爱丽丝，语气克制。',
    postHistoryInstructions: '',
    tags: [],
    ...overrides,
  };
}

function specWith(overrides: Parameters<typeof assemblePrompt>[0] extends infer T ? Partial<T> : never = {}) {
  return assemblePrompt({
    character: card({ mesExample: '<START>\n{{user}}: 早\n{{char}}: 早。' }),
    persona: { name: 'ASMobbin' },
    summaries: [{ id: 's1', content: '两人已相识。', coversFrom: 1, coversTo: 2, tokenCount: 8, level: 1 }],
    messages: [
      { id: 'm1', role: 'user', content: '委托人是谁？', archived: true, sortOrder: 1 },
      { id: 'm2', role: 'assistant', content: '现在不能说。', archived: true, sortOrder: 2 },
      { id: 'm3', role: 'user', content: '那走吧。', archived: false, sortOrder: 3 },
    ],
    userInput: '再说一次。',
    nowMs: NOW,
    timezoneOffsetMinutes: 480,
    ...overrides,
  });
}

const openaiOpts = { providerType: 'openai' as const, model: 'gpt-4o-mini', limit: 20_000 };
const anthropicOpts = { providerType: 'anthropic' as const, model: 'claude-sonnet', limit: 20_000 };

describe('编码选择', () => {
  it('按模型名选 o200k_base / cl100k_base', () => {
    expect(selectOpenAiEncoding('gpt-4o-mini')).toBe('o200k_base');
    expect(selectOpenAiEncoding('gpt-4o')).toBe('o200k_base');
    expect(selectOpenAiEncoding('o1-preview')).toBe('o200k_base');
    expect(selectOpenAiEncoding('gpt-4')).toBe('cl100k_base');
    expect(selectOpenAiEncoding('gpt-3.5-turbo')).toBe('cl100k_base');
  });

  it('未知模型退回 cl100k_base 而不是报错', () => {
    expect(selectOpenAiEncoding('some-local-model')).toBe('cl100k_base');
  });

  it('只有 OpenAI 系可精确计数，Anthropic 一律估算', () => {
    expect(canCountExactly('openai', 'gpt-4o-mini')).toBe(true);
    expect(canCountExactly('openai', 'deepseek-chat')).toBe(false);
    expect(canCountExactly('anthropic', 'claude-sonnet')).toBe(false);
  });
});

describe('精确计数与估算的标记', () => {
  it('OpenAI 系返回 exact: true 且 method 点名 tokenizer 与编码', () => {
    const result = countText('hello world', openaiOpts);
    expect(result.exact).toBe(true);
    expect(result.method).toContain('gpt-tokenizer');
    expect(result.method).toContain('o200k_base');
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('Anthropic 返回 exact: false（绝不允许把估算当精确）', () => {
    const result = countText('hello world', anthropicOpts);
    expect(result.exact).toBe(false);
    expect(result.method).toContain('估算');
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('估算对 CJK 明显更高（同一字符数下中文更贵）', () => {
    const cjk = estimateTokens('钟表店的学徒对时间异常敏感');
    const ascii = estimateTokens('abcdefghijklmn');
    expect(cjk).toBeGreaterThan(ascii);
  });

  it('空文本计 0，但估算函数对非空输入至少给 1', () => {
    expect(countText('', openaiOpts).tokens).toBe(0);
    expect(countText('', anthropicOpts).tokens).toBe(0);
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('精确计数是确定性的（同输入同输出）', () => {
    const text = '「齿轮不是坏了，是被人换过。」';
    expect(countText(text, openaiOpts)).toEqual(countText(text, openaiOpts));
  });
});

describe('分段计数（验收项 5）', () => {
  it('各分段之和等于合计——这正是本模块的结构保证', () => {
    const breakdown = countPromptSpec(specWith(), openaiOpts);
    const sum = breakdown.segments.reduce((acc, s) => acc + s.count.tokens, 0);
    expect(sum).toBe(breakdown.total.tokens);
  });

  it('分段标签与 IR 的六类一致，且带条目数', () => {
    const breakdown = countPromptSpec(specWith(), openaiOpts);
    const byKind = Object.fromEntries(breakdown.segments.map((s) => [s.kind, s]));
    expect(byKind.system!.label).toBe('system');
    expect(byKind.fewShot!.label).toBe('few-shot');
    expect(byKind.summary!.label).toBe('摘要');
    expect(byKind.history!.label).toBe('历史');
    expect(byKind.user!.label).toBe('本次输入');
    // 两条 few-shot 示例合并统计，条目数为 2
    expect(byKind.fewShot!.itemCount).toBe(2);
    expect(byKind.history!.itemCount).toBe(1);
  });

  it('Anthropic 下 anyEstimated 为真、合计 exact 为假', () => {
    const breakdown = countPromptSpec(specWith(), anthropicOpts);
    expect(breakdown.anyEstimated).toBe(true);
    expect(breakdown.total.exact).toBe(false);
    // 每一项都必须自己带 exact 标记，UI 才能逐项加"约"
    expect(breakdown.segments.every((s) => s.count.exact === false)).toBe(true);
  });

  it('OpenAI 下全部精确，合计也精确', () => {
    const breakdown = countPromptSpec(specWith(), openaiOpts);
    expect(breakdown.anyEstimated).toBe(false);
    expect(breakdown.total.exact).toBe(true);
  });

  it('occupancyPercent / ratio 归一到 limit', () => {
    const breakdown = countPromptSpec(specWith(), { ...openaiOpts, limit: 1000 });
    expect(breakdown.limit).toBe(1000);
    expect(occupancyPercent(breakdown)).toBe(Math.round((breakdown.total.tokens / 1000) * 100));
    expect(breakdown.ratio).toBeGreaterThanOrEqual(0);
    expect(breakdown.ratio).toBeLessThanOrEqual(1);
  });

  it('ratio 被夹在 [0,1]，超出上限时也不越界（用另一处判定超限）', () => {
    const breakdown = countPromptSpec(specWith(), { ...openaiOpts, limit: 1 });
    expect(breakdown.ratio).toBe(1);
    expect(exceedsLimit(breakdown)).toBe(true);
  });

  it('limit 为 0 或负数时不产生 NaN', () => {
    const breakdown = countPromptSpec(specWith(), { ...openaiOpts, limit: 0 });
    expect(Number.isFinite(breakdown.ratio)).toBe(true);
    expect(breakdown.limit).toBe(1);
  });

  it('不超限时 exceedsLimit 为假', () => {
    expect(exceedsLimit(countPromptSpec(specWith(), { ...openaiOpts, limit: 1_000_000 }))).toBe(false);
  });
});

describe('展示格式（UI 文档验收项 9）', () => {
  it('估算值必须带"约"前缀', () => {
    expect(formatTokenCount({ tokens: 12_400, exact: false, method: '估算' })).toBe('约 12,400');
  });

  it('精确值不带前缀，且千分位分隔', () => {
    expect(formatTokenCount({ tokens: 12_400, exact: true, method: 'gpt-tokenizer' })).toBe('12,400');
    expect(formatTokenCount({ tokens: 180, exact: true, method: 'x' })).toBe('180');
  });
});
