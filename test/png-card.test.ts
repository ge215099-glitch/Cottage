/**
 * PNG 角色卡解析测试。
 *
 * 样本都是**代码合成**的 PNG（只写 chunk，不做真实像素压缩）：这样测试可以精确构造
 * 各种坏情况，也不必把一张第三方角色卡塞进仓库。
 *
 * 用例形状全部来自对一张真实 v2 卡（768×1376、969KB）的实测结构：
 * `tEXt` / 关键词 `chara` / base64 编码的 JSON，而且**同一个文件里有两个 `chara` 块**
 * （内容还不完全一样：只有一个带 `character_book`）。所以"取第一个块"是不够的。
 */
import { describe, expect, it } from 'vitest';
import {
  PngCardError,
  extractPngCardPayload,
  isPngFile,
} from '../src/core/png-card.js';
import { parseCharacterCard } from '../src/core/character-card.js';

/* ------------------------------- 合成 PNG ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((ch) => ch.charCodeAt(0) & 0xff));
}

function textChunk(keyword: string, text: string): Uint8Array {
  const payload = new Uint8Array(keyword.length + 1 + text.length);
  payload.set(latin1Bytes(keyword), 0);
  payload[keyword.length] = 0;
  payload.set(latin1Bytes(text), keyword.length + 1);
  return chunk('tEXt', payload);
}

function ztxtChunk(keyword: string, compressed: Uint8Array): Uint8Array {
  const payload = new Uint8Array(keyword.length + 2 + compressed.length);
  payload.set(latin1Bytes(keyword), 0);
  payload[keyword.length] = 0;
  payload[keyword.length + 1] = 0; // 压缩方法：deflate
  payload.set(compressed, keyword.length + 2);
  return chunk('zTXt', payload);
}

function itxtChunk(keyword: string, text: string, compressed = false): Uint8Array {
  const head = latin1Bytes(`${keyword}\0${compressed ? '\u0001' : '\u0000'}\u0000\u0000\u0000`);
  const textBytes = new TextEncoder().encode(text);
  const payload = new Uint8Array(head.length + textBytes.length);
  payload.set(head, 0);
  payload.set(textBytes, head.length);
  return chunk('iTXt', payload);
}

const IHDR = chunk(
  'IHDR',
  (() => {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, 768);
    view.setUint32(4, 1376);
    data[8] = 8;
    data[9] = 6;
    return data;
  })(),
);
const IEND = chunk('IEND', new Uint8Array(0));

function png(...chunks: Uint8Array[]): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const total = signature.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  out.set(signature, 0);
  let offset = signature.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 角色卡 JSON → base64（与真实卡一致：base64 在文本块里，按 UTF-8 还原）。 */
function cardBase64(card: unknown): string {
  const json = JSON.stringify(card);
  const utf8 = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '林晚',
    description: '小镇旧书店的年轻店主。',
    personality: '安静',
    scenario: '雨天',
    first_mes: '外面雨挺大的。',
    tags: ['日常'],
    character_book: { entries: [{ keys: ['雨'] }] },
  },
};

const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: { name: '林晚', description: 'v3 版本', tags: [] },
};

/* --------------------------------- 用例 --------------------------------- */

describe('isPngFile', () => {
  it('认 PNG 文件头', () => {
    expect(isPngFile(png(IHDR, IEND))).toBe(true);
    expect(isPngFile(new TextEncoder().encode('{"spec":"chara_card_v2"}'))).toBe(false);
    expect(isPngFile(new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(isPngFile(new Uint8Array(0))).toBe(false);
  });
});

describe('extractPngCardPayload', () => {
  it('从 tEXt/chara 里取出 JSON，并能交给 parseCharacterCard', () => {
    const payload = extractPngCardPayload(png(IHDR, textChunk('chara', cardBase64(V2_CARD)), IEND));
    expect(payload.keyword).toBe('chara');
    const card = parseCharacterCard(payload.json);
    expect(card.specVersion).toBe('v2');
    expect(card.name).toBe('林晚');
    // 第三方字段必须原样保留（character_book 不在 Cottage 管理范围内）
    expect(card.preservedFields).toContain('data.character_book');
  });

  it('同时有 ccv3 与 chara 时优先用 ccv3', () => {
    const payload = extractPngCardPayload(
      png(IHDR, textChunk('chara', cardBase64(V2_CARD)), textChunk('ccv3', cardBase64(V3_CARD)), IEND),
    );
    expect(payload.keyword).toBe('ccv3');
    expect(parseCharacterCard(payload.json).specVersion).toBe('v3');
  });

  it('重复的 chara 块：第一个解不出来就用下一个（真实卡里就有两个）', () => {
    const broken = textChunk('chara', '这不是 base64 也不是 JSON');
    const good = textChunk('chara', cardBase64(V2_CARD));
    const payload = extractPngCardPayload(png(IHDR, broken, good, IEND));
    expect(parseCharacterCard(payload.json).name).toBe('林晚');
  });

  it('第一个块是合法 JSON 但缺 name 时，也交给上层去报缺 name（不静默换块）', () => {
    // 取块的判据是"base64 + JSON 可解"，业务字段校验属于 parseCharacterCard 的职责
    const payload = extractPngCardPayload(
      png(IHDR, textChunk('chara', cardBase64({ spec: 'chara_card_v2', data: {} })), IEND),
    );
    expect(() => parseCharacterCard(payload.json)).toThrowError(/name/);
  });

  it('支持未压缩的 iTXt', () => {
    const payload = extractPngCardPayload(png(IHDR, itxtChunk('chara', cardBase64(V2_CARD)), IEND));
    expect(parseCharacterCard(payload.json).name).toBe('林晚');
  });

  it('非 PNG 文件给出可读错误', () => {
    expect(() => extractPngCardPayload(new TextEncoder().encode('{"a":1}'))).toThrowError(PngCardError);
    expect(() => extractPngCardPayload(new TextEncoder().encode('{"a":1}'))).toThrowError(/PNG/);
  });

  it('没有角色卡文本块的 PNG：说清楚"这只是一张图片"', () => {
    expect(() => extractPngCardPayload(png(IHDR, IEND))).toThrowError(/没有角色卡数据/);
  });

  it('压缩过的块给出明确指引，而不是笼统失败', () => {
    const compressed = ztxtChunk('chara', new Uint8Array([1, 2, 3, 4]));
    expect(() => extractPngCardPayload(png(IHDR, compressed, IEND))).toThrowError(/压缩/);
    expect(() => extractPngCardPayload(png(IHDR, compressed, IEND))).toThrowError(/另存/);
  });

  it('截断的文件不会越界读，而是报"没有可解析内容"或"内容损坏"', () => {
    const full = png(IHDR, textChunk('chara', cardBase64(V2_CARD)), IEND);
    const truncated = full.subarray(0, full.length - 40);
    expect(() => extractPngCardPayload(truncated)).toThrowError(PngCardError);
  });

  it('长度字段被写坏时停止扫描，不读出垃圾也不崩', () => {
    const broken = png(IHDR, textChunk('chara', cardBase64(V2_CARD)), IEND);
    // 把 IHDR 的 length 改成 0xffffff00，偏移会立刻越界
    new DataView(broken.buffer).setUint32(8, 0xffffff00);
    expect(() => extractPngCardPayload(broken)).toThrowError(PngCardError);
  });

  it('文本块存在但内容是坏 base64 / 坏 JSON 时报"内容损坏"', () => {
    expect(() => extractPngCardPayload(png(IHDR, textChunk('chara', '!!!not-base64!!!'), IEND))).toThrowError(
      /损坏/,
    );
    const notJson = btoa('hello world');
    expect(() => extractPngCardPayload(png(IHDR, textChunk('chara', notJson), IEND))).toThrowError(/损坏/);
  });

  it('base64 解出来的 UTF-8 中文不会乱码', () => {
    const card = { spec: 'chara_card_v2', data: { name: '林晚·书店', first_mes: '「雨停了。」' } };
    const payload = extractPngCardPayload(png(IHDR, textChunk('chara', cardBase64(card)), IEND));
    const parsed = parseCharacterCard(payload.json);
    expect(parsed.name).toBe('林晚·书店');
    expect(parsed.firstMes).toBe('「雨停了。」');
  });
});
