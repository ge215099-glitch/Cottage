/**
 * 用量统计的纯函数测试。
 *
 * 这里守的是**最容易悄悄错的那部分**：本地时区切天。SQLite 没有时区概念，
 * 一旦把分桶放回 SQL（或改用 `toISOString().slice(0,10)`），东八区凌晨的请求
 * 就会被算到前一天去——而这种错在界面上只表现为"某天数字偏小"，没人会去查。
 */
import { describe, expect, it } from 'vitest';
import {
  USAGE_MAX_DAYS,
  aggregateUsage,
  localDayKey,
  resolveUsageRange,
  startOfLocalDay,
  usageAxisMax,
  usageAxisTicks,
  type UsageSourceRow,
} from '../src/core/usage/index.js';

/** 2026-10-06 14:30 本地时间。用本地构造器，测试与运行机器的时区无关。 */
const NOW = new Date(2026, 9, 6, 14, 30, 0, 0).getTime();

function row(overrides: Partial<UsageSourceRow> = {}): UsageSourceRow {
  return {
    providerId: 'prv_1',
    model: 'deepseek-chat',
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    tokensExact: true,
    failed: false,
    createdAt: NOW,
    ...overrides,
  };
}

/** 某个本地日的某个小时（用本地构造器，避免写死 UTC 时刻）。 */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe('本地日切分', () => {
  it('localDayKey 用本地字段而不是 UTC 日期', () => {
    // 本地 00:30 在东八区是"前一天 16:30 UTC"；若用 toISOString 就会归错天
    expect(localDayKey(at(2026, 10, 6, 0, 30))).toBe('2026-10-06');
    expect(localDayKey(at(2026, 10, 6, 23, 59))).toBe('2026-10-06');
  });

  it('startOfLocalDay 落在本地 00:00', () => {
    const start = new Date(startOfLocalDay(NOW));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(localDayKey(start.getTime())).toBe('2026-10-06');
  });
});

describe('区间解析', () => {
  it('本月从 1 日 00:00 起', () => {
    const bounds = resolveUsageRange('month', NOW, null);
    expect(localDayKey(bounds.from)).toBe('2026-10-01');
    expect(new Date(bounds.from).getHours()).toBe(0);
    expect(bounds.to).toBe(NOW);
  });

  it('今年从 1 月 1 日 00:00 起', () => {
    const bounds = resolveUsageRange('year', NOW, null);
    expect(localDayKey(bounds.from)).toBe('2026-01-01');
  });

  it('近 7 天含今天，从 6 天前的 00:00 起', () => {
    const bounds = resolveUsageRange('week', NOW, null);
    expect(localDayKey(bounds.from)).toBe('2026-09-30');
    expect(localDayKey(bounds.to)).toBe('2026-10-06');
  });

  it('全部从最早一条记录那天起；一条都没有时退化成"今天"', () => {
    const withData = resolveUsageRange('all', NOW, at(2025, 3, 9, 8));
    expect(localDayKey(withData.from)).toBe('2025-03-09');

    const empty = resolveUsageRange('all', NOW, null);
    expect(localDayKey(empty.from)).toBe('2026-10-06');
  });
});

describe('聚合', () => {
  it('请求数按 assistant 消息计数，失败也计入但单独统计', () => {
    const summary = aggregateUsage({
      rows: [
        row({ promptTokens: 100, completionTokens: 50 }),
        row({ failed: true, promptTokens: 80, completionTokens: 0 }),
      ],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });

    expect(summary.requests).toBe(2);
    expect(summary.failedRequests).toBe(1);
    expect(summary.promptTokens).toBe(180);
    expect(summary.completionTokens).toBe(50);
    expect(summary.tokens).toBe(230);
  });

  it('没有请求的日子占位为 0，日序列长度等于区间天数', () => {
    const summary = aggregateUsage({
      rows: [row({ createdAt: at(2026, 10, 4) })],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });

    expect(summary.daily.map((d) => d.day)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(summary.daily.map((d) => d.requests)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(summary.activeDays).toBe(1);
  });

  it('同一份行按本地日分桶，凌晨的请求不会被算到前一天', () => {
    const summary = aggregateUsage({
      rows: [
        row({ createdAt: at(2026, 10, 5, 23, 50), promptTokens: 10, completionTokens: 0 }),
        row({ createdAt: at(2026, 10, 6, 0, 10), promptTokens: 20, completionTokens: 0 }),
      ],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });

    const byDay = new Map(summary.daily.map((d) => [d.day, d.tokens]));
    expect(byDay.get('2026-10-05')).toBe(10);
    expect(byDay.get('2026-10-06')).toBe(20);
  });

  it('按模型分组并按合计倒序；模型缺失归到「（未记录模型）」', () => {
    const summary = aggregateUsage({
      rows: [
        row({ model: 'deepseek-chat', promptTokens: 10, completionTokens: 10 }),
        row({ model: 'deepseek-reasoner', promptTokens: 500, completionTokens: 500 }),
        row({ model: '', promptTokens: 1, completionTokens: 1 }),
      ],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });

    expect(summary.models.map((m) => m.model)).toEqual([
      'deepseek-reasoner',
      'deepseek-chat',
      '（未记录模型）',
    ]);
    expect(summary.models[0]!.tokens).toBe(1000);
  });

  it('任一行是估算值就把整体标成估算（UI 据此挂「约」）', () => {
    const exact = aggregateUsage({
      rows: [row({ tokensExact: true })],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });
    expect(exact.anyEstimated).toBe(false);

    const mixed = aggregateUsage({
      rows: [row({ tokensExact: true }), row({ tokensExact: false })],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });
    expect(mixed.anyEstimated).toBe(true);
  });

  it('思考型模型的思考次数单独统计', () => {
    const summary = aggregateUsage({
      rows: [row({ reasoningTokens: 120 }), row({ reasoningTokens: 0 })],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });
    expect(summary.reasoningRequests).toBe(1);
  });

  it('区间外的行不会被算进来（SQL 的过滤结果被如实采用）', () => {
    // 这里刻意只放区间内的行——聚合不重复过滤，边界由 SQL + resolveUsageRange 保证
    const summary = aggregateUsage({
      rows: [row({ createdAt: at(2026, 9, 30, 23) })],
      range: 'month',
      providerId: null,
      now: NOW,
      earliest: null,
    });
    expect(summary.requests).toBe(1);
    expect(summary.daily.every((d) => d.requests === 0)).toBe(true);
    expect(summary.activeDays).toBe(0);
  });

  it('providerId 原样回传，便于 UI 确认"当前看的是哪一把 Key"', () => {
    const summary = aggregateUsage({
      rows: [],
      range: 'week',
      providerId: 'prv_9',
      now: NOW,
      earliest: null,
    });
    expect(summary.providerId).toBe('prv_9');
    expect(summary.range).toBe('week');
  });

  it('区间超过上限时保留最近的那一段，而不是最早的那一段', () => {
    const summary = aggregateUsage({
      rows: [],
      range: 'all',
      providerId: null,
      now: NOW,
      earliest: at(2015, 1, 1),
    });
    expect(summary.daily).toHaveLength(USAGE_MAX_DAYS);
    expect(summary.daily[summary.daily.length - 1]!.day).toBe('2026-10-06');
  });
});

describe('图表坐标', () => {
  it('纵轴上限向上取到 1/2/5 × 10^n', () => {
    expect(usageAxisMax(0)).toBe(1);
    expect(usageAxisMax(1)).toBe(1);
    expect(usageAxisMax(1.5)).toBe(2);
    expect(usageAxisMax(3)).toBe(5);
    expect(usageAxisMax(7)).toBe(10);
    expect(usageAxisMax(1200)).toBe(2000);
  });

  it('x 轴标签至多 6 个，且一定含最后一天', () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({
      day: `2026-10-${String(i + 1).padStart(2, '0')}`,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
    }));
    const ticks = usageAxisTicks(daily);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(29);
  });

  it('天数少于标签上限时每天都标', () => {
    const daily = Array.from({ length: 5 }, (_, i) => ({
      day: `2026-10-0${i + 1}`,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
    }));
    expect(usageAxisTicks(daily)).toEqual([0, 1, 2, 3, 4]);
  });

  it('标签数上限在各种天数下都不被突破，且末尾一定在', () => {
    // 这条把 total 从 6 铺到 400：步长必须用 ceil 算，才不会在某个 total 上
    // 正好多挤出一个标签（用 floor 时实测 total=30 就会得到 7 个）。
    for (const total of [6, 7, 12, 30, 31, 60, 180, 366, 400]) {
      const daily = Array.from({ length: total }, (_, i) => ({
        day: `2026-01-01+${i}`,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        tokens: 0,
      }));
      const ticks = usageAxisTicks(daily);
      expect(ticks.length, `total=${total} 时标签数超了`).toBeLessThanOrEqual(6);
      expect(ticks[0], `total=${total} 时首个标签不是 0`).toBe(0);
      expect(ticks[ticks.length - 1], `total=${total} 时最后一个标签不是末尾`).toBe(total - 1);
      expect([...new Set(ticks)].length, `total=${total} 时标签重复`).toBe(ticks.length);
      for (let i = 1; i < ticks.length; i += 1) {
        expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
      }
    }
  });

  it('空序列返回空，恰好等于上限时每天都标', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        day: `d${i}`,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        tokens: 0,
      }));
    expect(usageAxisTicks([])).toEqual([]);
    expect(usageAxisTicks(make(1))).toEqual([0]);
    expect(usageAxisTicks(make(6))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
