import type { CSSProperties } from 'react';
const paths = {
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></>,
  moon: <path d="M20.7 13A9 9 0 0 1 11 3.3 9 9 0 1 0 20.7 13Z"/>,
  monitor: <><rect x="3" y="3" width="18" height="14" rx="3"/><path d="M8 21h8m-4-4v4"/></>,
  connection: <><path d="m10 13 4-4m-5 7-2 2a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m0 4 2-2a4.2 4.2 0 0 1 6 6l-5 5a4.2 4.2 0 0 1-6 0" transform="translate(1 -1)"/></>,
  chart: <><path d="M4 3v17h17M9 15v-4m5 4V6m5 9v-7"/></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></>,
  person: <><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></>,
  export: <><path d="M12 15V3m-4 4 4-4 4 4M5 13v7h14v-7"/></>,
  new: <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-9 9-5 1 1-5Z"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  library: <><rect x="3" y="4" width="7" height="16" rx="2"/><path d="m14 4 6 1-2 15-6-1Z"/></>,
  settings: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
  filter: <><path d="M4 6h16M7 12h10m-7 6h4"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="18" r="2" fill="currentColor" stroke="none"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  down: <path d="m7 10 5 5 5-5"/>,
  up: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
  memory: <><path d="M9 4h6v3h4v7h-3v6H8v-6H5V7h4Z"/><path d="M10 10h4m-4 4h4"/></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
};
export function UiIcon({ name, style }: { name: keyof typeof paths; style?: CSSProperties }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
