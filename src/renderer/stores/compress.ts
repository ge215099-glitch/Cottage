/**
 * 压缩状态机（UI 文档 R3 / 第 3.2 节）。
 *
 * ```
 *   idle ──用户点压缩──→ running ──成功──→ idle（并记录 lastResult 用于内联播报）
 *                          │
 *                          ├──取消──→ idle（未写摘要、未改归档标记）
 *                          └──失败──→ error（按钮位置变错误条 + 重试）
 * ```
 *
 * 状态放在这里而不是组件里，理由与菜单相同：压缩进行中时右栏可能被切走再切回，
 * 组件卸载不能把"正在压缩"这件事弄丢。
 */
import { create } from 'zustand';
import type { CompressResult, NormalizedError } from '@shared/types.js';

export type CompressStatus = 'idle' | 'running' | 'error';

export interface CompressState {
  status: CompressStatus;
  conversationId: string | null;
  done: number;
  total: number;
  phase: 'summarizing' | 'writing';
  /** 最近一次成功的结果，用于内联播报「已将第 3–15 条压缩（1200 → 180 tokens）」 */
  lastResult: CompressResult | null;
  error: NormalizedError | null;

  start(conversationId: string, total: number): void;
  progress(done: number, total: number, phase: 'summarizing' | 'writing'): void;
  succeed(result: CompressResult): void;
  fail(error: NormalizedError): void;
  cancel(): void;
  clearResult(): void;
}

export const useCompressStore = create<CompressState>((set) => ({
  status: 'idle',
  conversationId: null,
  done: 0,
  total: 0,
  phase: 'summarizing',
  lastResult: null,
  error: null,

  start: (conversationId, total) =>
    set({
      status: 'running',
      conversationId,
      done: 0,
      total,
      phase: 'summarizing',
      error: null,
    }),

  progress: (done, total, phase) => set({ done, total, phase }),

  succeed: (lastResult) =>
    set({ status: 'idle', conversationId: null, done: 0, total: 0, lastResult, error: null }),

  fail: (error) => set({ status: 'error', error, conversationId: null }),

  // 取消后后端不会写摘要也不会改归档标记（原子性），这里只需回到 idle
  cancel: () => set({ status: 'idle', conversationId: null, done: 0, total: 0, error: null }),

  clearResult: () => set({ lastResult: null, error: null }),
}));

/** 压缩进行中的进度百分比（0–100）。 */
export function compressPercent(state: CompressState): number {
  if (state.total <= 0) return 0;
  return Math.min(100, Math.round((state.done / state.total) * 100));
}

/**
 * 压缩完成后的播报文案（产品设计文档 3.4：UI 反馈必须具体到条数与 token 变化）。
 *
 * 例：`已将第 3–15 条压缩（1,200 → 180 tokens）`
 */
export function compressAnnouncement(result: CompressResult): string {
  const before = result.tokensBefore.toLocaleString('en-US');
  const after = result.tokensAfter.toLocaleString('en-US');
  return `已将第 ${result.from}–${result.to} 条压缩（${before} → ${after} tokens）`;
}

/** 恢复归档后的播报文案：`已恢复第 3–15 条，对应摘要已失效` */
export function restoreAnnouncement(from: number, to: number): string {
  return `已恢复第 ${from}–${to} 条，对应摘要已失效`;
}
