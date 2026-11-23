import type { DatabaseDriver } from '../driver.js';

export const id = '006';
export const name = 'chub-source';

export function up(db: DatabaseDriver): void {
  db.exec(`ALTER TABLE characters ADD COLUMN chub_path TEXT;
    CREATE UNIQUE INDEX characters_chub_path ON characters(chub_path);`);
}
