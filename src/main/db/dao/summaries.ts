/**
 * 摘要 DAO（产品设计文档 3.4）。
 *
 * MVP 定死为**单层摘要**：摘要不可再被压缩，因此不存在 level=2。
 * `level` 字段保留仅为将来演进；装配时摘要区永远是一组互不重叠、按时间升序的
 * level-1 摘要，语义无歧义。
 *
 * **原子性**（验收项 6/7）：写 `summaries` 与把消息标记 `archived=1` 必须在
 * 同一个事务里，任何一步失败都不留半截状态。
 */
import type { Summary } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { toSummary, type SummaryRow } from '../mappers.js';

export function listSummaries(db: DatabaseDriver, conversationId: string): Summary[] {
  return db
    .prepare<SummaryRow>(
      'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY covers_from ASC',
    )
    .all(conversationId)
    .map(toSummary);
}

export function getSummary(db: DatabaseDriver, id: string): Summary | null {
  const row = db.prepare<SummaryRow>('SELECT * FROM summaries WHERE id = ?').get(id);
  return row ? toSummary(row) : null;
}

/** 取最老的一段连续未归档消息，作为压缩候选区间。 */
export interface CompressionCandidate {
  ids: string[];
  from: number;
  to: number;
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; sortOrder: number }>;
}

export function pickCompressionCandidates(
  db: DatabaseDriver,
  conversationId: string,
  limit: number,
): CompressionCandidate {
  const rows = db
    .prepare<{ id: string; role: string; content: string; sort_order: number }>(
      `SELECT id, role, content, sort_order FROM messages
       WHERE conversation_id = ? AND archived = 0
       ORDER BY sort_order ASC LIMIT ?`,
    )
    .all(conversationId, limit);

  return {
    ids: rows.map((r) => r.id),
    from: rows.length ? rows[0]!.sort_order : 0,
    to: rows.length ? rows[rows.length - 1]!.sort_order : 0,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.content,
      sortOrder: r.sort_order,
    })),
  };
}

export interface WriteSummaryInput {
  conversationId: string;
  content: string;
  coversFrom: number;
  coversTo: number;
  tokenCount: number;
  providerId: string | null;
  model: string;
  /** 被这段摘要覆盖、需要被归档的消息 id */
  archiveMessageIds: string[];
}

/**
 * 写入摘要 + 归档原消息，**同一事务**。
 *
 * 这是压缩算法的第 3、4 步（产品设计文档 3.4）：
 *   3. 写入 summaries 一行，记录 covers_from / covers_to / token_count / level=1 / provider / model
 *   4. 该区间消息标记 archived=1
 */
export function writeSummaryAtomic(
  db: DatabaseDriver,
  input: WriteSummaryInput,
  now: number,
): Summary {
  const id = newId(ID_PREFIX.summary);
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO summaries
         (id,conversation_id,content,covers_from,covers_to,token_count,level,provider_id,model,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.conversationId,
      input.content,
      input.coversFrom,
      input.coversTo,
      input.tokenCount,
      1,
      input.providerId,
      input.model,
      now,
    );

    const stmt = db.prepare('UPDATE messages SET archived = 1, updated_at = ? WHERE id = ?');
    for (const messageId of input.archiveMessageIds) stmt.run(now, messageId);

    return getSummary(db, id)!;
  });
}

/**
 * 恢复一段归档：删除覆盖它的摘要，并把区间内消息取消归档。
 *
 * 恢复语义（产品设计文档 3.4）：恢复某区间 → 删除覆盖它的摘要 → token 占用释放。
 * 这两步同样必须在一个事务里，否则会出现"摘要没了但消息还归档着"。
 */
export function restoreSummary(
  db: DatabaseDriver,
  summaryId: string,
  now: number,
): { restored: boolean; unarchivedCount: number; from: number; to: number } {
  return db.transaction(() => {
    const summary = getSummary(db, summaryId);
    if (!summary) return { restored: false, unarchivedCount: 0, from: 0, to: 0 };

    const unarchivedCount = db
      .prepare(
        `UPDATE messages SET archived = 0, updated_at = ?
         WHERE conversation_id = ? AND archived = 1 AND sort_order BETWEEN ? AND ?`,
      )
      .run(now, summary.conversationId, summary.coversFrom, summary.coversTo).changes;

    db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId);

    return {
      restored: true,
      unarchivedCount,
      from: summary.coversFrom,
      to: summary.coversTo,
    };
  });
}

/** 摘要区间是否与给定区间重叠（用于"这次编辑会不会让某段摘要失效"的预览提示）。 */
export function findSummariesOverlapping(
  db: DatabaseDriver,
  conversationId: string,
  fromSortOrder: number,
): Summary[] {
  return db
    .prepare<SummaryRow>(
      'SELECT * FROM summaries WHERE conversation_id = ? AND covers_to >= ? ORDER BY covers_from ASC',
    )
    .all(conversationId, fromSortOrder)
    .map(toSummary);
}
