/**
 * 基于 `node:sqlite` 的驱动实现。
 *
 * 用途分两处，都是**刻意的**：
 *   1. 单元测试：让 DAO / 迁移 / 事务测试在**纯 Node** 下跑真实 SQLite，
 *      不必等待 better-sqlite3 按 Electron ABI 重建成功（技术方案 5.4 的对冲目标）。
 *      用的是 Node 内建的 SQLite，不是"自己糊一个 SQL 解释器"，所以测的是真行为。
 *   2. 运行兜底：若 better-sqlite3 原生模块加载失败，主进程可退到这条路径，
 *      避免"昨天还好好的"直接变成打不开应用（技术方案第 13 节风险的软着陆）。
 *
 * 与 better-sqlite3 的 API 差异已在本文件内一次性消化，DAO 看不到：
 *   - `exec()` 的多语句行为不同 → 这里按分号切分逐条执行；
 *   - `PRAGMA user_version` 的读法不同 → 这里读列 `user_version`；
 *   - `lastInsertRowid` 可能是 bigint → 统一转 number。
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  DatabaseDriver,
  Row,
  RunResult,
  SqlValue,
  TypedStatement,
} from './driver.js';
import { normalizeParams } from './driver.js';

export interface NodeSqliteOpenOptions {
  file: string;
}

/** 把可能含多条语句的 SQL 切成单条（够用即可：迁移脚本里没有字符串字面量含分号）。 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s));
}

function wrapStatement<T extends object = Row>(
  raw: ReturnType<DatabaseSync['prepare']>,
): TypedStatement<T> {
  return {
    run(...params: SqlValue[]): RunResult {
      const r = raw.run(...normalizeParams(params)) as {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
      };
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

export function openNodeSqliteDriver(options: NodeSqliteOpenOptions): DatabaseDriver {
  const db = new DatabaseSync(options.file);

  // 与 better-sqlite3 驱动保持同样的连接参数（技术方案 5.1）。
  for (const pragma of [
    'journal_mode = WAL',
    'foreign_keys = ON',
    'synchronous = NORMAL',
  ]) {
    try {
      db.exec(`PRAGMA ${pragma}`);
    } catch {
      // 内存库不支持 WAL 之类的情况：不阻塞启动。
    }
  }

  let depth = 0;
  const transaction = <T,>(fn: () => T): T => {
    // 嵌套事务用 SAVEPOINT，语义与 better-sqlite3 的 transaction() 一致。
    const nested = depth > 0;
    const name = `sp_${depth}`;
    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (err) {
      depth -= 1;
      try {
        db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
      } catch {
        // 回滚本身失败时不掩盖原始异常。
      }
      throw err;
    }
  };

  // 对象字面量里不能写重载签名列表，因此实现抽成局部函数，再由单一方法转发。
  function prepareImpl<T extends object>(sql: string): TypedStatement<T> {
    return wrapStatement<T>(db.prepare(sql));
  }

  return {
    exec(sql: string): void {
      for (const stmt of splitStatements(sql)) db.exec(stmt);
    },
    prepare: prepareImpl,
    transaction,
    getUserVersion(): number {
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      return Number(row?.user_version ?? 0);
    },
    setUserVersion(version: number): void {
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(`非法的 user_version：${version}`);
      }
      db.exec(`PRAGMA user_version = ${version}`);
    },
    close(): void {
      db.close();
    },
  };
}
