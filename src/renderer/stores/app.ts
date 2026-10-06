/**
 * 全局应用切片：当前视图、侧栏折叠、会话列表、角色/人设缓存、错误提示。
 *
 * 会话列表放在这里而不是 chat 切片里，因为它被左栏与主区同时读取；
 * 放在 chat 里会让"只关心列表"的组件也订阅到流式状态，白白重渲染。
 */
import { create } from 'zustand';
import type {
  AppSettings,
  Character,
  Conversation,
  NormalizedError,
  Persona,
  Provider,
} from '@shared/types.js';

/**
 * 导航项（UI 文档第 3 节）。
 *
 * `chat` 不在导航里：正下方就是会话列表，它本身就是回到对话的入口，
 * 再放一个「对话」等于同一个动作两个入口（见 `Sidebar.tsx` 的说明）。
 * 因此导航只列这些"去别处"的入口。`apiKeys` 是 Provider 与密钥自己的模块。
 */
export type ViewKey = 'chat' | 'characters' | 'personas' | 'apiKeys' | 'settings';

export interface AppState {
  view: ViewKey;
  sidebarCollapsed: boolean;
  /** 搜索框内容；过滤在后端做（会话标题匹配） */
  query: string;

  conversations: Conversation[];
  characters: Character[];
  personas: Persona[];
  providers: Provider[];
  settings: AppSettings | null;

  /** 需求：Linux basic_text 时 UI 必须显著警告 */
  storageWarning: string | null;

  /** 主进程推来的错误（app:error），显示在 toast 里 */
  lastError: NormalizedError | null;

  setView(view: ViewKey): void;
  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  setQuery(query: string): void;

  setConversations(list: Conversation[]): void;
  upsertConversation(conversation: Conversation): void;
  removeConversation(id: string): void;
  setCharacters(list: Character[]): void;
  setPersonas(list: Persona[]): void;
  setProviders(list: Provider[]): void;
  setSettings(settings: AppSettings): void;
  setStorageWarning(warning: string | null): void;
  setLastError(error: NormalizedError | null): void;
}

export const useAppStore = create<AppState>((set) => ({
  view: 'chat',
  sidebarCollapsed: false,
  query: '',
  conversations: [],
  characters: [],
  personas: [],
  providers: [],
  settings: null,
  storageWarning: null,
  lastError: null,

  setView: (view) => set({ view }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setQuery: (query) => set({ query }),

  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (conversation) =>
    set((s) => {
      const index = s.conversations.findIndex((c) => c.id === conversation.id);
      if (index === -1) return { conversations: [conversation, ...s.conversations] };
      const next = [...s.conversations];
      next[index] = conversation;
      return { conversations: next };
    }),
  removeConversation: (id) =>
    set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),
  setCharacters: (characters) => set({ characters }),
  setPersonas: (personas) => set({ personas }),
  setProviders: (providers) => set({ providers }),
  setSettings: (settings) => set({ settings }),
  setStorageWarning: (storageWarning) => set({ storageWarning }),
  setLastError: (lastError) => set({ lastError }),
}));

/**
 * 会话列表排序——与主进程 DAO 的 SQL 保持同一规则：
 * 置顶优先，置顶段内按置顶时刻倒序，其余按 updatedAt 倒序。
 *
 * 之所以在 renderer 再实现一次：`*:changed` 事件带来的增量更新需要就地重排，
 * 不能每次都回主进程重取整表（UI 文档 5.6：不做整表重取）。
 * 两处规则必须一致，因此各自的测试都断言同一组样例。
 */
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt === null ? 0 : 1;
    const pb = b.pinnedAt === null ? 0 : 1;
    if (pa !== pb) return pb - pa;
    if (pa === 1 && pb === 1) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    return b.updatedAt - a.updatedAt;
  });
}

export interface ConversationGroups {
  pinned: Conversation[];
  rest: Conversation[];
}

/**
 * 列表**只有两段**：已置顶（有置顶才出现）与其余全部。
 *
 * **刻意不做「今天 / 昨天 / 前 7 天 / 更早」的时间分组**（UI 文档 5.1）：
 * 会话列表是"最近用过的在最上面"的有序队列，时间分组只增加标题占位与视觉噪音。
 */
export function groupConversations(list: Conversation[]): ConversationGroups {
  const sorted = sortConversations(list);
  return {
    pinned: sorted.filter((c) => c.pinnedAt !== null),
    rest: sorted.filter((c) => c.pinnedAt === null),
  };
}

/** 会话标题过滤；输入不足 2 字时不过滤（避免全表抖动，UI 文档 5.2）。 */
export function filterConversations(list: Conversation[], query: string): Conversation[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return list;
  return list.filter((c) => c.title.toLowerCase().includes(q));
}
