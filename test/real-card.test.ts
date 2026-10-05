/**
 * 对**真实** PNG 角色卡的验证（默认跳过，CI 上不会因为缺文件而失败）。
 *
 * 合成样本能覆盖各种坏情况，却覆盖不了"真实工具写出来的卡长什么样"：
 * 实测那张 v2 卡（768×1376、969KB）里就有**两个** `chara` 文本块，
 * 这是我写合成样本时根本想不到的结构。所以留一个入口，让真卡随时能被验一遍：
 *
 * ```
 * COTTAGE_REAL_CARD="D:\Downloads\某张卡.png" pnpm exec vitest run test/real-card.test.ts
 * ```
 *
 * 这样仓库里不必存第三方卡（近 1MB，且不是我们的内容），
 * 但"用真卡验过"这件事仍然可复现。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPngCardPayload } from '../src/core/png-card.js';
import { parseCharacterCard } from '../src/core/character-card.js';
import { importCharacterFromFile } from '../src/main/services/character-import.js';
import { openMigratedDb } from './helpers/db.js';

const realCardPath = process.env['COTTAGE_REAL_CARD'] ?? '';
const describeReal = realCardPath && existsSync(realCardPath) ? describe : describe.skip;

describeReal('真实 PNG 角色卡', () => {
  it('能从真卡里取出 JSON 并解析出角色', () => {
    const bytes = new Uint8Array(readFileSync(realCardPath));
    const payload = extractPngCardPayload(bytes);
    const card = parseCharacterCard(payload.json);

    expect(payload.keyword).toMatch(/^(chara|ccv3)$/);
    expect(card.name.length).toBeGreaterThan(0);
    expect(['v2', 'v3', 'unknown']).toContain(card.specVersion);
    // 有开场白才算一张能用的卡，否则导进去是个空壳
    expect(card.firstMes.length).toBeGreaterThan(0);

    console.log(
      `  真卡：keyword=${payload.keyword} spec=${card.specVersion} name=${card.name} ` +
        `tags=${card.tags.length} 保留字段=${JSON.stringify(card.preservedFields)}`,
    );
  });

  it('重复的文本块不会让解析失败（真卡里有两个 chara）', () => {
    const bytes = new Uint8Array(readFileSync(realCardPath));
    expect(() => extractPngCardPayload(bytes)).not.toThrow();
  });
});

describeReal('用真卡走一遍导入链路', () => {
  it('导入真实 PNG 卡：库里有角色，头像文件落盘且内容与源文件一致', async () => {
    const db = openMigratedDb();
    const userData = mkdtempSync(path.join(tmpdir(), 'cottage-real-import-'));
    try {
      const bytes = new Uint8Array(readFileSync(realCardPath));
      const expected = parseCharacterCard(extractPngCardPayload(bytes).json);

      const result = await importCharacterFromFile(db, userData, realCardPath, 1_700_000_000_000);

      expect(result.savedAvatar).toBe(true);
      expect(result.character.name).toBe(expected.name);
      expect(result.character.avatarPath).toBe(`avatars/${result.character.id}.png`);

      const avatarFile = path.join(userData, result.character.avatarPath!);
      expect(existsSync(avatarFile)).toBe(true);
      // 内容必须是完整的源 PNG（不是空文件或截断文件）
      expect(readFileSync(avatarFile).length).toBe(bytes.length);

      console.log(
        `  导入结果：name=${result.character.name} avatar=${result.character.avatarPath} ` +
          `spec=${result.specVersion} 保留字段=${JSON.stringify(result.preservedFields)}`,
      );
    } finally {
      rmSync(userData, { recursive: true, force: true });
      db.close();
    }
  });

  it('同一张卡导入两次：两个角色各有头像文件，互不覆盖', async () => {
    const db = openMigratedDb();
    const userData = mkdtempSync(path.join(tmpdir(), 'cottage-real-import2-'));
    try {
      const first = await importCharacterFromFile(db, userData, realCardPath, 1_700_000_000_000);
      const second = await importCharacterFromFile(db, userData, realCardPath, 1_700_000_000_001);

      expect(first.character.id).not.toBe(second.character.id);
      expect(first.character.avatarPath).not.toBe(second.character.avatarPath);
      expect(existsSync(path.join(userData, first.character.avatarPath!))).toBe(true);
      expect(existsSync(path.join(userData, second.character.avatarPath!))).toBe(true);
      expect(second.character.name).toBe(first.character.name);
    } finally {
      rmSync(userData, { recursive: true, force: true });
      db.close();
    }
  });

  it('同一批数据里的 JSON 卡不产生头像文件', async () => {
    const db = openMigratedDb();
    const userData = mkdtempSync(path.join(tmpdir(), 'cottage-json-import-'));
    try {
      const payload = extractPngCardPayload(new Uint8Array(readFileSync(realCardPath)));
      const jsonPath = path.join(userData, 'card.json');
      writeFileSync(jsonPath, payload.json, 'utf8');

      const result = await importCharacterFromFile(db, userData, jsonPath, 1_700_000_000_000);

      expect(result.savedAvatar).toBe(false);
      expect(result.character.avatarPath).toBeNull();
      expect(result.character.name.length).toBeGreaterThan(0);
    } finally {
      rmSync(userData, { recursive: true, force: true });
      db.close();
    }
  });
});
