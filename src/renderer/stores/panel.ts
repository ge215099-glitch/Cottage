/** 对话右栏。开关不影响聊天或后台整理任务。 */
import { create } from 'zustand';

/** 右栏的直接入口，与界面顺序一致。 */
export type PanelTab = 'context' | 'conversation' | 'character' | 'data';

export const PANEL_TABS: Array<{ key: PanelTab; label: string }> = [
  { key: 'character', label: '角色' },
  { key: 'conversation', label: '对话' },
  { key: 'context', label: '记忆' },
  { key: 'data', label: '导出' },
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
  tab: 'character',
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
