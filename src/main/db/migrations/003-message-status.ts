/**
 * 003 — 消息生成状态。
 *
 * 来源：docs/tech-stack.md 5.2 迁移清单 + 7.6 崩溃恢复。
 * 崩溃恢复需要能定位"残留的生成中行"，因此状态必须落库而不是只存在内存里。
 */
import type { DatabaseDriver } from '../driver.js';

export const id = '003';
export const name = 'message-status';

export function up(db: DatabaseDriver): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
      CHECK (status IN ('streaming','done','interrupted','error'));
    CREATE INDEX idx_messages_status ON messages (status);
  `);
}
