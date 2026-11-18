import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, groupConversations } from '../stores/app.js';
import { useChatStore } from '../stores/chat.js';
import { useMenuStore } from '../stores/menu.js';
import { UiIcon } from './UiIcon.js';
import type { Conversation } from '@shared/types.js';

export const TITLE_MAX_LENGTH = 80;
export interface SidebarProps {
  onNewChat(): void;
  onSelectConversation(id: string): void;
  onRenameConversation(id: string, title: string): Promise<void>;
  onTogglePin(id: string, pinned: boolean): void;
  onDeleteConversation(id: string): void;
  onOpenPersonaMenu(rect: DOMRect, trigger: HTMLElement): void;
}
export function Sidebar(props: SidebarProps) {
  const { view, setView, conversations, sidebarCollapsed, toggleSidebar, setSidebarCollapsed } = useAppStore();
  const activeId = useChatStore(s => s.conversationId);
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const renameCanceled = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => groupConversations(conversations.filter(c => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))), [conversations, search]);
  useEffect(() => { renameRef.current?.focus(); renameRef.current?.select(); }, [renaming]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSidebarCollapsed(false); searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [setSidebarCollapsed]);
  const navigate = (action: () => void) => { action(); if (window.innerWidth <= 900) setSidebarCollapsed(true); };
  const menu = (c: Conversation, trigger: HTMLElement) => useMenuStore.getState().open(
    { rect: trigger.getBoundingClientRect(), targetId: c.id, trigger }, [
      { label: '重命名', onSelect: () => { renameCanceled.current = false; setRenaming(c); setTitle(c.title); } },
      { label: c.pinnedAt === null ? '置顶对话' : '取消置顶', onSelect: () => props.onTogglePin(c.id, c.pinnedAt === null) },
      { label: '删除对话', danger: true, onSelect: () => props.onDeleteConversation(c.id) },
    ], `更多操作：${c.title}`);
  const row = (c: Conversation) => <div key={c.id} className={`conversation-row ${activeId === c.id && view === 'chat' ? 'selected' : ''}`}>
    {renaming?.id === c.id ? <input ref={renameRef} aria-label="会话名称" value={title} maxLength={TITLE_MAX_LENGTH} onChange={e => setTitle(e.target.value)} onBlur={() => { if (!renameCanceled.current && title.trim()) void props.onRenameConversation(c.id, title.trim()); setRenaming(null); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); renameCanceled.current = true; setRenaming(null); } }} /> : <>
      <button className="conversation-link" onClick={() => navigate(() => props.onSelectConversation(c.id))} onContextMenu={e => { e.preventDefault(); menu(c, e.currentTarget); }} title={c.title}>{c.title}</button>
      <button className="conversation-more icon-btn" aria-label={`更多操作：${c.title}`} aria-haspopup="menu" data-menu-trigger onClick={e => menu(c, e.currentTarget)}><UiIcon name="more"/></button>
    </>}
  </div>;
  return <>
    {!sidebarCollapsed && <button className="mobile-backdrop" aria-label="关闭侧栏" onClick={toggleSidebar}/>}
    <aside className={`next-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="主导航">
      <div className="next-brand"><button className="brand-button" onClick={() => navigate(() => setView('chat'))}><UiIcon name="home"/><span>Cottage</span></button><button className="icon-btn" aria-label="收起侧栏" title="收起侧栏 Ctrl+B" onClick={toggleSidebar}><UiIcon name="sidebar"/></button></div>
      <nav className="primary-nav">
        <button className="nav-row" onClick={() => navigate(props.onNewChat)}><UiIcon name="new"/><span>新对话</span><kbd>Ctrl N</kbd></button>
        <label className="nav-row search-control"><UiIcon name="search"/><input ref={searchRef} placeholder="搜索对话" aria-label="搜索对话" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <button className={`nav-row ${view === 'characters' ? 'selected' : ''}`} onClick={() => navigate(() => setView('characters'))}><UiIcon name="library"/><span>角色库</span></button>
      </nav>
      <div className="next-conversations">
        {!!groups.pinned.length && <><h3>已置顶</h3>{groups.pinned.map(row)}</>}
        <h3>{search ? '搜索结果' : '你的对话'}</h3>{groups.rest.map(row)}
        {!groups.pinned.length && !groups.rest.length && <p className="sidebar-empty">{search ? '没有找到相关对话' : '故事会从这里开始'}</p>}
      </div>
      <div className="next-sidebar-footer"><button className={`nav-row ${['settings', 'apiKeys', 'usage', 'personas'].includes(view) ? 'selected' : ''}`} onClick={() => navigate(() => setView('settings'))}><UiIcon name="settings"/><span>设置</span></button><span className="local-note"><i/>对话保存在此设备</span></div>
    </aside>
  </>;
}
