/**
 * 迁移器：`PRAGMA user_version` + 编号脚本顺序执行（技术方案 5.2）。
 *
 * 两条必须成立的承诺（验收项 5）：
 *   1. 一次启动把空库推到最新版本；
 *   2. 重复启动幂等——连续启动三次后 `user_version` 与表结构不变。
 *
 * 每个迁移在**一个事务内**执行并递增 `user_version`：中途失败则整条迁移回滚，
 * 不会留下"表建了一半、版本号没动"的中间态。
 */
import type { DatabaseDriver } from '../driver.js';
import * as m001 from './001-initial-schema.js';
import * as m002 from './002-conversation-pinned-at.js';
import * as m003 from './003-message-status.js';
import * as m004 from './004-message-role-index.js';

export interface Migration {
  id: string;
  name: string;
  up(db: DatabaseDriver): void;
}

/** 迁移清单。**只允许追加，禁止修改已发布的条目。** */
export const MIGRATIONS: Migration[] = [m001, m002, m003, m004];

export const LATEST_VERSION = MIGRATIONS.length;

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * 把库迁移到最新版本。幂等：已应用过的迁移会被跳过。
 *
 * @throws 任一迁移抛错时向上传递；该迁移的改动已由事务回滚，`user_version` 未变。
 */
export function migrate(db: DatabaseDriver, migrations: Migration[] = MIGRATIONS): MigrateResult {
  const from = db.getUserVersion();
  const applied: string[] = [];

  for (let i = 0; i < migrations.length; i += 1) {
    const migration = migrations[i]!;
    const targetVersion = i + 1;
    if (targetVersion <= from) continue;

    if (Number(migration.id) !== targetVersion) {
      throw new Error(
        `迁移编号与顺序不符：第 ${targetVersion} 条迁移的 id 是 "${migration.id}"，期望 "${String(targetVersion).padStart(3, '0')}"`,
      );
    }

    db.transaction(() => {
      migration.up(db);
      db.setUserVersion(targetVersion);
    });
    applied.push(migration.id);
  }

  return { from, to: db.getUserVersion(), applied };
}
