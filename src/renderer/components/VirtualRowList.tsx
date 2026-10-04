/**
 * 定高虚拟滚动列表。
 *
 * 为什么需要它（技术方案 9.1 / UI 文档 5.6）：会话数可能过千，全部渲染会
 * 让首次挂载与每次列表刷新都变慢，滚动也会掉帧。行高固定 36px（设计 token），
 * 所以可以走定高模式——比动态测量简单得多，也不会有滚动条抖动。
 *
 * 两个刻意的约束：
 *   1. **不接管滚动容器本身**：虚拟列表只负责"渲染哪几行"，滚动条仍由父容器提供，
 *      这样分组标题（吸顶）与空态可以照常放在同一个滚动区里。
 *   2. **rowKey 必须稳定**：用会话 id 而不是索引，否则改名/置顶重排时
 *      React 会复用错行的 DOM，焦点与行内编辑态都会乱。
 */
import { useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** 会话行固定高度（UI 文档 4.1：高 36px）。 */
export const ROW_HEIGHT = 36;

/** 视口上下各多渲染几行，减少快速滚动时的白屏。 */
export const OVERSCAN = 10;

export interface VirtualRowListProps<T> {
  items: T[];
  rowKey(item: T, index: number): string;
  renderRow(item: T, index: number): ReactNode;
  /** 行高；默认 ROW_HEIGHT */
  rowHeight?: number;
  /** 滚动容器（父级）。不传时组件自己包一个可滚动 div。 */
  scrollElement?: HTMLElement | null;
  /** 没有滚动容器时的高度上限 */
  maxHeight?: number;
}

/**
 * 定高虚拟列表。
 *
 * 默认自己提供滚动容器（高度由 CSS 的 flex 布局决定）；传入 `scrollElement`
 * 时复用外部容器——侧栏就是这种情况，因为分组标题要与列表共享同一个滚动区。
 */
export function VirtualRowList<T>({
  items,
  rowKey,
  renderRow,
  rowHeight = ROW_HEIGHT,
  scrollElement,
  maxHeight,
}: VirtualRowListProps<T>): JSX.Element {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const parent = scrollElement ?? ownRef.current;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent ?? null,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const inner = (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        return (
          <div
            key={rowKey(item, virtualRow.index)}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${rowHeight}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderRow(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );

  // 复用外部滚动容器时，本组件只渲染内容层
  if (scrollElement) return inner;

  return (
    <div
      ref={ownRef}
      style={{
        overflowY: 'auto',
        ...(maxHeight ? { maxHeight: `${maxHeight}px` } : {}),
      }}
    >
      {inner}
    </div>
  );
}

/**
 * 需要虚拟滚动的最小条目数。
 *
 * 低于这个数直接全量渲染：虚拟化本身也要成本（测量、绝对定位、额外的 DOM 层），
 * 几十条会话时它只会让代码更复杂而没有任何收益。
 */
export const VIRTUALIZE_THRESHOLD = 40;

/** 依据条目数决定用虚拟列表还是普通列表。 */
export function shouldVirtualize(count: number): boolean {
  return count > VIRTUALIZE_THRESHOLD;
}
