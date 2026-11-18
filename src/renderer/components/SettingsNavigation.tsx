import { useAppStore, type ViewKey } from '../stores/app.js';
export function SettingsNavigation() {
  const view = useAppStore(s => s.view);
  const setView = useAppStore(s => s.setView);
  const items: { key: ViewKey; label: string }[] = [{ key: 'settings', label: '通用' }, { key: 'apiKeys', label: '模型连接' }, { key: 'personas', label: '我的人设' }, { key: 'usage', label: '用量' }];
  return <nav className="settings-navigation" aria-label="设置分类">{items.map(item => <button key={item.key} className={view === item.key ? 'active' : ''} onClick={() => setView(item.key)}>{item.label}</button>)}</nav>;
}
