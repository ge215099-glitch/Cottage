/**
 * 迁移机制测试（产品设计文档第 4 节约束 + 技术方案 5.2 + 验收项 5/6）。
 *
 * 对应验收清单：
 *   - 从空库启动到最新版本可一次性完成
 *   - 重复启动幂等（连续三次 user_version 与表结构不变）
 *   - 迁移中途失败时整条回滚（不留半截状态）
 */
import { describe, expect, it } from 'vitest';
import { LATEST_VERSION, MIGRATIONS, migrate } from '../src/main/db/migrations/index.js';
import { openRawDb, tableNames, tableSql, indexNames } from './helpers/db.js';

describe('迁移机制', () => {
  it('空库一次启动推到最新版本', () => {
    const db = openRawDb();
    expect(db.getUserVersion()).toBe(0);

    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_VERSION);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    db.close();
  });

  it('001 建出产品设计文档第 4 节要求的全部实体与索引', () => {
    const db = openRawDb();
    migrate(db);

    expect(tableNames(db)).toEqual([
      'app_settings',
      'characters',
      'conversations',
      'messages',
      'personas',
      'providers',
      'summaries',
    ]);

    // 索引清单（产品设计文档第 4 节"索引至少覆盖"）
    expect(indexNames(db, 'messages')).toContain('idx_messages_conv_order');
    expect(indexNames(db, 'messages')).toContain('idx_messages_conv_archived');
    expect(indexNames(db, 'summaries')).toContain('idx_summaries_conv_from');
    expect(indexNames(db, 'conversations')).toContain('idx_conversations_updated');
    // 002 追加的置顶索引
    expect(indexNames(db, 'conversations')).toContain('idx_conversations_pinned');
    // 003 追加的状态索引
    expect(indexNames(db, 'messages')).toContain('idx_messages_status');
    db.close();
  });

  it('每张表都带 created_at / updated_at（app_settings 与 summaries 按文档约定）', () => {
    const db = openRawDb();
    migrate(db);

    for (const table of ['providers', 'characters', 'personas', 'conversations', 'messages']) {
      const sql = tableSql(db, table) ?? '';
      expect(sql, `${table} 必须有 created_at`).toContain('created_at');
      expect(sql, `${table} 必须有 updated_at`).toContain('updated_at');
    }
    expect(tableSql(db, 'app_settings') ?? '').toContain('updated_at');
    expect(tableSql(db, 'summaries') ?? '').toContain('created_at');
    db.close();
  });

  it('summaries 记录生成它的 provider 与 model', () => {
    const sql = tableSql(openMigrated(), 'summaries') ?? '';
    expect(sql).toContain('provider_id');
    expect(sql).toContain('model');
    expect(sql).toContain('level');
  });

  it('重复启动幂等：连续三次后 user_version 与表结构不变', () => {
    const db = openRawDb();
    migrate(db);

    const versionAfterFirst = db.getUserVersion();
    const schemaAfterFirst = tableNames(db).map((t) => tableSql(db, t));
    const indexesAfterFirst = indexNames(db, 'messages').concat(indexNames(db, 'conversations'));

    const second = migrate(db);
    const third = migrate(db);

    expect(second.applied).toEqual([]);
    expect(third.applied).toEqual([]);
    expect(db.getUserVersion()).toBe(versionAfterFirst);
    expect(tableNames(db).map((t) => tableSql(db, t))).toEqual(schemaAfterFirst);
    expect(indexNames(db, 'messages').concat(indexNames(db, 'conversations'))).toEqual(
      indexesAfterFirst,
    );
    db.close();
  });

  it('只补差额：停在 001 的库再次迁移只跑 002 之后的每一条', () => {
    const db = openRawDb();
    migrate(db, MIGRATIONS.slice(0, 1));
    expect(db.getUserVersion()).toBe(1);

    const result = migrate(db);
    expect(result.from).toBe(1);
    // 不写死具体编号：新增迁移时这里不该失败，只该验证"补的是差额"
    expect(result.applied).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
    db.close();
  });

  it('迁移中途失败时整条回滚，user_version 不前进、表不留半截', () => {
    const db = openRawDb();
    migrate(db);

    const broken = {
      // 编号必须接在最后一条之后，否则先撞上"编号与顺序不符"那条断言
      id: String(MIGRATIONS.length + 1).padStart(3, '0'),
      name: 'broken',
      up(driver: typeof db): void {
        driver.exec('CREATE TABLE half_done (a TEXT);');
        throw new Error('模拟迁移中断');
      },
    };

    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow('模拟迁移中断');
    // 版本没动
    expect(db.getUserVersion()).toBe(LATEST_VERSION);
    // 半截表被回滚掉
    expect(tableNames(db)).not.toContain('half_done');
    db.close();
  });

  it('迁移编号与顺序不符时立刻报错，而不是静默跳过', () => {
    const db = openRawDb();
    const wrongOrder = [{ id: '002', name: 'out-of-order', up: () => undefined }];
    expect(() => migrate(db, wrongOrder)).toThrow(/迁移编号与顺序不符/);
    db.close();
  });

  it('002 增加 pinned_at 且排序 SQL 可执行', () => {
    const db = openMigrated();
    const now = Date.now();
    db.prepare(
      `INSERT INTO characters (id,name,raw_json,created_at,updated_at) VALUES (?,?,?,?,?)`,
    ).run('ch1', '爱丽丝', '{}', now, now);
    db.prepare(
      `INSERT INTO conversations (id,title,character_id,created_at,updated_at,pinned_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('c1', '未置顶', 'ch1', now, now + 10, null);
    db.prepare(
      `INSERT INTO conversations (id,title,character_id,created_at,updated_at,pinned_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('c2', '置顶', 'ch1', now, now + 1, now + 5);

    // 排序规则来自 UI 文档 9.1
    const rows = db
      .prepare<{ id: string }>(
        `SELECT id FROM conversations
         ORDER BY pinned_at IS NOT NULL DESC, COALESCE(pinned_at, 0) DESC, updated_at DESC`,
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual(['c2', 'c1']);
    db.close();
  });

  it('003 的 status 默认 done 且受 CHECK 约束', () => {
    const db = openMigrated();
    const now = Date.now();
    db.prepare(
      `INSERT INTO characters (id,name,raw_json,created_at,updated_at) VALUES (?,?,?,?,?)`,
    ).run('ch1', '爱丽丝', '{}', now, now);
    db.prepare(
      `INSERT INTO conversations (id,title,character_id,created_at,updated_at) VALUES (?,?,?,?,?)`,
    ).run('c1', 't', 'ch1', now, now);
    db.prepare(
      `INSERT INTO messages (id,conversation_id,role,content,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('m1', 'c1', 'user', 'hi', 1, now, now);

    const row = db.prepare<{ status: string }>('SELECT status FROM messages WHERE id = ?').get('m1');
    expect(row?.status).toBe('done');

    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (id,conversation_id,role,content,status,sort_order,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run('m2', 'c1', 'user', 'x', 'bogus', 2, now, now),
    ).toThrow();
    db.close();
  });

  it('004 为 messages.role 建索引（用量统计按 role 过滤）', () => {
    const db = openMigrated();
    expect(indexNames(db, 'messages')).toContain('idx_messages_role');
    // 索引真的被查询计划用上，而不是"建了但没人走"
    const plan = db
      .prepare<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE role = 'assistant'",
      )
      .all()
      .map((row) => row.detail)
      .join(' ');
    expect(plan).toContain('idx_messages_role');
    db.close();
  });
});

/** 便捷：打开已迁移库。 */
function openMigrated() {
  const db = openRawDb();
  migrate(db);
  return db;
}
