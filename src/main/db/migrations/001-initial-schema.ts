/**
 * 001 — 初始 schema。
 *
 * 来源：docs/product-design.md 第 4 节（实体与关键字段）+ 其"约束"段（时间戳、
 * persona 关系、summaries 记录 provider/model、索引清单）。
 *
 * 全部字段 snake_case 落库；camelCase 的转换只在 DAO 内做一次（技术方案 5.3）。
 */
import type { DatabaseDriver } from '../driver.js';

export const id = '001';
export const name = 'initial-schema';

export function up(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE providers (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      type               TEXT NOT NULL CHECK (type IN ('openai','anthropic')),
      base_url           TEXT NOT NULL,
      api_key_enc        TEXT,
      models_json        TEXT NOT NULL DEFAULT '[]',
      default_model      TEXT NOT NULL DEFAULT '',
      compression_model  TEXT NOT NULL DEFAULT '',
      enabled            INTEGER NOT NULL DEFAULT 1,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );

    CREATE TABLE characters (
      id                        TEXT PRIMARY KEY,
      name                      TEXT NOT NULL,
      description               TEXT NOT NULL DEFAULT '',
      personality               TEXT NOT NULL DEFAULT '',
      scenario                  TEXT NOT NULL DEFAULT '',
      first_mes                 TEXT NOT NULL DEFAULT '',
      alternate_greetings_json  TEXT NOT NULL DEFAULT '[]',
      mes_example               TEXT NOT NULL DEFAULT '',
      system_prompt             TEXT NOT NULL DEFAULT '',
      post_history_instructions TEXT NOT NULL DEFAULT '',
      tags_json                 TEXT NOT NULL DEFAULT '[]',
      favorite                  INTEGER NOT NULL DEFAULT 0,
      avatar_path               TEXT,
      raw_json                  TEXT NOT NULL,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL
    );

    CREATE TABLE personas (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar_path TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE conversations (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      persona_id   TEXT REFERENCES personas(id) ON DELETE SET NULL,
      provider_id  TEXT REFERENCES providers(id) ON DELETE SET NULL,
      model        TEXT NOT NULL DEFAULT '',
      params_json  TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content         TEXT NOT NULL DEFAULT '',
      metadata_json   TEXT NOT NULL DEFAULT '{}',
      archived        INTEGER NOT NULL DEFAULT 0,
      sort_order      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE summaries (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content         TEXT NOT NULL,
      covers_from     INTEGER NOT NULL,
      covers_to       INTEGER NOT NULL,
      token_count     INTEGER NOT NULL DEFAULT 0,
      level           INTEGER NOT NULL DEFAULT 1,
      provider_id     TEXT,
      model           TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX idx_messages_conv_order   ON messages (conversation_id, sort_order);
    CREATE INDEX idx_messages_conv_archived ON messages (conversation_id, archived);
    CREATE INDEX idx_summaries_conv_from    ON summaries (conversation_id, covers_from);
    CREATE INDEX idx_conversations_updated  ON conversations (updated_at DESC);
    CREATE INDEX idx_characters_favorite    ON characters (favorite DESC, updated_at DESC);
  `);
}
