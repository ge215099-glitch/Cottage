import { useRef } from 'react';
import { useAppStore, type SettingsViewKey } from '../stores/app.js';
import { UiIcon } from './UiIcon.js';

const items = [
  { key: 'settings', label: '通用设置', icon: 'settings' },
  { key: 'apiKeys', label: '模型连接', icon: 'connection' },
  { key: 'personas', label: '我的人设', icon: 'person' },
  { key: 'usage', label: '用量', icon: 'chart' },
] as const;

export function SettingsNavigation() {
  const view = useAppStore(s => s.settingsView);
  const setView = useAppStore(s => s.setView);
  const refs = useRef<Partial<Record<SettingsViewKey, HTMLButtonElement | null>>>({});
  return <nav className="settings-navigation" role="tablist" aria-label="设置分类" aria-orientation="vertical">
    {items.map((item, index) => <button
      key={item.key}
      ref={element => { refs.current[item.key] = element; }}
      id={`settings-tab-${item.key}`}
      role="tab"
      aria-selected={view === item.key}
      aria-controls="settings-content"
      tabIndex={view === item.key ? 0 : -1}
      onClick={() => setView(item.key)}
      onKeyDown={event => {
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length
          : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        const target = items[next]!;
        setView(target.key);
        refs.current[target.key]?.focus();
      }}
    ><UiIcon name={item.icon}/><span>{item.label}</span></button>)}
  </nav>;
}
