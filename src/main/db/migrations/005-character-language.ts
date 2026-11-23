import type { DatabaseDriver } from '../driver.js';

export const id = '005';
export const name = 'character-language';

export function up(db: DatabaseDriver): void {
  db.exec("ALTER TABLE characters ADD COLUMN language_mode TEXT CHECK (language_mode IN ('zh', 'bilingual'))");
}
