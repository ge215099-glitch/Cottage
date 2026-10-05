/**
 * 从文件导入角色卡（技术方案 6.2 的 `characters:import-file`）。
 *
 * 支持两种文件：
 *   - **JSON**：角色卡对象或 JSON 文本；
 *   - **PNG**：SillyTavern 的 PNG 卡——JSON 藏在 `chara` / `ccv3` 文本块里，
 *     **图片本身就是卡面图**，所以导入时把整个 PNG 存进 `<userData>/avatars/`，
 *     相对路径写进 `characters.avatar_path`（产品文档 3.2 早就定了这个落点）。
 *
 * 为什么单独立一个 service 而不是塞进 IPC handler：这里同时碰文件系统、
 * 头像目录与 DAO，是能独立测试的一段逻辑（handler 只负责弹对话框与翻译错误）。
 *
 * 顺序很重要：**先入库拿到 id，再用 id 命名头像文件**。用原文件名当头像名会有
 * 重名覆盖与非法字符两个问题；而先写文件再入库，失败时会留下孤儿文件。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CharacterCardError } from '@core/character-card.js';
import { extractPngCardPayload, isPngFile } from '@core/png-card.js';
import type { CharacterImportResult } from '@shared/types.js';
import type { DatabaseDriver } from '../db/driver.js';
import { importCharacter, updateCharacter } from '../db/dao/characters.js';
import { AVATAR_DIR } from '../avatars.js';

export interface FileImportResult extends CharacterImportResult {
  /** 是否落了头像文件（PNG 卡 true，JSON 卡 false） */
  savedAvatar: boolean;
}

/** 读入文件并导入；PNG 卡会顺带把图片存成头像。 */
export async function importCharacterFromFile(
  db: DatabaseDriver,
  userDataDir: string,
  filePath: string,
  now: number,
): Promise<FileImportResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch {
    throw new CharacterCardError('unreadable', `读不到文件：${path.basename(filePath)}`);
  }
  return importCharacterFromBytes(db, userDataDir, bytes, filePath, now);
}

/**
 * 从内存字节导入（测试与"将来从剪贴板/拖拽导入"共用同一个入口）。
 *
 * PNG：解析出 JSON → 入库 → 把**原始 PNG 字节**写到 `avatars/<角色 id>.png`。
 * JSON：直接入库，不动头像。
 */
export async function importCharacterFromBytes(
  db: DatabaseDriver,
  userDataDir: string,
  bytes: Uint8Array,
  sourceName: string,
  now: number,
): Promise<FileImportResult> {
  const isPng = isPngFile(bytes);

  let cardJson: unknown;
  if (isPng) {
    // 解析失败就让它抛 PngCardError，由上层翻成可读错误
    cardJson = extractPngCardPayload(bytes).json;
  } else {
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!text.trim()) {
      throw new CharacterCardError('invalid-json', `文件是空的：${path.basename(sourceName)}`);
    }
    cardJson = text;
  }

  const imported = importCharacter(db, cardJson, now);
  const characterId = imported.character.id;

  if (!isPng) {
    return {
      character: imported.character,
      specVersion: imported.specVersion,
      preservedFields: imported.preservedFields,
      savedAvatar: false,
    };
  }

  // 头像名用角色 id：稳定、唯一、不含用户输入，自然避开重名覆盖与非法字符
  const relativePath = `${AVATAR_DIR}/${characterId}.png`;
  const absoluteDir = path.join(userDataDir, AVATAR_DIR);
  await mkdir(absoluteDir, { recursive: true });
  await writeFile(path.join(absoluteDir, `${characterId}.png`), bytes);

  const updated = updateCharacter(db, characterId, { avatarPath: relativePath }, now);
  return {
    character: updated ?? imported.character,
    specVersion: imported.specVersion,
    preservedFields: imported.preservedFields,
    savedAvatar: true,
  };
}
