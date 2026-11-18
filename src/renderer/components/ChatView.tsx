import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Character, Conversation, Message, Summary, TokenPreview } from '@shared/types.js';
import { useAppStore } from '../stores/app.js';
import { useChatStore } from '../stores/chat.js';
import { useComposerStore } from '../stores/composer.js';
import { usePanelStore } from '../stores/panel.js';
import { useMenuStore } from '../stores/menu.js';
import { toast } from '../stores/toast.js';
import { MessageItem } from './MessageItem.js';
import { UiIcon } from './UiIcon.js';

export interface ChatViewProps {
  conversation: Conversation | null; character: Character | null; summaries: Summary[];
  preview: TokenPreview | null; hasProvider: boolean; renaming: boolean;
  onStartRename(): void; onCommitRename(title: string): void; onCancelRename(): void;
  onTogglePin(): void; onTogglePanel(): void;
  onSend(text: string): Promise<boolean>; onStop(): void; onOpenApiKeys(): void;
  onRestoreSummary(id: string): void; onNewConversation(): void;
  onEditMessage(id: string, content: string, truncate: boolean): void;
  onDeleteMessage(id: string): void; onDeleteFromMessage(id: string): void;
  onRegenerate(id: string): void; onCopyMessage(message: Message): void;
}
const threadPositions = new Map<string, { top: number; stick: boolean }>();

export function ChatView(p: ChatViewProps) {
  const messages = useChatStore(s => s.messages);
  const loading = useChatStore(s => s.loading);
  const draft = useComposerStore(s => s.draft);
  const setDraft = useComposerStore(s => s.setDraft);
  const { providers, settings, sidebarCollapsed, toggleSidebar, setView, upsertConversation } = useAppStore();
  const [pendingSends, setPendingSends] = useState<string[]>([]);
  const sendError = useComposerStore(s => p.conversation ? s.sendErrors[p.conversation.id] : null);
  const [stickBottom, setStickBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const activeId = p.conversation?.id;
  const restoredId = useRef<string | undefined>(undefined);
  const sending = !!activeId && pendingSends.includes(activeId);
  const streaming = messages.some(m => m.status === 'streaming');
  const provider = providers.find(item => item.id === (p.conversation?.providerId ?? settings?.chatProviderId));
  const model = p.conversation?.model || provider?.defaultModel || provider?.models[0];
  const lastAssistant = useMemo(() => [...messages].reverse().find(m => m.role === 'assistant')?.id, [messages]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId || loading) return;
    if (restoredId.current !== activeId) {
      restoredId.current = activeId;
      const saved = threadPositions.get(activeId);
      el.scrollTop = saved && !saved.stick ? saved.top : el.scrollHeight;
      setStickBottom(saved?.stick ?? true);
    } else if (stickBottom) el.scrollTop = el.scrollHeight;
  }, [activeId, messages, stickBottom, loading]);
  useEffect(() => { if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.style.height = `${Math.min(200, inputRef.current.scrollHeight)}px`; } }, [draft, activeId]);
  const send = async () => {
    const text = draft.trim();
    if (!text || streaming || sending || !activeId) return;
    setPendingSends(ids => [...ids, activeId]);
    useComposerStore.getState().setSendError(activeId, null);
    try {
      const accepted = await p.onSend(text);
      if (!accepted) useComposerStore.getState().setSendError(activeId, useComposerStore.getState().sendErrors[activeId] || '消息未发送，草稿已保留。请检查模型连接或对话记忆后重试。');
      if (accepted) { useComposerStore.getState().clearSentDraft(activeId, draft); if (useChatStore.getState().conversationId === activeId) setStickBottom(true); }
    } catch { useComposerStore.getState().setSendError(activeId, '发送失败，草稿已保留。请稍后重试。'); }
    finally { setPendingSends(ids => ids.filter(id => id !== activeId)); }
  };
  const openModelMenu = (trigger: HTMLElement) => {
    const usable = providers.filter(item => item.enabled && item.hasKey);
    const choices = usable.flatMap(item => [...new Set([item.defaultModel, ...item.models].filter(Boolean))].map(name => ({
      label: `${name === model && item.id === provider?.id ? '✓ ' : ''}${name}`, kbd: item.name,
      onSelect: () => { void (async () => {
        if (!p.conversation) return;
        const result = await window.cottage.conversations.update(p.conversation.id, { providerId: item.id, model: name });
        if (result.ok) upsertConversation(result.data);
        else toast(result.error.message, 'error');
      })(); },
    })));
    useMenuStore.getState().open({ rect: trigger.getBoundingClientRect(), targetId: 'models', trigger }, [...choices, { label: '管理模型连接…', onSelect: p.onOpenApiKeys }], '选择模型');
  };
  const openMore = (trigger: HTMLElement) => useMenuStore.getState().open({ rect: trigger.getBoundingClientRect(), targetId: 'conversation', trigger }, [
    { label: '对话设置', onSelect: () => usePanelStore.getState().setTab('conversation') },
    { label: '角色资料', onSelect: () => usePanelStore.getState().setTab('character') },
    { label: '对话记忆', onSelect: () => usePanelStore.getState().setTab('context') },
    { label: '导出与更多操作', onSelect: () => usePanelStore.getState().setTab('data') },
  ], '会话操作');
  return <main className="next-main" aria-label="对话">
    <header className="next-topbar">
      <div className="topbar-identity">{sidebarCollapsed && <button className="icon-btn" aria-label="展开侧栏" onClick={toggleSidebar}><UiIcon name="sidebar"/></button>}
        <button className="identity-name" onClick={() => p.conversation ? usePanelStore.getState().setTab('character') : undefined}>{p.character?.name || 'Cottage'}</button>
        {p.conversation && <><span className="identity-divider"/><button className="model-selector" onClick={e => openModelMenu(e.currentTarget)} aria-label="选择模型" aria-haspopup="menu" data-menu-trigger>{model || '配置模型'}<UiIcon name="down"/></button></>}
      </div>
      {p.conversation && <button className="icon-btn" onClick={e => openMore(e.currentTarget)} aria-label="会话操作" aria-haspopup="menu" data-menu-trigger><UiIcon name="more"/></button>}
    </header>
    {!p.conversation ? <div className="welcome-screen"><div className="welcome-content"><div className="welcome-mark"><UiIcon name="home"/></div><p className="welcome-eyebrow">A PLACE FOR YOUR STORIES</p><h1>故事，从一句话开始。</h1><p className="welcome-subtitle">遇见一个角色，走进另一种日常。</p><button className="welcome-primary" onClick={p.onNewConversation}>开启新对话<UiIcon name="arrow"/></button><div className="welcome-links"><button onClick={() => setView('characters')}>探索角色库</button><span>·</span><button onClick={p.onOpenApiKeys}>配置模型连接</button></div></div><p className="welcome-footnote">属于你的角色，留在这里的故事。</p></div> : <>
      <div ref={scrollRef} className="next-thread-scroll" onScroll={() => { const el = scrollRef.current; if (el && activeId && !loading && restoredId.current === activeId) { const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 70; setStickBottom(stick); threadPositions.set(activeId, { top: el.scrollTop, stick }); } }}>
        <div className="next-thread" aria-live="polite" aria-busy={loading}>
          {loading ? <p className="thread-loading">正在翻开对话…</p> : messages.length === 0 ? <div className="conversation-empty"><p>和{p.character?.name || '角色'}说点什么吧</p><span>一段新的故事，正等着开始。</span></div> : messages.map(message => <MessageItem key={message.id} message={message} characterName={p.character?.name ?? '角色'} showMetaAlways={false} streaming={message.status === 'streaming'} isLastAssistant={message.id === lastAssistant} onCopy={() => p.onCopyMessage(message)} onEdit={(content, truncate) => p.onEditMessage(message.id, content, truncate)} onRegenerate={() => p.onRegenerate(message.id)} onDelete={() => p.onDeleteMessage(message.id)} onDeleteFrom={() => p.onDeleteFromMessage(message.id)} onContinue={() => p.onRegenerate(message.id)} onStop={p.onStop} invalidatedSummaries={m => p.summaries.filter(s => s.coversTo >= m.sortOrder).length}/>)}
        </div>
      </div>
      {!stickBottom && <button className="latest-button icon-btn" aria-label="回到最新消息" onClick={() => { setStickBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}><UiIcon name="down"/></button>}
      <div className="next-composer-area">
        {sendError && <p className="composer-notice" role="alert">{sendError}</p>}
        {!provider?.hasKey && <div className="composer-notice">先配置一个模型连接，就可以开始聊天。<button onClick={p.onOpenApiKeys}>去配置 →</button></div>}
        {p.preview && p.preview.percent >= 75 && <button className="context-notice" onClick={() => usePanelStore.getState().setTab('context')}>对话记忆{p.preview.anyEstimated ? '约' : ''}占用 {p.preview.percent}% · 查看与整理</button>}
        <form className="next-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          <textarea ref={inputRef} rows={1} aria-label="输入消息" placeholder={`发消息给${p.character?.name || '角色'}…`} value={draft} onChange={e => setDraft(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
            const shortcut = settings?.sendWithCtrlEnter ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey && !e.metaKey;
            if (shortcut) { e.preventDefault(); void send(); }
          }}/>
          {streaming ? <button type="button" className="composer-send" aria-label="停止生成" onClick={p.onStop}><UiIcon name="stop"/></button> : <button className="composer-send" type="submit" aria-label="发送消息" disabled={!draft.trim() || !provider?.hasKey || sending || loading}><UiIcon name="up"/></button>}
        </form>
        <p className="composer-footnote">{settings?.sendWithCtrlEnter ? 'Ctrl + Enter 发送' : 'Enter 发送 · Shift + Enter 换行'}</p>
      </div>
    </>}
  </main>;
}
