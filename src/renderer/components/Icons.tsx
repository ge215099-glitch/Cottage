/**
 * 图标集合。
 *
 * 全部用内联 SVG（不引入图标库）：技术方案 9.1 明确不引入成品 UI 组件库，
 * 图标库虽小，但它会带来第二套尺寸/描边体系，与设计 token 形成双轨。
 * 每个图标都是 24×24 视框、`currentColor` 描边，因此颜色一律由 CSS 决定。
 */
import type { JSX } from 'react';

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icons = {
  plus: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" strokeWidth={2} />
    </Svg>
  ),
  /** 向导里表示"当前已选中"的勾。 */
  check: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7" strokeWidth={2.2} />
    </Svg>
  ),
  search: (p: IconProps = {}) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  ),
  sidebar: (p: IconProps = {}) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  ),
  panel: (p: IconProps = {}) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Svg>
  ),
  chat: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
    </Svg>
  ),
  characters: (p: IconProps = {}) => (
    <Svg {...p}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </Svg>
  ),
  personas: (p: IconProps = {}) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3 12h18" />
    </Svg>
  ),
  settings: (p: IconProps = {}) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" />
    </Svg>
  ),
  dots: (p: IconProps = {}) => (
    <svg viewBox="0 0 24 24" width={p.size ?? 16} height={p.size ?? 16} fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  ),
  copy: (p: IconProps = {}) => (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5H6a1 1 0 0 0-1 1v9" />
    </Svg>
  ),
  edit: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M4 20h4l10-10-4-4L4 16v4Z" />
      <path d="m14 6 4 4" />
    </Svg>
  ),
  redo: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </Svg>
  ),
  stop: (p: IconProps = {}) => (
    <svg viewBox="0 0 24 24" width={p.size ?? 16} height={p.size ?? 16} fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  ),
  send: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" strokeWidth={2} />
    </Svg>
  ),
  chevron: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" strokeWidth={2} />
    </Svg>
  ),
  pin: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
    </Svg>
  ),
  trash: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    </Svg>
  ),
  export: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 3v12M8 11l4 4 4-4" />
      <path d="M5 20h14" />
    </Svg>
  ),
  moon: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </Svg>
  ),
  down: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </Svg>
  ),
  star: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8Z" />
    </Svg>
  ),
  download: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 3v12M8 11l4 4 4-4" />
      <path d="M5 20h14" />
    </Svg>
  ),
  upload: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M12 20V8M8 12l4-4 4 4" />
      <path d="M5 4h14" />
    </Svg>
  ),
  wrench: (p: IconProps = {}) => (
    <Svg {...p}>
      <path d="M15 5a5 5 0 0 0-6.6 6.6L4 16v4h4l4.4-4.4A5 5 0 0 0 19 9l-3 3-3-3 2-4Z" />
    </Svg>
  ),
} as const;
