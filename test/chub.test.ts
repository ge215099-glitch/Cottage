import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listCharacters } from '../src/main/db/dao/characters.js';
import { createChubCatalog } from '../src/main/services/chub.js';
import { openMigratedDb } from './helpers/db.js';
import { cardPng } from './helpers/png.js';

describe('Chub 公开角色卡', () => {
  it('将搜索限定为公开角色，保留服务端热度顺序', async () => {
    const db = openMigratedDb();
    try {
      const card = { fullPath: 'Author/space-cat', name: '太空猫', projectSpace: 'characters', is_public: true, is_unlisted: false, nsfw_image: false };
      const fetcher = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ data: {
        count: 30,
        nodes: [card, { ...card, name: '未列出', fullPath: 'author/hidden', is_unlisted: true }, { ...card, name: '月亮猫', fullPath: 'author/moon-cat' }],
      } }));
      const result = await createChubCatalog(db, '', fetcher).search({ keyword: '太空 & 猫', page: 1 });
      expect(result.cards.map((item) => item.name)).toEqual(['太空猫', '月亮猫']);
      expect(result.hasNext).toBe(true);
      const url = new URL(fetcher.mock.calls[0]![0]);
      expect(url.origin).toBe('https://api.chub.ai');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ search: '太空 & 猫', sort: 'star_count', sort_dir: 'desc', nsfw: 'false' });
      expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    } finally {
      db.close();
    }
  });

  it('同源卡并发导入时只保存一次，创建新服务后也识别为已导入', async () => {
    const db = openMigratedDb();
    const userData = await mkdtemp(path.join(tmpdir(), 'cottage-chub-test-'));
    const avatars = path.join(userData, 'avatars');
    try {
      const bytes = cardPng({ name: '太空猫', description: '角色介绍' });
      const fetcher = vi.fn(async () => new Response(Buffer.from(bytes), { headers: { 'content-type': 'image/png' } }));
      const catalog = createChubCatalog(db, userData, fetcher);
      await Promise.all([catalog.importCard('Author/space-cat'), catalog.importCard('author/space-cat')]);
      expect(await createChubCatalog(db, userData, fetcher).importCard('author/space-cat')).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(listCharacters(db)).toHaveLength(1);
      expect(await readdir(avatars)).toHaveLength(1);
    } finally {
      db.close();
      const files = await readdir(avatars).catch(() => []);
      await Promise.all(files.map((file) => unlink(path.join(avatars, file))));
      await rmdir(avatars).catch(() => undefined);
      await rmdir(userData);
    }
  });
});
