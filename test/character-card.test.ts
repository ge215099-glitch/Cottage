/**
 * 角色卡导入 / 导出测试（产品设计文档 7 验收项 1）。
 *
 * 验收原文：
 *   "一张 v3 角色卡导入后导出，除 Cottage 管理的字段外，其他字段与 `raw_json` 完全一致。"
 */
import { describe, expect, it } from 'vitest';
import {
  CharacterCardError,
  exportCharacterCard,
  findLostFields,
  parseCharacterCard,
} from '../src/core/character-card.js';

/** 一张带大量第三方字段的 v3 卡，用来验证"不丢字段"。 */
const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '爱丽丝',
    description: '白天是镇上钟表店的学徒，夜里替一位不肯露面的委托人抄写旧报纸。',
    personality: '话不多，但对时间异常敏感。',
    scenario: '雨后的石板街，报纸还剩三份未送。',
    first_mes: '「齿轮不是坏了，是被人换过。」',
    alternate_greetings: ['「你来晚了十一分钟。」', '「今天不出门。」'],
    mes_example: '<START>\n{{user}}: 委托人是谁？\n{{char}}: 现在不能说。\n<START>\n{{user}}: 走吧。\n{{char}}: 手灯给我。',
    system_prompt: '你扮演爱丽丝，语气克制、观察细致。',
    post_history_instructions: '保持简短，不要解释自己的设定。',
    tags: ['奇幻', '冒险'],
    creator_notes: '第三方字段：创作者笔记',
    character_version: '1.4',
    // 第三方扩展命名空间，必须原样保留
    extensions: {
      第三方插件: { 配置: [1, 2, 3], 开关: true },
      depth_prompt: { prompt: '深层提示', depth: 4, role: 'system' },
    },
    character_book: {
      name: '世界书',
      entries: [{ keys: ['钟表'], content: '钟表店在旧城石板街。' }],
    },
  },
  // 顶层第三方字段也必须保留
  cottage_unknown_top_field: { some: 'value' },
  another_top: 'keep-me',
};

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '管家',
    description: '老宅的管家。',
    personality: '讲分寸。',
    scenario: '走廊很深。',
    first_mes: '「您比约定的时间早了十一分钟。」',
    alternate_greetings: [],
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['悬疑'],
    extensions: { talkativeness: '0.5' },
  },
};

const BARE_CARD = {
  name: '美嘉',
  description: '附近面包店的店主。',
  first_mes: '「二比一，别信食谱上写的三比一。」',
  tags: ['日常'],
};

describe('角色卡解析', () => {
  it('识别 v3 卡并读出全部 Cottage 管理字段', () => {
    const card = parseCharacterCard(V3_CARD);
    expect(card.specVersion).toBe('v3');
    expect(card.name).toBe('爱丽丝');
    expect(card.alternateGreetings).toHaveLength(2);
    expect(card.tags).toEqual(['奇幻', '冒险']);
    expect(card.postHistoryInstructions).toContain('保持简短');
  });

  it('识别 v2 卡', () => {
    expect(parseCharacterCard(V2_CARD).specVersion).toBe('v2');
  });

  it('接受裸卡（字段直接在顶层）', () => {
    const card = parseCharacterCard(BARE_CARD);
    expect(card.specVersion).toBe('unknown');
    expect(card.name).toBe('美嘉');
  });

  it('接受 JSON 字符串输入', () => {
    expect(parseCharacterCard(JSON.stringify(V3_CARD)).name).toBe('爱丽丝');
  });

  it('记下原卡里 Cottage 不管理的字段，供 UI 提示', () => {
    const card = parseCharacterCard(V3_CARD);
    expect(card.preservedFields).toContain('cottage_unknown_top_field');
    expect(card.preservedFields).toContain('another_top');
    expect(card.preservedFields).toContain('data.creator_notes');
    expect(card.preservedFields).toContain('data.character_book');
  });

  it('raw_json 是深拷贝，改它不会污染入参', () => {
    const input = structuredClone(V3_CARD);
    const card = parseCharacterCard(input);
    (card.rawJson.data as Record<string, unknown>).name = '改过了';
    expect((input.data as Record<string, unknown>).name).toBe('爱丽丝');
  });

  it('缺少 name 时抛出可识别的错误', () => {
    expect(() => parseCharacterCard({ description: 'x' })).toThrow(CharacterCardError);
    try {
      parseCharacterCard({ description: 'x' });
    } catch (err) {
      expect((err as CharacterCardError).reason).toBe('missing-name');
    }
  });

  it('非法 JSON 文本与非法结构都被拒绝', () => {
    expect(() => parseCharacterCard('{ not json')).toThrow(/合法的 JSON/);
    expect(() => parseCharacterCard([1, 2])).toThrow(/必须是一个 JSON 对象/);
  });

  it('alternate_greetings 是字符串时按单元素数组处理', () => {
    const card = parseCharacterCard({ name: 'x', alternate_greetings: '只有一条' });
    expect(card.alternateGreetings).toEqual(['只有一条']);
  });
});

describe('角色卡导出：验收项 1（无损 round-trip）', () => {
  it('v3 卡导入后原样导出，第三方字段一个不丢', () => {
    const card = parseCharacterCard(V3_CARD);
    const exported = exportCharacterCard(card.rawJson, {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      alternateGreetings: card.alternateGreetings,
      mesExample: card.mesExample,
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
      tags: card.tags,
    });

    expect(findLostFields(card.rawJson, exported)).toEqual([]);
    // 关键第三方字段逐个点名，避免 findLostFields 自身有洞时假通过
    expect(exported.cottage_unknown_top_field).toEqual({ some: 'value' });
    expect(exported.another_top).toBe('keep-me');
    expect(exported.spec).toBe('chara_card_v3');
    const data = exported.data as Record<string, unknown>;
    expect(data.creator_notes).toBe('第三方字段：创作者笔记');
    expect(data.character_version).toBe('1.4');
    expect(data.character_book).toEqual(V3_CARD.data.character_book);
    expect(data.extensions).toEqual(V3_CARD.data.extensions);
  });

  it('字段没改过时，导出结果与原卡深度相等', () => {
    const card = parseCharacterCard(V3_CARD);
    const exported = exportCharacterCard(card.rawJson, {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      alternateGreetings: card.alternateGreetings,
      mesExample: card.mesExample,
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
      tags: card.tags,
    });
    expect(exported).toEqual(V3_CARD);
  });

  it('改过的字段被写回，未涉及的第三方字段不受影响', () => {
    const card = parseCharacterCard(V3_CARD);
    const exported = exportCharacterCard(card.rawJson, {
      name: '爱丽丝（改）',
      description: '新的描述',
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      alternateGreetings: ['新开场白'],
      mesExample: card.mesExample,
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
      tags: ['奇幻'],
    });
    const data = exported.data as Record<string, unknown>;
    expect(data.name).toBe('爱丽丝（改）');
    expect(data.description).toBe('新的描述');
    expect(data.alternate_greetings).toEqual(['新开场白']);
    expect(findLostFields(card.rawJson, exported)).toEqual([]);
  });

  it('自定义头像内联到 extensions.cottage，不覆盖第三方扩展', () => {
    const card = parseCharacterCard(V3_CARD);
    const exported = exportCharacterCard(
      card.rawJson,
      {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        firstMes: card.firstMes,
        alternateGreetings: card.alternateGreetings,
        mesExample: card.mesExample,
        systemPrompt: card.systemPrompt,
        postHistoryInstructions: card.postHistoryInstructions,
        tags: card.tags,
      },
      { avatar: 'avatars/alice.png' },
    );
    const ext = (exported.data as Record<string, unknown>).extensions as Record<string, unknown>;
    expect(ext.cottage).toEqual({ avatar: 'avatars/alice.png' });
    // 第三方命名空间仍在
    expect(ext.第三方插件).toEqual(V3_CARD.data.extensions.第三方插件);
    expect(findLostFields(card.rawJson, exported)).toEqual([]);
  });

  it('裸卡导出后仍是裸卡结构，不强行套上 spec/data', () => {
    const card = parseCharacterCard(BARE_CARD);
    const exported = exportCharacterCard(card.rawJson, {
      name: card.name,
      description: card.description,
      personality: '',
      scenario: '',
      firstMes: card.firstMes,
      alternateGreetings: [],
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: card.tags,
    });
    expect(exported.name).toBe('美嘉');
    expect(exported.data).toBeUndefined();
  });

  it('v2 卡导出后 spec 仍是 v2，不被改写成 v3', () => {
    const card = parseCharacterCard(V2_CARD);
    const exported = exportCharacterCard(card.rawJson, {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      alternateGreetings: [],
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: card.tags,
    });
    expect(exported.spec).toBe('chara_card_v2');
    expect(findLostFields(card.rawJson, exported)).toEqual([]);
  });

  it('findLostFields 本身有效：删掉字段必须被检出', () => {
    const card = parseCharacterCard(V3_CARD);
    const broken = structuredClone(V3_CARD) as Record<string, unknown>;
    delete broken.another_top;
    expect(findLostFields(card.rawJson, broken)).toContain('another_top');

    const nested = structuredClone(V3_CARD) as Record<string, unknown>;
    delete (nested.data as Record<string, unknown>).character_book;
    expect(findLostFields(card.rawJson, nested)).toContain('data.character_book');
  });
});
