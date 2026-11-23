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
 * PNG 头像使用预分配的角色 ID 命名。头像写好后再入库，入库失败时清理头像。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CharacterCardError } from '@core/character-card.js';
import { extractPngCardPayload, isPngFile } from '@core/png-card.js';
import type { CharacterImportResult } from '@shared/types.js';
import type { DatabaseDriver } from '../db/driver.js';
import { importCharacter } from '../db/dao/characters.js';
import { ID_PREFIX, newId } from '../db/ids.js';
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
 * PNG：解析出 JSON → 将原始 PNG 保存为头像 → 入库。
 * JSON：直接入库，不动头像。
 */
export async function importCharacterFromBytes(
  db: DatabaseDriver,
  userDataDir: string,
  bytes: Uint8Array,
  sourceName: string,
  now: number,
  chubPath?: string,
): Promise<FileImportResult> {
  if (!isPngFile(bytes)) {
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!text.trim()) {
      throw new CharacterCardError('invalid-json', `文件是空的：${path.basename(sourceName)}`);
    }
    return { ...importCharacter(db, text, now), savedAvatar: false };
  }

  const cardJson = extractPngCardPayload(bytes).json;
  const characterId = newId(ID_PREFIX.character);
  const relativePath = `${AVATAR_DIR}/${characterId}.png`;
  const avatarFile = path.join(userDataDir, relativePath);
  await mkdir(path.dirname(avatarFile), { recursive: true });
  try {
    await writeFile(avatarFile, bytes);
    const imported = importCharacter(db, cardJson, now, relativePath, { id: characterId, chubPath });
    return { ...imported, savedAvatar: true };
  } catch (error) {
    await rm(avatarFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
