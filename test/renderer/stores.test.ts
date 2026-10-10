/**
 * 渲染层纯函数与状态机测试。
 *
 * 这些函数是"文档里的规则"在 renderer 侧的落点，比如列表排序的 SQL 等价实现、
 * 占用条阈值、压缩播报文案、菜单宽限期。它们不需要 DOM，因此在纯 Node 下跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as appStoreModule from '../../src/renderer/stores/app.js';
import {
  groupConversations,
  sortConversations,
} from '../../src/renderer/stores/app.js';
import {
  buildTimeline,
  groupMessages,
  summaryAnchor,
} from '../../src/renderer/stores/chat.js';
import {
  compressAnnouncement,
  compressPercent,
  restoreAnnouncement,
  useCompressStore,
} from '../../src/renderer/stores/compress.js';
import { meterLevel, meterText } from '../../src/renderer/stores/composer.js';
import {
  DEFAULT_GRACE_MS,
  countMenuItems,
  isMenuOpen,
  useMenuStore,
} from '../../src/renderer/stores/menu.js';
import { tabFromShortcut } from '../../src/renderer/stores/panel.js';
import {
  makeConversation,
  makeMessage,
  makeSummary,
  makeTokenPreview,
  T0,
} from './helpers.js';

describe('会话列表排序（与主进程 SQL 规则一致）', () => {
  it('置顶优先、置顶段内按置顶时刻倒序、其余按 updatedAt 倒序', () => {
    const list = [
      makeConversation({ id: 'a', updatedAt: T0 + 100 }),
      makeConversation({ id: 'b', updatedAt: T0 + 300 }),
      makeConversation({ id: 'c', pinnedAt: T0 + 10, updatedAt: T0 }),
      makeConversation({ id: 'd', pinnedAt: T0 + 20, updatedAt: T0 }),
    ];
    expect(sortConversations(list).map((c) => c.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('只分两段：pinned 与 rest，且 rest 不带标题', () => {
    const list = [
      makeConversation({ id: 'a' }),
      makeConversation({ id: 'b', pinnedAt: T0 }),
      makeConversation({ id: 'c', pinnedAt: T0 + 1 }),
    ];
    const groups = groupConversations(list);
    expect(groups.pinned.map((c) => c.id)).toEqual(['c', 'b']);
    expect(groups.rest.map((c) => c.id)).toEqual(['a']);
  });

  it('没有置顶时 pinned 段为空（调用方据此不渲染段标题）', () => {
    expect(groupConversations([makeConversation()]).pinned).toEqual([]);
  });

  it('不修改入参数组', () => {
    const list = [makeConversation({ id: 'a', updatedAt: T0 }), makeConversation({ id: 'b', updatedAt: T0 + 1 })];
    const snapshot = list.map((c) => c.id);
    sortConversations(list);
    expect(list.map((c) => c.id)).toEqual(snapshot);
  });
});

describe('会话搜索已整体移除（UI 文档 5.2 / 第 14 节，v1.8）', () => {
  /*
   * 守的是"别再把它加回来"：会话搜索当年在 store 里落成 `query` + `setQuery` +
   * `filterConversations` 三件套，左栏 ② 区还有一个常驻搜索框与 ⌘K 快捷键。
   * 三件套一起删除之后，这里用模块导出面把它钉住——只要有人恢复其中任何一件，
   * 这条断言就会红，逼他先回答"为什么又要一个常驻搜索框"。
   */
  it('store 不再导出会话标题过滤函数', () => {
    expect('filterConversations' in appStoreModule).toBe(false);
  });

  it('store 里既没有 query 状态也没有 setQuery', () => {
    const state = appStoreModule.useAppStore.getState();
    expect('query' in state).toBe(false);
    expect('setQuery' in state).toBe(false);
  });
});

describe('消息分组与时间线（摘要条的落点）', () => {
  const messages = [
    makeMessage({ id: 'm1', role: 'assistant', sortOrder: 1 }),
    makeMessage({ id: 'm2', role: 'assistant', sortOrder: 2 }),
    makeMessage({ id: 'm3', role: 'user', sortOrder: 3 }),
    makeMessage({ id: 'm4', role: 'assistant', sortOrder: 4 }),
  ];

  it('同角色连续合并为一个 run', () => {
    const runs = groupMessages(messages);
    expect(runs.map((r) => [r.role, r.messages.length])).toEqual([
      ['assistant', 2],
      ['user', 1],
      ['assistant', 1],
    ]);
  });

  it('乱序输入也按 sortOrder 归组', () => {
    const shuffled = [messages[3]!, messages[0]!, messages[2]!, messages[1]!];
    expect(groupMessages(shuffled).flatMap((r) => r.messages.map((m) => m.id))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('summaryAnchor 取被覆盖区间最后一条的 sortOrder', () => {
    expect(summaryAnchor(makeSummary({ coversFrom: 1, coversTo: 2 }), messages)).toBe(2);
    expect(summaryAnchor(makeSummary({ coversFrom: 2, coversTo: 3 }), messages)).toBe(3);
  });

  it('摘要覆盖不到任何现存消息时不产生锚点（避免渲染出空条）', () => {
    expect(summaryAnchor(makeSummary({ coversFrom: 90, coversTo: 99 }), messages)).toBeNull();
  });

  it('buildTimeline 把摘要插在它覆盖区间的最后一条消息之后', () => {
    const timeline = buildTimeline(messages, [makeSummary({ id: 's1', coversFrom: 1, coversTo: 2 })]);
    expect(timeline.map((i) => i.key)).toEqual(['m:m1', 'm:m2', 's:s1', 'm:m3', 'm:m4']);
  });

  it('多段摘要按各自锚点分别插入', () => {
    const timeline = buildTimeline(messages, [
      makeSummary({ id: 's1', coversFrom: 1, coversTo: 2 }),
      makeSummary({ id: 's2', coversFrom: 3, coversTo: 4 }),
    ]);
    expect(timeline.filter((i) => i.kind === 'summary').map((i) => i.key)).toEqual(['s:s1', 's:s2']);
  });
});

describe('占用条阈值与文案（UI 文档第 5 节）', () => {
  it('normal / warn(≥75) / danger(≥80) 三档', () => {
    expect(meterLevel(0)).toBe('normal');
    expect(meterLevel(74)).toBe('normal');
    expect(meterLevel(75)).toBe('warn');
    expect(meterLevel(79)).toBe('warn');
    expect(meterLevel(80)).toBe('danger');
    expect(meterLevel(100)).toBe('danger');
  });

  it('自定义自动压缩阈值会改变 danger 的起点', () => {
    expect(meterLevel(60, 0.6)).toBe('danger');
    expect(meterLevel(59, 0.6)).toBe('normal');
  });

  it('估算值带「约」前缀；精确值不带', () => {
    expect(meterText(makeTokenPreview({ percent: 62, anyEstimated: true }))).toBe('上下文 约 62%');
    expect(meterText(makeTokenPreview({ percent: 62, anyEstimated: false }))).toBe('上下文 62%');
  });

  it('没有预览时不显示假的 0%', () => {
    expect(meterText(null)).toBe('上下文 —');
  });
});

describe('压缩状态机与播报文案', () => {
  beforeEach(() => {
    useCompressStore.setState({
      status: 'idle',
      conversationId: null,
      done: 0,
      total: 0,
      phase: 'summarizing',
      lastResult: null,
      error: null,
    });
  });

  it('idle → running → idle（成功时记下结果）', () => {
    const store = useCompressStore.getState();
    store.start('cnv_1', 8);
    expect(useCompressStore.getState().status).toBe('running');
    expect(useCompressStore.getState().total).toBe(8);

    useCompressStore.getState().progress(3, 8, 'writing');
    expect(compressPercent(useCompressStore.getState())).toBe(38);

    useCompressStore.getState().succeed({
      from: 1,
      to: 8,
      tokensBefore: 1200,
      tokensAfter: 180,
      summary: makeSummary(),
    });
    expect(useCompressStore.getState().status).toBe('idle');
    expect(useCompressStore.getState().lastResult?.from).toBe(1);
  });

  it('失败进入 error 并保留原因', () => {
    useCompressStore.getState().start('cnv_1', 8);
    useCompressStore.getState().fail({ code: 'UPSTREAM_ERROR', message: '上游崩了', retryable: true });
    expect(useCompressStore.getState().status).toBe('error');
    expect(useCompressStore.getState().error?.message).toBe('上游崩了');
  });

  it('取消回到 idle，且不留错误与结果（后端也没写摘要）', () => {
    useCompressStore.getState().start('cnv_1', 8);
    useCompressStore.getState().cancel();
    const state = useCompressStore.getState();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.conversationId).toBeNull();
  });

  it('进度百分比在 total 为 0 时不产生 NaN', () => {
    expect(compressPercent(useCompressStore.getState())).toBe(0);
  });

  it('完成播报含具体条数与 token 变化（产品设计文档 3.4 要求）', () => {
    const text = compressAnnouncement({
      from: 3,
      to: 15,
      tokensBefore: 1200,
      tokensAfter: 180,
      summary: makeSummary(),
    });
    expect(text).toBe('已将第 3–15 条压缩（1,200 → 180 tokens）');
  });

  it('恢复播报说明摘要已失效', () => {
    expect(restoreAnnouncement(3, 15)).toBe('已恢复第 3–15 条，对应摘要已失效');
  });
});

describe('菜单单实例与宽限期（技术方案 9.4）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useMenuStore.getState().close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const anchor = { rect: { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }, targetId: 'a', trigger: null };

  it('打开后是打开态；同一时刻只有一份菜单', () => {
    useMenuStore.getState().open(anchor, [{ label: '重命名', onSelect: () => undefined }], '更多操作');
    expect(isMenuOpen(useMenuStore.getState())).toBe(true);

    // 锚点切换：内容被替换而不是叠加
    useMenuStore.getState().open({ ...anchor, targetId: 'b' }, [{ label: '删除', onSelect: () => undefined }], '更多操作');
    expect(useMenuStore.getState().items).toHaveLength(1);
    expect(useMenuStore.getState().items[0]!.label).toBe('删除');
    expect(useMenuStore.getState().anchor?.targetId).toBe('b');
  });

  it('宽限期内不关闭：定时器没走完之前菜单还在', () => {
    useMenuStore.getState().open(anchor, [{ label: 'x', onSelect: () => undefined }], 'm');
    useMenuStore.getState().scheduleClose(DEFAULT_GRACE_MS);

    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 20);
    expect(isMenuOpen(useMenuStore.getState())).toBe(true);

    vi.advanceTimersByTime(40);
    expect(isMenuOpen(useMenuStore.getState())).toBe(false);
  });

  it('宽限期内 cancelClose 能救回菜单（消除手抖丢菜单）', () => {
    useMenuStore.getState().open(anchor, [{ label: 'x', onSelect: () => undefined }], 'm');
    useMenuStore.getState().scheduleClose(DEFAULT_GRACE_MS);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 20);
    useMenuStore.getState().cancelClose();

    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 2);
    expect(isMenuOpen(useMenuStore.getState())).toBe(true);
  });

  it('close 立即关闭并清掉待执行的定时器', () => {
    useMenuStore.getState().open(anchor, [{ label: 'x', onSelect: () => undefined }], 'm');
    useMenuStore.getState().scheduleClose(DEFAULT_GRACE_MS);
    useMenuStore.getState().close();

    expect(isMenuOpen(useMenuStore.getState())).toBe(false);
    // 定时器即使到点也不该再改变状态
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 3);
    expect(isMenuOpen(useMenuStore.getState())).toBe(false);
  });

  it('countMenuItems 不把分隔线算进去（"超过 5 条就砍"的口径）', () => {
    expect(
      countMenuItems([
        { label: 'a', onSelect: () => undefined },
        { label: '', separator: true, onSelect: () => undefined },
        { label: 'b', onSelect: () => undefined },
      ]),
    ).toBe(2);
  });
});

describe('右栏标签快捷键（UI 文档第 8 节）', () => {
  it('⌘1/2/3/4 依次对应 上下文/对话/角色/数据', () => {
    expect(tabFromShortcut('1')).toBe('context');
    expect(tabFromShortcut('2')).toBe('conversation');
    expect(tabFromShortcut('3')).toBe('character');
    expect(tabFromShortcut('4')).toBe('data');
  });

  it('越界或非数字返回 null', () => {
    expect(tabFromShortcut('5')).toBeNull();
    expect(tabFromShortcut('0')).toBeNull();
    expect(tabFromShortcut('a')).toBeNull();
  });
});
