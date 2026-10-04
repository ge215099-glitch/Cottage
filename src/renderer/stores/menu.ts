/**
 * 菜单切片：**唯一的菜单实例**（技术方案 9.4 / UI 文档第 12 节）。
 *
 * 为什么必须是单一 store 而不是每行各自持有 `open`：
 *   UI 文档对菜单提了明确时序——180ms 宽限期、锚点切换不闪断、`Esc` 焦点回到
 *   触发按钮。这些要求只有在"同一时刻只有一个菜单"时才可能实现；
 *   开放成多个实例就会退化成"两个菜单同时开着"。
 *
 * 左栏会话行的 ⋯ 与消息的 ⋯ 共用同一个组件，只是菜单项不同。
 */
import { create } from 'zustand';

export interface MenuItem {
  label: string;
  /** 显示在右侧的快捷键提示 */
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 分隔线：用 `'-'` 表示 */
  separator?: boolean;
  onSelect(): void;
}

export interface MenuAnchor {
  /** 锚点矩形（通常是触发按钮的 getBoundingClientRect） */
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** 菜单归属的对象（会话 id 或消息 id），用于判断锚点是否切换 */
  targetId: string;
  /** 焦点回收目标：菜单关闭后 `Esc` 要回到这个按钮 */
  trigger: HTMLElement | null;
}

export interface MenuState {
  anchor: MenuAnchor | null;
  items: MenuItem[];
  ariaLabel: string;
  /** 宽限期定时器句柄；由 store 持有，保证"只有一个菜单"的时序只写一处 */
  graceTimer: ReturnType<typeof setTimeout> | null;

  open(anchor: MenuAnchor, items: MenuItem[], ariaLabel: string): void;
  /**
   * 指针离开行/菜单时调用：延迟 `delayMs` 关闭。
   * 宽限期内若指针回来，调用 `cancelClose` 即可（消除"手抖丢菜单"）。
   */
  scheduleClose(delayMs: number): void;
  cancelClose(): void;
  close(): void;
}

export const DEFAULT_GRACE_MS = 180;

export const useMenuStore = create<MenuState>((set, get) => ({
  anchor: null,
  items: [],
  ariaLabel: '更多操作',
  graceTimer: null,

  open: (anchor, items, ariaLabel) => {
    const previous = get().graceTimer;
    if (previous) clearTimeout(previous);
    // 锚点切换直接换内容，不先关再开——那会造成可见的闪断
    set({ anchor, items, ariaLabel, graceTimer: null });
  },

  scheduleClose: (delayMs) => {
    const existing = get().graceTimer;
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      set({ anchor: null, items: [], graceTimer: null });
    }, delayMs);
    set({ graceTimer: timer });
  },

  cancelClose: () => {
    const existing = get().graceTimer;
    if (existing) clearTimeout(existing);
    set({ graceTimer: null });
  },

  close: () => {
    const existing = get().graceTimer;
    if (existing) clearTimeout(existing);
    set({ anchor: null, items: [], graceTimer: null });
  },
}));

/** 菜单是否打开。 */
export function isMenuOpen(state: MenuState): boolean {
  return state.anchor !== null;
}

/**
 * 菜单项计数（不含分隔线）——UI 文档规定"超过 5 条就砍"。
 * 这个函数存在的意义是让那条约定可被测试。
 */
export function countMenuItems(items: MenuItem[]): number {
  return items.filter((i) => !i.separator).length;
}
