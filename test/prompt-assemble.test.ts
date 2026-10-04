/**
 * Prompt 组装测试（产品设计文档 7 验收项 3，技术方案不变量 I3）。
 *
 * 验收原文："同一会话状态两次组装的 `PromptSpec` 完全一致（纯函数性）。"
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../src/core/errors.js';
import { assemblePrompt, groupSegments, parseExampleDialogue } from '../src/core/prompt/assemble.js';
import { collectVariableNames, replaceVariables } from '../src/core/prompt/variables.js';
import type { AssembleInput, CharacterCard, PromptMessage } from '../src/core/types.js';

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: '爱丽丝',
    description: '钟表店学徒。',
    personality: '话不多。',
    scenario: '雨后的石板街。',
    firstMes: '「齿轮被换过。」',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    ...overrides,
  };
}

function msg(sortOrder: number, role: 'user' | 'assistant', content: string, archived = false): PromptMessage {
  return { id: `m${sortOrder}`, role, content, archived, sortOrder };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    character: card(),
    persona: { name: 'ASMobbin' },
    summaries: [],
    messages: [],
    userInput: '委托人是谁？',
    nowMs: NOW,
    timezoneOffsetMinutes: 480,
    ...overrides,
  };
}

describe('变量替换', () => {
  it('替换 {{char}} / {{user}} / {{time}} / {{date}} / {{weekday}}', () => {
    const ctx = { char: '爱丽丝', user: 'ASMobbin', nowMs: NOW, timezoneOffsetMinutes: 480 };
    // 2023-11-15 是星期三
    expect(replaceVariables('{{char}} 对 {{user}} 说', ctx)).toBe('爱丽丝 对 ASMobbin 说');
    expect(replaceVariables('{{time}}', ctx)).toBe('06:13');
    expect(replaceVariables('{{date}}', ctx)).toBe('2023-11-15');
    expect(replaceVariables('{{weekday}}', ctx)).toBe('三');
  });

  it('容错：大小写、多余空格都能识别', () => {
    const ctx = { char: 'A', user: 'B', nowMs: NOW, timezoneOffsetMinutes: 0 };
    expect(replaceVariables('{{ CHAR }} {{User}}', ctx)).toBe('A B');
  });

  it('未知变量原样保留（静默删除会让角色卡悄悄失效）', () => {
    const ctx = { char: 'A', user: 'B', nowMs: NOW, timezoneOffsetMinutes: 0 };
    expect(replaceVariables('{{random}} 和 {{getvar:x}}', ctx)).toBe('{{random}} 和 {{getvar:x}}');
  });

  it('时区偏移影响 date/time（证明时间确实来自入参）', () => {
    const base = { char: 'A', user: 'B', nowMs: NOW };
    expect(replaceVariables('{{date}} {{time}}', { ...base, timezoneOffsetMinutes: 0 })).toBe(
      '2023-11-14 22:13',
    );
    expect(replaceVariables('{{date}} {{time}}', { ...base, timezoneOffsetMinutes: 480 })).toBe(
      '2023-11-15 06:13',
    );
  });

  it('纯函数：同输入同输出', () => {
    const ctx = { char: 'A', user: 'B', nowMs: NOW, timezoneOffsetMinutes: 60 };
    const text = '{{char}}/{{user}}/{{time}}';
    expect(replaceVariables(text, ctx)).toBe(replaceVariables(text, ctx));
  });

  it('collectVariableNames 去重并保序', () => {
    expect(collectVariableNames('{{user}} 问 {{char}}，{{user}} 又问 {{unknown}}')).toEqual([
      'user',
      'char',
      'unknown',
    ]);
  });
});

describe('mes_example 解析', () => {
  it('按 <START> 与 {{user}}/{{char}} 标记切成成对示例', () => {
    const parsed = parseExampleDialogue(
      '<START>\n{{user}}: 委托人是谁？\n{{char}}: 现在不能说。\n<START>\n{{user}}: 走吧。\n{{char}}: 手灯给我。',
    );
    expect(parsed).toEqual([
      { role: 'user', content: '委托人是谁？' },
      { role: 'assistant', content: '现在不能说。' },
      { role: 'user', content: '走吧。' },
      { role: 'assistant', content: '手灯给我。' },
    ]);
  });

  it('多行回复并入同一条消息', () => {
    const parsed = parseExampleDialogue('{{char}}: 第一行\n第二行\n{{user}}: 嗯');
    expect(parsed[0]).toEqual({ role: 'assistant', content: '第一行\n第二行' });
  });

  it('中文冒号也能识别', () => {
    expect(parseExampleDialogue('{{user}}：你好')).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('解析不出成对结构时返回空数组（不猜）', () => {
    expect(parseExampleDialogue('这是一段没有标记的自由文本。')).toEqual([]);
    expect(parseExampleDialogue('')).toEqual([]);
  });
});

describe('PromptSpec 组装顺序（产品设计文档 3.3）', () => {
  it('按 system → few-shot → 摘要 → 历史 → post_history → user 排列', () => {
    const spec = assemblePrompt(
      input({
        character: card({
          systemPrompt: '你扮演爱丽丝。',
          mesExample: '{{user}}: 早\n{{char}}: 早。',
          postHistoryInstructions: '保持简短。',
        }),
        summaries: [
          { id: 's1', content: '摘要 A', coversFrom: 1, coversTo: 2, tokenCount: 10, level: 1 },
        ],
        messages: [msg(1, 'user', '历史一', true), msg(2, 'assistant', '历史二', true), msg(3, 'user', '历史三')],
      }),
    );

    expect(spec.segments.map((s) => s.kind)).toEqual([
      'system',
      'fewShot',
      'fewShot',
      'summary',
      'history',
      'postHistory',
      'user',
    ]);
  });

  it('system_prompt 为空时用 描述/性格/场景 拼接', () => {
    const spec = assemblePrompt(input());
    const system = spec.segments.find((s) => s.kind === 'system')!;
    expect(system.text).toContain('角色描述：钟表店学徒。');
    expect(system.text).toContain('性格：话不多。');
    expect(system.text).toContain('场景：雨后的石板街。');
  });

  it('system_prompt 非空时优先，不再拼接描述', () => {
    const spec = assemblePrompt(input({ character: card({ systemPrompt: '只有这一句。' }) }));
    expect(spec.segments.find((s) => s.kind === 'system')!.text).toBe('只有这一句。');
  });

  it('归档消息不进入历史，但计入 archivedCount', () => {
    const spec = assemblePrompt(
      input({
        messages: [msg(1, 'user', '已归档', true), msg(2, 'user', '保留一'), msg(3, 'assistant', '保留二')],
      }),
    );
    const history = spec.segments.filter((s) => s.kind === 'history');
    expect(history.map((s) => s.text)).toEqual(['保留一', '保留二']);
    expect(spec.meta.historyCount).toBe(2);
    expect(spec.meta.archivedCount).toBe(1);
  });

  it('摘要按覆盖区间升序排列（与传入顺序无关）', () => {
    const spec = assemblePrompt(
      input({
        summaries: [
          { id: 's2', content: '后面的', coversFrom: 16, coversTo: 34, tokenCount: 10, level: 1 },
          { id: 's1', content: '前面的', coversFrom: 3, coversTo: 15, tokenCount: 10, level: 1 },
        ],
      }),
    );
    const summaries = spec.segments.filter((s) => s.kind === 'summary');
    expect(summaries.map((s) => s.text)).toEqual(['前面的', '后面的']);
    expect(summaries[0]!.coversFrom).toBe(3);
    expect(summaries[0]!.coversTo).toBe(15);
  });

  it('历史按 sort_order 排序，即使传入顺序是乱的', () => {
    const spec = assemblePrompt(
      input({
        messages: [msg(3, 'assistant', '第三'), msg(1, 'user', '第一'), msg(2, 'assistant', '第二')],
      }),
    );
    expect(spec.segments.filter((s) => s.kind === 'history').map((s) => s.text)).toEqual([
      '第一',
      '第二',
      '第三',
    ]);
  });

  it('空文本分段不产生记录（token 明细里没有 0 值噪音）', () => {
    const spec = assemblePrompt(input({ character: card({ systemPrompt: '', description: '', personality: '', scenario: '' }) }));
    expect(spec.segments.some((s) => s.kind === 'system')).toBe(false);
  });

  it('userInput 为空时（预览态）不产生 user 分段', () => {
    const spec = assemblePrompt(input({ userInput: '' }));
    expect(spec.segments.some((s) => s.kind === 'user')).toBe(false);
  });

  it('完全没有内容可发时抛出 EMPTY_ASSEMBLY，而不是静默发空请求', () => {
    expect(() =>
      assemblePrompt(
        input({ character: card({ description: '', personality: '', scenario: '', systemPrompt: '' }), userInput: '' }),
      ),
    ).toThrow(CoreError);
  });

  it('变量替换在组装阶段统一执行，覆盖角色卡与用户输入', () => {
    const spec = assemblePrompt(
      input({
        character: card({ systemPrompt: '你扮演 {{char}}。', firstMes: '' }),
        persona: { name: '小明' },
        userInput: '{{user}} 想问 {{char}} 一个问题',
      }),
    );
    expect(spec.segments.find((s) => s.kind === 'system')!.text).toBe('你扮演 爱丽丝。');
    expect(spec.segments.find((s) => s.kind === 'user')!.text).toBe('小明 想问 爱丽丝 一个问题');
    expect(spec.meta.userName).toBe('小明');
  });
});

describe('纯函数性（验收项 3）', () => {
  const rich = input({
    character: card({
      systemPrompt: '你扮演 {{char}}。',
      mesExample: '<START>\n{{user}}: 早\n{{char}}: 早。',
      postHistoryInstructions: '保持 {{user}} 的视角。',
    }),
    summaries: [{ id: 's1', content: '摘要 {{char}} 与 {{user}}', coversFrom: 1, coversTo: 2, tokenCount: 9, level: 1 }],
    messages: [msg(1, 'user', '一', true), msg(2, 'assistant', '二', true), msg(3, 'user', '三')],
  });

  it('两次组装结果深度相等', () => {
    expect(assemblePrompt(rich)).toEqual(assemblePrompt(rich));
  });

  it('序列化后也完全一致（不含 Date / 随机数 / 引用）', () => {
    expect(JSON.stringify(assemblePrompt(rich))).toBe(JSON.stringify(assemblePrompt(rich)));
  });

  it('不修改入参对象（组装是只读的）', () => {
    const snapshot = JSON.stringify(rich);
    assemblePrompt(rich);
    expect(JSON.stringify(rich)).toBe(snapshot);
  });

  it('改变入参的 nowMs 会改变输出（证明确实只依赖入参，而不是内部读时钟）', () => {
    const a = assemblePrompt(input({ character: card({ systemPrompt: '现在是 {{time}}' }) }));
    const b = assemblePrompt(
      input({ character: card({ systemPrompt: '现在是 {{time}}' }), nowMs: NOW + 3 * 3600_000 }),
    );
    expect(a.segments[0]!.text).not.toBe(b.segments[0]!.text);
  });
});

describe('groupSegments（UI 预览角度）', () => {
  it('按六类归组并统计条目数，空类不出现', () => {
    const spec = assemblePrompt(
      input({
        character: card({ mesExample: '{{user}}: 早\n{{char}}: 早。' }),
        summaries: [{ id: 's1', content: 'S', coversFrom: 1, coversTo: 2, tokenCount: 5, level: 1 }],
        messages: [msg(1, 'user', '一'), msg(2, 'assistant', '二')],
      }),
    );
    const groups = groupSegments(spec);
    expect(groups.map((g) => g.kind)).toEqual(['system', 'fewShot', 'summary', 'history', 'user']);
    expect(groups.find((g) => g.kind === 'fewShot')!.itemCount).toBe(2);
    expect(groups.find((g) => g.kind === 'history')!.itemCount).toBe(2);
    // 中文标签给 UI 直接用
    expect(groups.find((g) => g.kind === 'user')!.label).toBe('本次输入');
  });
});
