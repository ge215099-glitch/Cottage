/**
 * 主区对话视图（UI 文档第 3.1 / 4 / 5 节）。
 *
 * 顶栏**只有 2 个元素**：会话标题（可双击行内重命名）与详情开关。
 * 置顶按钮只在鼠标进入顶栏时淡入，但「已置顶」状态常驻可见——否则用户看不出置顶了。
 * 导出 / 删除 / 改参数一律不放在这里（P1：一屏一个主动作）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Character, Conversation, Message, Summary, TokenPreview } from '@shared/types.js';
import { useAppStore } from '../stores/app.js';
import { buildTimeline, useChatStore } from '../stores/chat.js';
import { useComposerStore, meterLevel, meterText } from '../stores/composer.js';
import { usePanelStore } from '../stores/panel.js';
import { Icons } from './Icons.js';
import { MessageItem } from './MessageItem.js';

export interface ChatViewProps {
  conversation: Conversation | null;
  character: Character | null;
  summaries: Summary[];
  preview: TokenPreview | null;
  /** 是否已配置可用 Provider（未配置时发送禁用并给出跳转提示） */
  hasProvider: boolean;
  renaming: boolean;
  onStartRename(): void;
  onCommitRename(title: string): void;
  onCancelRename(): void;
  onTogglePin(): void;
  onTogglePanel(): void;
  onSend(text: string): void;
  onStop(): void;
  onOpenSettings(): void;
  onRestoreSummary(summaryId: string): void;
  onNewConversation(): void;
  onEditMessage(messageId: string, content: string, truncate: boolean): void;
  onDeleteMessage(messageId: string): void;
  onDeleteFromMessage(messageId: string): void;
  onRegenerate(messageId: string): void;
  onCopyMessage(message: Message): void;
}

export function ChatView({
  conversation,
  character,
  summaries,
  preview,
  hasProvider,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onTogglePanel,
  onSend,
  onStop,
  onOpenSettings,
  onRestoreSummary,
  onNewConversation,
  onEditMessage,
  onDeleteMessage,
  onDeleteFromMessage,
  onRegenerate,
  onCopyMessage,
}: ChatViewProps): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const streamingConversationId = useChatStore((s) => s.streamingConversationId);
  const activeId = conversation?.id ?? null;
  const streaming = activeId !== null && streamingConversationId === activeId;

  const draft = useComposerStore((s) => s.draft);
  const setDraft = useComposerStore((s) => s.setDraft);
  const sendWithCtrlEnter = useAppStore((s) => s.settings?.sendWithCtrlEnter ?? false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [topbarHovered, setTopbarHovered] = useState(false);
  /** 用户手动上滚后停止粘底，并出现「回到最新」（UI 文档 4 节） */
  const [stickBottom, setStickBottom] = useState(true);

  const timeline = useMemo(() => buildTimeline(messages, summaries), [messages, summaries]);

  /** 「重新生成」只对最后一条助手消息可用（UI 文档第 4 节）。 */
  const lastAssistantId = useMemo(() => {
    const assistants = messages.filter((m) => m.role === 'assistant');
    return assistants.length ? assistants[assistants.length - 1]!.id : null;
  }, [messages]);

  /** 粘底：生成中滚到最底；用户上滚后不再自动跳。 */
  useEffect(() => {
    if (!stickBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline, stickBottom, streamingMessageId]);

  /** 修复初次进入与切换会话时的滚动位置。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickBottom(true);
  }, [activeId]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const scrollToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setStickBottom(true);
  };

  /** 输入框 1→8 行自适应（UI 文档第 5 节）。 */
  const autoGrow = (): void => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // 上限来自 token：约 200px，超过后内部滚动
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  };

  useEffect(autoGrow, [draft, activeId]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || streaming || !conversation) return;
    setDraft('');
    setStickBottom(true);
    onSend(text);
  };

  const level = preview ? meterLevel(preview.percent, preview.autoCompressAt) : 'normal';
  const canSend = Boolean(draft.trim()) && Boolean(conversation) && hasProvider;

  /* ------------------------------ 无会话 ------------------------------ */

  if (!conversation) {
    return (
      <main id="main">
        <div className="topbar">
          <div className="title">Cottage</div>
          <div className="spacer" />
          <button
            type="button"
            className="icon-btn"
            title="详情栏 (Ctrl+I)"
            aria-label="开关详情栏"
            onClick={onTogglePanel}
          >
            {Icons.panel()}
          </button>
        </div>
        <div id="scroll" className="page">
          <div className="empty-page">
            还没有对话　
            <button type="button" onClick={onNewConversation}>
              新建一个 →
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main id="main">
      {/* 顶栏：只有标题与详情开关两个可交互元素 */}
      <div
        className={`topbar${topbarHovered || conversation.pinnedAt !== null ? ' pin-visible' : ''}`}
        onMouseEnter={() => setTopbarHovered(true)}
        onMouseLeave={() => setTopbarHovered(false)}
      >
        {renaming ? (
          <TopbarRename
            initialValue={conversation.title}
            onSubmit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <div
            className="title"
            tabIndex={0}
            title="双击重命名"
            onDoubleClick={onStartRename}
            onKeyDown={(event) => {
              if (event.key === 'F2') {
                event.preventDefault();
                onStartRename();
              }
            }}
          >
            {conversation.title}
          </div>
        )}
        <button
          type="button"
          className={`icon-btn pin-btn${conversation.pinnedAt !== null ? ' on' : ''}`}
          title={conversation.pinnedAt !== null ? '取消置顶' : '置顶会话'}
          aria-label={conversation.pinnedAt !== null ? '取消置顶' : '置顶会话'}
          aria-pressed={conversation.pinnedAt !== null}
          onClick={onTogglePin}
        >
          {Icons.pin()}
        </button>
        <div className="spacer" />
        <ThemeButton />
        <button
          type="button"
          className="icon-btn"
          title="详情栏 (Ctrl+I)"
          aria-label="开关详情栏"
          onClick={onTogglePanel}
        >
          {Icons.panel()}
        </button>
      </div>

      {/* 消息流：唯一滚动区 */}
      <div id="scroll" ref={scrollRef} onScroll={onScroll}>
        {timeline.length === 0 ? (
          <EmptyState
            character={character}
            onPick={(text) => {
              setDraft(text);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          <div className="thread">
            {timeline.map((item) =>
              item.kind === 'summary' && item.summary ? (
                <SummaryDivider
                  key={item.key}
                  summary={item.summary}
                  onRestore={() => onRestoreSummary(item.summary!.id)}
                />
              ) : item.message ? (
                <MessageItem
                  key={item.key}
                  message={item.message}
                  characterName={character?.name ?? '角色'}
                  showMetaAlways={false}
                  streaming={item.message.id === streamingMessageId}
                  isLastAssistant={item.message.id === lastAssistantId}
                  onCopy={() => onCopyMessage(item.message!)}
                  onEdit={(content, truncate) => onEditMessage(item.message!.id, content, truncate)}
                  onRegenerate={() => onRegenerate(item.message!.id)}
                  onDelete={() => onDeleteMessage(item.message!.id)}
                  onDeleteFrom={() => onDeleteFromMessage(item.message!.id)}
                  onContinue={() => onRegenerate(item.message!.id)}
                  onStop={onStop}
                />
              ) : null,
            )}
          </div>
        )}
        {!stickBottom ? (
          <button type="button" id="to-latest" title="回到最新" aria-label="回到最新" onClick={scrollToLatest}>
            {Icons.down()}
          </button>
        ) : null}
      </div>

      {/* 输入区 */}
      <div className="composer-wrap">
        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              placeholder="和角色聊聊…（Enter 发送，Shift+Enter 换行）"
              aria-label="消息输入"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                const mod = event.ctrlKey || event.metaKey;
                if (event.key === 'Enter' && !event.shiftKey) {
                  // 设置可切换为 Ctrl+Enter 发送（UI 文档第 5 节）
                  if (sendWithCtrlEnter && !mod) return;
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-foot">
              <button
                type="button"
                className="mchip"
                title="切换 Provider / 模型"
                onClick={() => usePanelStore.getState().setTab('conversation')}
              >
                <span>{conversation.model || '未指定模型'}</span>
                {Icons.chevron()}
              </button>
              <button
                type="button"
                className="mchip"
                title="会话配置"
                onClick={() => usePanelStore.getState().setTab('conversation')}
              >
                <span>会话配置</span>
              </button>
              <button
                type="button"
                className={`meter ${level}`}
                title="上下文占用（点击打开详情）"
                onClick={() => usePanelStore.getState().setTab('context')}
              >
                <span>{streaming ? '生成中…' : meterText(preview)}</span>
                <span className="bar">
                  <i style={{ width: `${preview?.percent ?? 0}%` }} />
                </span>
              </button>
              <button
                type="button"
                className={streaming ? 'send-btn stop' : 'send-btn'}
                aria-label={streaming ? '停止生成' : '发送'}
                title={streaming ? '停止生成' : '发送'}
                disabled={!streaming && !canSend}
                onClick={() => (streaming ? onStop() : send())}
              >
                {streaming ? Icons.stop() : Icons.send()}
              </button>
            </div>
          </div>
          {!hasProvider ? (
            <div className="key-hint">
              先在设置里配置 Provider
              <button type="button" onClick={onOpenSettings}>
                去设置
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* 子组件                                                              */
/* ------------------------------------------------------------------ */

/** 顶栏行内重命名：与左栏行为一致（Esc 回滚、空标题不提交）。 */
function TopbarRename({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit(title: string): void;
  onCancel(): void;
}): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      setInvalid(true);
      window.setTimeout(() => setInvalid(false), 400);
      ref.current?.focus();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <input
      ref={ref}
      className="title-input"
      style={invalid ? { borderColor: 'var(--danger)' } : undefined}
      value={value}
      maxLength={80}
      aria-label="重命名对话"
      onChange={(event) => setValue(event.target.value.slice(0, 80))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

/**
 * 空态：角色名（大字，无头像）+ 描述 + 开场白胶囊。
 *
 * 开场白**只以胶囊形式出现一次**：设计文档 5 节要求"开场白有多个时下方一排小胶囊
 * 切换"，所以首条开场白也走胶囊，不再另起一段重复显示——否则同一句话在屏幕上
 * 出现两遍，读起来像 bug。
 */
function EmptyState({
  character,
  onPick,
}: {
  character: Character | null;
  onPick(text: string): void;
}): JSX.Element {
  const greetings = useMemo(() => {
    if (!character) return [];
    const all = [character.firstMes, ...character.alternateGreetings].filter((g) => g.trim());
    // 最多显示 6 个，多余的进 ⋯（一期只做前 6 个）
    return all.slice(0, 6);
  }, [character]);

  return (
    <div className="empty">
      <h2>{character?.name ?? '角色已被删除'}</h2>
      <p>{character?.description || character?.scenario || '开始一段新的对话。'}</p>
      {greetings.length ? (
        <div className="chips">
          {greetings.map((greeting, index) => (
            <button
              key={index}
              type="button"
              className="chip"
              onClick={() => onPick(greeting)}
              title={greeting.length > 18 ? greeting : '填入输入框'}
            >
              {greeting.length > 18 ? `${greeting.slice(0, 18)}…` : greeting}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 摘要分割条：全宽细线 + 居中胶囊。
 * 展开后原位显示归档原文，右侧「恢复」。
 * 归档消息**只以轻微降透明度区分**，不加「已归档」标签。
 */
function SummaryDivider({
  summary,
  onRestore,
}: {
  summary: Summary;
  onRestore(): void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="summary-divider" data-sum={summary.id}>
      <button
        type="button"
        className="summary-pill"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {Icons.copy()}
        {`已压缩 第 ${summary.coversFrom}–${summary.coversTo} 条 ${expanded ? '⌃' : '⌄'}`}
      </button>
      {expanded ? (
        <div className="summary-body" style={{ width: '100%' }}>
          <h4>
            摘要（覆盖 {summary.coversFrom}–{summary.coversTo} 条 ·{' '}
            {summary.tokenCount.toLocaleString('en-US')} tok · {summary.model}）
          </h4>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{summary.content}</p>
          <button type="button" className="restore" onClick={onRestore}>
            恢复这段原文，摘要将失效
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 深浅色开关（Demo 有、设计文档未列为必做，作为便利项保留）。 */
function ThemeButton(): JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);

  return (
    <button
      type="button"
      className="icon-btn"
      title="切换深浅色"
      aria-label="切换深浅色"
      onClick={() => {
        const next = document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset['theme'] = next;
        // 落库由 App 层的副作用统一处理；这里只更新本地状态
        if (settings) setSettings({ ...settings, theme: next });
      }}
    >
      {Icons.moon()}
    </button>
  );
}

// 顶层静态 import 已完成，这里不再延迟取 store。
