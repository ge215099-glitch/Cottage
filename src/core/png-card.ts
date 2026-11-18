/**
 * PNG 角色卡解析与写回（产品设计文档 3.2 的导入 / 导出两侧）。
 *
 * SillyTavern 的 PNG 角色卡把角色数据放进 PNG 的**文本块**里：
 *   - 关键词 `chara`：v2 规范（内容是 base64 编码的 JSON）；
 *   - 关键词 `ccv3`：v3 规范，同一套写法。
 * 图片本身即卡面图，所以导入时把整个 PNG 存下来当头像，JSON 走既有的
 * `parseCharacterCard` 流程（保证 `raw_json` 原样保留那条承诺不被绕过）；
 * 导出时反过来——**原样的卡面图 + 新写进去的文本块**，得到一个别家应用
 * （SillyTavern 等）能直接读的 PNG 卡。
 *
 * 本文件是**纯函数**，只用 `Uint8Array` / `DataView` / `TextDecoder` / `atob`，
 * 不 import 任何 `node:` 模块——这样 core 的零平台依赖约束仍然成立，
 * 而且可以在 renderer 侧复用。
 *
 * 读侧刻意不做 CRC 校验：真卡里出现重复文本块、工具改写内容的都有（实测拿到的
 * 一张 v2 卡里就有**两个** `chara` 块，内容还不完全一样）。base64 + JSON 解析
 * 本身就是足够强的完整性信号，坏数据会在那一步被拒绝并继续试下一个块。
 * 写侧相反：CRC 必须算对，因为读我们这张卡的是别人的程序。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const PNG_SIGNATURE_BYTES = new Uint8Array(PNG_SIGNATURE);

/** 数据块关键词：只有这两个承载角色卡。 */
export type PngCardKeyword = 'chara' | 'ccv3';

export const CARD_KEYWORDS: readonly PngCardKeyword[] = ['ccv3', 'chara'];

/**
 * 文本块关键词的优先级：**`ccv3` 优先于 `chara`**。
 *
 * 一张卡同时带两个块时，v3 块是更新的那份规范，应当优先采用。
 */
const KEYWORD_PRIORITY = CARD_KEYWORDS;

export class PngCardError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PngCardError';
    this.reason = reason;
  }
}

export function isPngFile(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

interface RawTextChunk {
  keyword: string;
  /** 未压缩的文本内容；`zTXt` 这类压缩块返回 null（由上层给出明确报错） */
  text: string | null;
  compressed: boolean;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** 从数据块里切出 `keyword\0` 之后的部分。 */
function splitKeyword(data: Uint8Array): { keyword: string; rest: Uint8Array } | null {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  return { keyword: latin1(data.subarray(0, nul)), rest: data.subarray(nul + 1) };
}

function readTextChunk(type: string, data: Uint8Array): RawTextChunk | null {
  if (type === 'tEXt') {
    const parts = splitKeyword(data);
    if (!parts) return null;
    return { keyword: parts.keyword, text: latin1(parts.rest), compressed: false };
  }

  if (type === 'zTXt') {
    const parts = splitKeyword(data);
    if (!parts) return null;
    // 第 1 字节是压缩方法（0 = deflate），压缩负载我们解不了
    return { keyword: parts.keyword, text: null, compressed: true };
  }

  if (type === 'iTXt') {
    const parts = splitKeyword(data);
    if (!parts) return null;
    const rest = parts.rest;
    const compressionFlag = rest[0] ?? 0;
    // rest = compressionFlag(1) + compressionMethod(1) + languageTag\0 + translatedKeyword\0 + text
    let cursor = 2;
    for (let i = 0; i < 2; i += 1) {
      const nul = rest.indexOf(0, cursor);
      if (nul < 0) return null;
      cursor = nul + 1;
    }
    if (compressionFlag === 1) {
      return { keyword: parts.keyword, text: null, compressed: true };
    }
    return {
      keyword: parts.keyword,
      text: new TextDecoder('utf-8').decode(rest.subarray(cursor)),
      compressed: false,
    };
  }

  return null;
}

interface RawChunk {
  type: string;
  /** 数据段（不含长度、类型与 CRC） */
  data: Uint8Array;
  /** 完整原始字节（长度 + 类型 + 数据 + CRC），导出时原样搬运 */
  raw: Uint8Array;
}

interface ChunkWalk {
  chunks: RawChunk[];
  /** 走到的偏移；IEND 之后若还有字节，就是从这里开始的 */
  offset: number;
  /** 长度字段或文件被写坏，扫描是被迫中断的（不是正常读到 IEND） */
  truncated: boolean;
}

/**
 * 遍历 chunk 列表。
 *
 * 越界即停止：长度字段被写坏时不能继续按偏移往前走，否则会读出垃圾；
 * 但要通过 `truncated` 把"被迫中断"和"正常读到 IEND"区分开——导入侧两者
 * 都可以尽力而为，导出侧则必须拒绝，否则会写出一个坏 PNG。
 */
function parseChunks(bytes: Uint8Array): ChunkWalk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: RawChunk[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return { chunks, offset, truncated: true }; // 截断的文件

    chunks.push({
      type,
      data: bytes.subarray(dataStart, dataEnd),
      raw: bytes.subarray(offset, dataEnd + 4),
    });

    offset = dataEnd + 4; // 跳过 CRC
    if (type === 'IEND') return { chunks, offset, truncated: false };
  }

  return { chunks, offset, truncated: false };
}

/**
 * 扫一遍 chunk，按关键词优先级 + 出现顺序返回候选文本块。
 *
 * 截断时保留已扫到的部分：真卡里坏在尾部（例如被下载截断）但数据块完好的情况
 * 是存在的，此时能读出卡总比直接报错有用。
 */
function collectTextChunks(bytes: Uint8Array): RawTextChunk[] {
  const found: RawTextChunk[] = [];
  for (const raw of parseChunks(bytes).chunks) {
    const chunk = readTextChunk(raw.type, raw.data);
    if (chunk) found.push(chunk);
  }

  const ordered: RawTextChunk[] = [];
  for (const keyword of KEYWORD_PRIORITY) {
    for (const chunk of found) {
      if (chunk.keyword === keyword) ordered.push(chunk);
    }
  }
  return ordered;
}

export interface PngCardPayload {
  /** 命中哪个关键词（`chara` / `ccv3`） */
  keyword: string;
  /** base64 解码后的角色卡 JSON 文本，可直接交给 `parseCharacterCard` */
  json: string;
}

/**
 * 从 PNG 字节里取出角色卡 JSON 文本。
 *
 * 多个文本块时：**按优先级逐个尝试**，第一个能 base64 解码且是合法 JSON 的胜出。
 * 真卡里存在重复块（实测那张 v2 卡里有两个 `chara`，其中只有一个带 `character_book`），
 * 所以"取第一个"是不够的，必须能往后试。
 */
export function extractPngCardPayload(bytes: Uint8Array): PngCardPayload {
  if (!isPngFile(bytes)) {
    throw new PngCardError('not-png', '这不是 PNG 文件（文件头不匹配）');
  }

  const chunks = collectTextChunks(bytes);
  if (!chunks.length) {
    throw new PngCardError(
      'no-card-chunk',
      '这张 PNG 里没有角色卡数据（找不到 chara / ccv3 文本块），它可能只是一张普通图片',
    );
  }

  let sawCompressed = false;
  for (const chunk of chunks) {
    if (chunk.compressed || chunk.text === null) {
      sawCompressed = true;
      continue;
    }
    let decoded: string;
    try {
      // 文本是 base64（ASCII），先还原成字节再按 UTF-8 解码
      const binary = atob(chunk.text.trim());
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i);
      decoded = new TextDecoder('utf-8').decode(raw);
    } catch {
      continue; // base64 坏了，试下一个块
    }

    try {
      JSON.parse(decoded);
    } catch {
      continue; // 解出来不是 JSON，试下一个
    }
    return { keyword: chunk.keyword, json: decoded };
  }

  if (sawCompressed) {
    throw new PngCardError(
      'compressed-chunk',
      '这张角色卡把数据压缩后写进 PNG（zTXt / 压缩的 iTXt），暂不支持；请用 SillyTavern 另存为未压缩的 v2/v3 卡',
    );
  }
  throw new PngCardError(
    'bad-payload',
    'PNG 里找到了角色卡文本块，但内容不是可解析的 JSON（可能文件损坏）',
  );
}

/* ------------------------------------------------------------------ */
/* 写回：把角色卡 JSON 塞进 PNG（导出侧）                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * PNG 数据块 CRC-32（ISO 3309 / PNG 规范附录 D）。
 *
 * 读侧不校验它，写侧必须算对：我们导出的卡是给别人的程序读的，
 * CRC 错的文件会被严格的读取器整块拒收。
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 字符串 → Latin-1 字节（PNG 的文本块关键词与文本都是单字节）。 */
function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 标准 base64 编码。
 *
 * 不用全局 `btoa`：它要求入参是"每字符 ≤ 0xFF 的字符串"，把字节数组拼成
 * 这种字符串既要在超大卡片上小心中间字符串长度，又在 **renderer 之外的
 * 纯 Node 环境**里多一层环境依赖。这里自己编码，行为完全一致且处处可用。
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 组装一个完整数据块：长度 + 类型 + 数据 + CRC。 */
function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1Encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 组装一个 `tEXt` 块：`关键词 \0 base64 文本`。 */
function buildTextChunk(keyword: PngCardKeyword, base64Text: string): Uint8Array {
  const head = latin1Encode(`${keyword}\0`);
  const body = latin1Encode(base64Text);
  return buildChunk('tEXt', concatBytes([head, body]));
}

/** 这个块是不是承载角色卡的文本块（`chara` / `ccv3`，含压缩形态）。 */
function isCardTextChunk(chunk: RawChunk): boolean {
  if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') return false;
  const parts = splitKeyword(chunk.data);
  return parts !== null && (CARD_KEYWORDS as readonly string[]).includes(parts.keyword);
}

/**
 * 把角色卡 JSON 写回 PNG，得到一张别家应用能直接读的 PNG 卡。
 *
 * 三条规则：
 *   1. **卡面图原样保留**——只动文本块，图片像素与其它元数据一个字节都不碰；
 *   2. **旧的 `chara` / `ccv3` 文本块必须丢掉**。留着它们，重新导入时读到的
 *      还是旧数据（读侧是按关键词取块的，不会因为多了一个新块就换一份），
 *      这会变成"改完导出、再导入又变回去"的静默数据丢失；
 *   3. 新块插在 `IEND` 之前，`IEND` 之后的字节（正常文件为空）原样保留，
 *      不因为导出而丢掉任何一个原本存在的字节。
 */
export function embedPngCardPayload(
  source: Uint8Array,
  json: string,
  keyword: PngCardKeyword = 'chara',
): Uint8Array {
  if (!isPngFile(source)) {
    throw new PngCardError('not-png', '这不是 PNG 文件（文件头不匹配），无法把角色卡写回去');
  }

  const { chunks, offset, truncated } = parseChunks(source);
  const iendIndex = chunks.findIndex((chunk) => chunk.type === 'IEND');
  if (truncated || iendIndex < 0) {
    throw new PngCardError(
      'truncated',
      '这张 PNG 结构不完整（缺少 IEND 或长度字段被写坏），无法把角色卡写回去',
    );
  }

  const kept = chunks.filter((chunk, index) => index !== iendIndex && !isCardTextChunk(chunk));

  return concatBytes([
    PNG_SIGNATURE_BYTES,
    ...kept.map((chunk) => chunk.raw),
    buildTextChunk(keyword, encodeBase64(new TextEncoder().encode(json))),
    chunks[iendIndex]!.raw,
    source.subarray(offset),
  ]);
}
