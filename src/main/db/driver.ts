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

/**
 * 绑定参数归一化。
 *
 * 两个驱动对 `undefined` 的容忍度不同：better-sqlite3 当它是 NULL，
 * 而 `node:sqlite` 直接抛 "Provided value cannot be bound to SQLite parameter N"。
 * 如果把差异留给各 DAO 自己处理，就会出现"测试挂、生产不挂"这种最难查的
 * 不一致。所以在驱动边界统一转成 `null`。
 */
export function normalizeParams(params: readonly unknown[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : (p as SqlValue)));
}

export interface RunResult {
  /** 受影响行数 */
  changes: number;
  /** 自增主键（无则 null） */
  lastInsertRowid: number | null;
}

/**
 * 一行查询结果。
 *
 * 注意这里的 `T extends object = Row` 写法：**类型参数必须带默认值**。
 * 因为泛型写在 rest 参数之前，调用点若省略显式类型实参，TypeScript 推断不出 `T`，
 * 带默认值才能让 `db.prepare('...').all()` 直接拿到可索引的行对象。
 */
export type Row = Record<string, SqlValue>;

export interface Statement {
  /** 执行写入语句。 */
  run(...params: SqlValue[]): RunResult;
  /** 取第一行，无则 undefined。 */
  get<T extends object = Row>(...params: SqlValue[]): T | undefined;
  /** 取全部行。 */
  all<T extends object = Row>(...params: SqlValue[]): T[];
}

/**
 * 把一行的类型从语句层钉住，于是调用点可以写成：
 *
 * ```ts
 * db.prepare<CharacterRow>(sql).all(id)   // 返回 CharacterRow[]
 * ```
 *
 * `prepare` 上的类型实参直接决定 `get`/`all` 的返回类型，DAO 读起来最省事。
 *
 * **刻意不 `extends Statement`**：`Statement` 里 `all<T extends object>` 的泛型参数
 * 一旦被固定成具体的 `T`，就不再是 `object` 的超集，接口继承会直接冲突
 * （TS2430）。所以这里把三个方法平铺重写一遍——它描述的是"同一批方法、
 * 更窄的返回类型"，结构上自洽，不需要真的去继承。
 */
export interface TypedStatement<T extends object> {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): T | undefined;
  all(...params: SqlValue[]): T[];
}

export interface DatabaseDriver {
  /** 执行一段可含多条语句的 SQL（DDL 用）。 */
  exec(sql: string): void;
  /**
   * 预编译语句。两种写法都对：
   *
   * ```ts
   * db.prepare<CharacterRow>(sql).all(id)   // 行类型钉在语句上（DAO 常用）
   * db.prepare(sql).get<{ n: number }>(id)  // 行类型写在取值处
   * ```
   *
   * 这里**只保留一个带默认值的泛型签名**：若改成 `prepare<T>` + `prepare` 两个重载，
   * TypeScript 会永远匹配到第一个，导致 `prepare(sql)` 把 `T` 推成 `object`，
   * 后续 `.get<X>()` / `.all<X>()` 全部报"不接受类型实参"。默认值 `Row`
   * 让省略类型实参时依然拿到可索引的行对象。
   */
  prepare<T extends object = Row>(sql: string): TypedStatement<T>;
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
