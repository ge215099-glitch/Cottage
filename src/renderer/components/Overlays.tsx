/**
 * 浮层：菜单 / 对话框 / toast（UI 文档第 4.4 / 4.5 / 4.7 节）。
 *
 * 定位交给 `@floating-ui/react`（边界检测与翻转是它的核心能力），
 * 而**开关时序、宽限期、焦点回收自己写**——技术方案 9.4 明确说现有组件库的
 * 关闭时序与 UI 文档要求冲突，越用越拧。
 *
 * 菜单的开关状态由 `useMenuStore` 单一持有；这里只是它的渲染层。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { computePosition, flip, offset, shift } from '@floating-ui/react';
import { DEFAULT_GRACE_MS, useMenuStore } from '../stores/menu.js';
import { useToastStore } from '../stores/toast.js';

/* ------------------------------------------------------------------ */
/* 菜单                                                               */
/* ------------------------------------------------------------------ */

/**
 * 挂载在 body 上的菜单。
 *
 * 时序（UI 文档 4.2）：
 *   - 打开无延迟；
 *   - 关闭加 180ms 宽限期（指针离开行/菜单后 180ms 内回到任一者则不关闭）；
 *   - 菜单内 ↑/↓ / Home / End 移动，Esc 关闭并把焦点还给触发按钮。
 */
export function MenuLayer(): JSX.Element | null {
  const anchor = useMenuStore((s) => s.anchor);
  const items = useMenuStore((s) => s.items);
  const ariaLabel = useMenuStore((s) => s.ariaLabel);
  const close = useMenuStore((s) => s.close);
  const cancelClose = useMenuStore((s) => s.cancelClose);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // 定位：默认对齐锚点右下；右/下溢出时由 floating-ui 自动翻转
  useLayoutEffect(() => {
    if (!anchor || !menuRef.current) {
      setPosition(null);
      return;
    }
    let cancelled = false;
    void computePosition(
      {
        getBoundingClientRect: () => anchor.rect as DOMRect,
      } as unknown as Element,
      menuRef.current,
      {
        placement: 'bottom-end',
        strategy: 'fixed',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      },
    ).then(({ x, y }) => {
      if (!cancelled) setPosition({ left: x, top: y });
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  // 打开时焦点进入第一项（UI 文档 4.5）
  useEffect(() => {
    if (!anchor) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    first?.focus();

    // 滚轮 / 列表滚动 / 窗口尺寸变化都关闭菜单
    const onScroll = (): void => close();
    const onResize = (): void => close();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, close]);

  // 点击菜单外任意处关闭（点到谁是谁，不抢焦点）
  useEffect(() => {
    if (!anchor) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('[data-menu-layer]') || target?.closest('[data-menu-trigger]')) return;
      close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [anchor, close]);

  if (!anchor || !items.length) return null;

  const focusables = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const list = focusables();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Esc 关闭并把焦点还给触发按钮（UI 文档 4.5）
      const trigger = anchor.trigger;
      close();
      trigger?.focus();
    } else if (event.key === 'Tab') {
      // Tab 关闭菜单并继续正常 Tab 顺序（不在菜单内循环）
      close();
    }
  };

  return (
    <div className="overlay-root">
      <div
        ref={menuRef}
        data-menu-layer
        className="menu"
        role="menu"
        aria-label={ariaLabel}
        style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
        onKeyDown={onKeyDown}
        // 指针移入菜单要取消待关闭（宽限期语义）
        onMouseEnter={cancelClose}
        onMouseLeave={() => useMenuStore.getState().scheduleClose(DEFAULT_GRACE_MS)}
      >
        {items.map((item, index) =>
          item.separator ? (
            <hr key={`sep-${index}`} />
          ) : (
            <button
              key={`${item.label}-${index}`}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? 'danger' : undefined}
              disabled={item.disabled}
              onClick={() => {
                // 选中任一菜单项：立即关闭再执行动作（UI 文档 4.5）
                close();
                item.onSelect();
              }}
            >
              {item.label}
              {item.kbd ? <span className="k">{item.kbd}</span> : null}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 对话框                                                             */
/* ------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  title: string;
  /** 若干段落；最后一段通常是「此操作不可撤销」这类后果说明 */
  paragraphs: ReactNode[];
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 默认焦点在「取消」——破坏性操作的默认动作必须是安全的那一个 */
  defaultFocus?: 'cancel' | 'confirm';
  /** 出错时在对话框内联显示（UI 文档 7 节：删除失败要就地报错） */
  error?: string | null;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({
  title,
  paragraphs,
  confirmLabel,
  cancelLabel = '取消',
  danger,
  error,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 「取消」为默认聚焦项，Enter 默认不删除（UI 文档 4.7）
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      // 焦点陷阱：Tab 在对话框内循环，避免焦点跑到背后的界面上
      if (event.key === 'Tab') {
        const list = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
        );
        if (!list.length) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="overlay-root">
      <div
        className="scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}
      >
        <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
          <h3>{title}</h3>
          {paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
          {error ? <div className="dialog-error">{error}</div> : null}
          <div className="actions">
            <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={danger ? 'btn confirm-danger' : 'btn primary'}
              style={{ width: 'auto' }}
              onClick={onConfirm}
              disabled={busy}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

export function ToastLayer(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="toast-root" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={t.tone === 'error' ? 'toast error' : 'toast'}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
