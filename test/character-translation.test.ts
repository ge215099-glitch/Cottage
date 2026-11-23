import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationInput } from '../src/shared/character-translation.js';
import { parseExampleDialogue } from '../src/core/prompt/assemble.js';
import { exportCharacter, getCharacter, importCharacter, listCharacters, updateCharacter } from '../src/main/db/dao/characters.js';
import { createConversation } from '../src/main/db/dao/conversations.js';
import { createProvider } from '../src/main/db/dao/providers.js';
import { CharacterTranslationService } from '../src/main/services/character-translation.js';
import { assembleForConversation } from '../src/main/services/assemble.js';
import type { TranslationUnit } from '../src/core/character-translation.js';
import { openMigratedDb } from './helpers/db.js';

vi.mock('../src/main/secrets/index.js', () => ({
  decryptSecret: async () => ({ plain: 'test-key', shouldReEncrypt: false }),
}));

const RAW_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Robin',
    description: 'Robin lives near North Gate.',
    personality: 'Patient and curious.',
    scenario: 'You meet in the garden.',
    first_mes: 'You found the key. Now we can open North Gate, {{user}}.',
    alternate_greetings: ['Come along. Robin leads the way.', 'Are you ready? Follow me.'],
    mes_example: '<START>\n{{user}}: I found the key.\n{{char}}: Well done, {{user}}! Let us go.\n<START>\n{{user}}: Where are we going?\n{{char}}: Follow me.',
    system_prompt: 'Stay in character as {{char}}.',
    post_history_instructions: 'Keep the replies brief.',
    tags: ['fantasy'],
    character_book: { entries: [{ keys: ['North Gate'], content: 'A garden gate.' }] },
    extensions: { example: { version: 1 } },
  },
};

function translate(units: TranslationUnit[]) {
  return units.map(({ id, text, targets }) => ({
    id,
    ...(targets.includes('zh') ? { zh: `我们找到钥匙了。${(text.match(/__COTTAGE_\d+__/g) ?? []).join(' ')}` } : {}),
    ...(targets.includes('en') ? { en: `We found the key. ${(text.match(/__COTTAGE_\d+__/g) ?? []).join(' ')}` } : {}),
  }));
}

describe('角色卡转换工作流', () => {
  let db: ReturnType<typeof openMigratedDb>;
  let sourceId: string;
  let input: TranslationInput;
  let makeTranslator: ReturnType<typeof vi.fn<() => Promise<typeof translate>>>;
  let service: CharacterTranslationService;

  beforeEach(() => {
    db = openMigratedDb();
    sourceId = importCharacter(db, RAW_CARD, 1, 'avatars/original.png').character.id;
    input = { requestId: 'translation', characterId: sourceId, mode: 'bilingual', providerId: 'test', model: 'test', protectedTerms: ['North Gate'], confirmUncertain: false };
    makeTranslator = vi.fn(async () => translate);
    service = new CharacterTranslationService(db, makeTranslator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('中文卡和不确定的卡在选择模型前就被拦截', async () => {
    const chinese = importCharacter(db, { name: 'Robin', description: 'Robin 正在北门附近等你。', first_mes: '走吧，我们该出发了。' }, 1).character;
    const short = importCharacter(db, { name: 'Robin', description: 'Hello!' }, 1).character;
    const mixed = importCharacter(db, { name: 'Robin', description: '我们在花园碰面。', first_mes: 'I found the garden gate.' }, 1).character;
    for (const mode of ['zh', 'bilingual'] as const) {
      expect(await service.start({ ...input, mode, characterId: chinese.id })).toEqual({ status: 'already-zh' });
    }
    expect(await service.start({ ...input, characterId: short.id })).toEqual({ status: 'confirm-language' });
    expect(await service.start({ ...input, characterId: mixed.id })).toEqual({ status: 'confirm-language' });
    expect(makeTranslator).not.toHaveBeenCalled();
    expect(listCharacters(db)).toHaveLength(4);
    const confirmed = await service.start({ ...input, characterId: mixed.id, confirmUncertain: true });
    expect(confirmed.status === 'preview' && confirmed.fields.description).toBe('We found the key.\n我们在花园碰面。');
  });

  it('检查预览、双语开场与示例、独立保存及导入导出', async () => {
    const result = await service.start(input);
    expect(listCharacters(db)).toHaveLength(1);
    expect(result.status).toBe('preview');
    if (result.status !== 'preview') throw new Error('缺少预览');
    expect(result.fields.firstMes).toBe('You found the key.\n我们找到钥匙了。\nNow we can open North Gate, {{user}}.\n我们找到钥匙了。North Gate {{user}}');
    expect(result.fields.alternateGreetings.map((text) => text.split('\n').length)).toEqual([4, 4]);
    expect(result.fields.mesExample.match(/<START>/g)).toHaveLength(2);
    const messages = parseExampleDialogue(result.fields.mesExample);
    expect(messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]?.content).toContain('Well done, {{user}}!\n我们找到钥匙了。{{user}}\nLet us go.');
    const saved = service.save(input.requestId, Date.now());
    expect(saved).toMatchObject({ name: 'Robin', avatarPath: 'avatars/original.png', languageMode: 'bilingual', tags: ['fantasy'] });
    expect(saved.id).not.toBe(sourceId);
    expect(getCharacter(db, sourceId)?.firstMes).toBe(RAW_CARD.data.first_mes);
    expect(() => service.save(input.requestId, Date.now())).toThrow('预览已失效');
    const exported = exportCharacter(db, saved.id);
    expect(exported).toMatchObject({ data: { character_book: RAW_CARD.data.character_book, extensions: { ...RAW_CARD.data.extensions, cottage: { languageMode: 'bilingual' } } } });
    const reimported = importCharacter(db, exported, 2).character;
    expect(reimported.languageMode).toBe('bilingual');
    const conversation = createConversation(db, { title: 'Might we go?', characterId: saved.id, personaId: null, providerId: null, model: 'test' }, 2);
    const { spec } = assembleForConversation(db, conversation.id, 'Hello', 3);
    const replyInstructions = spec.segments.find(({ kind }) => kind === 'postHistory')?.text;
    expect(replyInstructions).toContain('以自然段为单位配对');
    expect(replyInstructions).toContain('每组之间恰好空一行');
    expect(replyInstructions).toContain('She stepped closer to the gate.\n灯笼忽明忽暗。她朝大门走近了些。\n\n“Are you coming?”');
    expect(spec.segments.find(({ kind }) => kind === 'fewShot')?.text).toContain('I found the key.\n我们找到钥匙了。');
  });

  it('中文版只输出中文正文并精确保留锁定词和变量', async () => {
    const result = await service.start({ ...input, mode: 'zh' });
    expect(result).toMatchObject({ status: 'preview', fields: { description: '我们找到钥匙了。Robin North Gate', systemPrompt: '我们找到钥匙了。{{char}}' } });
    const saved = service.save(input.requestId, Date.now());
    expect(saved.languageMode).toBe('zh');
    expect(await service.start({ ...input, characterId: saved.id })).toEqual({ status: 'already-zh' });
  });

  it('保留开场白中独立成行的地名，同时翻译相邻的短句', async () => {
    const card = importCharacter(db, {
      name: 'Yes, My Liege',
      first_mes: 'Florin.\n\nYour home.',
      mes_example: '<START>\n{{user}}: Who lives beyond Florin?\n{{char}}: A whole kingdom lives there.',
    }, 1).character;
    const translator = vi.fn((units: TranslationUnit[]) => translate(units).map((reply) =>
      units.find((unit) => unit.id === reply.id)?.text === 'Your home.' ? { ...reply, zh: '你的家。' } : reply));
    const localized = new CharacterTranslationService(db, async () => async (units) => translator(units));
    const result = await localized.start({ ...input, characterId: card.id, mode: 'zh' });
    expect(result).toMatchObject({ status: 'preview', fields: { firstMes: 'Florin.\n\n你的家。' } });
    expect(translator).toHaveBeenCalledOnce();
    const units = translator.mock.calls[0]![0];
    expect(units.filter((unit) => unit.field === '开场白').map((unit) => unit.text)).toEqual(['Your home.']);
    expect(units.some((unit) => unit.text.includes('Florin'))).toBe(false);
  });

  it('中文开场白返回英文时只重译出错片段', async () => {
    const card = importCharacter(db, {
      name: 'Robin',
      first_mes: 'You found the key.',
      alternate_greetings: Array.from({ length: 6 }, () => 'Robin leads the way. '.repeat(80)),
    }, 1).character;
    const translator = vi.fn(async (units: TranslationUnit[], _signal: AbortSignal, retry?: boolean) =>
      translate(units).map((reply, index) => units[index]?.field === '开场白' && !retry ? { ...reply, zh: 'You found the key.' } : reply));
    const localized = new CharacterTranslationService(db, async () => translator);
    const result = await localized.start({ ...input, characterId: card.id, mode: 'zh' });
    expect(result).toMatchObject({ status: 'preview', fields: { firstMes: '我们找到钥匙了。' } });
    const calls = translator.mock.calls;
    expect(calls[0]?.[0].map((unit) => unit.field)).toEqual([
      '开场白', '备用开场白 1', '备用开场白 2', '备用开场白 3', '备用开场白 4', '备用开场白 5', '备用开场白 6',
    ]);
    expect(calls[1]?.[0].map((unit) => unit.field)).toEqual(['开场白']);
    expect(calls[1]?.[2]).toBe(true);
    expect(translator).toHaveBeenCalledTimes(2);
  });

  it('同一段重译后仍然出错时结束转换', async () => {
    const card = importCharacter(db, {
      name: 'Robin',
      first_mes: 'You found the key.',
      alternate_greetings: Array.from({ length: 6 }, () => 'Robin leads the way. '.repeat(80)),
    }, 1).character;
    const translator = vi.fn(async (units: TranslationUnit[]) =>
      translate(units).map((reply, index) => units[index]?.field === '开场白' ? { ...reply, zh: 'You found the key.' } : reply));
    const localized = new CharacterTranslationService(db, async () => translator);
    await expect(localized.start({ ...input, characterId: card.id, mode: 'zh' })).rejects.toThrow('开场白：模型返回的译文语言不正确');
    expect(translator).toHaveBeenCalledTimes(2);
    expect(translator.mock.calls[1]?.[0]).toHaveLength(1);
    expect(() => localized.save(input.requestId, Date.now())).toThrow('预览已失效');
  });

  it.each([
    ['https://api.deepseek.com/v1', 393_216, 'stop'],
    ['https://api.deepseek.com/v1', 393_216, 'length'],
    ['https://example.invalid/v1', undefined, 'stop'],
  ] as const)('向 %s 一次发送整卡（输出上限 %s，结束原因 %s）', async (baseUrl, outputLimit, finishReason) => {
    const card = importCharacter(db, {
      name: 'Robin',
      alternate_greetings: Array.from({ length: 19 }, () => 'Look for the gate. '.repeat(110)),
    }, 1).character;
    const model = 'deepseek-v4-pro';
    const provider = createProvider(db, {
      name: '翻译测试', type: 'openai', baseUrl, defaultModel: model,
      models: [model], compressionModel: '', enabled: true,
    }, { apiKeyEnc: 'test-encrypted', now: 1 });
    const fetchModel = vi.fn(async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body));
      expect(Object.hasOwn(body, 'max_tokens')).toBe(outputLimit !== undefined);
      expect(body.max_tokens).toBe(outputLimit);
      expect(Object.hasOwn(body, 'thinking')).toBe(outputLimit !== undefined);
      expect(body.thinking).toEqual(outputLimit === undefined ? undefined : { type: 'disabled' });
      const units: TranslationUnit[] = JSON.parse(body.messages.at(-1).content);
      expect(units).toHaveLength(19);
      expect(units.reduce((length, unit) => length + unit.text.length, 0)).toBeGreaterThan(38_000);
      const content = finishReason === 'length' ? '[' : JSON.stringify(translate(units));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
    });
    vi.stubGlobal('fetch', fetchModel);

    const localized = new CharacterTranslationService(db);
    const result = localized.start({ ...input, characterId: card.id, providerId: provider.id, model, mode: 'zh' });
    if (finishReason === 'length') {
      await expect(result).rejects.toThrow('译文达到模型的输出上限');
      expect(() => localized.save(input.requestId, Date.now())).toThrow('预览已失效');
    } else {
      await expect(result).resolves.toMatchObject({ status: 'preview' });
    }
    expect(fetchModel).toHaveBeenCalledOnce();
  });

  it('模型遗漏锁定词时报告字段并拒绝写入', async () => {
    const invalid = new CharacterTranslationService(db, async () => async (units) => units.map(({ id }) => ({ id, zh: '钥匙。' })));
    await expect(invalid.start(input)).rejects.toThrow('简介：译文改动了锁定词或模板标记');
    expect(() => invalid.save(input.requestId, Date.now())).toThrow('预览已失效');
    expect(listCharacters(db)).toHaveLength(1);
  });

  it('可取消在途请求及丢弃预览，原卡变化后拒绝保存', async () => {
    let onStarted: () => void;
    const started = new Promise<void>((resolve) => { onStarted = resolve; });
    const slow = new CharacterTranslationService(db, async () => (_units, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      onStarted();
    }));
    const pending = slow.start(input);
    await started;
    expect(slow.cancel(input.requestId)).toBe(true);
    expect(await pending).toEqual({ status: 'cancelled' });
    await service.start(input);
    expect(service.cancel(input.requestId)).toBe(true);
    expect(() => service.save(input.requestId, Date.now())).toThrow('预览已失效');
    await service.start(input);
    updateCharacter(db, sourceId, { description: 'A completely different story.' }, 2);
    expect(() => service.save(input.requestId, Date.now())).toThrow('原角色卡已修改或删除');
    expect(listCharacters(db)).toHaveLength(1);
  });
});
