/**
 * 用量统计的纯计算（`core`，零平台依赖，可纯 Node 单测）。
 *
 * 为什么分桶不放在 SQL 里：SQLite 没有时区概念，把
 * `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')` 用在毫秒时间戳上会按 **UTC**
 * 切天——UTC+8 的用户在 00:00–08:00 之间发的请求会被算进前一天。
 * 所以 SQL 只取原始行，按本地自然日分桶在这里做，时区从 `Date` 的本地方法天然得到。
 *
 * 三条口径，写在这里也写进测试：
 *
 * 1. **一次生成 = 一次请求**：判据是"存在 assistant 消息"，而不是"有 token 数"。
 *    失败的那次只花输入 token（甚至一个都没花），但它确实发出去了。
 * 2. **没有请求的日子占位为 0**：图表按天等距排列，缺的补 0 而不是跳过。
 * 3. **估算必须能被识别**：任一行 `tokensExact === false` 就把整体标成估算，
 *    UI 据此给数字挂「约」（技术方案第 8 节）。
 */
import type {
  UsageDailyPoint,
  UsageModelStat,
  UsageRangeKey,
  UsageSummary,
} from '@shared/types.js';

/** 与 `main/db/dao/usage.ts` 的 `UsageMessageRow` 结构一致（core 不反向依赖 main）。 */
export interface UsageSourceRow {
  providerId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  tokensExact: boolean;
  failed: boolean;
  createdAt: number;
}

/** 图表 x 轴的硬上限：超过一年就只画最近 366 天，避免返回一个巨大的数组。 */
export const USAGE_MAX_DAYS = 366;

/** 区间键的中文名（UI 下拉直接用它，避免两处各写一份文案）。 */
export const USAGE_RANGE_LABELS: Record<UsageRangeKey, string> = {
  month: '本月',
  week: '近 7 天',
  year: '今年',
  all: '全部',
};

export const USAGE_RANGE_KEYS: UsageRangeKey[] = ['month', 'week', 'year', 'all'];

/** 本地自然日的起点（00:00:00.000）。 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 本地自然日的键：`YYYY-MM-DD`。
 *
 * 刻意不用 `toISOString().slice(0, 10)`——那是 UTC 日期，会把东八区凌晨的请求
 * 归到前一天。这里用本地字段手工拼。
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 在本地日历上平移若干天。用 setDate 而不是加减固定毫秒，跨夏令时也不会错位。 */
function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export interface UsageRangeBounds {
  from: number;
  to: number;
}

/**
 * 把区间键解析成**毫秒闭区间**。
 *
 * - `month`：本地本月 1 日 00:00 → 现在
 * - `year`：本地本年 1 月 1 日 00:00 → 现在
 * - `week`：含今天的最近 7 天（今天 00:00 往前推 6 天）→ 现在
 * - `all`：最早一条记录所在日的 00:00 → 现在；没有任何记录时退化成"今天 00:00 → 现在"
 *   （这样空库的页面是一根零柱，而不是一段空白区间）
 */
export function resolveUsageRange(
  key: UsageRangeKey,
  now: number,
  earliest: number | null,
): UsageRangeBounds {
  const todayStart = startOfLocalDay(now);
  switch (key) {
    case 'month': {
      const d = new Date(now);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return { from: d.getTime(), to: now };
    }
    case 'year': {
      const d = new Date(now);
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return { from: d.getTime(), to: now };
    }
    case 'week':
      return { from: addLocalDays(todayStart, -6), to: now };
    case 'all':
    default:
      return {
        from: earliest === null ? todayStart : startOfLocalDay(earliest),
        to: now,
      };
  }
}

/**
 * 日序列：从起点到终点逐日推进。
 *
 * 超过 `USAGE_MAX_DAYS` 时**保留最后那一段**（最近的天）而不是最前那一段：
 * 图表右边是"现在"，截掉最近几天等于图表在骗人。
 */
function buildDayKeys(from: number, to: number): string[] {
  const firstDay = startOfLocalDay(from);
  const lastDay = startOfLocalDay(to);

  const keys: string[] = [];
  let cursor = firstDay;
  while (cursor <= lastDay && keys.length < USAGE_MAX_DAYS) {
    keys.push(localDayKey(cursor));
    cursor = addLocalDays(cursor, 1);
  }
  if (cursor > lastDay) return keys;

  const tail: string[] = [];
  let c = addLocalDays(lastDay, -(USAGE_MAX_DAYS - 1));
  for (let i = 0; i < USAGE_MAX_DAYS; i += 1) {
    tail.push(localDayKey(c));
    c = addLocalDays(c, 1);
  }
  return tail;
}

const UNKNOWN_MODEL_LABEL = '（未记录模型）';

/**
 * 聚合用量。
 *
 * `rows` 是**已在 SQL 里按区间与 provider 过滤过**的原始行；这里只做分桶与求和，
 * 不重复过滤——否则同一套筛选条件会有两个实现，其中一个迟早写错。
 */
export function aggregateUsage(input: {
  rows: UsageSourceRow[];
  range: UsageRangeKey;
  providerId: string | null;
  now: number;
  earliest: number | null;
}): UsageSummary {
  const { rows, range, providerId, now, earliest } = input;
  const bounds = resolveUsageRange(range, now, earliest);

  const dayKeys = buildDayKeys(bounds.from, bounds.to);
  const dayIndex = new Map<string, number>();
  dayKeys.forEach((key, index) => dayIndex.set(key, index));
  const daily: UsageDailyPoint[] = dayKeys.map((day) => ({
    day,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokens: 0,
  }));

  const modelIndex = new Map<string, UsageModelStat>();
  let requests = 0;
  let failedRequests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningRequests = 0;
  let anyEstimated = false;

  for (const row of rows) {
    requests += 1;
    if (row.failed) failedRequests += 1;
    if (row.reasoningTokens > 0) reasoningRequests += 1;
    if (!row.tokensExact) anyEstimated = true;

    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    const rowTokens = row.promptTokens + row.completionTokens;

    const daySlot = daily[dayIndex.get(localDayKey(row.createdAt)) ?? -1];
    if (daySlot) {
      daySlot.requests += 1;
      daySlot.promptTokens += row.promptTokens;
      daySlot.completionTokens += row.completionTokens;
      daySlot.tokens += rowTokens;
    }

    const modelKey = row.model.trim() || UNKNOWN_MODEL_LABEL;
    let stat = modelIndex.get(modelKey);
    if (!stat) {
      stat = { model: modelKey, requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 };
      modelIndex.set(modelKey, stat);
    }
    stat.requests += 1;
    stat.promptTokens += row.promptTokens;
    stat.completionTokens += row.completionTokens;
    stat.tokens += rowTokens;
  }

  // 模型明细按总量倒序：用得最多的那个排最前（并列时按名字，保证顺序稳定可断言）
  const models = [...modelIndex.values()].sort(
    (a, b) => b.tokens - a.tokens || b.requests - a.requests || a.model.localeCompare(b.model),
  );

  return {
    range,
    providerId,
    from: bounds.from,
    to: bounds.to,
    daily,
    activeDays: daily.filter((d) => d.requests > 0).length,
    models,
    requests,
    failedRequests,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens,
    reasoningRequests,
    anyEstimated,
  };
}

/**
 * 图表 x 轴要显示标签的下标。
 *
 * 不是每天都标——366 个标签会糊成一条灰带。规则是"至多 `maxLabels` 个、
 * 尽量均匀、且**一定包含最后一天**"：时间序列的右端是"现在"，
 * 少了它用户就没法把柱子和"今天"对上。
 *
 * 首尾两个刻度是固定的，中间按 `ceil(last / (maxLabels - 1))` 的步长铺——
 * 用 `ceil` 而不是 `floor`，标签数就不会越过上限（`floor` 会多挤出一个来）。
 * 末尾那个刻度离最后一天太近时**换掉**而不是追加，否则两个标签会叠在一起。
 *
 * 放在 core 而不是页面里：它是纯计算，且"标签数不能超上限、必须含末尾"这两条
 * 都要能被单测逐个边界钉住（`total` 从 1 到 366）。
 */
export function usageAxisTicks(daily: UsageDailyPoint[], maxLabels = 6): number[] {
  const total = daily.length;
  if (total === 0) return [];
  if (total <= maxLabels) return daily.map((_, index) => index);
  if (maxLabels < 2) return [total - 1];

  const last = total - 1;
  const step = Math.max(1, Math.ceil(last / (maxLabels - 1)));
  const ticks: number[] = [];
  for (let i = 0; i < last; i += step) ticks.push(i);

  const tail = ticks[ticks.length - 1]!;
  if (last - tail < step / 2) ticks[ticks.length - 1] = last;
  else ticks.push(last);
  return ticks;
}

/** 纵轴上限向上取整到一个好读的刻度（1 / 2 / 5 × 10^n）。 */
export function usageAxisMax(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const factor of [1, 2, 5, 10]) {
    if (peak <= magnitude * factor) return magnitude * factor;
  }
  return magnitude * 10;
}
