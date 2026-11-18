/**
 * 角色卡导出服务测试（产品设计文档 3.2 的导出侧）。
 *
 * 这里测的是"从库里的角色 → 落到文件里的字节"这一段：格式分发、卡面图的取用、
 * 以及导不出时给的是**可读原因**而不是一张造出来的图。
 *
 * 系统保存对话框只能在 IPC 层，所以本文件测到"内容生成"为止；
 * `path` 与落盘由 `ipc/index.ts` 负责（那一层在 cd 冒烟里跑）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPngCardPayload } from '../src/core/png-card.js';
import { findLostFields, parseCharacterCard } from '../src/core/character-card.js';
import { createAppContext, type AppContext } from '../src/main/context.js';
import { importCharacterFromBytes } from '../src/main/services/character-import.js';
import {
  ExportError,
  exportCharacter,
  exportCharacterPng,
  prepareCharacterExport,
} from '../src/main/services/export.js';
import { updateCharacter } from '../src/main/db/dao/characters.js';
import { withExportExtension } from '../src/main/services/file-name.js';
import { openMigratedDb } from './helpers/db.js';
import { cardPng, listChunks, rawChunkOf, png, IHDR, IEND } from './helpers/png.js';

const NOW = 1_700_000_000_000;

/** 带第三方字段的 v2 卡：导出必须一个字段都不丢。 */
const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '林晚',
    description: '小镇旧书店的年轻店主。',
    personality: '安静',
    scenario: '雨天',
    first_mes: '外面雨挺大的。',
    tags: ['日常'],
    character_book: { entries: [{ keys: ['雨'], content: '雨天不开门。' }] },
  },
};

/** 纯数据卡（模拟"只用 JSON 导入过"的角色，没有卡面图）。 */
const JSON_ONLY_CARD = { spec: 'chara_card_v2', data: { name: '老周', description: '修表铺老板。' } };

let db: ReturnType<typeof openMigratedDb>;
let userData: string;
let ctx: AppContext;

beforeEach(() => {
  db = openMigratedDb();
  userData = mkdtempSync(path.join(tmpdir(), 'cottage-export-'));
  ctx = createAppContext(db, path.join(userData, 'cottage.db'), userData);
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  db.close();
});

/** 导入一张带卡面图的 PNG 卡，返回角色。 */
async function importPngCard() {
  const result = await importCharacterFromBytes(
    db,
    userData,
    cardPng(CARD),
    'lin-wan.png',
    NOW,
  );
  return result.character;
}

describe('JSON 导出', () => {
  it('返回卡对象本身，不含额外字节', async () => {
    const character = await importPngCard();
    const prepared = await prepareCharacterExport(ctx, character.id, 'json');
    expect(prepared.bytes).toBeNull();
    expect(prepared.card['spec']).toBe('chara_card_v2');
    expect((prepared.card['data'] as Record<string, unknown>)['name']).toBe('林晚');
  });

  it('库里改过的字段写回导出结果（不是原卡的旧值）', async () => {
    const character = await importPngCard();
    updateCharacter(db, character.id, { name: '林晚（改）', tags: ['日常', '治愈'] }, NOW + 1);

    const card = exportCharacter(ctx, character.id);
    const data = card['data'] as Record<string, unknown>;
    expect(data['name']).toBe('林晚（改）');
    expect(data['tags']).toEqual(['日常', '治愈']);
  });

  it('角色不存在时报 NOT_FOUND，两种格式一致', async () => {
    expect(() => exportCharacter(ctx, 'chr_missing')).toThrowError(ExportError);
    await expect(prepareCharacterExport(ctx, 'chr_missing', 'json')).rejects.toThrowError(/角色不存在/);
    await expect(prepareCharacterExport(ctx, 'chr_missing', 'png')).rejects.toThrowError(/角色不存在/);
  });
});

describe('PNG 导出', () => {
  it('产出的是能吃回去的 PNG 卡：导入 → 导出 → 再导入，数据一致', async () => {
    const character = await importPngCard();
    const { bytes, card } = await exportCharacterPng(ctx, character.id);

    expect(bytes.length).toBeGreaterThan(0);
    // 交给解析器：这就是"别人拿到这张卡"的路径
    const payload = extractPngCardPayload(bytes);
    expect(payload.keyword).toBe('chara');
    expect(parseCharacterCard(payload.json).name).toBe('林晚');

    // 再导入一次，库里拿到的就是导出的那份数据
    const reimported = await importCharacterFromBytes(db, userData, bytes, 'exported.png', NOW + 2);
    expect(reimported.savedAvatar).toBe(true);
    expect(reimported.character.name).toBe('林晚');
    expect(reimported.character.description).toBe(CARD.data.description);
    expect(reimported.character.tags).toEqual(CARD.data.tags);
    expect(card['spec']).toBe('chara_card_v2');
  });

  it('卡面图像素与其它元数据没被动过，且块 CRC 全部正确', async () => {
    const character = await importPngCard();
    const source = readFileSync(path.join(userData, character.avatarPath!));
    const { bytes } = await exportCharacterPng(ctx, character.id);

    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      expect(Array.from(rawChunkOf(bytes, type)!)).toEqual(Array.from(rawChunkOf(source, type)!));
    }
    expect(listChunks(bytes).every((c) => c.crcOk)).toBe(true);
    // 块数不变：旧的角色卡文本块被换成新的那一个，而不是再多留一个
    expect(listChunks(bytes).length).toBe(listChunks(source).length);
    expect(listChunks(bytes).filter((c) => c.keyword === 'chara')).toHaveLength(1);
  });

  it('卡里的第三方字段在 PNG 形态下同样无损', async () => {
    const character = await importPngCard();
    const { bytes } = await exportCharacterPng(ctx, character.id);

    const raw = parseCharacterCard(CARD).rawJson;
    const exported = JSON.parse(extractPngCardPayload(bytes).json) as Record<string, unknown>;
    expect(findLostFields(raw, exported)).toEqual([]);
    const data = exported['data'] as Record<string, unknown>;
    expect(data['character_book']).toEqual(CARD.data.character_book);
  });

  it('v3 卡导出成 ccv3 关键词', async () => {
    const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '爱丽丝', tags: [] } };
    const result = await importCharacterFromBytes(db, userData, cardPng(v3, 'ccv3'), 'v3.png', NOW);
    const { bytes } = await exportCharacterPng(ctx, result.character.id);
    expect(extractPngCardPayload(bytes).keyword).toBe('ccv3');
  });

  it('没有卡面图的角色：明确报错，且不造一张图出来', async () => {
    const result = await importCharacterFromBytes(
      db,
      userData,
      new TextEncoder().encode(JSON.stringify(JSON_ONLY_CARD)),
      'lao-zhou.json',
      NOW,
    );
    expect(result.character.avatarPath).toBeNull();

    await expect(exportCharacterPng(ctx, result.character.id)).rejects.toThrowError(/没有卡面图/);
    // 同一个角色导 JSON 仍然正常——这是给用户的出路，不能在错误信息里堵死
    expect((exportCharacter(ctx, result.character.id)['data'] as Record<string, unknown>)['name']).toBe('老周');
  });

  it('卡面图文件被删掉后报"已丢失"，而不是抛底层 ENOENT', async () => {
    const character = await importPngCard();
    unlinkSync(path.join(userData, character.avatarPath!));

    await expect(exportCharacterPng(ctx, character.id)).rejects.toThrowError(/丢失/);
  });

  it('卡面图不是 PNG（例如 jpg）时拒绝写回，不产出坏文件', async () => {
    const character = await importPngCard();
    // 造一个扩展名在白名单里、内容却不是 PNG 的头像
    const jpgPath = path.join(userData, 'avatars', 'not-a-png.jpg');
    writeFileSync(jpgPath, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    updateCharacter(db, character.id, { avatarPath: 'avatars/not-a-png.jpg' }, NOW + 3);

    await expect(exportCharacterPng(ctx, character.id)).rejects.toThrowError(/不是 PNG/);
  });

  it('普通图片（没有角色卡文本块）也能被写成一张卡', async () => {
    // 头像目录里放一张没有任何文本块的 PNG，再把角色指向它
    const character = await importPngCard();
    const plain = png(IHDR, IEND);
    writeFileSync(path.join(userData, 'avatars', 'plain.png'), plain);
    updateCharacter(db, character.id, { avatarPath: 'avatars/plain.png' }, NOW + 4);

    const { bytes } = await exportCharacterPng(ctx, character.id);
    expect(parseCharacterCard(extractPngCardPayload(bytes).json).name).toBe('林晚');
  });

  it('头像路径越界时按"丢失"处理，不读 userData 之外的文件', async () => {
    const character = await importPngCard();
    updateCharacter(db, character.id, { avatarPath: 'avatars/../../secret.png' }, NOW + 5);

    await expect(exportCharacterPng(ctx, character.id)).rejects.toThrowError(ExportError);
    expect(existsSync(path.join(userData, 'secret.png'))).toBe(false);
  });
});

describe('导出文件名补扩展名', () => {
  it('缺扩展名时补上', () => {
    expect(withExportExtension(path.join('D:', 'cards', '林晚'), 'png')).toMatch(/林晚\.png$/);
    expect(withExportExtension(path.join('D:', 'cards', '林晚'), 'json')).toMatch(/林晚\.json$/);
  });

  it('用户明确写了扩展名就尊重他，不硬改', () => {
    expect(withExportExtension('D:\\cards\\林晚.txt', 'png')).toBe('D:\\cards\\林晚.txt');
    expect(withExportExtension('D:\\cards\\林晚.JSON', 'json')).toBe('D:\\cards\\林晚.JSON');
  });
});
