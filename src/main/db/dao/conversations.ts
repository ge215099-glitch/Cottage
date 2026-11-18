/**
 * 会话 DAO（产品设计文档 3.5 + UI 文档 9.1）。
 *
 * 本模块承载两条容易写坏的规则，各自都有专门测试：
 *   1. **排序**：`pinned_at IS NOT NULL DESC, COALESCE(pinned_at,0) DESC, updated_at DESC`
 *   2. **置顶不得触碰 `updated_at`**（UI 文档 9.1 + 验收项 21/22）
 *
 * 会话列表永远只分两段（已置顶 / 其余全部），**不按今天/昨天分组**。
 */
import type { Conversation, GenerationParams } from '@shared/types.js';
import { DEFAULT_GENERATION_PARAMS } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { toConversation, toJsonColumn, type ConversationRow } from '../mappers.js';

/**
 * 列表查询：顺带把消息数与摘要段数一起算出来。
 * 用子查询而不是 N+1，是为了让虚拟滚动的每一行都不触发额外查询。
 */
const LIST_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
    (SELECT COUNT(*) FROM summaries s WHERE s.conversation_id = c.id) AS summary_count
  FROM conversations c
  ORDER BY c.pinned_at IS NOT NULL DESC, COALESCE(c.pinned_at, 0) DESC, c.updated_at DESC
`;

export function listConversations(db: DatabaseDriver): Conversation[] {
  return db.prepare<ConversationRow>(LIST_SQL).all().map(toConversation);
}

export function getConversation(db: DatabaseDriver, id: string): Conversation | null {
  const row = db
    .prepare<ConversationRow>(
      `SELECT c.*,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
         (SELECT COUNT(*) FROM summaries s WHERE s.conversation_id = c.id) AS summary_count
       FROM conversations c WHERE c.id = ?`,
    )
    .get(id);
  return row ? toConversation(row) : null;
}

export interface CreateConversationInput {
  title: string;
  characterId: string;
  personaId: string | null;
  providerId: string | null;
  model: string;
  params?: Partial<GenerationParams>;
}

export function createConversation(
  db: DatabaseDriver,
  input: CreateConversationInput,
  now: number,
): Conversation {
  const id = newId(ID_PREFIX.conversation);
  db.prepare(
    `INSERT INTO conversations
       (id,title,character_id,persona_id,provider_id,model,params_json,pinned_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.title,
    input.characterId,
    input.personaId,
    input.providerId,
    input.model,
    toJsonColumn({ ...DEFAULT_GENERATION_PARAMS, ...input.params }),
    null,
    now,
    now,
  );
  return getConversation(db, id)!;
}

/** 会话标题长度上限（与 `createConversationInputSchema` 的 80 对齐）。 */
export const TITLE_MAX_LENGTH = 80;

/**
 * 给"自动命名"的会话取一个不重名的标题。
 *
 * 产品规则：新会话默认叫**角色名**；如果重名，就在后面加 " 2"、" 3"…… 以此类推。
 *
 * 两个刻意的决定：
 *   - **只在自动命名时调用**。用户手动改过的名字（`renameConversation`）一律不干预，
 *     否则"我把名字改成和别人一样"会变成一件做不到的事。
 *   - 重名判断查**全表**，不只看同一个角色的会话。标题只会出现在一个列表里，
 *     只有全局唯一才不会出现两条一模一样的标题让人分不清。
 *
 * 放在 DAO 而不是 renderer：唯一性以库为准，renderer 手里的列表可能已经过期。
 */
export function nextConversationTitle(db: DatabaseDriver, base: string): string {
  const clean = base.trim() || '新对话';
  const taken = new Set(
    db
      .prepare<{ title: string }>('SELECT title FROM conversations')
      .all()
      .map((row) => row.title),
  );

  /** 把 base 截到"加上后缀也不超上限"。 */
  const fit = (suffix: string): string => {
    const room = TITLE_MAX_LENGTH - suffix.length;
    return (clean.length > room ? clean.slice(0, Math.max(1, room)) : clean) + suffix;
  };

  if (!taken.has(fit(''))) return fit('');
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = fit(` ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  // 理论上到不了这里；真到了就退化成一个不会重名的名字
  return fit(` ${Date.now()}`);
}

/**
 * 只改标题：**默认不修改 `updated_at`**，避免"刚改完名就跳走"（UI 文档 4.6）。
 * 首条消息派生标题时传 `touch: true` 也无害——紧随其后写入的消息本来就会推进它。
 */
export function renameConversation(
  db: DatabaseDriver,
  id: string,
  title: string,
  options: { now?: number; touch?: boolean } = {},
): Conversation | null {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('标题不能为空');
  if (trimmed.length > 80) throw new Error('标题不能超过 80 字');

  const result =
    options.touch && options.now !== undefined
      ? db
          .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
          .run(trimmed, options.now, id)
      : db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(trimmed, id);

  return result.changes > 0 ? getConversation(db, id) : null;
}

/**
 * 置顶 / 取消置顶。
 *
 * **刻意不写 `updated_at`**：否则取消置顶后，一条上个月的会话会因为 updated_at
 * 被刷新而跳到列表最前面，把本该在最上面的近期会话挤下去（UI 文档 9.1）。
 */
export function setPinned(
  db: DatabaseDriver,
  id: string,
  pinned: boolean,
  now: number,
): Conversation | null {
  const result = db
    .prepare('UPDATE conversations SET pinned_at = ? WHERE id = ?')
    .run(pinned ? now : null, id);
  return result.changes > 0 ? getConversation(db, id) : null;
}

/** 更新会话配置（模型 / provider / persona / 生成参数）。参数变更视为会话活跃，刷新 updated_at。 */
export interface ConversationPatch {
  personaId?: string | null;
  providerId?: string | null;
  model?: string;
  params?: Partial<GenerationParams>;
  /** 首条消息生成标题时用；为 false 时不动 updated_at */
  touch?: boolean;
}

export function updateConversation(
  db: DatabaseDriver,
  id: string,
  patch: ConversationPatch,
  now: number,
): Conversation | null {
  const existing = getConversation(db, id);
  if (!existing) return null;

  const params: GenerationParams = { ...existing.params, ...patch.params };
  const touch = patch.touch !== false;

  db.prepare(
    `UPDATE conversations SET
       persona_id = ?, provider_id = ?, model = ?, params_json = ?,
       updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END
     WHERE id = ?`,
  ).run(
    patch.personaId === undefined ? existing.personaId : patch.personaId,
    patch.providerId === undefined ? existing.providerId : patch.providerId,
    patch.model ?? existing.model,
    toJsonColumn(params),
    touch ? 1 : 0,
    now,
    id,
  );
  return getConversation(db, id);
}

/** 每轮对话结束后推进 updated_at（驱动列表排序）。 */
export function touchConversation(db: DatabaseDriver, id: string, now: number): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * 删除会话。**一个事务**带走 messages / summaries / conversations（产品设计文档 3.7）。
 * 失败则整笔回滚，UI 不会看到"删了一半"。
 */
export function deleteConversation(db: DatabaseDriver, id: string): { ok: boolean; deleted: { messages: number; summaries: number } } {
  return db.transaction(() => {
    const messages = Number(
      db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
        .get(id)?.n ?? 0,
    );
    const summaries = Number(
      db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?')
        .get(id)?.n ?? 0,
    );
    // 显式删子表，不依赖外键级联是否开启——删除必须是"看得见的动作"。
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    const changes = db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
    return { ok: changes > 0, deleted: { messages, summaries } };
  });
}

/** 删除会话时要展示的统计（UI 文档 4.7 的确认框需要消息数与摘要段数）。 */
export function getConversationStats(
  db: DatabaseDriver,
  id: string,
): { messageCount: number; summaryCount: number } {
  const row = db
    .prepare<{ message_count: number; summary_count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS message_count,
         (SELECT COUNT(*) FROM summaries WHERE conversation_id = ?) AS summary_count`,
    )
    .get(id, id);
  return {
    messageCount: Number(row?.message_count ?? 0),
    summaryCount: Number(row?.summary_count ?? 0),
  };
}
