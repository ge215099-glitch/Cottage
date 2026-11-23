export interface ChubQuery {
  keyword: string;
  page: number;
}

export interface ChubCard {
  path: string;
  name: string;
  description: string;
  imported: boolean;
}

export interface ChubPage {
  cards: ChubCard[];
  hasNext: boolean;
}

export const CHUB_PAGE_SIZE = 20;
export const CHUB_MAX_PAGE = 5000;

export function chubSearchUrl(query: ChubQuery, origin = 'https://chub.ai'): URL {
  const url = new URL('/search', origin);
  url.search = new URLSearchParams({
    search: query.keyword,
    namespace: 'characters',
    sort: 'star_count',
    sort_dir: 'desc',
    nsfw: 'false',
    nsfw_only: 'false',
    nsfl: 'false',
    page: String(query.page),
    first: String(CHUB_PAGE_SIZE),
  }).toString();
  return url;
}
