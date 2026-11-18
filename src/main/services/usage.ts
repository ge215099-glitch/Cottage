/**
 * 用量统计服务：把"区间的解析 → SQL 取行 → 纯函数聚合"三步串起来。
 *
 * 只有这三步，没有缓存。理由是**这个页面是用户主动打开的只读投影**，
 * 而缓存会引入"刚聊完但用量没变"的错位感；单次扫描在本产品的量级
 * （几千到几万条消息）下是毫秒级。
 */
import { aggregateUsage, resolveUsageRange } from '@core/usage/index.js';
import type { UsageRangeKey, UsageSummary } from '@shared/types.js';
import type { DatabaseDriver } from '../db/driver.js';
import { earliestUsageAt, listUsageMessages } from '../db/dao/usage.js';

export interface UsageSummaryInput {
  range?: UsageRangeKey;
  providerId?: string | null;
}

export function buildUsageSummary(
  db: DatabaseDriver,
  input: UsageSummaryInput = {},
  now: number = Date.now(),
): UsageSummary {
  const range: UsageRangeKey = input.range ?? 'month';
  const providerId = input.providerId ?? null;
  const earliest = earliestUsageAt(db);

  /*
   * 区间解析要先于 SQL：`all` 的起点就是"最早一条记录所在日"，
   * 而它同时也是 SQL 的下界。先算出来再传下去，避免 SQL 里再写一次同样的判断。
   */
  const bounds = resolveUsageRange(range, now, earliest);
  const rows = listUsageMessages(db, { from: bounds.from, to: bounds.to, providerId });

  return aggregateUsage({ rows, range, providerId, now, earliest });
}
