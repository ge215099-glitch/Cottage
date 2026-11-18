/**
 * 测试侧的 PNG 合成器。
 *
 * 刻意**不复用 `src/core/png-card.ts` 的写回函数**：用它造样本、再用它读样本，
 * 一旦 base64 或块结构整体写错，两边会一起错而对消，测试变成永远为真。
 * 这里按 PNG 规范手写块结构，CRC 也是独立实现，读侧由它来验。
 */
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

export function chunk(type: string, data: Uint8Array): Uint8Array {
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

export function latin1Bytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((ch) => ch.charCodeAt(0) & 0xff));
}

export function textChunk(keyword: string, text: string): Uint8Array {
  const payload = new Uint8Array(keyword.length + 1 + text.length);
  payload.set(latin1Bytes(keyword), 0);
  payload[keyword.length] = 0;
  payload.set(latin1Bytes(text), keyword.length + 1);
  return chunk('tEXt', payload);
}

export function ztxtChunk(keyword: string, compressed: Uint8Array): Uint8Array {
  const payload = new Uint8Array(keyword.length + 2 + compressed.length);
  payload.set(latin1Bytes(keyword), 0);
  payload[keyword.length] = 0;
  payload[keyword.length + 1] = 0; // 压缩方法：deflate
  payload.set(compressed, keyword.length + 2);
  return chunk('zTXt', payload);
}

export function itxtChunk(keyword: string, text: string, compressed = false): Uint8Array {
  const head = latin1Bytes(`${keyword}\0${compressed ? '\u0001' : '\u0000'}\u0000\u0000\u0000`);
  const textBytes = new TextEncoder().encode(text);
  const payload = new Uint8Array(head.length + textBytes.length);
  payload.set(head, 0);
  payload.set(textBytes, head.length);
  return chunk('iTXt', payload);
}

export const IHDR = chunk(
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

export const IEND = chunk('IEND', new Uint8Array(0));

export function png(...chunks: Uint8Array[]): Uint8Array {
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
export function cardBase64(card: unknown): string {
  const json = JSON.stringify(card);
  const utf8 = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 一张带卡面图数据的完整 PNG 卡（模拟"从 SillyTavern 导出的卡"）。 */
export function cardPng(card: unknown, keyword = 'chara'): Uint8Array {
  const idat = chunk('IDAT', new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]));
  return png(IHDR, idat, textChunk(keyword, cardBase64(card)), IEND);
}

export interface ListedChunk {
  type: string;
  keyword: string;
  text: string;
  /** 块内 CRC 与重算结果是否一致 */
  crcOk: boolean;
  /** 完整原始字节 */
  raw: Uint8Array;
  /** 仅数据段 */
  data: Uint8Array;
}

/** 拆块（测试侧独立实现，不复用 src 的解析路径）。 */
export function listChunks(bytes: Uint8Array): ListedChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ListedChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const stored = view.getUint32(offset + 8 + length);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    const nul = data.indexOf(0);
    out.push({
      type,
      keyword: nul > 0 ? String.fromCharCode(...data.subarray(0, nul)) : '',
      text: nul > 0 ? String.fromCharCode(...data.subarray(nul + 1)) : '',
      crcOk: crc32(body) === stored,
      raw: bytes.subarray(offset, offset + 12 + length),
      data,
    });
    offset += 12 + length;
  }
  return out;
}

/** 取某一类块的原始字节（用于断言"图片数据没被动过"）。 */
export function rawChunkOf(bytes: Uint8Array, type: string): Uint8Array | undefined {
  return listChunks(bytes).find((c) => c.type === type)?.raw;
}
