import { z } from 'zod';
import { isPngFile } from '@core/png-card.js';
import { CHUB_MAX_PAGE, CHUB_PAGE_SIZE, chubSearchUrl, type ChubCard, type ChubPage, type ChubQuery } from '@shared/chub.js';
import type { DatabaseDriver } from '../db/driver.js';
import { getChubCharacterId } from '../db/dao/characters.js';
import { importCharacterFromBytes } from './character-import.js';

const assetOrigin = 'https://avatars.charhub.io';
type ChubFetch = (url: string, options: RequestInit) => Promise<Response>;
export const chubPathSchema = z.string().max(300).regex(/^[\w-][\w.-]*\/[\w-][\w.-]*$/);
export const chubQuerySchema = z.object({
  keyword: z.string().trim().max(200),
  page: z.number().int().min(1).max(CHUB_MAX_PAGE),
});
const searchResponse = z.object({ data: z.object({
  count: z.number().int().nonnegative(),
  nodes: z.array(z.unknown()).max(CHUB_PAGE_SIZE),
}) });
const characterNode = z.object({
  fullPath: chubPathSchema,
  name: z.string().trim().min(1),
  description: z.string().nullish(),
  tagline: z.string().nullish(),
  projectSpace: z.literal('characters'),
  is_public: z.literal(true),
  is_unlisted: z.literal(false),
  nsfw_image: z.literal(false),
});

function assetUrl(cardPath: string, filename: 'avatar.webp' | 'chara_card_v2.png'): string {
  return `${assetOrigin}/avatars/${chubPathSchema.parse(cardPath)}/${filename}`;
}

async function requestBytes(fetcher: ChubFetch, url: string, limit: number, accept: string): Promise<Buffer> {
  try {
    const response = await fetcher(url, {
      headers: { Accept: accept },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (!response.ok || contentType !== accept || !response.body) {
      await response.body?.cancel();
      if (response.status === 403) throw new ChubError('Chub 拒绝了请求，请检查系统代理能否访问 Chub。');
      if (response.status === 404) throw new ChubError('Chub 上的这份资源已不可用。');
      if (response.status === 429) throw new ChubError('Chub 请求过于频繁，请稍后重试。');
      throw new ChubError('Chub 返回了无法读取的内容。');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, length);
        length += value.byteLength;
        if (length > limit) throw new ChubError('Chub 返回的文件过大。');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof ChubError) throw error;
    throw new ChubError('无法连接 Chub，请检查系统代理后重试。');
  }
}

class ChubError extends Error {}

export function createChubCatalog(db: DatabaseDriver, userDataDir: string, fetcher: ChubFetch) {
  const imports = new Map<string, Promise<void>>();

  return {
    async search(query: ChubQuery): Promise<ChubPage> {
      const url = chubSearchUrl(query, 'https://api.chub.ai');
      const bytes = await requestBytes(fetcher, url.href, 4 * 1024 * 1024, 'application/json');
      let payload: unknown;
      try {
        payload = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new ChubError('无法读取 Chub 搜索结果。');
      }
      const result = searchResponse.safeParse(payload);
      if (!result.success) throw new ChubError('无法读取 Chub 搜索结果。');
      const { count, nodes } = result.data.data;
      const cards: ChubCard[] = [];
      const seen = new Set<string>();
      for (const node of nodes) {
        const parsed = characterNode.safeParse(node);
        if (!parsed.success) continue;
        const { name, fullPath, description, tagline } = parsed.data;
        const key = fullPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push({
          path: fullPath,
          name: name.slice(0, 180),
          description: (description || tagline || '').slice(0, 12_000),
          imported: Boolean(getChubCharacterId(db, fullPath)),
        });
      }
      return { cards, hasNext: nodes.length > 0 && query.page < CHUB_MAX_PAGE && query.page * CHUB_PAGE_SIZE < count };
    },

    async cover(cardPath: string): Promise<string | null> {
      try {
        const bytes = await requestBytes(fetcher, assetUrl(cardPath, 'avatar.webp'), 512 * 1024, 'image/webp');
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
        return `data:image/webp;base64,${bytes.toString('base64')}`;
      } catch {
        return null;
      }
    },

    async importCard(cardPath: string): Promise<true> {
      const key = cardPath.toLowerCase();
      if (getChubCharacterId(db, key)) return true;
      let pending = imports.get(key);
      if (!pending) {
        pending = (async () => {
          const bytes = await requestBytes(fetcher, assetUrl(cardPath, 'chara_card_v2.png'), 20 * 1024 * 1024, 'image/png');
          if (!isPngFile(bytes)) throw new ChubError('Chub 返回的文件不是有效的 PNG 角色卡。');
          await importCharacterFromBytes(db, userDataDir, bytes, 'Chub.png', Date.now(), key);
        })().finally(() => imports.delete(key));
        imports.set(key, pending);
      }
      await pending;
      return true;
    },
  };
}
