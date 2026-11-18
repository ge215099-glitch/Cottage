import { create } from 'zustand';
import type { CompressResult, NormalizedError } from '@shared/types.js';

export interface CompressionTask {
  status: 'idle' | 'running' | 'error';
  done: number;
  total: number;
  phase: 'summarizing' | 'writing';
  lastResult: CompressResult | null;
  error: NormalizedError | null;
}
export const emptyCompression: CompressionTask = { status: 'idle', done: 0, total: 0, phase: 'summarizing', lastResult: null, error: null };
interface CompressState {
  tasks: Record<string, CompressionTask>;
  start(id: string, total: number): void;
  progress(id: string, done: number, total: number, phase: CompressionTask['phase']): void;
  succeed(id: string, result: CompressResult): void;
  fail(id: string, error: NormalizedError): void;
}
// 任务按会话保存；弹层关闭和会话切换不改变实际任务。
export const useCompressStore = create<CompressState>((set) => {
  const update = (id: string, patch: Partial<CompressionTask>) => set(s => ({ tasks: { ...s.tasks, [id]: { ...(s.tasks[id] ?? emptyCompression), ...patch } } }));
  return {
    tasks: {},
    start: (id, total) => update(id, { ...emptyCompression, status: 'running', total }),
    progress: (id, done, total, phase) => update(id, { status: 'running', done, total, phase, error: null, lastResult: null }),
    succeed: (id, lastResult) => update(id, { status: 'idle', done: 0, total: 0, lastResult, error: null }),
    fail: (id, error) => update(id, { status: 'error', error }),
  };
});
