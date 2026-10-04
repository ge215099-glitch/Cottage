/**
 * 单条消息（UI 文档第 4 节）。
 *
 * 规格要点：
 *   - 角色消息**无气泡**（全宽文本 + 名字一行）；用户消息是右对齐气泡、不显示名字。
 *   - 悬停才出现工具条（复制 / 编辑 / 重新生成 / ⋯）。
 *   - 生成中：末尾 2px 强调色光标闪烁，工具条换成「停止」。
 *   - 中断：气泡下方 `已中断` + 「继续」按钮。
 *   - 元信息默认隐藏，悬停时显示（model / 用时 / tokens / 精确或估算）。
 *   - 界面**不使用头像**。
 */
import { memo, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Message } from '@shared/types.js';
import { useMenuStore } from '../stores/menu.js';
import { Icons } from './Icons.js';
import { MarkdownBody } from './MarkdownBody.js';

export interface MessageItemProps {
  message: Message;
  characterName: string;
  /** 全局「显示 token 元信息」开关 */
  showMetaAlways: boolean;
  /** 本条是否正在流式生成 */
  streaming: boolean;
  /** 是否是最后一条助手消息（决定「重新生成」是否可用） */
  isLastAssistant?: boolean;
  onCopy?(): void;
  onEdit?(content: string, truncate: boolean): void;
  onRegenerate?(): void;
  onDelete?(): void;
  onDeleteFrom?(): void;
  onContinue?(): void;
  onStop?(): void;
  /** 编辑时若会波及摘要，给出段数提示 */
  invalidatedSummaries?(message: Message): number;
}

function formatElapsed(ms?: number): string {
  if (typeof ms !== 'number') return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

function MetaLine({ message, showMetaAlways }: { message: Message; showMetaAlways: boolean }): JSX.Element | null {
  const meta = message.metadata;
  const hasAnything =
    meta.model || meta.elapsedMs || meta.completionTokens || meta.ttftMs || meta.promptTokens;
  if (!hasAnything) return null;

  const tokens = meta.completionTokens ?? 0;
  const precision = meta.tokensExact ? '精确' : '约（估算）';
  const parts = [
    meta.model,
    formatElapsed(meta.elapsedMs),
    tokens ? `${tokens.toLocaleString('en-US')} tok` : '',
    precision,
  ].filter(Boolean);

  return (
    <div className={showMetaAlways ? 'meta pinned' : 'meta'}>
      {parts.join(' · ')}
      {meta.ttftMs ? ` · TTFT ${meta.ttftMs}ms` : ''}
    </div>
  );
}

function MessageItemInner({
  message,
  characterName,
  showMetaAlways,
  streaming,
  isLastAssistant,
  onCopy,
  onEdit,
  onRegenerate,
  onDelete,
  onDeleteFrom,
  onContinue,
  onStop,
  invalidatedSummaries,
}: MessageItemProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [error, setError] = useState('');
  const openMenu = useMenuStore((s) => s.open);

  const isUser = message.role === 'user';
  const cascadeCount = useMemo(
    () => (editing && invalidatedSummaries ? invalidatedSummaries(message) : 0),
    [editing, invalidatedSummaries, message],
  );

  const startEdit = (): void => {
    setDraft(message.content);
    setError('');
    setEditing(true);
  };

  const save = (truncate: boolean): void => {
    const value = draft.trim();
    if (!value) {
      setError('内容不能为空');
      return;
    }
    setEditing(false);
    onEdit?.(value, truncate);
  };

  const openMoreMenu = (trigger: HTMLElement): void => {
    openMenu(
      { rect: trigger.getBoundingClientRect(), targetId: message.id, trigger },
      [
        { label: '复制内容', onSelect: () => onCopy?.() },
        { label: '删除这一条', danger: true, onSelect: () => onDelete?.() },
        { label: '删除以下全部', danger: true, onSelect: () => onDeleteFrom?.() },
      ],
      '消息操作',
    );
  };

  return (
    <div
      className={`msg ${isUser ? 'user' : 'assistant'}${message.archived ? ' archived' : ''}`}
      data-id={message.id}
      data-role={message.role}
    >
      {/* 工具条：只在该条悬停时出现；生成中换成「停止」 */}
      <div className="toolbar" role="toolbar" aria-label="消息操作">
        {streaming ? (
          <button type="button" title="停止生成" aria-label="停止生成" onClick={onStop}>
            {Icons.stop()}
          </button>
        ) : (
          <>
            <button type="button" title="复制" aria-label="复制消息" onClick={() => onCopy?.()}>
              {Icons.copy()}
            </button>
            {isUser ? (
              <button type="button" title="编辑" aria-label="编辑消息" onClick={startEdit}>
                {Icons.edit()}
              </button>
            ) : null}
            {!isUser && isLastAssistant ? (
              <button
                type="button"
                title="重新生成"
                aria-label="重新生成"
                onClick={() => onRegenerate?.()}
              >
                {Icons.redo()}
              </button>
            ) : null}
            <button
              type="button"
              title="更多"
              aria-label="更多消息操作"
              aria-haspopup="menu"
              data-menu-trigger
              onClick={(event) => openMoreMenu(event.currentTarget)}
            >
              {Icons.dots()}
            </button>
          </>
        )}
      </div>

      {/* 角色消息有名字行；用户消息不显示名字 */}
      {!isUser ? (
        <div className="head">
          <span className="name">{characterName}</span>
        </div>
      ) : null}

      {editing ? (
        <div className="body">
          <textarea
            className="edit-area"
            value={draft}
            aria-label="编辑消息"
            onChange={(event) => {
              setDraft(event.target.value);
              setError('');
            }}
          />
          <div className="edit-actions">
            <span>截断后续消息？</span>
            <button type="button" className="btn" style={{ height: 28 }} onClick={() => save(false)}>
              仅保存
            </button>
            <button
              type="button"
              className="btn primary"
              style={{ height: 28, width: 'auto' }}
              onClick={() => save(true)}
            >
              保存并截断
            </button>
            <button type="button" className="btn" style={{ height: 28 }} onClick={() => setEditing(false)}>
              取消
            </button>
            {cascadeCount > 0 ? (
              <span className="inline-error">{`此操作会使 ${cascadeCount} 段摘要失效并被删除`}</span>
            ) : null}
            {error ? <span className="inline-error">{error}</span> : null}
          </div>
        </div>
      ) : (
        <div className="body">
          {isUser ? (
            message.content
          ) : (
            <>
              <MarkdownBody content={message.content} />
              {streaming ? <span className="cursor" aria-hidden="true" /> : null}
            </>
          )}
        </div>
      )}

      {/* 中断状态 */}
      {message.status === 'interrupted' && !streaming ? (
        <div className="interrupted-tag">
          已中断
          <button type="button" onClick={onContinue}>
            继续
          </button>
        </div>
      ) : null}

      {/* 错误条：原因 + 重试 */}
      {message.metadata.error ? (
        <div className="error-bar">
          {message.metadata.error.message}
          <button type="button" onClick={onRegenerate}>
            重试
          </button>
        </div>
      ) : null}

      <MetaLine message={message} showMetaAlways={showMetaAlways} />
    </div>
  );
}

/**
 * 段落级 memo（技术方案 9.5）。
 *
 * 流式期间只有最后一条助手消息在变，其余消息的 props 不变，
 * 因此这里的 memo 能挡住"每个 chunk 把整篇对话重渲染一遍"的开销。
 */
export const MessageItem = memo(MessageItemInner);
