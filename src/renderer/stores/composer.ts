/**
 * 输入区切片（UI 文档第 5 节）。
 *
 * 一条刻意的设计：模型 chip 常驻，温度与人设 chip **只在用户打开过该会话的配置后
 * 才常驻**（`showAdvancedChips`）。中文界面上三个下拉并排就是视觉噪音，
 * 这条记忆化是"既好找又不吵"的折中。
 */
import { create } from 'zustand';
import type { TokenPreview } from '@shared/types.js';

export interface ComposerState {
  draft: string;
  /** 本次生成临时覆盖的 provider / 模型（切换即时生效于下一条消息） */
  providerOverrideId: string | null;
  modelOverride: string | null;
  /** 是否常驻显示温度 / 人设 chip */
  showAdvancedChips: boolean;
  /** token 占用预览（由主进程 tokens:preview 计算，renderer 不自行计数） */
  preview: TokenPreview | null;
  /** 预览计算中 */
  previewing: boolean;

  setDraft(draft: string): void;
  clearDraft(): void;
  setProviderOverride(id: string | null): void;
  setModelOverride(model: string | null): void;
  setShowAdvancedChips(show: boolean): void;
  setPreview(preview: TokenPreview | null): void;
  setPreviewing(previewing: boolean): void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  draft: '',
  providerOverrideId: null,
  modelOverride: null,
  showAdvancedChips: false,
  preview: null,
  previewing: false,

  setDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: '' }),
  setProviderOverride: (providerOverrideId) => set({ providerOverrideId }),
  setModelOverride: (modelOverride) => set({ modelOverride }),
  setShowAdvancedChips: (showAdvancedChips) => set({ showAdvancedChips }),
  setPreview: (preview) => set({ preview }),
  setPreviewing: (previewing) => set({ previewing }),
}));

/**
 * 占用条的阈值状态（UI 文档第 5 节）：
 *   ≥75% 转琥珀；≥80% 触发自动压缩时改为「压缩中…」并转红。
 */
export type MeterLevel = 'normal' | 'warn' | 'danger';

export function meterLevel(percent: number, autoCompressAt = 0.8): MeterLevel {
  const ratio = percent / 100;
  if (ratio >= autoCompressAt) return 'danger';
  if (ratio >= 0.75) return 'warn';
  return 'normal';
}

/** 占用文案：估算时必须带「约」前缀（token 精度要求）。 */
export function meterText(preview: TokenPreview | null): string {
  if (!preview) return '上下文 —';
  const prefix = preview.anyEstimated ? '约 ' : '';
  return `上下文 ${prefix}${preview.percent}%`;
}
