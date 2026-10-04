/**
 * 摘要模板与解析测试（产品设计文档 3.4）。
 */
import { describe, expect, it } from 'vitest';
import {
  SUMMARY_SECTIONS,
  buildSummaryPrompt,
  buildTranscript,
  parseSummary,
  summarizeBenefit,
} from '../src/core/summary/index.js';

const GOOD_REPLY = [
  '人物关系：{{user}} 与爱丽丝在钟表店相识。',
  '关键事件：主角替她修好了停摆的座钟。',
  '当前场景：雨后的石板街，报纸还剩三份。',
  '情绪与态度：她态度松动，但仍有提防。',
  '未回收伏笔：第三份报纸的收件人姓名被墨迹盖住。',
  '事实状态：时间凌晨；地点旧城石板街；持有物三份报纸、一盏手灯。',
].join('\n');

describe('摘要指令', () => {
  it('包含全部六个小标题，且顺序固定', () => {
    const prompt = buildSummaryPrompt({
      messageCount: 13,
      transcript: '爱丽丝：……',
      characterName: '爱丽丝',
      userName: 'ASMobbin',
    });
    let lastIndex = -1;
    for (const section of SUMMARY_SECTIONS) {
      const index = prompt.indexOf(`${section}：`);
      expect(index, `缺少小标题 ${section}`).toBeGreaterThan(-1);
      expect(index, `小标题 ${section} 顺序不对`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('点明条数、角色名与用户名，并禁止复述原文与编造', () => {
    const prompt = buildSummaryPrompt({
      messageCount: 13,
      transcript: 'T',
      characterName: '爱丽丝',
      userName: 'ASMobbin',
    });
    expect(prompt).toContain('13 条');
    expect(prompt).toContain('爱丽丝');
    expect(prompt).toContain('ASMobbin');
    expect(prompt).toContain('不要复述原文');
    expect(prompt).toContain('不要编造');
  });

  it('有前序摘要时把它写进指令，用来保持线索连续', () => {
    const prompt = buildSummaryPrompt({
      messageCount: 5,
      transcript: 'T',
      characterName: 'A',
      userName: 'U',
      previousSummary: '之前她把报纸送完了。',
    });
    expect(prompt).toContain('之前她把报纸送完了。');
    expect(prompt).toContain('前序摘要');
  });

  it('转写文本用"角色名：内容"的形式', () => {
    const prompt = buildSummaryPrompt({
      messageCount: 2,
      transcript: buildTranscript(
        [
          { role: 'assistant', content: '「你来了。」' },
          { role: 'user', content: '嗯。' },
        ],
        { characterName: '爱丽丝', userName: 'ASMobbin' },
      ),
      characterName: '爱丽丝',
      userName: 'ASMobbin',
    });
    expect(prompt).toContain('爱丽丝：「你来了。」');
    expect(prompt).toContain('ASMobbin：嗯。');
  });
});

describe('buildTranscript', () => {
  it('按传入顺序保留，角色名替换到位', () => {
    const transcript = buildTranscript(
      [
        { role: 'user', content: '一' },
        { role: 'assistant', content: '二' },
        { role: 'user', content: '三' },
      ],
      { characterName: 'C', userName: 'U' },
    );
    expect(transcript).toBe('U：一\n\nC：二\n\nU：三');
  });

  it('超预算时保留**最近**的内容（越靠后越决定接下来怎么演）', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `第${i + 1}条内容`,
    }));
    const transcript = buildTranscript(messages, { characterName: 'C', userName: 'U', maxChars: 60 });
    // 最后一条必须在
    expect(transcript).toContain('第20条内容');
    // 最早那条必须被丢掉
    expect(transcript).not.toContain('第1条内容');
  });

  it('空数组返回空串', () => {
    expect(buildTranscript([], { characterName: 'C', userName: 'U' })).toBe('');
  });
});

describe('parseSummary', () => {
  it('解析出全部六段并标记 structured', () => {
    const parsed = parseSummary(GOOD_REPLY);
    expect(parsed.structured).toBe(true);
    expect(Object.keys(parsed.sections)).toHaveLength(6);
    expect(parsed.sections.人物关系).toContain('钟表店相识');
    expect(parsed.sections.事实状态).toContain('手灯');
    expect(parsed.text).toBe(GOOD_REPLY);
  });

  it('容忍 Markdown 前缀与中文/英文冒号', () => {
    const text = [
      '## 人物关系: 甲与乙',
      '- **关键事件**：发生了某件事',
      '1. 当前场景：某个地方',
    ].join('\n');
    const parsed = parseSummary(text);
    expect(parsed.sections.人物关系).toBe('甲与乙');
    expect(parsed.sections.关键事件).toBe('发生了某件事');
    expect(parsed.sections.当前场景).toBe('某个地方');
  });

  it('多行内容并入同一个小标题', () => {
    const parsed = parseSummary('人物关系：第一行\n第二行\n\n关键事件：别的事');
    expect(parsed.sections.人物关系).toBe('第一行\n第二行');
    expect(parsed.sections.关键事件).toBe('别的事');
  });

  it('只写"无"的小标题被丢掉（避免 UI 里堆一排"无"）', () => {
    const parsed = parseSummary('人物关系：无\n关键事件：真的发生了事\n当前场景：N/A\n情绪与态度：—');
    expect(parsed.sections.人物关系).toBeUndefined();
    expect(parsed.sections.当前场景).toBeUndefined();
    expect(parsed.sections.情绪与态度).toBeUndefined();
    expect(parsed.sections.关键事件).toBe('真的发生了事');
  });

  it('模型不按格式回答时退回整段正文，不抛异常', () => {
    const prose = '这段剧情里，爱丽丝和主角把报纸送完了，但最后一个收件人的名字还没解开。';
    const parsed = parseSummary(prose);
    expect(parsed.structured).toBe(false);
    expect(parsed.sections).toEqual({});
    expect(parsed.text).toBe(prose);
  });

  it('空输入得到空结果而不是崩溃', () => {
    const parsed = parseSummary('');
    expect(parsed.structured).toBe(false);
    expect(parsed.text).toBe('');
  });
});

describe('压缩收益文案', () => {
  it('给出前后对比与节省百分比（UI 要求播报具体数字）', () => {
    expect(summarizeBenefit(1200, 180)).toBe('1,200 → 180 tokens（省 85%）');
  });

  it('没有节省时不出现负百分比', () => {
    expect(summarizeBenefit(100, 120)).toBe('100 → 120 tokens（省 0%）');
  });

  it('before 为 0 时不出现 NaN', () => {
    expect(summarizeBenefit(0, 0)).toBe('0 → 0 tokens（省 0%）');
  });
});
