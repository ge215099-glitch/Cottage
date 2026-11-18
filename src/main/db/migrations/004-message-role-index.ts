/**
 * 004 — messages.role 索引。
 *
 * 来源：用量模块（`docs/product-design.md` 3.4）。
 *
 * 用量统计要扫"全部 assistant 消息的 metadata_json"，这条索引让扫描落在
 * `role = 'assistant'` 这个最粗的过滤条件上，而不是整表。
 *
 * **刻意不建统计专表**：每条 assistant 消息的 `metadata_json` 里已经有
 * `providerId / model / promptTokens / completionTokens`，用量是它们的**派生只读投影**。
 * 另建一张采集表会立刻多出两个真相来源——一旦生成流程漏写采集行，用量就会静默少算，
 * 而"少算"是没人会发现的那种错。
 */
import type { DatabaseDriver } from '../driver.js';

export const id = '004';
export const name = 'message-role-index';

export function up(db: DatabaseDriver): void {
  db.exec('CREATE INDEX idx_messages_role ON messages (role);');
}
