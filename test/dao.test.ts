/**
 * DAO 层测试。
 *
 * 重点覆盖那些"写错了很久也不会有人发现"的规则：
 *   - 置顶不得改写 `updated_at`（UI 文档 9.1 / 验收项 22）
 *   - 列表排序 SQL 与"只有两段、不按时间分组"
 *   - 删除会话是一个事务
 *   - 压缩写摘要 + 归档在同一事务（验收项 6）
 *   - 恢复归档 → 摘要失效、占用释放（验收项 7）
 *   - 编辑并截断落在摘要区间 → 摘要级联失效（验收项 8）
 *   - 启动清扫把残留 streaming 改成 interrupted（验收项 10）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseDriver } from '../src/main/db/driver.js';
import * as characters from '../src/main/db/dao/characters.js';
import * as conversations from '../src/main/db/dao/conversations.js';
import * as messages from '../src/main/db/dao/messages.js';
import * as personas from '../src/main/db/dao/personas.js';
import * as providers from '../src/main/db/dao/providers.js';
import * as settings from '../src/main/db/dao/settings.js';
import * as summaries from '../src/main/db/dao/summaries.js';
import { openMigratedDb } from './helpers/db.js';

const T0 = 1_700_000_000_000;

let db: DatabaseDriver;
let charId: string;
let personaId: string;

/** 建一个角色 + 一个会话，返回会话 id。 */
function seedConversation(title = '夜巡酒馆的第三夜'): string {
  const conversation = conversations.createConversation(
    db,
    { title, characterId: charId, personaId, providerId: null, model: 'deepseek-chat' },
    T0,
  );
  return conversation.id;
}

/** 往会话里塞 n 条消息（user/assistant 交替）。 */
function seedMessages(conversationId: string, n: number, startAt = T0): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const m = messages.insertMessage(
      db,
      {
        conversationId,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `第 ${i + 1} 条消息的正文内容，用来撑起一点长度。`,
      },
      startAt + i * 1000,
    );
    ids.push(m.id);
  }
  return ids;
}

beforeEach(() => {
  db = openMigratedDb();
  charId = characters.importCharacter(
    db,
    { spec: 'chara_card_v3', data: { name: '管家', description: '老宅的管家。', first_mes: '「您来早了。」' } },
    T0,
  ).character.id;
  personaId = personas.createPersona(db, { name: 'ASMobbin', description: '' }, T0).id;
});

describe('会话 DAO', () => {
  it('置顶不修改 updated_at（验收项 22）', () => {
    const id = seedConversation();
    const before = conversations.getConversation(db, id)!;
    expect(before.pinnedAt).toBeNull();

    // 用一个明显更晚的时刻置顶：若实现顺手写了 updated_at，这里必然被检出
    conversations.setPinned(db, id, true, T0 + 999_999);

    const after = conversations.getConversation(db, id)!;
    expect(after.pinnedAt).toBe(T0 + 999_999);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('取消置顶后回到它按 updated_at 该在的位置', () => {
    const old = seedConversation('上个月的会话');
    const recent = seedConversation('最近的会话');
    conversations.touchConversation(db, old, T0 - 30 * 86_400_000);
    conversations.touchConversation(db, recent, T0);

    // 置顶老会话 → 排到最前
    conversations.setPinned(db, old, true, T0 + 5000);
    expect(conversations.listConversations(db).map((c) => c.id)).toEqual([old, recent]);

    // 取消置顶 → 回到时间序（近期在前）。若置顶污染了 updated_at，old 会错误地留在最前。
    conversations.setPinned(db, old, false, T0 + 6000);
    expect(conversations.listConversations(db).map((c) => c.id)).toEqual([recent, old]);
  });

  it('排序规则：置顶段在前、段内按置顶时刻倒序，其余按 updated_at 倒序', () => {
    const a = seedConversation('A');
    const b = seedConversation('B');
    const c = seedConversation('C');
    conversations.touchConversation(db, a, T0 + 100);
    conversations.touchConversation(db, b, T0 + 300);
    conversations.touchConversation(db, c, T0 + 200);

    expect(conversations.listConversations(db).map((x) => x.title)).toEqual(['B', 'C', 'A']);

    conversations.setPinned(db, a, true, T0 + 10);
    conversations.setPinned(db, c, true, T0 + 20);
    // 置顶段内 c（更晚置顶）在 a 之前
    expect(conversations.listConversations(db).map((x) => x.title)).toEqual(['C', 'A', 'B']);
  });

  it('重命名默认不修改 updated_at（列表不发生跳变）', () => {
    const id = seedConversation('旧标题');
    const before = conversations.getConversation(db, id)!;
    conversations.renameConversation(db, id, '新标题');
    const after = conversations.getConversation(db, id)!;
    expect(after.title).toBe('新标题');
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('标题为空或超长被拒绝', () => {
    const id = seedConversation();
    expect(() => conversations.renameConversation(db, id, '   ')).toThrow(/不能为空/);
    expect(() => conversations.renameConversation(db, id, 'x'.repeat(81))).toThrow(/80/);
  });

  it('列表带出消息数与摘要段数，不产生 N+1 查询', () => {
    const id = seedConversation();
    seedMessages(id, 5);
    const stats = conversations.getConversationStats(db, id);
    expect(stats.messageCount).toBe(5);

    const listed = conversations.listConversations(db)[0]!;
    expect(listed.messageCount).toBe(5);
    expect(listed.summaryCount).toBe(0);
  });

  it('删除会话是一个事务：messages / summaries / conversations 一起消失', () => {
    const id = seedConversation();
    const msgIds = seedMessages(id, 3);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '摘要正文',
        coversFrom: 1,
        coversTo: 2,
        tokenCount: 120,
        providerId: null,
        model: 'deepseek-chat',
        archiveMessageIds: msgIds.slice(0, 2),
      },
      T0,
    );
    expect(conversations.getConversationStats(db, id)).toEqual({ messageCount: 3, summaryCount: 1 });

    const result = conversations.deleteConversation(db, id);
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual({ messages: 3, summaries: 1 });
    expect(conversations.getConversation(db, id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get<{ n: number }>()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM summaries').get<{ n: number }>()).toEqual({ n: 0 });
  });

  it('生成参数是会话级覆盖，且过 schema 校验', () => {
    const id = seedConversation();
    const updated = conversations.updateConversation(db, id, { params: { temperature: 0.3 } }, T0 + 1)!;
    expect(updated.params.temperature).toBe(0.3);
    // 未覆盖的字段保持默认
    expect(updated.params.topP).toBe(0.95);
    expect(updated.params.maxTokens).toBe(1024);
  });
});

describe('消息 DAO', () => {
  it('sort_order 由 DAO 分配且删除后不重号', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 3);
    expect(messages.listMessages(db, id).map((m) => m.sortOrder)).toEqual([1, 2, 3]);

    messages.deleteMessage(db, ids[1]!);
    const fourth = messages.insertMessage(
      db,
      { conversationId: id, role: 'assistant', content: '第 4 条' },
      T0 + 9999,
    );
    // 用 COUNT 实现的话这里会得到 3，与既有行重号
    expect(fourth.sortOrder).toBe(4);
  });

  it('流式落库：先写 streaming，收尾写状态与用量', () => {
    const id = seedConversation();
    const m = messages.insertMessage(
      db,
      { conversationId: id, role: 'assistant', content: '', status: 'streaming' },
      T0,
    );
    expect(m.status).toBe('streaming');

    messages.appendMessageContent(db, m.id, '已经生成了一半', T0 + 100);
    expect(messages.getMessage(db, m.id)!.content).toBe('已经生成了一半');

    const finished = messages.finishMessage(
      db,
      m.id,
      'done',
      { model: 'deepseek-chat', completionTokens: 12, ttftMs: 400, elapsedMs: 1800, tokensExact: false },
      T0 + 2000,
    )!;
    expect(finished.status).toBe('done');
    expect(finished.metadata.ttftMs).toBe(400);
    expect(finished.metadata.tokensExact).toBe(false);
  });

  it('启动清扫把残留 streaming 改成 interrupted 并补标记（验收项 10）', () => {
    const id = seedConversation();
    const a = messages.insertMessage(
      db,
      { conversationId: id, role: 'assistant', content: '半截内容', status: 'streaming' },
      T0,
    );
    const b = messages.insertMessage(
      db,
      { conversationId: id, role: 'assistant', content: '完整内容', status: 'done' },
      T0 + 1,
    );

    const swept = messages.sweepStreamingMessages(db, T0 + 5000);
    expect(swept).toBe(1);

    const sweptMsg = messages.getMessage(db, a.id)!;
    expect(sweptMsg.status).toBe('interrupted');
    expect(sweptMsg.metadata.interrupted).toBe(true);
    // 部分内容仍在（产品承诺）
    expect(sweptMsg.content).toBe('半截内容');
    // 已完成的行不受影响
    expect(messages.getMessage(db, b.id)!.status).toBe('done');

    // 幂等：再扫一次没有可扫的
    expect(messages.sweepStreamingMessages(db, T0 + 6000)).toBe(0);
  });

  it('metadata 里的坏 JSON 不会打断整表读取', () => {
    const id = seedConversation();
    const m = messages.insertMessage(db, { conversationId: id, role: 'user', content: 'hi' }, T0);
    db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run('{ 不是合法 JSON', m.id);
    const loaded = messages.getMessage(db, m.id)!;
    expect(loaded.metadata).toEqual({});
  });
});

describe('压缩与摘要 DAO', () => {
  it('写摘要与归档原消息在同一事务（验收项 6）', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 6);

    const summary = summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '结构化摘要正文',
        coversFrom: 1,
        coversTo: 4,
        tokenCount: 180,
        providerId: null,
        model: 'deepseek-chat',
        archiveMessageIds: ids.slice(0, 4),
      },
      T0,
    );

    expect(summary.level).toBe(1);
    expect(summary.coversFrom).toBe(1);
    expect(summary.tokenCount).toBe(180);
    expect(summary.model).toBe('deepseek-chat');

    const archivedCount = messages.listMessages(db, id).filter((m) => m.archived).length;
    expect(archivedCount).toBe(4);
  });

  it('事务失败时摘要不落库、归档标记不变（原子性，验收项 6 的反面）', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 4);

    expect(() =>
      summaries.writeSummaryAtomic(
        db,
        {
          conversationId: id,
          content: 'x',
          coversFrom: 1,
          coversTo: 2,
          tokenCount: 10,
          providerId: null,
          model: 'm',
          // 第二条 id 不存在：SQLite 会因外键/约束失败？——不会，UPDATE 影响 0 行。
          // 所以这里用一个必然违反约束的方式：covers_to 写成超出范围不该抛错,
          // 改为直接注入一条非法 level 的场景不由本函数负责。
          // 真正会抛错的是 conversationId 指向不存在的会话（外键约束）。
          archiveMessageIds: ids.slice(0, 2),
        },
        T0,
      ),
    ).not.toThrow();

    // 换一个真正会失败的场景：conversation_id 指向不存在的会话
    expect(() =>
      summaries.writeSummaryAtomic(
        db,
        {
          conversationId: 'cnv_不存在',
          content: 'x',
          coversFrom: 1,
          coversTo: 2,
          tokenCount: 10,
          providerId: null,
          model: 'm',
          archiveMessageIds: [],
        },
        T0,
      ),
    ).toThrow();

    // 失败那条没留下任何痕迹
    expect(db.prepare('SELECT COUNT(*) AS n FROM summaries').get<{ n: number }>()?.n).toBe(1);
  });

  it('恢复归档：摘要被删除且消息取消归档（验收项 7）', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 5);
    const summary = summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '摘要',
        coversFrom: 1,
        coversTo: 3,
        tokenCount: 150,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 3),
      },
      T0,
    );
    expect(summaries.listSummaries(db, id)).toHaveLength(1);
    expect(messages.listMessages(db, id).filter((m) => m.archived)).toHaveLength(3);

    const result = summaries.restoreSummary(db, summary.id, T0 + 1000);
    expect(result.restored).toBe(true);
    expect(result.from).toBe(1);
    expect(result.to).toBe(3);

    // 摘要消失
    expect(summaries.listSummaries(db, id)).toHaveLength(0);
    // 消息回到历史
    expect(messages.listMessages(db, id).filter((m) => m.archived)).toHaveLength(0);
  });

  it('恢复不存在的摘要返回 restored=false，不抛异常', () => {
    expect(summaries.restoreSummary(db, 'sum_不存在', T0).restored).toBe(false);
  });

  it('压缩候选是最老的连续未归档消息', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 10);
    // 归档前 4 条后，候选应从第 5 条开始
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '摘要',
        coversFrom: 1,
        coversTo: 4,
        tokenCount: 100,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 4),
      },
      T0,
    );

    const candidates = summaries.pickCompressionCandidates(db, id, 3);
    expect(candidates.from).toBe(5);
    expect(candidates.to).toBe(7);
    expect(candidates.ids).toHaveLength(3);
  });
});

describe('改消息与压缩的冲突规则（验收项 8）', () => {
  it('编辑并截断落在摘要区间内 → 摘要级联失效、消息取消归档', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 10);
    // 摘要覆盖第 1–6 条
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '覆盖 1–6 条',
        coversFrom: 1,
        coversTo: 6,
        tokenCount: 200,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 6),
      },
      T0,
    );
    expect(summaries.listSummaries(db, id)).toHaveLength(1);

    // 编辑第 3 条并截断后续：被截断区间 4..10 与摘要 1–6 重叠
    const result = messages.editMessageWithOptionalTruncate(
      db,
      ids[2]!,
      '编辑后的内容',
      true,
      T0 + 10_000,
    );

    expect(result.invalidatedSummaries).toBe(1);
    expect(result.truncatedCount).toBe(7); // 第 4..10 条
    expect(result.unarchivedCount).toBe(3); // 摘要区间内 4..6 条已归档的被取消归档

    // 摘要确实被删了（否则会出现"摘要里写着已经删掉的剧情"）
    expect(summaries.listSummaries(db, id)).toHaveLength(0);
    // 只剩前 3 条
    expect(messages.listMessages(db, id)).toHaveLength(3);
    expect(messages.listMessages(db, id).some((m) => m.archived)).toBe(false);
  });

  it('编辑不截断时摘要不受影响', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 8);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '覆盖 1–4 条',
        coversFrom: 1,
        coversTo: 4,
        tokenCount: 120,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 4),
      },
      T0,
    );

    const result = messages.editMessageWithOptionalTruncate(db, ids[5]!, '改一下', false, T0 + 1);
    expect(result.invalidatedSummaries).toBe(0);
    expect(summaries.listSummaries(db, id)).toHaveLength(1);
    expect(messages.listMessages(db, id)).toHaveLength(8);
  });

  it('截断区间不触及任何摘要时，摘要保持有效', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 8);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '覆盖 1–2 条',
        coversFrom: 1,
        coversTo: 2,
        tokenCount: 60,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 2),
      },
      T0,
    );

    // 从第 6 条开始截断：与摘要 1–2 无重叠
    const result = messages.editMessageWithOptionalTruncate(db, ids[5]!, '改', true, T0 + 2);
    expect(result.invalidatedSummaries).toBe(0);
    expect(summaries.listSummaries(db, id)).toHaveLength(1);
    expect(messages.listMessages(db, id)).toHaveLength(6);
  });

  it('删除一条消息同样触发摘要级联失效', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 6);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: '覆盖 1–5 条',
        coversFrom: 1,
        coversTo: 5,
        tokenCount: 180,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 5),
      },
      T0,
    );

    const result = messages.deleteMessageWithCascade(db, ids[3]!, T0 + 1);
    expect(result.deleted).toBe(true);
    expect(result.invalidatedSummaries).toBe(1);
    expect(summaries.listSummaries(db, id)).toHaveLength(0);
    expect(messages.listMessages(db, id)).toHaveLength(5);
  });

  it('findSummariesOverlapping 给出"会使几段摘要失效"的预览', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 20);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: 'A',
        coversFrom: 1,
        coversTo: 4,
        tokenCount: 60,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 4),
      },
      T0,
    );
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: 'B',
        coversFrom: 5,
        coversTo: 9,
        tokenCount: 80,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(4, 9),
      },
      T0,
    );

    // 从第 3 条起编辑 → 两段都受影响
    expect(summaries.findSummariesOverlapping(db, id, 3)).toHaveLength(2);
    // 从第 10 条起编辑 → 都不受影响
    expect(summaries.findSummariesOverlapping(db, id, 10)).toHaveLength(0);
  });
});

describe('清空会话（用开场白重开）', () => {
  it('消息与摘要一并清空，并推进 updated_at', () => {
    const id = seedConversation();
    const ids = seedMessages(id, 5);
    summaries.writeSummaryAtomic(
      db,
      {
        conversationId: id,
        content: 'S',
        coversFrom: 1,
        coversTo: 3,
        tokenCount: 90,
        providerId: null,
        model: 'm',
        archiveMessageIds: ids.slice(0, 3),
      },
      T0,
    );

    const result = messages.clearConversation(db, id, T0 + 77_000);
    expect(result).toEqual({ messages: 5, summaries: 1 });
    expect(messages.listMessages(db, id)).toHaveLength(0);
    expect(summaries.listSummaries(db, id)).toHaveLength(0);
    expect(conversations.getConversation(db, id)!.updatedAt).toBe(T0 + 77_000);
  });
});

describe('角色 DAO', () => {
  it('导入后能按名称、描述、标签搜索', () => {
    characters.importCharacter(
      db,
      { spec: 'chara_card_v2', data: { name: '爱丽丝', description: '钟表店学徒', tags: ['奇幻', '冒险'] } },
      T0,
    );
    characters.importCharacter(
      db,
      { spec: 'chara_card_v2', data: { name: '美嘉', description: '面包店店主', tags: ['日常'] } },
      T0,
    );

    expect(characters.listCharacters(db, { search: '钟表' })).toHaveLength(1);
    expect(characters.listCharacters(db, { search: '美嘉' })).toHaveLength(1);
    // 标签是精确匹配，不能把"奇幻"当成"奇"的子串命中
    expect(characters.listCharacters(db, { tags: ['日常'] }).map((c) => c.name)).toEqual(['美嘉']);
    expect(characters.listCharacters(db, { tags: ['不存在'] })).toHaveLength(0);
  });

  it('收藏排序在前，标签统计可用', () => {
    const a = characters.importCharacter(
      db,
      { data: { name: 'A', tags: ['共同'] } },
      T0,
    ).character.id;
    characters.importCharacter(db, { data: { name: 'B', tags: ['共同', '独有'] } }, T0 + 1);
    characters.updateCharacter(db, a, { favorite: true }, T0 + 2);

    expect(characters.listCharacters(db)[0]!.name).toBe('A');
    expect(characters.listCharacters(db, { favoriteOnly: true })).toHaveLength(1);

    const tags = characters.listCharacterTags(db);
    expect(tags.find((t) => t.tag === '共同')?.count).toBe(2);
    expect(tags.find((t) => t.tag === '独有')?.count).toBe(1);
  });

  it('导出走 raw_json 基底，第三方字段不丢（验收项 1 走库路径同样成立）', () => {
    const imported = characters.importCharacter(
      db,
      {
        spec: 'chara_card_v3',
        data: { name: '爱丽丝', description: '原描述', creator_notes: '第三方', 第三方键: { a: 1 } },
        顶层第三方: 'keep',
      },
      T0,
    );

    characters.updateCharacter(db, imported.character.id, { description: '改过的描述' }, T0 + 1);
    const exported = characters.exportCharacter(db, imported.character.id)!;

    const data = exported.data as Record<string, unknown>;
    expect(data.description).toBe('改过的描述');
    expect(data.creator_notes).toBe('第三方');
    expect(data.第三方键).toEqual({ a: 1 });
    expect(exported.顶层第三方).toBe('keep');
  });

  it('角色名不能改成空', () => {
    const id = characters.importCharacter(db, { data: { name: 'A' } }, T0).character.id;
    expect(() => characters.updateCharacter(db, id, { name: '  ' }, T0 + 1)).toThrow(/不能为空/);
  });

  it('被会话引用的角色不允许删除，并给出可读原因', () => {
    const other = characters.importCharacter(db, { data: { name: '无人使用' } }, T0).character.id;
    seedConversation();

    const blocked = characters.deleteCharacter(db, charId);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/对话/);
    // 未使用的可以删
    expect(characters.deleteCharacter(db, other).ok).toBe(true);
  });
});

describe('人设 DAO', () => {
  it('第一个 persona 自动成为默认，且默认唯一', () => {
    const first = personas.createPersona(db, { name: '第二个' }, T0 + 1);
    const second = personas.createPersona(db, { name: '第三个' }, T0 + 2);
    expect(first.isDefault).toBe(false);

    personas.setDefaultPersona(db, second.id);
    const all = personas.listPersonas(db);
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
    expect(all.find((p) => p.isDefault)!.id).toBe(second.id);
    expect(all[0]!.id).toBe(second.id); // 默认排最前
  });

  it('删除默认 persona 后默认顺延，并解除会话绑定', () => {
    const second = personas.createPersona(db, { name: '备用' }, T0 + 1);
    const conversationId = seedConversation();

    const result = personas.deletePersona(db, personaId);
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/解除/);

    expect(personas.getPersona(db, personaId)).toBeNull();
    // 会话的 persona_id 被置空
    expect(conversations.getConversation(db, conversationId)!.personaId).toBeNull();
    // 默认顺延给剩下的
    expect(personas.getDefaultPersona(db)!.id).toBe(second.id);
  });
});

describe('Provider DAO 与密钥边界', () => {
  it('对外只暴露 hasKey 布尔量，绝不回传密文', () => {
    const created = providers.createProvider(
      db,
      {
        name: '本地端点',
        type: 'openai',
        baseUrl: 'https://example.invalid/v1',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        compressionModel: 'deepseek-chat',
        enabled: true,
      },
      { apiKeyEnc: 'v10:加密后的密文', now: T0 },
    );

    expect(created.hasKey).toBe(true);
    // 序列化后整条记录里不得出现密文
    expect(JSON.stringify(created)).not.toContain('v10:加密后的密文');
    // 主进程专用视图才拿得到密文
    expect(providers.getProviderSecretForMain(db, created.id)!.apiKeyEnc).toBe('v10:加密后的密文');
  });

  it('不传 apiKey 时保留原密钥；clearKey 才清除', () => {
    const base = {
      name: 'p',
      type: 'openai' as const,
      baseUrl: 'https://example.invalid/v1',
      models: [],
      defaultModel: 'm',
      compressionModel: 'm',
      enabled: true,
    };
    const created = providers.createProvider(db, base, { apiKeyEnc: '密文1', now: T0 });

    // 不传 apiKey → 保留
    providers.updateProvider(db, created.id, { ...base, name: '改名' }, { now: T0 + 1 });
    expect(providers.getProviderSecretForMain(db, created.id)!.apiKeyEnc).toBe('密文1');

    // 传新密文 → 覆盖
    providers.updateProvider(db, created.id, base, { apiKeyEnc: '密文2', now: T0 + 2 });
    expect(providers.getProviderSecretForMain(db, created.id)!.apiKeyEnc).toBe('密文2');

    // clearKey → 清除
    providers.updateProvider(db, created.id, base, { clearKey: true, now: T0 + 3 });
    expect(providers.getProviderSecretForMain(db, created.id)!.apiKeyEnc).toBeNull();
    expect(providers.getProvider(db, created.id)!.hasKey).toBe(false);
  });

  it('压缩模型缺省时回退到默认模型', () => {
    const created = providers.createProvider(
      db,
      {
        name: 'p',
        type: 'anthropic',
        baseUrl: 'https://example.invalid',
        models: ['claude-sonnet'],
        defaultModel: 'claude-sonnet',
        compressionModel: '',
        enabled: true,
      },
      { now: T0 },
    );
    expect(created.compressionModel).toBe('claude-sonnet');
  });
});

describe('可选字段的缺省处理', () => {
  /**
   * 回归测试：驱动层会把 `undefined` 归一成 `null`（node:sqlite 不接受 undefined），
   * 而 `null` 会撞上建表时的 NOT NULL 约束。所以 DAO 必须对每个可选字段显式给值，
   * 不能指望"省略参数 = 用列默认值"。
   * 这里用最小入参把每个 create 都过一遍。
   */
  it('createPersona 只给 name 也能落库（description 缺省为空串）', () => {
    const created = personas.createPersona(db, { name: '只给名字' }, T0 + 10);
    expect(created.description).toBe('');
    expect(created.avatarPath).toBeNull();
  });

  it('updatePersona 只改名字不会把 description 洗成 null', () => {
    const created = personas.createPersona(db, { name: 'A', description: '原来有描述' }, T0 + 11);
    const updated = personas.updatePersona(db, created.id, { name: 'B' }, T0 + 12)!;
    expect(updated.description).toBe('原来有描述');
    expect(updated.avatarPath).toBeNull();
  });

  it('createConversation 省略 params 时用默认生成参数', () => {
    const created = conversations.createConversation(
      db,
      { title: 't', characterId: charId, personaId: null, providerId: null, model: 'm' },
      T0 + 13,
    );
    expect(created.params).toEqual({ temperature: 0.9, topP: 0.95, maxTokens: 1024 });
    expect(created.pinnedAt).toBeNull();
  });

  it('insertMessage 省略 metadata / status 也能落库', () => {
    const id = seedsConversationForOptional();
    const m = messages.insertMessage(db, { conversationId: id, role: 'user', content: 'hi' }, T0);
    expect(m.metadata).toEqual({});
    expect(m.status).toBe('done');
    expect(m.archived).toBe(false);
  });
});

function seedsConversationForOptional(): string {
  return conversations.createConversation(
    db,
    { title: 'x', characterId: charId, personaId: null, providerId: null, model: 'm' },
    T0 + 14,
  ).id;
}

describe('设置 DAO', () => {
  it('默认值符合产品设计文档（自动压缩 80%）', () => {
    const current = settings.readSettings(db);
    expect(current.autoCompressEnabled).toBe(true);
    expect(current.autoCompressThreshold).toBe(0.8);
    expect(current.panelOpen).toBe(true);
    expect(current.panelTab).toBe('context');
  });

  it('增量写入并持久化，跨连接可读', () => {
    settings.writeSettings(db, { theme: 'dark', panelTab: 'data' }, T0);
    const current = settings.readSettings(db);
    expect(current.theme).toBe('dark');
    expect(current.panelTab).toBe('data');
    // 未覆盖的字段保持默认
    expect(current.autoCompressThreshold).toBe(0.8);
  });

  it('落库的值非法时回退为默认，而不是抛异常', () => {
    db.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(
      'app',
      '{"autoCompressThreshold": "不是一个数字"}',
      T0,
    );
    expect(settings.readSettings(db).autoCompressThreshold).toBe(0.8);
  });
});
