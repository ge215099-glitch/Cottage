/**
 * 用量 DAO 与服务测试（真实 SQLite，走 `node:sqlite`，不需要原生模块）。
 *
 * 与 `test/usage.test.ts` 的分工：那边测纯函数的统计口径，这边测**数据取得对不对**——
 * `json_extract` 的过滤、坏 JSON 的兜底、按 provider 分组取最新时间。
 * 这两类错误的表现完全不同：口径错了是"数字不对"，取数错了是"整块空白或串行"。
 */
import { describe, expect, it } from 'vitest';
import {
  earliestUsageAt,
  listUsageMessages,
  providerLastUsedMap,
} from '../src/main/db/dao/usage.js';
import { buildUsageSummary } from '../src/main/services/usage.js';
import { listProviders } from '../src/main/db/dao/providers.js';
import { createProvider } from '../src/main/db/dao/providers.js';
import { openMigratedDb } from './helpers/db.js';

const NOW = new Date(2026, 9, 6, 14, 30, 0, 0).getTime();
const T0 = new Date(2026, 9, 4, 10, 0, 0, 0).getTime();

/** 建一条最小可用的会话（消息要挂外键）。 */
function seedConversation(db: ReturnType<typeof openMigratedDb>, id = 'cnv_1'): void {
  db.prepare(
    `INSERT INTO characters (id,name,raw_json,created_at,updated_at) VALUES (?,?,?,?,?)`,
  ).run('chr_1', '爱丽丝', '{}', T0, T0);
  db.prepare(
    `INSERT INTO conversations (id,title,character_id,created_at,updated_at) VALUES (?,?,?,?,?)`,
  ).run(id, '会话', 'chr_1', T0, T0);
}

let seq = 0;
function seedMessage(
  db: ReturnType<typeof openMigratedDb>,
  options: {
    role?: string;
    status?: string;
    metadata?: unknown;
    raw?: string;
    createdAt?: number;
    conversationId?: string;
  } = {},
): void {
  seq += 1;
  const id = `msg_${seq}`;
  const metadata =
    options.raw ??
    JSON.stringify(options.metadata ?? { providerId: 'prv_1', model: 'deepseek-chat', promptTokens: 100, completionTokens: 50, tokensExact: true });
  db.prepare(
    `INSERT INTO messages (id,conversation_id,role,content,metadata_json,status,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    options.conversationId ?? 'cnv_1',
    options.role ?? 'assistant',
    '内容',
    metadata,
    options.status ?? 'done',
    seq,
    options.createdAt ?? T0,
    options.createdAt ?? T0,
  );
}

describe('用量取数', () => {
  it('只取 assistant 消息：用户消息的元数据不参与统计', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { role: 'user', metadata: { promptTokens: 999 } });
    seedMessage(db, { role: 'assistant', metadata: { promptTokens: 100, completionTokens: 50 } });

    const rows = listUsageMessages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.promptTokens).toBe(100);
    db.close();
  });

  it('坏 JSON 的列在 SQL 里就被挡掉，不会让整页挂掉', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { raw: '这不是 JSON' });
    seedMessage(db, { metadata: { promptTokens: 7, completionTokens: 3 } });

    const rows = listUsageMessages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.promptTokens).toBe(7);
    db.close();
  });

  it('元数据里缺字段的行降级为 0 而不是 NaN', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { metadata: { providerId: 'prv_1' } });

    const rows = listUsageMessages(db);
    expect(rows[0]).toMatchObject({ model: '', promptTokens: 0, completionTokens: 0 });
    // 没写 tokensExact 的历史行按估算处理：宁可挂「约」也不冒充精确值
    expect(rows[0]!.tokensExact).toBe(false);
    db.close();
  });

  it('按 provider 过滤走 json_extract；不过滤时返回全部', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { metadata: { providerId: 'prv_1', promptTokens: 10 } });
    seedMessage(db, { metadata: { providerId: 'prv_2', promptTokens: 20 } });

    expect(listUsageMessages(db)).toHaveLength(2);
    const only = listUsageMessages(db, { providerId: 'prv_2' });
    expect(only).toHaveLength(1);
    expect(only[0]!.promptTokens).toBe(20);
    expect(listUsageMessages(db, { providerId: 'prv_missing' })).toHaveLength(0);
    db.close();
  });

  it('时间区间是闭区间，边界当天的记录不会被漏掉', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { createdAt: 1000 });
    seedMessage(db, { createdAt: 2000 });
    seedMessage(db, { createdAt: 3000 });

    expect(listUsageMessages(db, { from: 2000, to: 3000 })).toHaveLength(2);
    db.close();
  });

  it('error 状态的行被标记为失败，但仍然计入请求', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { status: 'error', metadata: { providerId: 'prv_1', error: { code: 'TIMEOUT', message: 'x', retryable: true } } });

    const rows = listUsageMessages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failed).toBe(true);
    db.close();
  });

  it('providerLastUsedMap 每个 provider 取最新的时间', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { metadata: { providerId: 'prv_1' }, createdAt: 1000 });
    seedMessage(db, { metadata: { providerId: 'prv_1' }, createdAt: 5000 });
    seedMessage(db, { metadata: { providerId: 'prv_2' }, createdAt: 2000 });
    // 没有 providerId 的行不进分组
    seedMessage(db, { metadata: {}, createdAt: 9000 });

    const map = providerLastUsedMap(db);
    expect(map.get('prv_1')).toBe(5000);
    expect(map.get('prv_2')).toBe(2000);
    expect(map.size).toBe(2);
    db.close();
  });

  it('earliestUsageAt 只看 assistant 消息；空库返回 null', () => {
    const db = openMigratedDb();
    seedConversation(db);
    expect(earliestUsageAt(db)).toBeNull();

    seedMessage(db, { role: 'user', createdAt: 500 });
    seedMessage(db, { createdAt: 1500 });
    expect(earliestUsageAt(db)).toBe(1500);
    db.close();
  });

  it('Provider 列表带上「最新使用日期」，从未用过的是 null', () => {
    const db = openMigratedDb();
    seedConversation(db);
    createProvider(
      db,
      {
        name: '用过的',
        type: 'openai',
        baseUrl: 'https://a.invalid/v1',
        models: [],
        defaultModel: 'm',
        compressionModel: 'm',
        enabled: true,
      },
      { now: T0 },
    );
    createProvider(
      db,
      {
        name: '没用过的',
        type: 'openai',
        baseUrl: 'https://b.invalid/v1',
        models: [],
        defaultModel: 'm',
        compressionModel: 'm',
        enabled: true,
      },
      { now: T0 },
    );

    const providers = listProviders(db);
    const used = providers.find((p) => p.name === '用过的')!;
    seedMessage(db, { metadata: { providerId: used.id, promptTokens: 1 }, createdAt: 7777 });

    const after = listProviders(db);
    expect(after.find((p) => p.name === '用过的')!.lastUsedAt).toBe(7777);
    expect(after.find((p) => p.name === '没用过的')!.lastUsedAt).toBeNull();
    db.close();
  });
});

describe('用量服务', () => {
  it('本月区间把区间外的记录排除在外', () => {
    const db = openMigratedDb();
    seedConversation(db);
    // 上个月的一条 + 本月的一条
    const lastMonth = new Date(2026, 8, 20, 12).getTime();
    const thisMonth = new Date(2026, 9, 5, 12).getTime();
    seedMessage(db, { createdAt: lastMonth, metadata: { providerId: 'prv_1', promptTokens: 1, completionTokens: 0 } });
    seedMessage(db, { createdAt: thisMonth, metadata: { providerId: 'prv_1', promptTokens: 40, completionTokens: 2 } });

    const summary = buildUsageSummary(db, { range: 'month' }, NOW);
    expect(summary.requests).toBe(1);
    expect(summary.promptTokens).toBe(40);
    expect(summary.daily.map((d) => d.day)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    db.close();
  });

  it('全部区间从最早一条记录那天开始', () => {
    const db = openMigratedDb();
    seedConversation(db);
    const first = new Date(2026, 6, 3, 9).getTime();
    seedMessage(db, { createdAt: first, metadata: { providerId: 'prv_1', promptTokens: 5 } });

    const summary = buildUsageSummary(db, { range: 'all' }, NOW);
    expect(summary.daily[0]!.day).toBe('2026-07-03');
    expect(summary.daily[summary.daily.length - 1]!.day).toBe('2026-10-06');
    db.close();
  });

  it('空库返回一根零柱，而不是空数组（图表要有基线）', () => {
    const db = openMigratedDb();
    const summary = buildUsageSummary(db, { range: 'month' }, NOW);
    expect(summary.requests).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.daily.length).toBe(6);
    expect(summary.daily.every((d) => d.tokens === 0)).toBe(true);
    db.close();
  });

  it('传 providerId 时只统计那一把 Key，并原样回传', () => {
    const db = openMigratedDb();
    seedConversation(db);
    seedMessage(db, { metadata: { providerId: 'prv_1', promptTokens: 10 }, createdAt: new Date(2026, 9, 5, 9).getTime() });
    seedMessage(db, { metadata: { providerId: 'prv_2', promptTokens: 90 }, createdAt: new Date(2026, 9, 5, 10).getTime() });

    const summary = buildUsageSummary(db, { range: 'month', providerId: 'prv_1' }, NOW);
    expect(summary.providerId).toBe('prv_1');
    expect(summary.requests).toBe(1);
    expect(summary.promptTokens).toBe(10);
    db.close();
  });

  it('缺省区间是本月（不传 range 也有确定行为）', () => {
    const db = openMigratedDb();
    const summary = buildUsageSummary(db, {}, NOW);
    expect(summary.range).toBe('month');
    expect(summary.providerId).toBeNull();
    db.close();
  });
});
