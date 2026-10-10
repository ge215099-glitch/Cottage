/**
 * 导入角色卡失败时的**错误码映射**（`toNormalizedError`）。
 *
 * 为什么单独测这一层：错误文案对了、错误码错了，任何测试都发现不了，而 UI 是拿
 * 错误码分支的（比如"这个文件不行，换一个"与"数据库坏了"该有不同处置）。
 *
 * 具体钉的是一个真实踩过的坑：`PngCardError`（PNG 容器坏）与 `CharacterCardError`
 * （卡 JSON 坏）是**两个互不继承的类**。少判一个，用户得到的仍是同一句可读文案，
 * 但码会掉进 `UNKNOWN`——静默降级，最难发现。
 */
import { describe, expect, it } from 'vitest';
import { CharacterCardError } from '../src/core/character-card.js';
import { PngCardError } from '../src/core/png-card.js';
import { toNormalizedError } from '../src/main/ipc/index.js';

describe('导入角色卡的错误码映射', () => {
  it('PNG 卡解析失败 → VALIDATION_ERROR，并且保留可读原因', () => {
    const error = new PngCardError('no-card-chunk', '这张 PNG 里没有角色卡数据（找不到 chara / ccv3 文本块）');
    const normalized = toNormalizedError(error);

    expect(normalized.code).toBe('VALIDATION_ERROR');
    expect(normalized.message).toContain('没有角色卡数据');
  });

  it('卡 JSON 非法 → VALIDATION_ERROR', () => {
    const normalized = toNormalizedError(new CharacterCardError('missing-name', '角色卡缺少 name 字段'));
    expect(normalized.code).toBe('VALIDATION_ERROR');
    expect(normalized.message).toContain('缺少 name');
  });

  it('压缩块这种"能解释清楚"的失败也走 VALIDATION_ERROR 而不是 UNKNOWN', () => {
    const normalized = toNormalizedError(
      new PngCardError('compressed-chunk', '这张角色卡把数据压缩后写进 PNG，暂不支持'),
    );
    expect(normalized.code).toBe('VALIDATION_ERROR');
  });

  it('认不出的异常仍然是 UNKNOWN（这条兜底不能被上面几条吃掉）', () => {
    const normalized = toNormalizedError(new Error('莫名其妙'));
    expect(normalized.code).toBe('UNKNOWN');
  });
});
