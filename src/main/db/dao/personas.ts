/**
 * Persona DAO（产品设计文档 3.2）。
 *
 * 关系约束：**Persona 是全局资源，关系落在 `conversations.persona_id`**，
 * 不放在 `personas` 表里。本模块只保证"有且至多一个默认 persona"。
 */
import type { Persona, PersonaInput } from '@shared/types.js';
import type { DatabaseDriver } from '../driver.js';
import { ID_PREFIX, newId } from '../ids.js';
import { toPersona, type PersonaRow } from '../mappers.js';

export function listPersonas(db: DatabaseDriver): Persona[] {
  return db
    .prepare<PersonaRow>('SELECT * FROM personas ORDER BY is_default DESC, created_at ASC')
    .all()
    .map(toPersona);
}

export function getPersona(db: DatabaseDriver, id: string): Persona | null {
  const row = db.prepare<PersonaRow>('SELECT * FROM personas WHERE id = ?').get(id);
  return row ? toPersona(row) : null;
}

/** 取全局默认 persona；没有显式默认时退回最早创建的一个。 */
export function getDefaultPersona(db: DatabaseDriver): Persona | null {
  const row = db
    .prepare<PersonaRow>('SELECT * FROM personas ORDER BY is_default DESC, created_at ASC LIMIT 1')
    .get();
  return row ? toPersona(row) : null;
}

/**
 * 建 persona。库里还没有任何 persona 时，第一个自动成为默认——
 * 否则"未绑定 persona 的会话用全局默认"这条会落空。
 */
export function createPersona(db: DatabaseDriver, input: PersonaInput, now: number): Persona {
  const id = input.id ?? newId(ID_PREFIX.persona);
  const count = Number(
    db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM personas').get()?.n ?? 0,
  );
  const shouldBeDefault = input.isDefault ?? count === 0;

  // 显式给全 NOT NULL 列的值：驱动会把 undefined 归一成 null，
  // 依赖建表默认值会直接撞 NOT NULL 约束。
  const description = input.description ?? '';
  const avatarPath = input.avatarPath ?? null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO personas (id,name,description,avatar_path,is_default,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, input.name, description, avatarPath, 0, now, now);
    if (shouldBeDefault) setDefaultPersona(db, id);
  });

  return getPersona(db, id)!;
}

export function updatePersona(
  db: DatabaseDriver,
  id: string,
  patch: Partial<PersonaInput>,
  now: number,
): Persona | null {
  const existing = getPersona(db, id);
  if (!existing) return null;

  const name = patch.name ?? existing.name;
  if (!name.trim()) throw new Error('人设名不能为空');

  db.transaction(() => {
    db.prepare(
      'UPDATE personas SET name = ?, description = ?, avatar_path = ?, updated_at = ? WHERE id = ?',
    ).run(
      name,
      patch.description ?? existing.description,
      patch.avatarPath === undefined ? existing.avatarPath : (patch.avatarPath ?? null),
      now,
      id,
    );
    if (patch.isDefault === true) setDefaultPersona(db, id);
  });

  return getPersona(db, id);
}

/** 置为唯一默认；`is_default` 是互斥状态，必须在一个事务里改。 */
export function setDefaultPersona(db: DatabaseDriver, id: string): void {
  db.transaction(() => {
    db.prepare('UPDATE personas SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE personas SET is_default = 1 WHERE id = ?').run(id);
  });
}

export function deletePersona(db: DatabaseDriver, id: string): { ok: boolean; reason?: string } {
  const persona = getPersona(db, id);
  if (!persona) return { ok: false, reason: '人设不存在' };

  const used = Number(
    db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE persona_id = ?')
      .get(id)?.n ?? 0,
  );

  db.transaction(() => {
    // 会话上的关系置空（ON DELETE SET NULL 也会兜底，这里显式做以便测试可断言）。
    db.prepare('UPDATE conversations SET persona_id = NULL WHERE persona_id = ?').run(id);
    db.prepare('DELETE FROM personas WHERE id = ?').run(id);
    // 删掉的若是默认，把默认顺延给剩下的第一个
    if (persona.isDefault) {
      const next = db
        .prepare<{ id: string }>('SELECT id FROM personas ORDER BY created_at ASC LIMIT 1')
        .get();
      if (next) db.prepare('UPDATE personas SET is_default = 1 WHERE id = ?').run(next.id);
    }
  });

  return { ok: true, reason: used > 0 ? `已解除 ${used} 个会话与该人设的绑定` : undefined };
}
