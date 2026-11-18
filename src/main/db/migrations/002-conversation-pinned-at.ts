/**
 * 002 — 会话置顶。
 *
 * 来源：docs/ui-design-conversation.md 第 9.1 节
 * （`ALTER TABLE conversations ADD COLUMN pinned_at INTEGER` + 索引）。
 *
 * 语义：NULL = 未置顶；非空 = 置顶时刻（毫秒）。
 * 配套硬规则：**写 pinned_at 不得触碰 updated_at**，由 DAO 层测试覆盖。
 */
import type { DatabaseDriver } from '../driver.js';

export const id = '002';
export const name = 'conversation-pinned-at';

export function up(db: DatabaseDriver): void {
  db.exec(`
    ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;
    CREATE INDEX idx_conversations_pinned ON conversations (pinned_at DESC);
  `);
}
