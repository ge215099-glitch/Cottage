import type { CSSProperties } from 'react';
const paths = {
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
  new: <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-9 9-5 1 1-5Z"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  library: <><rect x="3" y="4" width="7" height="16" rx="2"/><path d="m14 4 6 1-2 15-6-1Z"/></>,
  settings: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  down: <path d="m7 10 5 5 5-5"/>,
  up: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
  home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-8h6v8"/></>,
  memory: <><path d="M9 4h6v3h4v7h-3v6H8v-6H5V7h4Z"/><path d="M10 10h4m-4 4h4"/></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
};
export function UiIcon({ name, style }: { name: keyof typeof paths; style?: CSSProperties }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
