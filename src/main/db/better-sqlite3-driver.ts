/**
 * better-sqlite3 驱动的适配实现。
 *
 * 这是**唯一** import 原生模块的地方；DAO 与迁移只认 `DatabaseDriver` 接口。
 * 连接参数依技术方案 5.1：WAL / foreign_keys ON / synchronous NORMAL。
 */
import Database from 'better-sqlite3';
import type {
  DatabaseDriver,
  Row,
  RunResult,
  SqlValue,
  TypedStatement,
} from './driver.js';
import { normalizeParams } from './driver.js';

export interface OpenOptions {
  /** 数据库文件绝对路径，或 ':memory:'。路径由调用方传入——本模块不读 app.getPath。 */
  file: string;
}

/** better-sqlite3 的 Statement 与我们接口之间的薄转接。 */
function wrapStatement<T extends object = Row>(raw: Database.Statement): TypedStatement<T> {
  return {
    run(...params: SqlValue[]): RunResult {
      const r = raw.run(...normalizeParams(params));
      return {
        changes: Number(r.changes),
        lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid),
      };
    },
    get(...params: SqlValue[]): T | undefined {
      return (raw.get(...normalizeParams(params)) as T | undefined) ?? undefined;
    },
    all(...params: SqlValue[]): T[] {
      return raw.all(...normalizeParams(params)) as T[];
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

  // 对象字面量里不能写重载签名列表，因此实现抽成局部函数，再由单一方法转发。
  function prepareImpl<T extends object>(sql: string): TypedStatement<T> {
    return wrapStatement<T>(db.prepare(sql));
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare: prepareImpl,
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
