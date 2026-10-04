/**
 * better-sqlite3 驱动的适配实现。
 *
 * 这是**唯一** import 原生模块的地方；DAO 与迁移只认 `DatabaseDriver` 接口。
 * 连接参数依技术方案 5.1：WAL / foreign_keys ON / synchronous NORMAL。
 */
import Database from 'better-sqlite3';
import type { DatabaseDriver, RunResult, SqlValue, Statement } from './driver.js';

export interface OpenOptions {
  /** 数据库文件绝对路径，或 ':memory:'。路径由调用方传入——本模块不读 app.getPath。 */
  file: string;
}

/** better-sqlite3 的 Statement 与我们接口之间的薄转接。 */
function wrapStatement(raw: Database.Statement): Statement {
  return {
    run(...params: SqlValue[]): RunResult {
      const r = raw.run(...params);
      return {
        changes: Number(r.changes),
        lastInsertRowid:
          typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : Number(r.lastInsertRowid),
      };
    },
    get<T = Record<string, SqlValue>>(...params: SqlValue[]): T | undefined {
      return raw.get(...params) as T | undefined;
    },
    all<T = Record<string, SqlValue>>(...params: SqlValue[]): T[] {
      return raw.all(...params) as T[];
    },
  };
}

export function openBetterSqlite3Driver(options: OpenOptions): DatabaseDriver {
  const db = new Database(options.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // better-sqlite3 的 transaction() 已正确处理嵌套与异常回滚。
  const txn = db.transaction(<T,>(fn: () => T): T => fn());

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): Statement {
      return wrapStatement(db.prepare(sql));
    },
    transaction<T>(fn: () => T): T {
      return txn(fn) as T;
    },
    getUserVersion(): number {
      const row = db.pragma('user_version', { simple: true });
      return Number(row);
    },
    setUserVersion(version: number): void {
      // PRAGMA 不支持绑定参数，因此这里校验为整数后再拼接。
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(`非法的 user_version：${version}`);
      }
      db.pragma(`user_version = ${version}`);
    },
    close(): void {
      db.close();
    },
  };
}
