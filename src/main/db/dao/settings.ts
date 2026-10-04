/**
 * app_settings DAO。
 *
 * **`value` 的类型由代码侧 schema 校验，不做裸字符串读取**（产品设计文档第 4 节约束）。
 * 因此本模块不导出 `getSetting(key): string` 这样的裸接口，只导出
 * `readSettings()` / `writeSettings()`，由 `settingsSchema` 统一把关。
 */
import { z } from 'zod';
import type { AppSettings } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';

/** 全局设置 schema：既是默认值的来源，也是落库前的校验器。 */
export const settingsSchema = z.object({
  chatProviderId: z.string().nullable(),
  compressionProviderId: z.string().nullable(),
  autoCompressEnabled: z.boolean(),
  autoCompressThreshold: z.number().min(0.1).max(1),
  sendWithCtrlEnter: z.boolean(),
  panelOpen: z.boolean(),
  panelTab: z.enum(['context', 'conversation', 'character', 'data']),
  theme: z.enum(['light', 'dark', 'system']),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000),
});

export const DEFAULT_SETTINGS: AppSettings = {
  chatProviderId: null,
  compressionProviderId: null,
  autoCompressEnabled: true,
  // 产品设计文档 3.4：默认模型上限的 80%
  autoCompressThreshold: 0.8,
  sendWithCtrlEnter: false,
  panelOpen: true,
  panelTab: 'context',
  theme: 'system',
  requestTimeoutMs: 60_000,
};

const SETTINGS_KEY = 'app';

interface SettingsRow {
  key: string;
  value: string;
  updated_at: number;
}

/** 读全部设置：坏数据降级为默认值，绝不因为一个字段写坏就打不开设置页。 */
export function readSettings(db: DatabaseDriver): AppSettings {
  const row = db.prepare<SettingsRow>('SELECT * FROM app_settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = settingsSchema.partial().safeParse(JSON.parse(row.value));
    if (parsed.success) return { ...DEFAULT_SETTINGS, ...parsed.data };
  } catch {
    // 落到默认值
  }
  console.warn('[dao] app_settings 内容非法，已回退为默认设置');
  return { ...DEFAULT_SETTINGS };
}

/** 增量写设置；返回值是合并后的完整设置。 */
export function writeSettings(
  db: DatabaseDriver,
  patch: Partial<AppSettings>,
  now: number,
): AppSettings {
  const merged = settingsSchema.parse({ ...readSettings(db), ...patch });
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTINGS_KEY, JSON.stringify(merged), now);
  return merged;
}

/** 仅供测试与诊断：把整张表导出为可读对象。 */
export function dumpSettings(db: DatabaseDriver): Record<string, unknown> {
  const rows = db.prepare<SettingsRow>('SELECT * FROM app_settings').all();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = null;
    }
  }
  return out;
}
