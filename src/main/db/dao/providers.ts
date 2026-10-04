/**
 * Provider DAO（产品设计文档 3.1）。
 *
 * 密钥边界：
 *   - 库里只有 `api_key_enc`（safeStorage 密文）。本模块**不认识**明文 Key，
 *     加解密由 `src/main/secrets` 负责，明文只在主进程内的一次调用栈里存在。
 *   - 对外的 `Provider` 只带 `hasKey: boolean`（技术方案 6.4 规则 1）。
 */
import type { Provider, ProviderInput, ProviderType } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { toJsonColumn, toProvider, type ProviderRow } from '../mappers.js';

export interface ProviderSecretRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyEnc: string | null;
  models: string[];
  defaultModel: string;
  compressionModel: string;
  enabled: boolean;
  sortOrder: number;
}

/**
 * 主进程内部使用的"带密文"视图。
 *
 * **本函数不得跨 IPC 暴露**——它含 `apiKeyEnc`。名字里的 `ForMain` 就是为了让越界
 * 调用在评审时一眼可见。
 */
export function getProviderSecretForMain(db: DatabaseDriver, id: string): ProviderSecretRecord | null {
  const row = db.prepare<ProviderRow>('SELECT * FROM providers WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: row.base_url,
    apiKeyEnc: row.api_key_enc,
    models: toProvider(row).models,
    defaultModel: row.default_model,
    compressionModel: row.compression_model,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
  };
}

export function listProviders(db: DatabaseDriver): Provider[] {
  return db
    .prepare<ProviderRow>(
      'SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC',
    )
    .all()
    .map(toProvider);
}

export function getProvider(db: DatabaseDriver, id: string): Provider | null {
  const row = db.prepare<ProviderRow>('SELECT * FROM providers WHERE id = ?').get(id);
  return row ? toProvider(row) : null;
}

export interface UpsertProviderOptions {
  /** 由调用方（主进程 secrets 层）加密后的密文；undefined = 保留原值 */
  apiKeyEnc?: string | null;
  /** 显式清除密钥 */
  clearKey?: boolean;
  now: number;
}

export function createProvider(
  db: DatabaseDriver,
  input: ProviderInput,
  options: UpsertProviderOptions,
): Provider {
  const id = input.id ?? newId(ID_PREFIX.provider);
  const { now } = options;
  db.prepare(
    `INSERT INTO providers
       (id,name,type,base_url,api_key_enc,models_json,default_model,compression_model,enabled,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.name,
    input.type,
    input.baseUrl,
    options.apiKeyEnc ?? null,
    toJsonColumn(input.models),
    input.defaultModel,
    input.compressionModel || input.defaultModel,
    input.enabled ? 1 : 0,
    input.sortOrder ?? nextSortOrder(db),
    now,
    now,
  );
  return getProvider(db, id)!;
}

export function updateProvider(
  db: DatabaseDriver,
  id: string,
  input: ProviderInput,
  options: UpsertProviderOptions,
): Provider | null {
  const existing = getProvider(db, id);
  if (!existing) return null;

  // 三态密钥处理：未传 = 保留；传空串 = 视为清除；传值 = 覆盖为新的密文。
  let apiKeyEnc: string | null | undefined;
  if (options.clearKey) apiKeyEnc = null;
  else if (options.apiKeyEnc !== undefined) apiKeyEnc = options.apiKeyEnc;

  if (apiKeyEnc === undefined) {
    db.prepare(
      `UPDATE providers SET
         name = ?, type = ?, base_url = ?, models_json = ?, default_model = ?,
         compression_model = ?, enabled = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.type,
      input.baseUrl,
      toJsonColumn(input.models),
      input.defaultModel,
      input.compressionModel || input.defaultModel,
      input.enabled ? 1 : 0,
      input.sortOrder ?? existing.sortOrder,
      options.now,
      id,
    );
  } else {
    db.prepare(
      `UPDATE providers SET
         name = ?, type = ?, base_url = ?, api_key_enc = ?, models_json = ?, default_model = ?,
         compression_model = ?, enabled = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.type,
      input.baseUrl,
      apiKeyEnc,
      toJsonColumn(input.models),
      input.defaultModel,
      input.compressionModel || input.defaultModel,
      input.enabled ? 1 : 0,
      input.sortOrder ?? existing.sortOrder,
      options.now,
      id,
    );
  }
  return getProvider(db, id);
}

export function deleteProvider(db: DatabaseDriver, id: string): boolean {
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  return result.changes > 0;
}

/** 只更新模型列表（"从端点拉取模型"后落库）。 */
export function setProviderModels(
  db: DatabaseDriver,
  id: string,
  models: string[],
  now: number,
  defaultModel?: string,
): Provider | null {
  if (!getProvider(db, id)) return null;
  db.prepare('UPDATE providers SET models_json = ?, default_model = COALESCE(?, default_model), updated_at = ? WHERE id = ?').run(
    toJsonColumn(models),
    defaultModel ?? null,
    now,
    id,
  );
  return getProvider(db, id);
}

function nextSortOrder(db: DatabaseDriver): number {
  const row = db
    .prepare<{ max_order: number | null }>('SELECT MAX(sort_order) AS max_order FROM providers')
    .get();
  return Number(row?.max_order ?? 0) + 1;
}
