/**
 * PNG 角色卡解析（产品设计文档 3.2 的导入侧）。
 *
 * SillyTavern 的 PNG 角色卡把角色数据放进 PNG 的**文本块**里：
 *   - 关键词 `chara`：v2 规范（内容是 base64 编码的 JSON）；
 *   - 关键词 `ccv3`：v3 规范，同一套写法。
 * 图片本身即卡面图，所以导入时把整个 PNG 存下来当头像，JSON 走既有的
 * `parseCharacterCard` 流程（保证 `raw_json` 原样保留那条承诺不被绕过）。
 *
 * 本文件是**纯函数**，只用 `Uint8Array` / `DataView` / `TextDecoder` / `atob`，
 * 不 import 任何 `node:` 模块——这样 core 的零平台依赖约束仍然成立，
 * 而且可以在 renderer 侧复用。
 *
 * 刻意不做 CRC 校验：真卡里出现重复文本块、工具改写内容的都有（实测拿到的
 * 一张 v2 卡里就有**两个** `chara` 块，内容还不完全一样）。base64 + JSON 解析
 * 本身就是足够强的完整性信号，坏数据会在那一步被拒绝并继续试下一个块。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * 文本块关键词的优先级：**`ccv3` 优先于 `chara`**。
 *
 * 一张卡同时带两个块时，v3 块是更新的那份规范，应当优先采用。
 */
const KEYWORD_PRIORITY = ['ccv3', 'chara'] as const;

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

/**
 * 扫一遍 chunk，按关键词优先级 + 出现顺序返回候选文本块。
 *
 * 越界即停止：长度字段被写坏时不能继续按偏移往前走，否则会读出垃圾。
 */
function collectTextChunks(bytes: Uint8Array): RawTextChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: RawTextChunk[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break; // 截断的文件，停止解析

    const chunk = readTextChunk(type, bytes.subarray(dataStart, dataEnd));
    if (chunk) found.push(chunk);

    offset = dataEnd + 4; // 跳过 CRC
    if (type === 'IEND') break;
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
