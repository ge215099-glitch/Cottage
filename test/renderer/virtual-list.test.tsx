// @vitest-environment jsdom
/**
 * 虚拟滚动测试（技术方案 9.1 / UI 文档 5.6）。
 *
 * 诚实边界：jsdom 没有布局引擎，`getVirtualItems()` 无法基于真实尺寸计算，
 * 所以这里**不测**"只渲染视口 ±10 行"这个数量结果——那需要 E2E 或真实浏览器。
 * 这里测的是可判定的部分：
 *   - 阈值函数（什么时候该虚拟化）
 *   - 行高契约（定高 36px，与设计 token 一致）
 *   - 条目数低于阈值时不引入虚拟化层（行为与结构都不变）
 */
import { describe, expect, it } from 'vitest';
import {
  ROW_HEIGHT,
  OVERSCAN,
  VIRTUALIZE_THRESHOLD,
  shouldVirtualize,
} from '../../src/renderer/components/VirtualRowList.js';

describe('虚拟滚动阈值', () => {
  it('少量会话不做虚拟化（虚拟化本身也有成本）', () => {
    expect(shouldVirtualize(0)).toBe(false);
    expect(shouldVirtualize(1)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZE_THRESHOLD)).toBe(false);
  });

  it('超过阈值才虚拟化', () => {
    expect(shouldVirtualize(VIRTUALIZE_THRESHOLD + 1)).toBe(true);
    expect(shouldVirtualize(1000)).toBe(true);
  });

  it('阈值是个合理的中等规模值', () => {
    expect(VIRTUALIZE_THRESHOLD).toBeGreaterThanOrEqual(20);
    expect(VIRTUALIZE_THRESHOLD).toBeLessThanOrEqual(100);
  });
});

describe('行高契约', () => {
  it('行高固定 36px，与 UI 文档 4.1 的会话行规格一致', () => {
    expect(ROW_HEIGHT).toBe(36);
  });

  it('overscan 覆盖"视口 ±10 行"的要求', () => {
    expect(OVERSCAN).toBe(10);
  });
});
