/**
 * 消息 DAO（产品设计文档 3.5 + 技术方案 7.6）。
 *
 * 三个必须在这里守住的不变量：
 *   1. `sort_order` 由 DAO 分配，调用方不需要关心，避免出现空洞或重号。
 *   2. 流式落库：先插入 `status='streaming'` 的行，崩溃后能被启动清扫找到（验收项 10）。
 *   3. 编辑/截断与摘要的级联失效必须在**同一个事务**里完成（产品设计文档 3.5 冲突规则）。
 */
import type { Message, MessageMetadata, MessageRole, MessageStatus } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { toJsonColumn, toMessage, type MessageRow } from '../mappers.js';

export function listMessages(db: DatabaseDriver, conversationId: string): Message[] {
  return db
    .prepare<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sort_order ASC',
    )
    .all(conversationId)
    .map(toMessage);
}

export function getMessage(db: DatabaseDriver, id: string): Message | null {
  const row = db.prepare<MessageRow>('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? toMessage(row) : null;
}

/** 下一个 sort_order：取当前最大值 + 1，而不是 COUNT，避免删除后重号。 */
function nextSortOrder(db: DatabaseDriver, conversationId: string): number {
  const row = db
    .prepare<{ max_order: number | null }>(
      'SELECT MAX(sort_order) AS max_order FROM messages WHERE conversation_id = ?',
    )
    .get(conversationId);
  return Number(row?.max_order ?? 0) + 1;
}

export interface InsertMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  metadata?: MessageMetadata;
  /** 显式指定排序位次（用于"用开场白重开"或原位重新生成） */
  sortOrder?: number;
}

export function insertMessage(db: DatabaseDriver, input: InsertMessageInput, now: number): Message {
  const id = newId(ID_PREFIX.message);
  db.prepare(
    `INSERT INTO messages
       (id,conversation_id,role,content,metadata_json,archived,status,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.conversationId,
    input.role,
    input.content,
    toJsonColumn(input.metadata ?? {}),
    0,
    input.status ?? 'done',
    input.sortOrder ?? nextSortOrder(db, input.conversationId),
    now,
    now,
  );
  return getMessage(db, id)!;
}

/** 流式期间的增量落库（主进程按 ~500ms 节流调用，技术方案 7.6）。 */
export function appendMessageContent(
  db: DatabaseDriver,
  id: string,
  fullContent: string,
  now: number,
): void {
  db.prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?').run(fullContent, now, id);
}

/** 收尾：写状态与用量元数据。 */
export function finishMessage(
  db: DatabaseDriver,
  id: string,
  status: MessageStatus,
  metadata: MessageMetadata,
  now: number,
): Message | null {
  db.prepare('UPDATE messages SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?').run(
    status,
    toJsonColumn(metadata),
    now,
    id,
  );
  return getMessage(db, id);
}

export function updateMessageContent(
  db: DatabaseDriver,
  id: string,
  content: string,
  now: number,
): Message | null {
  db.prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?').run(content, now, id);
  return getMessage(db, id);
}

export function setMessageArchived(
  db: DatabaseDriver,
  ids: string[],
  archived: boolean,
  now: number,
): void {
  if (!ids.length) return;
  const stmt = db.prepare(
    'UPDATE messages SET archived = ?, updated_at = ? WHERE id = ?',
  );
  for (const id of ids) stmt.run(archived ? 1 : 0, now, id);
}

/** 会话内某区间的消息 id（按 sort_order 升序，1-based 闭区间）。 */
export function messageIdsInRange(
  db: DatabaseDriver,
  conversationId: string,
  from: number,
  to: number,
): string[] {
  const rows = db
    .prepare<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = ? AND sort_order BETWEEN ? AND ?
       ORDER BY sort_order ASC`,
    )
    .all(conversationId, from, to);
  return rows.map((r) => r.id);
}

export function deleteMessage(db: DatabaseDriver, id: string): boolean {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

/**
 * 编辑一条用户消息，可选截断其后全部消息。
 *
 * **级联失效**（产品设计文档 3.5）：
 *   若被截断的区间落在某个摘要的覆盖范围内，该摘要必须一并删除，受影响消息取消归档。
 *   否则会出现"摘要里写着已经删掉的剧情"。整件事在一个事务里完成。
 */
export interface EditAndTruncateResult {
  message: Message;
  /** 被截断掉的消息条数（不含被编辑的这条） */
  truncatedCount: number;
  /** 级联失效的摘要段数 */
  invalidatedSummaries: number;
  /** 取消归档的消息条数 */
  unarchivedCount: number;
}

export function editMessageWithOptionalTruncate(
  db: DatabaseDriver,
  messageId: string,
  content: string,
  truncate: boolean,
  now: number,
): EditAndTruncateResult {
  return db.transaction(() => {
    const message = getMessage(db, messageId);
    if (!message) throw new Error('消息不存在');

    db.prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?').run(content, now, messageId);

    if (!truncate) {
      return {
        message: getMessage(db, messageId)!,
        truncatedCount: 0,
        invalidatedSummaries: 0,
        unarchivedCount: 0,
      };
    }

    const doomed = db
      .prepare<{ id: string; sort_order: number }>(
        'SELECT id, sort_order FROM messages WHERE conversation_id = ? AND sort_order > ? ORDER BY sort_order ASC',
      )
      .all(message.conversationId, message.sortOrder);

    if (!doomed.length) {
      return {
        message: getMessage(db, messageId)!,
        truncatedCount: 0,
        invalidatedSummaries: 0,
        unarchivedCount: 0,
      };
    }

    const firstDoomedOrder = doomed[0]!.sort_order;

    // 任何 coversTo >= 被截断起点的摘要都失去了依据 → 删除
    const hitSummaries = db
      .prepare<{ id: string; covers_from: number; covers_to: number }>(
        'SELECT id, covers_from, covers_to FROM summaries WHERE conversation_id = ? AND covers_to >= ?',
      )
      .all(message.conversationId, firstDoomedOrder);

    let unarchivedCount = 0;
    for (const summary of hitSummaries) {
      // 只处理**会被保留下来**的那部分区间：`sort_order > 被编辑消息` 的行马上就要被删掉，
      // 对它们取消归档既无意义，也会让 UI 文案（"已恢复 N 条"）报出假数字。
      const upper = Math.min(summary.covers_to, message.sortOrder);
      if (upper < summary.covers_from) continue;

      const affected = db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM messages
           WHERE conversation_id = ? AND archived = 1 AND sort_order BETWEEN ? AND ?`,
        )
        .get(message.conversationId, summary.covers_from, upper);
      unarchivedCount += Number(affected?.n ?? 0);

      // 取消归档：这些消息重新回到历史里
      db.prepare(
        `UPDATE messages SET archived = 0, updated_at = ?
         WHERE conversation_id = ? AND archived = 1 AND sort_order BETWEEN ? AND ?`,
      ).run(now, message.conversationId, summary.covers_from, upper);
      db.prepare('DELETE FROM summaries WHERE id = ?').run(summary.id);
    }

    // 删掉被截断的后续消息
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND sort_order > ?').run(
      message.conversationId,
      message.sortOrder,
    );

    return {
      message: getMessage(db, messageId)!,
      truncatedCount: doomed.length,
      invalidatedSummaries: hitSummaries.length,
      unarchivedCount,
    };
  });
}

/** 删除一条消息，并同样处理摘要级联失效。 */
export function deleteMessageWithCascade(
  db: DatabaseDriver,
  messageId: string,
  now: number,
): { deleted: boolean; invalidatedSummaries: number } {
  return db.transaction(() => {
    const message = getMessage(db, messageId);
    if (!message) return { deleted: false, invalidatedSummaries: 0 };

    const hitSummaries = db
      .prepare<{ id: string; covers_from: number; covers_to: number }>(
        'SELECT id, covers_from, covers_to FROM summaries WHERE conversation_id = ? AND covers_to >= ?',
      )
      .all(message.conversationId, message.sortOrder);

    for (const summary of hitSummaries) {
      db.prepare(
        `UPDATE messages SET archived = 0, updated_at = ?
         WHERE conversation_id = ? AND archived = 1 AND sort_order BETWEEN ? AND ?`,
      ).run(now, message.conversationId, summary.covers_from, summary.covers_to);
      db.prepare('DELETE FROM summaries WHERE id = ?').run(summary.id);
    }

    const deleted = db.prepare('DELETE FROM messages WHERE id = ?').run(messageId).changes > 0;
    return { deleted, invalidatedSummaries: hitSummaries.length };
  });
}

/** 删除某条之后（含）的全部消息，同样处理摘要级联失效。 */
export function deleteMessagesFrom(
  db: DatabaseDriver,
  conversationId: string,
  fromSortOrder: number,
  now: number,
): { deletedCount: number; invalidatedSummaries: number } {
  return db.transaction(() => {
    const hitSummaries = db
      .prepare<{ id: string; covers_from: number; covers_to: number }>(
        'SELECT id, covers_from, covers_to FROM summaries WHERE conversation_id = ? AND covers_to >= ?',
      )
      .all(conversationId, fromSortOrder);

    for (const summary of hitSummaries) {
      db.prepare(
        `UPDATE messages SET archived = 0, updated_at = ?
         WHERE conversation_id = ? AND archived = 1 AND sort_order BETWEEN ? AND ?`,
      ).run(now, conversationId, summary.covers_from, summary.covers_to);
      db.prepare('DELETE FROM summaries WHERE id = ?').run(summary.id);
    }

    const deletedCount = db
      .prepare('DELETE FROM messages WHERE conversation_id = ? AND sort_order >= ?')
      .run(conversationId, fromSortOrder).changes;
    return { deletedCount, invalidatedSummaries: hitSummaries.length };
  });
}

/**
 * 启动清扫：把残留的 `streaming` 行改成 `interrupted`（技术方案 7.6 第 4 条）。
 *
 * 必须在注册 IPC 之前执行，否则窗口可能先读到"生成中"的旧状态（验收项 10）。
 */
export function sweepStreamingMessages(db: DatabaseDriver, now: number): number {
  const rows = db
    .prepare<{ id: string; metadata_json: string }>(
      "SELECT id, metadata_json FROM messages WHERE status = 'streaming'",
    )
    .all();

  return db.transaction(() => {
    for (const row of rows) {
      let metadata: MessageMetadata = {};
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === 'object') metadata = parsed as MessageMetadata;
      } catch {
        metadata = {};
      }
      metadata.interrupted = true;
      db.prepare('UPDATE messages SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?').run(
        'interrupted',
        toJsonColumn(metadata),
        now,
        row.id,
      );
    }
    return rows.length;
  });
}

/** 清空会话的全部消息与摘要（"用开场白重开"）。 */
export function clearConversation(
  db: DatabaseDriver,
  conversationId: string,
  now: number,
): { messages: number; summaries: number } {
  return db.transaction(() => {
    const summaries = db
      .prepare('DELETE FROM summaries WHERE conversation_id = ?')
      .run(conversationId).changes;
    const messages = db
      .prepare('DELETE FROM messages WHERE conversation_id = ?')
      .run(conversationId).changes;
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    return { messages, summaries };
  });
}
