/**
 * 测试用的驱动工厂。
 *
 * 走 `node:sqlite`（Node 内建 SQLite），这样迁移与 DAO 测试在**纯 Node** 下
 * 验证的是真实 SQLite 行为，同时不依赖 better-sqlite3 是否已按 Electron ABI 重建
 * （技术方案 5.4 的"隔离"手段）。
 */
import { openNodeSqliteDriver } from '../../src/main/db/node-sqlite-driver.js';
import { migrate } from '../../src/main/db/migrations/index.js';
import type { DatabaseDriver } from '../../src/main/db/driver.js';

/** 打开一个空的 :memory: 库（**不**执行迁移）。 */
export function openRawDb(): DatabaseDriver {
  return openNodeSqliteDriver({ file: ':memory:' });
}

/** 打开一个已迁移到最新版本的 :memory: 库。 */
export function openMigratedDb(): DatabaseDriver {
  const db = openRawDb();
  migrate(db);
  return db;
}

/** 取某张表在 sqlite_master 里的建表 SQL。 */
export function tableSql(db: DatabaseDriver, table: string): string | undefined {
  const row = db
    .prepare<{ sql: string }>('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table);
  return row?.sql;
}

/** 列出全部用户表名。 */
export function tableNames(db: DatabaseDriver): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

/** 列出某张表的索引名。 */
export function indexNames(db: DatabaseDriver, table: string): string[] {
  return db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
    )
    .all(table)
    .map((r) => r.name);
}
