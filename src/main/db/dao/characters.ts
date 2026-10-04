/**
 * 角色卡 DAO（产品设计文档 3.2）。
 *
 * 关键约定：`raw_json` 原样保存，是导出时的基底。本模块负责把核心层解析出的
 * `ParsedCharacterCard` 落库，并在导出时把 `raw_json` 原样取回交给 core 处理。
 */
import type { Character, CharacterImportResult } from '@shared/types.js';
import { exportCharacterCard, parseCharacterCard } from '@core/character-card.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { parseJsonColumn, stringArraySchema, toCharacter, toJsonColumn, type CharacterRow } from '../mappers.js';

const SELECT_COLUMNS = `
  id,name,description,personality,scenario,first_mes,alternate_greetings_json,mes_example,
  system_prompt,post_history_instructions,tags_json,favorite,avatar_path,raw_json,created_at,updated_at
`;

export interface ListCharactersQuery {
  /** 名称 / 描述 / 标签模糊匹配 */
  search?: string;
  /** 标签精确匹配（任一命中） */
  tags?: string[];
  /** 只看收藏 */
  favoriteOnly?: boolean;
}

export function listCharacters(db: DatabaseDriver, query: ListCharactersQuery = {}): Character[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  const search = query.search?.trim();
  if (search) {
    where.push('(name LIKE ? OR description LIKE ? OR personality LIKE ? OR tags_json LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (query.favoriteOnly) where.push('favorite = 1');

  const sql = `SELECT ${SELECT_COLUMNS} FROM characters
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY favorite DESC, updated_at DESC`;

  let rows = db.prepare<CharacterRow>(sql).all(...params);

  // 标签筛选放在内存里做：tags 是 JSON 列，SQL 里的 LIKE 会误命中子串
  // （"奇" 命中 "奇幻"），这里按解析后的数组精确比。
  const tags = query.tags?.filter(Boolean) ?? [];
  if (tags.length) {
    const wanted = new Set(tags);
    rows = rows.filter((row) =>
      toCharacter(row).tags.some((t) => wanted.has(t)),
    );
  }

  return rows.map(toCharacter);
}

export function getCharacter(db: DatabaseDriver, id: string): Character | null {
  const row = db
    .prepare<CharacterRow>(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = ?`)
    .get(id);
  return row ? toCharacter(row) : null;
}

/** 取原始 JSON（导出用）。**只在主进程使用。** */
export function getCharacterRawJson(
  db: DatabaseDriver,
  id: string,
): Record<string, unknown> | null {
  const row = db.prepare<{ raw_json: string }>('SELECT raw_json FROM characters WHERE id = ?').get(id);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 导入角色卡。
 *
 * @throws CharacterCardError 卡结构非法
 */
export function importCharacter(
  db: DatabaseDriver,
  cardJson: unknown,
  now: number,
): CharacterImportResult {
  const card = parseCharacterCard(cardJson);
  const id = newId(ID_PREFIX.character);

  db.prepare(
    `INSERT INTO characters
       (id,name,description,personality,scenario,first_mes,alternate_greetings_json,mes_example,
        system_prompt,post_history_instructions,tags_json,favorite,avatar_path,raw_json,
        created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    card.name,
    card.description,
    card.personality,
    card.scenario,
    card.firstMes,
    toJsonColumn(card.alternateGreetings),
    card.mesExample,
    card.systemPrompt,
    card.postHistoryInstructions,
    toJsonColumn(card.tags),
    0,
    null,
    toJsonColumn(card.rawJson),
    now,
    now,
  );

  return {
    character: getCharacter(db, id)!,
    specVersion: card.specVersion,
    preservedFields: card.preservedFields,
  };
}

/** 可编辑字段（产品设计文档 3.2 的清单）。 */
export interface CharacterUpdate {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  alternateGreetings?: string[];
  mesExample?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  tags?: string[];
  favorite?: boolean;
  avatarPath?: string | null;
}

export function updateCharacter(
  db: DatabaseDriver,
  id: string,
  patch: CharacterUpdate,
  now: number,
): Character | null {
  const existing = getCharacter(db, id);
  if (!existing) return null;

  const merged = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    personality: patch.personality ?? existing.personality,
    scenario: patch.scenario ?? existing.scenario,
    firstMes: patch.firstMes ?? existing.firstMes,
    alternateGreetings: patch.alternateGreetings ?? existing.alternateGreetings,
    mesExample: patch.mesExample ?? existing.mesExample,
    systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
    postHistoryInstructions: patch.postHistoryInstructions ?? existing.postHistoryInstructions,
    tags: patch.tags ?? existing.tags,
  };
  if (!merged.name.trim()) {
    throw new Error('角色名不能为空');
  }

  db.prepare(
    `UPDATE characters SET
       name = ?, description = ?, personality = ?, scenario = ?, first_mes = ?,
       alternate_greetings_json = ?, mes_example = ?, system_prompt = ?,
       post_history_instructions = ?, tags_json = ?, favorite = ?, avatar_path = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    merged.name,
    merged.description,
    merged.personality,
    merged.scenario,
    merged.firstMes,
    toJsonColumn(merged.alternateGreetings),
    merged.mesExample,
    merged.systemPrompt,
    merged.postHistoryInstructions,
    toJsonColumn(merged.tags),
    (patch.favorite ?? existing.favorite) ? 1 : 0,
    patch.avatarPath === undefined ? existing.avatarPath : patch.avatarPath,
    now,
    id,
  );
  return getCharacter(db, id);
}

/**
 * 导出角色卡：以 `raw_json` 为基底，只覆盖 Cottage 管理的字段（验收项 1）。
 */
export function exportCharacter(
  db: DatabaseDriver,
  id: string,
): Record<string, unknown> | null {
  const character = getCharacter(db, id);
  const raw = getCharacterRawJson(db, id);
  if (!character || !raw) return null;

  return exportCharacterCard(
    raw,
    {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      firstMes: character.firstMes,
      alternateGreetings: character.alternateGreetings,
      mesExample: character.mesExample,
      systemPrompt: character.systemPrompt,
      postHistoryInstructions: character.postHistoryInstructions,
      tags: character.tags,
    },
    { avatar: character.avatarPath },
  );
}

export function deleteCharacter(db: DatabaseDriver, id: string): { ok: boolean; reason?: string } {
  // 有会话引用时不允许删除：ON DELETE RESTRICT 会抛错，这里先给出可读原因。
  const used = db
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE character_id = ?')
    .get(id);
  if (Number(used?.n ?? 0) > 0) {
    return { ok: false, reason: `该角色还有 ${used!.n} 个对话，请先删除这些对话` };
  }
  return { ok: db.prepare('DELETE FROM characters WHERE id = ?').run(id).changes > 0 };
}

/** 角色库里出现过的全部标签（供筛选器渲染）。 */
export function listCharacterTags(db: DatabaseDriver): Array<{ tag: string; count: number }> {
  const rows = db.prepare<{ tags_json: string }>('SELECT tags_json FROM characters').all();
  const counter = new Map<string, number>();
  for (const row of rows) {
    // 标签筛选要精确，所以必须先过 schema 解析成数组再统计。
    const tags = parseJsonColumn(row.tags_json, stringArraySchema, [], 'characters.tags_json');
    for (const tag of tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}
