/**
 * 右栏切片（技术方案 9.3）。
 *
 * 开关与当前标签**落 `app_settings`**（UI 文档 8 节：只需记忆"上次是否打开 +
 * 上次在哪个标签"）。宽度不落库——因为只有展开/收起两态，没有中间值。
 */
import { create } from 'zustand';

/** 右栏四个标签（UI 文档第 3.2 节注：含新增的「角色」入口）。 */
export type PanelTab = 'context' | 'conversation' | 'character' | 'data';

export const PANEL_TABS: Array<{ key: PanelTab; label: string }> = [
  { key: 'context', label: '上下文' },
  { key: 'conversation', label: '对话' },
  { key: 'character', label: '角色' },
  { key: 'data', label: '数据' },
];

export interface PanelState {
  open: boolean;
  tab: PanelTab;
  /** 用于「点击占用数字 → 滚到 token 明细」这类跳转 */
  scrollTo: string | null;

  setOpen(open: boolean): void;
  toggle(): void;
  setTab(tab: PanelTab): void;
  setScrollTo(target: string | null): void;
}

export const usePanelStore = create<PanelState>((set) => ({
  open: true,
  tab: 'context',
  scrollTo: null,

  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setTab: (tab) => set({ tab, open: true }),
  setScrollTo: (scrollTo) => set({ scrollTo }),
}));

/** 快捷键 ⌘1/2/3/4 的映射。 */
export function tabFromShortcut(key: string): PanelTab | null {
  const index = Number(key) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= PANEL_TABS.length) return null;
  return PANEL_TABS[index]!.key;
}
