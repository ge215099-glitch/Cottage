/**
 * 左侧栏（UI 文档第 2.1 / 3 / 4 / 5 节）。
 *
 * 结构（上固定 / 下滚动）：
 *   ① 品牌行 ② 新对话 + 搜索 ③ 固定导航 ④ 列表标题 ⑤ 对话列表（唯一滚动区）⑥ 底部人设
 *
 * 三个容易被低估的实现点：
 *   1. `⋯` 按钮**常驻占位**（26px 恒在，只是 opacity 0），否则悬停时标题会横跳。
 *   2. `⋯` **不进入 Tab 序列**（`tabIndex={-1}`），改用 Shift+F10 触发——
 *      1000 条会话不该产生 2000 个 Tab 停留点（UI 文档 5.4）。
 *   3. 列表**只有「已置顶」与其余全部两段**，不按时间分组。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useAppStore, filterConversations, groupConversations, type ViewKey } from '../stores/app.js';
import { useChatStore } from '../stores/chat.js';
import { DEFAULT_GRACE_MS, useMenuStore } from '../stores/menu.js';
import { Icons } from './Icons.js';
import { VirtualRowList, shouldVirtualize } from './VirtualRowList.js';
import type { Conversation } from '@shared/types.js';

/**
 * 固定导航项（不设二级分组标题）。
 *
 * **为什么没有「对话」**：正下方就是会话列表，它本身就是回到对话的入口——
 * 再放一个「对话」导航等于同一个动作有两个入口，用户点列表时还会疑惑
 * "为什么点了没跳转"。所以导航只留三个"去别处"的入口（角色库 / 人设 / 设置），
 * 回到对话靠点会话行或新建一个。
 */
const NAV_ITEMS: Array<{ key: ViewKey; label: string; icon: () => JSX.Element }> = [
  { key: 'characters', label: '角色库', icon: Icons.characters },
  { key: 'personas', label: '人设', icon: Icons.personas },
  { key: 'settings', label: '设置', icon: Icons.settings },
];

/** 标题长度上限（UI 文档 4.6：超出即截断输入，不等到提交才报错）。 */
export const TITLE_MAX_LENGTH = 80;

export interface SidebarProps {
  onNewChat(): void;
  onSelectConversation(id: string): void;
  onRenameConversation(id: string, title: string): Promise<void>;
  onTogglePin(id: string, pinned: boolean): void;
  onDeleteConversation(id: string): void;
  onOpenPersonaMenu(rect: DOMRect, trigger: HTMLElement): void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function Sidebar({
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onTogglePin,
  onDeleteConversation,
  onOpenPersonaMenu,
  searchInputRef,
}: SidebarProps): JSX.Element {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const conversations = useAppStore((s) => s.conversations);
  const personas = useAppStore((s) => s.personas);

  const activeId = useChatStore((s) => s.conversationId);
  const streamingId = useChatStore((s) => s.streamingConversationId);
  const openMenu = useMenuStore((s) => s.open);
  const scheduleClose = useMenuStore((s) => s.scheduleClose);
  const cancelClose = useMenuStore((s) => s.cancelClose);

  /** 正在行内重命名的会话 id */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const defaultPersona = useMemo(
    () => personas.find((p) => p.isDefault) ?? personas[0] ?? null,
    [personas],
  );

  // 行内重命名：进入时全选、光标在末尾
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!renamingId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [renamingId]);

  /** 过滤 + 两段分组。注意过滤态下不渲染「已置顶」标题（UI 文档 5.2）。 */
  const filtered = useMemo(
    () => filterConversations(conversations, query),
    [conversations, query],
  );
  const groups = useMemo(() => groupConversations(filtered), [filtered]);
  const filtering = query.trim().length >= 2;

  /** 打开某个会话行的 ⋯ 菜单（菜单项 ≤ 5 条，UI 文档 4.3）。 */
  const openRowMenu = (conversation: Conversation, trigger: HTMLElement): void => {
    const pinned = conversation.pinnedAt !== null;
    openMenu(
      { rect: trigger.getBoundingClientRect(), targetId: conversation.id, trigger },
      [
        { label: '重命名', kbd: 'F2', onSelect: () => setRenamingId(conversation.id) },
        {
          label: pinned ? '取消置顶' : '置顶',
          onSelect: () => onTogglePin(conversation.id, !pinned),
        },
        // 分隔线是一条独立项（不计数），把破坏性动作与上面的动作隔开
        { label: '', separator: true, onSelect: () => undefined },
        { label: '删除', danger: true, onSelect: () => onDeleteConversation(conversation.id) },
      ],
      `更多操作：${conversation.title}`,
    );
  };

  /** 列表键盘导航（UI 文档 5.4）。 */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.conv-row');
    if (!row) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.conv-row') ?? []);
    const index = rows.indexOf(row);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows[Math.min(rows.length - 1, index + 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(0, index - 1)]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    } else if (event.key === 'F2') {
      event.preventDefault();
      setRenamingId(row.dataset['id'] ?? null);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const id = row.dataset['id'];
      if (id) onDeleteConversation(id);
    } else if (event.key === 'F10' && event.shiftKey) {
      // Shift+F10 是 ⋯ 的键盘等效入口（⋯ 本身不在 Tab 序列里）
      event.preventDefault();
      const id = row.dataset['id'];
      const conversation = conversations.find((c) => c.id === id);
      const trigger = row.querySelector<HTMLElement>('.row-menu-btn') ?? row;
      if (conversation) openRowMenu(conversation, trigger);
    } else if (event.key === 'Home') {
      event.preventDefault();
      rows[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (event.key === 'ContextMenu') {
      event.preventDefault();
      const id = row.dataset['id'];
      const conversation = conversations.find((c) => c.id === id);
      if (conversation) openRowMenu(conversation, row);
    }
  };

  const renderRow = (conversation: Conversation): JSX.Element => {
    const active = conversation.id === activeId;
    // 生成中的会话标题右侧带 8px 呼吸圆点；切换会话不打断生成
    const streaming = streamingId === conversation.id;
    const isRenaming = renamingId === conversation.id;

    return (
      <div
        key={conversation.id}
        className={`conv-row${active ? ' active' : ''}`}
        role="listitem"
        tabIndex={0}
        data-id={conversation.id}
        aria-label={`对话：${conversation.title}`}
        aria-current={active ? 'true' : undefined}
        aria-haspopup="menu"
        onClick={() => {
          if (!isRenaming) onSelectConversation(conversation.id);
        }}
        onDoubleClick={() => setRenamingId(conversation.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          openRowMenu(conversation, event.currentTarget);
        }}
        onMouseEnter={cancelClose}
        onMouseLeave={() => scheduleClose(DEFAULT_GRACE_MS)}
      >
        {isRenaming ? (
          <RenameInput
            ref={renameInputRef}
            initialValue={conversation.title}
            onSubmit={async (value) => {
              await onRenameConversation(conversation.id, value);
              setRenamingId(null);
            }}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <>
            <span className="conv-title">
              <Highlight text={conversation.title} query={filtering ? query : ''} />
            </span>
            {streaming ? <span className="stream-dot" title="生成中" /> : null}
            <button
              type="button"
              className="row-menu-btn"
              data-menu-trigger
              // 刻意不进 Tab 序列：行数可上千，否则 Tab 停留点会爆炸
              tabIndex={-1}
              aria-haspopup="menu"
              aria-label={`更多操作：${conversation.title}`}
              title="更多操作"
              onClick={(event) => {
                event.stopPropagation();
                openRowMenu(conversation, event.currentTarget);
              }}
            >
              {Icons.dots()}
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <aside id="sidebar" className={collapsed ? 'collapsed' : undefined} aria-label="侧边栏">
      {/* ① 品牌行：双击整行折叠/展开 */}
      <div className="sidebar-head" onDoubleClick={toggleSidebar}>
        <div className="brand">Cottage</div>
        <div className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title="折叠侧栏 (Ctrl+B)"
          aria-label="折叠侧栏"
          onClick={toggleSidebar}
        >
          {Icons.sidebar()}
        </button>
      </div>

      {/* ② 主操作 */}
      <div className="sidebar-actions">
        <button type="button" className="new-chat" onClick={onNewChat} title="新对话 (Ctrl+N)">
          {Icons.plus()}
          <span>新对话</span>
        </button>
        <div className="search-row">
          {Icons.search()}
          <input
            ref={searchInputRef}
            type="search"
            placeholder="搜索对话…"
            aria-label="搜索对话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
              }
            }}
          />
          <span className="kbd">Ctrl K</span>
        </div>
      </div>

      {/* ③ 固定导航：当前项 = 浅填充 + 左 2px 强调条，图标不着色 */}
      <nav className="nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-item${view === item.key ? ' active' : ''}`}
            onClick={() => setView(item.key)}
            aria-current={view === item.key ? 'page' : undefined}
            title={item.label}
          >
            {item.icon()}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* ④ 列表标题行 */}
      <div className="list-head">
        <span>对话</span>
        <div className="spacer" />
        <button type="button" className="icon-btn" title="新对话" aria-label="新对话" onClick={onNewChat}>
          {Icons.plus()}
        </button>
      </div>

      {/* ⑤ 对话列表：唯一滚动区 */}
      <div
        id="conv-list"
        ref={listRef}
        className="conv-list"
        role="list"
        aria-label="对话列表"
        onKeyDown={onListKeyDown}
      >
        {!filtered.length ? (
          <div className="list-empty">
            {filtering ? (
              '没有匹配的对话'
            ) : (
              <>
                还没有对话　
                <button type="button" onClick={onNewChat}>
                  新建一个 →
                </button>
              </>
            )}
          </div>
        ) : filtering ? (
          <>
            {/* 过滤态：不渲染「已置顶」标题，改为一行计数（置顶项仍排最前） */}
            <div className="group-title">
              <span>找到 {filtered.length} 个对话</span>
            </div>
            <ConversationRows rows={[...groups.pinned, ...groups.rest]} renderRow={renderRow} />
          </>
        ) : (
          <>
            {groups.pinned.length ? (
              <>
                <div className="group-title">
                  <span>已置顶</span>
                </div>
                <ConversationRows rows={groups.pinned} renderRow={renderRow} />
              </>
            ) : null}
            {/* 其余全部会话没有段标题 */}
            <ConversationRows rows={groups.rest} renderRow={renderRow} />
          </>
        )}
      </div>

      {/* ⑥ 底部人设（不留头像位，身份靠文本） */}
      <div
        className="sidebar-foot"
        role="button"
        tabIndex={0}
        title="当前人设"
        onClick={(event) => onOpenPersonaMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenPersonaMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget);
          }
        }}
      >
        <div className="who">
          {defaultPersona?.name ?? '未设置人设'}
          <small>默认人设</small>
        </div>
        <button type="button" className="icon-btn" aria-label="人设选项" tabIndex={-1}>
          {Icons.dots()}
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 行内重命名                                                          */
/* ------------------------------------------------------------------ */

interface RenameInputProps {
  initialValue: string;
  onSubmit(value: string): void | Promise<void>;
  onCancel(): void;
}

/**
 * 行内重命名输入框（UI 文档 4.6）。
 *
 * 行为细节全部来自文档：
 *   - 文本**全选**、光标在末尾；
 *   - `Enter` 或失焦 → 提交；`Esc` → 取消并回滚；
 *   - 空标题不提交、不弹窗，只抖动 + 危险色边框，**保持编辑态**；
 *   - 上限 80 字，超出即截断输入。
 */
export const RenameInput = (() => {
  // 用 forwardRef 风格的普通函数组件即可（React 19 允许 ref 作为 prop）
  return function RenameInputInner({ initialValue, onSubmit, onCancel, ref }: RenameInputProps & { ref?: React.Ref<HTMLInputElement> }): JSX.Element {
    const [value, setValue] = useState(initialValue);
    const [invalid, setInvalid] = useState(false);
    const [errorText, setErrorText] = useState('');
    const localRef = useRef<HTMLInputElement | null>(null);

    const attachRef = (node: HTMLInputElement | null): void => {
      localRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    };

    const commit = (): void => {
      const trimmed = value.trim();
      if (!trimmed) {
        // 空标题：不提交、不弹窗，抖动 + 危险色，保持编辑态
        setInvalid(true);
        setErrorText('标题不能为空');
        window.setTimeout(() => setInvalid(false), 400);
        localRef.current?.focus();
        return;
      }
      void onSubmit(trimmed);
    };

    return (
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          ref={attachRef}
          className={invalid ? 'rename-input invalid' : 'rename-input'}
          value={value}
          maxLength={TITLE_MAX_LENGTH}
          aria-label="重命名对话"
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setValue(event.target.value.slice(0, TITLE_MAX_LENGTH));
            setErrorText('');
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
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
        {/* 无障碍播报：不夺焦点 */}
        <span aria-live="polite" className="sr-only">
          {errorText}
        </span>
      </span>
    );
  };
})();

/** 搜索命中片段加粗（其余不变）。 */
function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
  const q = query.trim();
  if (q.length < 2) return <>{text}</>;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <b>{text.slice(index, index + q.length)}</b>
      {text.slice(index + q.length)}
    </>
  );
}

/**
 * 会话行渲染器：条目多时走虚拟滚动，少时直接全量渲染。
 *
 * 阈值存在的理由：虚拟化要付出绝对定位 + 额外算层的成本，几十条会话时纯属负担。
 * 上千条时它才是必需的——UI 文档 5.6 明确要求"只渲染视口 ±10 行"。
 *
 * 注意这里**不接管滚动容器**：滚动条仍由 `.conv-list` 提供，这样分组标题的
 * `position: sticky` 才能照常吸顶（把滚动交给虚拟列表自己，吸顶就会失效）。
 */
function ConversationRows({
  rows,
  renderRow,
}: {
  rows: Conversation[];
  renderRow(conversation: Conversation): JSX.Element;
}): JSX.Element {
  const scrollElement = document.getElementById('conv-list');

  if (!shouldVirtualize(rows.length) || !scrollElement) {
    return <>{rows.map(renderRow)}</>;
  }

  return (
    <VirtualRowList
      items={rows}
      rowKey={(conversation) => conversation.id}
      renderRow={(conversation) => renderRow(conversation)}
      scrollElement={scrollElement}
    />
  );
}
