/**
 * 数据库驱动的最小接口（技术方案 5.3 / 5.4）。
 *
 * **DAO 与迁移不得 import electron，也不得直接 import better-sqlite3。**
 * 它们只依赖本接口，由调用方注入具体实现：
 *   - 生产：`src/main/db/better-sqlite3-driver.ts`（主进程，原生模块已按 Electron ABI 重建）
 *   - 测试：`test/helpers/memory-driver.ts`（纯 JS，无需任何原生模块）
 *
 * 这样做的收益正好对应技术方案 5.4 的对冲表："DAO 不依赖 Electron，使绝大多数测试
 * 在本地 Node 下运行，不依赖重编译成功"——原生模块 ABI 出错时测试仍然可信。
 */

/** SQLite 列类型（本产品只用这四种 + 主键）。 */
export type SqlType = 'TEXT' | 'INTEGER' | 'REAL';

/** 允许绑定到语句的值。 */
export type SqlValue = string | number | null;

export interface RunResult {
  /** 受影响行数 */
  changes: number;
  /** 自增主键（无则 null） */
  lastInsertRowid: number | null;
}

export interface Statement {
  /** 执行写入语句。 */
  run(...params: SqlValue[]): RunResult;
  /** 取第一行，无则 undefined。 */
  get<T = Record<string, SqlValue>>(...params: SqlValue[]): T | undefined;
  /** 取全部行。 */
  all<T = Record<string, SqlValue>>(...params: SqlValue[]): T[];
}

export interface DatabaseDriver {
  /** 执行一段可含多条语句的 SQL（DDL 用）。 */
  exec(sql: string): void;
  /** 预编译语句。 */
  prepare(sql: string): Statement;
  /**
   * 在一个事务内执行 `fn`。
   *
   * **全成或全不成**：`fn` 抛异常时必须回滚且不留半截状态（产品设计文档 3.7）。
   * 实现可以是 better-sqlite3 的 `db.transaction`，也可以是手写 BEGIN/COMMIT/ROLLBACK。
   */
  transaction<T>(fn: () => T): T;
  /** 读取 `PRAGMA user_version`。 */
  getUserVersion(): number;
  /** 写入 `PRAGMA user_version`（迁移器专用）。 */
  setUserVersion(version: number): void;
  /** 关闭连接。 */
  close(): void;
}
