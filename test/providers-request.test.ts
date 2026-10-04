/**
 * Provider 适配器测试（产品设计文档 7 验收项 4）。
 *
 * 验收原文："同一 IR 分别序列化为 OpenAI 与 Anthropic 请求体，格式均合法
 * （Anthropic 无 system 角色）。"
 *
 * 纪律（技术方案 11.3 规则 1）：**永不发真实网络请求**，全部是对 IR → 请求体的断言。
 */
import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '../src/core/prompt/assemble.js';
import {
  buildAnthropicRequest,
  buildOpenAiRequest,
  buildProbeRequest,
  joinUrl,
  toAnthropicMessages,
  toAnthropicSystem,
  toOpenAiMessages,
  type BuildRequestConfig,
} from '../src/core/providers/request.js';
import type { CharacterCard, PromptSpec } from '../src/core/types.js';

const NOW = 1_700_000_000_000;

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: '爱丽丝',
    description: '钟表店学徒。',
    personality: '话不多。',
    scenario: '雨后的石板街。',
    firstMes: '「齿轮被换过。」',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '你扮演爱丽丝。',
    postHistoryInstructions: '保持简短。',
    tags: [],
    ...overrides,
  };
}

/** 一份包含全部六类分段的 IR。 */
function fullSpec(): PromptSpec {
  return assemblePrompt({
    character: card({ mesExample: '<START>\n{{user}}: 早\n{{char}}: 早。' }),
    persona: { name: 'ASMobbin' },
    summaries: [{ id: 's1', content: '摘要：两人已相识。', coversFrom: 1, coversTo: 2, tokenCount: 12, level: 1 }],
    messages: [
      { id: 'm1', role: 'user', content: '一', archived: true, sortOrder: 1 },
      { id: 'm2', role: 'assistant', content: '二', archived: true, sortOrder: 2 },
      { id: 'm3', role: 'user', content: '历史一', archived: false, sortOrder: 3 },
    ],
    userInput: '委托人是谁？',
    nowMs: NOW,
    timezoneOffsetMinutes: 480,
  });
}

function cfg(overrides: Partial<BuildRequestConfig> = {}): BuildRequestConfig {
  return {
    providerType: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'TEST-KEY-NOT-REAL',
    model: 'deepseek-chat',
    temperature: 0.9,
    topP: 0.95,
    maxTokens: 1024,
    ...overrides,
  };
}

describe('joinUrl', () => {
  it('补齐 /v1 路径且不重复', () => {
    expect(joinUrl('https://a.com', '/v1/chat/completions')).toBe('https://a.com/v1/chat/completions');
    expect(joinUrl('https://a.com/', '/v1/chat/completions')).toBe('https://a.com/v1/chat/completions');
    expect(joinUrl('https://a.com/v1', '/v1/chat/completions')).toBe('https://a.com/v1/chat/completions');
  });

  it('用户直接填了完整端点时不再拼接', () => {
    expect(joinUrl('https://a.com/v1/chat/completions', '/v1/chat/completions')).toBe(
      'https://a.com/v1/chat/completions',
    );
  });

  it('保留子路径（自建网关常见）', () => {
    expect(joinUrl('https://gw.example.com/openai', '/v1/chat/completions')).toBe(
      'https://gw.example.com/openai/v1/chat/completions',
    );
  });
});

describe('OpenAI 兼容序列化', () => {
  it('system 类分段（system + post_history）合并到 messages[0]', () => {
    const messages = toOpenAiMessages(fullSpec());
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('你扮演爱丽丝。');
    expect(messages[0]!.content).toContain('保持简短。');
    // 只允许一条 system
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('其余分段按 IR 顺序保留（few-shot → 历史 → user），摘要并入 system', () => {
    const messages = toOpenAiMessages(fullSpec());
    // 分段顺序：system、fewShot×2、summary、history、postHistory、user
    // 其中 role=system 的（system / summary / postHistory）全部前置合并为一条
    expect(messages.map((m) => m.role)).toEqual([
      'system', // system + summary + post_history
      'user', // few-shot {{user}}
      'assistant', // few-shot {{char}}
      'user', // history
      'user', // 本次输入
    ]);
    expect(messages.map((m) => m.content)).toEqual([
      '你扮演爱丽丝。\n\n摘要：两人已相识。\n\n保持简短。',
      '早',
      '早。',
      '历史一',
      '委托人是谁？',
    ]);
  });

  it('请求体包含必需的流式字段', () => {
    const plan = buildOpenAiRequest(fullSpec(), cfg());
    expect(plan.method).toBe('POST');
    expect(plan.url).toBe('https://api.example.com/v1/chat/completions');
    expect(plan.headers.authorization).toBe('Bearer TEST-KEY-NOT-REAL');
    expect(plan.body.model).toBe('deepseek-chat');
    expect(plan.body.stream).toBe(true);
    expect(plan.body.temperature).toBe(0.9);
    expect(plan.body.max_tokens).toBe(1024);
  });

  it('要求上游回传 usage（否则拿不到 token 用量）', () => {
    expect(buildOpenAiRequest(fullSpec(), cfg()).body.stream_options).toEqual({ include_usage: true });
    expect(
      buildOpenAiRequest(fullSpec(), cfg({ includeUsage: false })).body.stream_options,
    ).toBeUndefined();
  });

  it('序列化是确定性纯函数：同一 IR 两次结果一致', () => {
    const spec = fullSpec();
    expect(buildOpenAiRequest(spec, cfg())).toEqual(buildOpenAiRequest(spec, cfg()));
  });
});

describe('Anthropic 序列化（验收项 4 的关键点）', () => {
  it('messages 里不含 system 角色', () => {
    const plan = buildAnthropicRequest(fullSpec(), cfg({ providerType: 'anthropic', model: 'claude-sonnet' }));
    const messages = plan.body.messages as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('"system"');
  });

  it('system 是顶层参数，且包含 system + post_history + 摘要', () => {
    const spec = fullSpec();
    const system = toAnthropicSystem(spec);
    expect(system).toContain('你扮演爱丽丝。');
    expect(system).toContain('保持简短。');
    // 摘要分段的 role 是 system，因此也进顶层 system
    expect(system).toContain('摘要：两人已相识。');

    const plan = buildAnthropicRequest(spec, cfg({ providerType: 'anthropic' }));
    expect(typeof plan.body.system).toBe('string');
  });

  it('user / assistant 严格交替：连续同角色被合并', () => {
    const spec: PromptSpec = {
      segments: [
        { kind: 'system', role: 'system', text: 'S' },
        { kind: 'history', role: 'user', text: 'A' },
        { kind: 'history', role: 'user', text: 'B' },
        { kind: 'history', role: 'assistant', text: 'C' },
        { kind: 'history', role: 'assistant', text: 'D' },
        { kind: 'user', role: 'user', text: 'E' },
      ],
      meta: { characterName: 'c', userName: 'u', historyCount: 4, summaryCount: 0, archivedCount: 0 },
    };
    const messages = toAnthropicMessages(spec);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]!.content).toBe('A\n\nB');
    expect(messages[1]!.content).toBe('C\n\nD');
    expect(messages[2]!.content).toBe('E');
  });

  it('历史以 assistant 开头时补一条引导 user（Anthropic 要求首条是 user）', () => {
    const spec: PromptSpec = {
      segments: [
        { kind: 'history', role: 'assistant', text: '「门开了一条缝。」' },
        { kind: 'user', role: 'user', text: '我进来' },
      ],
      meta: { characterName: 'c', userName: 'u', historyCount: 2, summaryCount: 0, archivedCount: 0 },
    };
    const messages = toAnthropicMessages(spec);
    expect(messages[0]!.role).toBe('user');
    // 角色的开场白没有被丢掉
    expect(messages[1]!.content).toBe('「门开了一条缝。」');
  });

  it('headers 用 x-api-key 与 anthropic-version，不用 Bearer', () => {
    const plan = buildAnthropicRequest(fullSpec(), cfg({ providerType: 'anthropic' }));
    expect(plan.headers['x-api-key']).toBe('TEST-KEY-NOT-REAL');
    expect(plan.headers['anthropic-version']).toBe('2023-06-01');
    expect(plan.headers.authorization).toBeUndefined();
    expect(plan.url).toBe('https://api.example.com/v1/messages');
  });

  it('无任何 system 类分段时不发顶层 system（空串会被上游拒绝）', () => {
    const spec: PromptSpec = {
      segments: [{ kind: 'user', role: 'user', text: '你好' }],
      meta: { characterName: 'c', userName: 'u', historyCount: 0, summaryCount: 0, archivedCount: 0 },
    };
    const plan = buildAnthropicRequest(spec, cfg({ providerType: 'anthropic' }));
    expect('system' in plan.body).toBe(false);
    expect(plan.body.messages).toEqual([{ role: 'user', content: '你好' }]);
  });
});

describe('两种序列化的差异是结构性的，不是文案差异', () => {
  it('同一 IR：OpenAI 有 system 角色，Anthropic 没有', () => {
    const spec = fullSpec();
    const openai = buildOpenAiRequest(spec, cfg());
    const anthropic = buildAnthropicRequest(spec, cfg({ providerType: 'anthropic' }));

    const openaiMessages = openai.body.messages as Array<{ role: string }>;
    const anthropicMessages = anthropic.body.messages as Array<{ role: string }>;

    expect(openaiMessages.some((m) => m.role === 'system')).toBe(true);
    expect(anthropicMessages.some((m) => m.role === 'system')).toBe(false);
    expect(typeof anthropic.body.system).toBe('string');
    expect(openai.body.system).toBeUndefined();
  });
});

describe('连接测试探针（产品设计文档 3.1 的分派策略）', () => {
  it('OpenAI 兼容用 1-token 的 chat/completions 探针，不假设有 /models', () => {
    const probe = buildProbeRequest({
      providerType: 'openai',
      baseUrl: 'https://a.com/v1',
      apiKey: 'K',
      model: 'deepseek-chat',
    });
    expect(probe.url).toBe('https://a.com/v1/chat/completions');
    expect(probe.body.max_tokens).toBe(1);
    expect(probe.body.stream).toBeUndefined();
  });

  it('Anthropic 用最小 messages 请求', () => {
    const probe = buildProbeRequest({
      providerType: 'anthropic',
      baseUrl: 'https://a.com',
      apiKey: 'K',
      model: '',
    });
    expect(probe.url).toBe('https://a.com/v1/messages');
    expect(probe.body.max_tokens).toBe(1);
    // 没填模型时给一个可用的默认值，避免探针必然 400
    expect(probe.body.model).toBeTruthy();
  });
});
