/**
 * 轻提示（toast）。
 *
 * 用途刻意收窄：UI 文档第 7 节明确"重命名成功、置顶、删除会话都不弹提示"（P1）。
 * 只有下列情况才用它：操作失败、压缩/恢复结果、需要用户知道的异步完成。
 */
import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface ToastState {
  toasts: Toast[];
  push(text: string, tone?: Toast['tone']): void;
  dismiss(id: number): void;
}

let seq = 0;
/** toast 存活时长；多留一点让用户读完中文文案。 */
export const TOAST_TTL_MS = 2600;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (text, tone = 'info') => {
    seq += 1;
    const id = seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => get().dismiss(id), TOAST_TTL_MS);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 便捷入口：在非组件代码里也能弹提示。 */
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  useToastStore.getState().push(text, tone);
}
