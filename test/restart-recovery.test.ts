/**
 * 崩溃恢复与持久化测试（产品设计文档 7 验收项 10 的可测部分）。
 *
 * 验收原文："应用在流式中被强杀后重启，消息状态一致，无残留『生成中』。"
 *
 * **这里能证明什么、不能证明什么**：
 *   - 能证明：写盘是真的（换一个连接读得到）、重启时的清扫逻辑能把残留
 *     `streaming` 改成 `interrupted` 且保留部分内容、清扫是幂等的。
 *   - 不能证明：Electron 进程真的被 SIGKILL 之后的行为。那需要拉起真实进程，
 *     属于 E2E；本文件用的是"关闭连接再重开"来模拟重启，**语义等价**于
 *     应用退出后重新启动（数据层完全一致），但不等价于验证 Electron 生命周期。
 *
 * 用真实文件而不是 `:memory:`：内存库换个连接就什么都没了，测不出持久化。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openNodeSqliteDriver } from '../src/main/db/node-sqlite-driver.js';
import { migrate } from '../src/main/db/migrations/index.js';
import * as characters from '../src/main/db/dao/characters.js';
import * as conversations from '../src/main/db/dao/conversations.js';
import * as messages from '../src/main/db/dao/messages.js';
import * as summaries from '../src/main/db/dao/summaries.js';
import type { DatabaseDriver } from '../src/main/db/driver.js';

const T0 = 1_700_000_000_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 开一个真实的临时库文件。 */
function openFileDb(): { db: DatabaseDriver; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cottage-restart-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'cottage.db');
  const db = openNodeSqliteDriver({ file });
  migrate(db);
  return { db, file };
}

/** 模拟"应用重启"：关闭连接后用同一个文件重新打开并跑一遍启动流程。 */
function restart(file: string): { db: DatabaseDriver; swept: number } {
  const db = openNodeSqliteDriver({ file });
  // 主进程启动时的顺序：迁移 → 清扫（见 src/main/index.ts）
  migrate(db);
  const swept = messages.sweepStreamingMessages(db, T0 + 999_999);
  return { db, swept };
}

describe('流式中断后的重启一致性（验收项 10）', () => {
  it('正常关闭再打开：消息与摘要都还在（先证明写盘是真的）', () => {
    const { db, file } = openFileDb();
    const charId = characters.importCharacter(db, { data: { name: '爱丽丝' } }, T0).character.id;
    const conversation = conversations.createConversation(
      db,
      { title: '持久化验证', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0,
    );
    messages.insertMessage(
      db,
      { conversationId: conversation.id, role: 'assistant', content: '已经落库的内容' },
      T0,
    );
    db.close();

    const { db: reopened } = restart(file);
    const loaded = messages.listMessages(reopened, conversation.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.content).toBe('已经落库的内容');
    reopened.close();
  });

  it('强杀（连接未收尾）后重启：残留的 streaming 变成 interrupted，部分内容仍在', () => {
    const { db, file } = openFileDb();
    const charId = characters.importCharacter(db, { data: { name: '管家' } }, T0).character.id;
    const conversation = conversations.createConversation(
      db,
      { title: '中断的会话', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0,
    );

    // 模拟"流到一半，进程没了"：行已插入且状态为 streaming，内容只写了一半
    const half = messages.insertMessage(
      db,
      { conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming' },
      T0,
    );
    messages.appendMessageContent(db, half.id, '已经收到一半的回复', T0 + 100);
    // 注意这里**故意不调用 finishMessage**，也不关闭连接——模拟强杀
    // （SQLite 的 WAL 会保证已提交的事务仍在）

    // 同一进程内换连接读，等价于重启
    const { db: afterRestart, swept } = restart(file);

    expect(swept).toBe(1);
    const recovered = messages.getMessage(afterRestart, half.id)!;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.metadata.interrupted).toBe(true);
    // 产品承诺：已收到的部分必须保留
    expect(recovered.content).toBe('已经收到一半的回复');

    // 不再有残留的"生成中"
    const stillStreaming = afterRestart
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'streaming'")
      .get();
    expect(Number(stillStreaming?.n)).toBe(0);

    afterRestart.close();
    db.close();
  });

  it('重复重启是幂等的：第二次清扫没有可扫的行', () => {
    const { db, file } = openFileDb();
    const charId = characters.importCharacter(db, { data: { name: 'A' } }, T0).character.id;
    const conversation = conversations.createConversation(
      db,
      { title: 't', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0,
    );
    messages.insertMessage(
      db,
      { conversationId: conversation.id, role: 'assistant', content: '半截', status: 'streaming' },
      T0,
    );

    const first = restart(file);
    expect(first.swept).toBe(1);
    first.db.close();

    const second = restart(file);
    expect(second.swept).toBe(0);
    // 状态没有被反复改写
    const all = messages.listMessages(second.db, conversation.id);
    expect(all.every((m) => m.status === 'interrupted')).toBe(true);
    second.db.close();
    db.close();
  });

  it('已完成的消息不会被清扫误伤', () => {
    const { db, file } = openFileDb();
    const charId = characters.importCharacter(db, { data: { name: 'A' } }, T0).character.id;
    const conversation = conversations.createConversation(
      db,
      { title: 't', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0,
    );
    const done = messages.insertMessage(
      db,
      { conversationId: conversation.id, role: 'assistant', content: '完整回答', status: 'streaming' },
      T0,
    );
    messages.finishMessage(db, done.id, 'done', { model: 'm', completionTokens: 12 }, T0 + 200);
    // 另一条仍留在 streaming
    messages.insertMessage(
      db,
      { conversationId: conversation.id, role: 'assistant', content: '半截', status: 'streaming' },
      T0 + 300,
    );
    db.close();

    const { db: afterRestart, swept } = restart(file);
    expect(swept).toBe(1);
    expect(messages.getMessage(afterRestart, done.id)!.status).toBe('done');
    afterRestart.close();
  });

  it('压缩结果跨重启保持一致（摘要与归档标记都持久化）', () => {
    const { db, file } = openFileDb();
    const charId = characters.importCharacter(db, { data: { name: 'A' } }, T0).character.id;
    const conversation = conversations.createConversation(
      db,
      { title: 't', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0,
    );
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(
        messages.insertMessage(
          db,
          { conversationId: conversation.id, role: 'user', content: `第 ${i + 1} 条` },
          T0 + i,
        ).id,
      );
    }
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: conversation.id,
        content: '摘要正文',
        coversFrom: 1,
        coversTo: 4,
        tokenCount: 150,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 4),
      },
      T0 + 100,
    );
    db.close();

    const { db: afterRestart } = restart(file);
    const restoredSummary = summaries.listSummaries(afterRestart, conversation.id);
    expect(restoredSummary).toHaveLength(1);
    expect(restoredSummary[0]!.content).toBe('摘要正文');

    // 归档标记也持久化：恢复后能正确取消归档
    const restored = summaries.restoreSummary(afterRestart, restoredSummary[0]!.id, T0 + 500);
    expect(restored.unarchivedCount).toBe(4);
    expect(messages.listMessages(afterRestart, conversation.id).every((m) => !m.archived)).toBe(true);
    afterRestart.close();
  });
});
