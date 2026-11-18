/**
 * 用量统计 DAO。
 *
 * **只读，且不新建采集表**：每条 assistant 消息的 `metadata_json` 里已经有
 * `providerId / model / promptTokens / completionTokens / reasoningTokens / tokensExact`，
 * 用量就是它们的派生投影。另建一张统计表会立刻多出一个真相来源——
 * 生成流程一旦漏写采集行，用量就静默少算，而"少算"没人会发现。
 *
 * 两个刻意的口径：
 *
 * 1. **SQL 只负责取回原始行**（谁、哪个模型、多少 token、精不精确），
 *    按"本地自然日"分桶、补齐空日、算区间这些事全在 `core` 的纯函数里做。
 *    SQLite 没有时区概念，把 `strftime('%Y-%m-%d')` 用在毫秒时间戳上会按 UTC 切天，
 *    于是 UTC+8 的用户在 0:00–8:00 之间的请求会被算到前一天去。
 * 2. **一次生成 = 一次请求**：判据是"存在 assistant 消息"，而不是"有 token 数"。
 *    上游报错、正文为空、超时这几种失败也会留下 assistant 消息（带 error 元数据），
 *    它们确实发出去了请求，只是没花到输出 token。
 */
import type { MessageMetadata } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { parseJsonColumn, messageMetadataSchema } from '../mappers.js';

/** 一行原始用量记录：已经是 camelCase，分桶由 core 负责。 */
export interface UsageMessageRow {
  providerId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  tokensExact: boolean;
  failed: boolean;
  createdAt: number;
}

interface RawUsageRow {
  metadata_json: string;
  status: string;
  created_at: number;
}

/**
 * 取回用量明细。
 *
 * 用 `json_valid(metadata_json)` 而不是只靠 `parseJsonColumn` 兜底：坏 JSON 的列
 * 在 SQL 里就被挡掉，不必把整表搬进内存再逐条丢弃。解析**仍然走 schema**
 * （技术方案 5.3：JSON 列禁止裸读），坏数据降级为 0 而不是让整页挂掉。
 *
 * `from` / `to` 是毫秒时间戳的闭区间；不传表示不限时间。
 */
export function listUsageMessages(
  db: DatabaseDriver,
  range: { from?: number; to?: number; providerId?: string | null } = {},
): UsageMessageRow[] {
  const conditions = ["role = 'assistant'", 'json_valid(metadata_json)'];
  const params: Array<string | number> = [];

  if (typeof range.from === 'number') {
    conditions.push('created_at >= ?');
    params.push(range.from);
  }
  if (typeof range.to === 'number') {
    conditions.push('created_at <= ?');
    params.push(range.to);
  }

  /*
   * provider 筛选走 `json_extract`。
   *
   * 不能过滤 `providerId IS NULL` 那种"没记 provider"的行——它们是真的没有归属，
   * 而"筛选某个 Key"是一个明确的限定条件。也不做 NULL 回落到会话表：
   * 消息落库时 provider 一定已经解析出来了（`beginGeneration` 决定），
   * 补一条回落规则只会让同一件事有两个算法。
   */
  if (range.providerId) {
    conditions.push("json_extract(metadata_json, '$.providerId') = ?");
    params.push(range.providerId);
  }

  const rows = db
    .prepare<RawUsageRow>(
      `SELECT metadata_json, status, created_at
         FROM messages
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ASC`,
    )
    .all(...params);

  return rows.map((row) => {
    const metadata: MessageMetadata = parseJsonColumn<MessageMetadata>(
      row.metadata_json,
      messageMetadataSchema,
      {},
      'messages.metadata_json#usage',
    );
    return {
      providerId: typeof metadata.providerId === 'string' ? metadata.providerId : null,
      model: typeof metadata.model === 'string' ? metadata.model : '',
      promptTokens: numberOr0(metadata.promptTokens),
      completionTokens: numberOr0(metadata.completionTokens),
      reasoningTokens: numberOr0(metadata.reasoningTokens),
      // 缺省视为估算：没写 tokensExact 的历史行宁可挂「约」，也不冒充精确值
      tokensExact: metadata.tokensExact === true,
      failed: row.status === 'error',
      createdAt: Number(row.created_at),
    };
  });
}

/**
 * 每个 provider 最近一次被使用的时间（毫秒）；从未用过的不在结果里。
 *
 * 供 API Key 列表的「最新使用日期」列使用。`providers` 表的行**不落这个字段**：
 * 它是消息的事实，不是配置的属性。
 */
export function providerLastUsedMap(db: DatabaseDriver): Map<string, number> {
  const rows = db
    .prepare<{ provider_id: string; last_used: number }>(
      `SELECT json_extract(metadata_json, '$.providerId') AS provider_id,
              MAX(created_at) AS last_used
         FROM messages
        WHERE role = 'assistant'
          AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.providerId') IS NOT NULL
        GROUP BY provider_id`,
    )
    .all();

  const map = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.provider_id === 'string' && row.provider_id.length) {
      map.set(row.provider_id, Number(row.last_used));
    }
  }
  return map;
}

/**
 * 单个 provider 最近一次被使用的时间（毫秒）；从未用过为 null。
 *
 * 与 `providerLastUsedMap` 是同一口径的两种形态：列表要 N 条（一次分组查询就够），
 * 详情只要 1 条（没必要为它把整张表分组一遍）。
 */
export function providerLastUsedAt(db: DatabaseDriver, id: string): number | null {
  const row = db
    .prepare<{ last_used: number | null }>(
      `SELECT MAX(created_at) AS last_used
         FROM messages
        WHERE role = 'assistant'
          AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.providerId') = ?`,
    )
    .get(id);
  return typeof row?.last_used === 'number' ? row.last_used : null;
}

/** 最早一条 assistant 消息的时间（毫秒）；一条都没有时为 null。 */
export function earliestUsageAt(db: DatabaseDriver): number | null {
  const row = db
    .prepare<{ first_at: number | null }>(
      "SELECT MIN(created_at) AS first_at FROM messages WHERE role = 'assistant'",
    )
    .get();
  const value = row?.first_at;
  return typeof value === 'number' ? value : null;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
