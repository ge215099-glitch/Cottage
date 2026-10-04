/**
 * 对话切片：当前会话、消息列表、摘要、流式状态（技术方案 9.3）。
 *
 * 权威数据在主进程；这里只做投影。流式期间的增量更新走 `appendStreamDelta`，
 * 它只改最后那条助手消息的 content —— 整篇重渲染会让长对话的 Markdown
 * 每帧重解析一次（技术方案 9.5 提到的瓶颈）。
 */
import { create } from 'zustand';
import type { Conversation, Message, Summary } from '@shared/types.js';

export interface ChatState {
  conversationId: string | null;
  messages: Message[];
  summaries: Summary[];
  /** 正在流式生成的会话 id（可能是非当前会话：切换会话不打断生成） */
  streamingConversationId: string | null;
  streamingMessageId: string | null;
  /** 同一会话内的流标识，用于丢弃迟到的推送 */
  streamId: string | null;
  loading: boolean;

  setActive(conversationId: string | null): void;
  setMessages(messages: Message[]): void;
  setSummaries(summaries: Summary[]): void;
  upsertMessage(message: Message): void;
  removeMessage(id: string): void;
  beginStream(conversationId: string, messageId: string, streamId: string): void;
  appendStreamDelta(messageId: string, delta: string): void;
  endStream(messageId: string, message: Message | null): void;
  setLoading(loading: boolean): void;
}

export const useChatStore = create<ChatState>((set) => ({
  conversationId: null,
  messages: [],
  summaries: [],
  streamingConversationId: null,
  streamingMessageId: null,
  streamId: null,
  loading: false,

  setActive: (conversationId) =>
    // 切换会话时清空消息，避免上一个会话的消息短暂出现在新会话里
    set({ conversationId, messages: [], summaries: [], streamingMessageId: null, streamId: null }),

  setMessages: (messages) => set({ messages }),
  setSummaries: (summaries) => set({ summaries }),

  upsertMessage: (message) =>
    set((s) => {
      const index = s.messages.findIndex((m) => m.id === message.id);
      if (index === -1) return { messages: [...s.messages, message] };
      const next = [...s.messages];
      next[index] = message;
      return { messages: next };
    }),

  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

  beginStream: (conversationId, messageId, streamId) =>
    set({ streamingConversationId: conversationId, streamingMessageId: messageId, streamId }),

  appendStreamDelta: (messageId, delta) =>
    set((s) => {
      const index = s.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return s;
      const next = [...s.messages];
      next[index] = { ...next[index]!, content: next[index]!.content + delta };
      return { messages: next };
    }),

  endStream: (messageId, message) =>
    set((s) => {
      const messages = message
        ? s.messages.map((m) => (m.id === messageId ? message : m))
        : s.messages;
      return {
        messages,
        streamingConversationId: null,
        streamingMessageId: null,
        streamId: null,
      };
    }),

  setLoading: (loading) => set({ loading }),
}));

/** 会话是否正在生成中（左栏呼吸圆点用它）。 */
export function isStreaming(state: ChatState, conversationId: string): boolean {
  return state.streamingConversationId === conversationId;
}

/** 当前会话是否正处于生成中（输入区发送键变停止）。 */
export function isActiveStreaming(state: ChatState): boolean {
  return state.conversationId !== null && state.streamingConversationId === state.conversationId;
}

/**
 * 按 sortOrder 分组为「同角色连续」的运行段，供消息流决定 8px 还是 24px 间距，
 * 以及摘要分割条该插在哪两条之间。
 */
export interface MessageRun {
  role: Message['role'];
  messages: Message[];
}

export function groupMessages(messages: Message[]): MessageRun[] {
  const runs: MessageRun[] = [];
  for (const message of [...messages].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const last = runs[runs.length - 1];
    if (last && last.role === message.role) last.messages.push(message);
    else runs.push({ role: message.role, messages: [message] });
  }
  return runs;
}

/** 取某段摘要应插入的位置：覆盖区间最后一条消息的 sortOrder。 */
export function summaryAnchor(summary: Summary, messages: Message[]): number | null {
  const covered = messages.filter(
    (m) => m.sortOrder >= summary.coversFrom && m.sortOrder <= summary.coversTo,
  );
  if (!covered.length) return null;
  return covered[covered.length - 1]!.sortOrder;
}

/** 供消息分组视图使用：按锚点把摘要插进消息序列。 */
export interface TimelineItem {
  kind: 'message' | 'summary';
  key: string;
  message?: Message;
  summary?: Summary;
}

export function buildTimeline(messages: Message[], summaries: Summary[]): TimelineItem[] {
  const anchors = new Map<number, Summary[]>();
  for (const summary of summaries) {
    const anchor = summaryAnchor(summary, messages);
    if (anchor === null) continue;
    const list = anchors.get(anchor) ?? [];
    list.push(summary);
    anchors.set(anchor, list);
  }

  const items: TimelineItem[] = [];
  for (const message of [...messages].sort((a, b) => a.sortOrder - b.sortOrder)) {
    items.push({ kind: 'message', key: `m:${message.id}`, message });
    for (const summary of anchors.get(message.sortOrder) ?? []) {
      items.push({ kind: 'summary', key: `s:${summary.id}`, summary });
    }
  }
  return items;
}

/** 当前会话对象（从列表里找），避免每个组件各自 find。 */
export function findConversation(
  conversations: Conversation[],
  id: string | null,
): Conversation | null {
  if (!id) return null;
  return conversations.find((c) => c.id === id) ?? null;
}
