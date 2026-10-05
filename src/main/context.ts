/**
 * 主进程的应用上下文：把"谁在用哪个数据库、正在流式生成哪些会话"集中到一处。
 *
 * 为什么不散着传：IPC handler 有 40 多个，如果每个都自己去开库、自己去记
 * AbortController，很快就会出现"两个连接写同一个库""停止生成找错流"这类问题。
 * 集中成单一对象后：
 *   - **单实例单连接**（技术方案 5.1）：SQLite 单写者假设成立。
 *   - **每条会话至多一个在飞的流**：`streams` 以 conversationId 为键，
 *     重复发送时先中断旧的，避免两条回答交错写同一条消息。
 */
import type { DatabaseDriver } from './db/driver.js';
import type { NormalizedError } from '@shared/types.js';

/** 在飞的一次流式生成。 */
export interface ActiveStream {
  streamId: string;
  conversationId: string;
  messageId: string;
  controller: AbortController;
}

export interface AppContext {
  db: DatabaseDriver;
  /** 每条会话至多一个在飞的流 */
  streams: Map<string, ActiveStream>;
  /** 主进程 → renderer 的事件发送器；由窗口层注入，未就绪时为 null */
  emit: ((channel: string, payload: unknown) => void) | null;
  /** 数据库文件路径，供诊断页展示 */
  dbPath: string;
  /** userData 目录：头像等旁挂文件的落点（头像存 `<userData>/avatars/`） */
  userDataDir: string;
}

export function createAppContext(
  db: DatabaseDriver,
  dbPath: string,
  userDataDir: string,
): AppContext {
  return { db, streams: new Map(), emit: null, dbPath, userDataDir };
}

/** 发送事件（窗口未就绪时静默丢弃，不抛异常）。 */
export function emitEvent(ctx: AppContext, channel: string, payload: unknown): void {
  ctx.emit?.(channel, payload);
}

/** 中断某会话正在进行的生成；返回是否真的中断了。 */
export function abortConversation(ctx: AppContext, conversationId: string): boolean {
  const active = ctx.streams.get(conversationId);
  if (!active) return false;
  active.controller.abort();
  ctx.streams.delete(conversationId);
  return true;
}

/** 中断全部在飞的流（窗口关闭 / 应用退出时用）。 */
export function abortAll(ctx: AppContext): number {
  const count = ctx.streams.size;
  for (const active of ctx.streams.values()) active.controller.abort();
  ctx.streams.clear();
  return count;
}

/** 主进程未捕获异常的可见化通道（技术方案 3.2 纪律 2）。 */
export function reportAppError(ctx: AppContext, error: NormalizedError): void {
  emitEvent(ctx, 'app:error', error);
}
