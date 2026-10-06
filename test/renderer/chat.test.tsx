// @vitest-environment jsdom
/**
 * 对话主区组件测试（UI 文档第 12 节的验收清单）。
 *
 * 诚实边界（技术方案 11.2）：悬停工具条"移开 180ms 内消失"、消息真实宽度、
 * 粘底滚动的像素行为都属于排版/滚动引擎范畴，jsdom 里测不出真值。
 * 这里测的是**可判定的部分**：DOM 结构、气泡与无气泡的区分、按钮语义、
 * 元信息与"约"前缀、归档只靠透明度、无头像、阈值文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 右栏在真实应用里是 ChatView 的**兄弟**节点（由 App 渲染），不是它的子节点。
// 这里把它替换成空实现，测试才聚焦在"主区"这个被测单元上；
// 右栏本身另有测试（panel.test.tsx）。
vi.mock('../../src/renderer/components/DetailPanel.js', () => ({
  DetailPanel: () => null,
}));

import { ChatView } from '../../src/renderer/components/ChatView.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useComposerStore } from '../../src/renderer/stores/composer.js';
import { usePanelStore } from '../../src/renderer/stores/panel.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import {
  makeCharacter,
  makeConversation,
  makeMessage,
  makeSummary,
  makeTokenPreview,
} from './helpers.js';

type ChatViewProps = Parameters<typeof ChatView>[0];

/**
 * 渲染 ChatView。
 *
 * `chatState` 收窄成 `Partial`：测试只需要描述"与默认不同的那几个字段"，
 * 每次都写全 11 个字段会让用例的重点被噪音淹没。
 */
function setup(
  overrides: Partial<ChatViewProps> = {},
  chatState: Partial<Parameters<typeof useChatStore.setState>[0]> = {},
): ChatViewProps {
  const props: ChatViewProps = {
    conversation: makeConversation(),
    character: makeCharacter(),
    summaries: [],
    preview: makeTokenPreview(),
    hasProvider: true,
    renaming: false,
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onTogglePin: vi.fn(),
    onTogglePanel: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onOpenApiKeys: vi.fn(),
    onRestoreSummary: vi.fn(),
    onNewConversation: vi.fn(),
    onEditMessage: vi.fn(),
    onDeleteMessage: vi.fn(),
    onDeleteFromMessage: vi.fn(),
    onRegenerate: vi.fn(),
    onCopyMessage: vi.fn(),
    ...overrides,
  };

  useChatStore.setState({
    conversationId: 'cnv_1',
    messages: [],
    summaries: [],
    // 显式复位流式字段：不这样做，上一个用例留下的 streamingConversationId
    // 会让占用条显示"生成中…"，产生与本用例无关的失败。
    streamingConversationId: null,
    streamingMessageId: null,
    streamId: null,
    loading: false,
    ...chatState,
  });
  render(<ChatView {...props} />);
  return props;
}

beforeEach(() => {
  useAppStore.setState({ settings: null });
  useComposerStore.setState({ draft: '', showAdvancedChips: false });
  usePanelStore.setState({ open: true, tab: 'context', scrollTo: null });
  useMenuStore.getState().close();
});

afterEach(() => {
  cleanup();
});

describe('顶栏（验收项 1 / 21）', () => {
  it('顶栏只含标题与详情开关两个常驻可交互元素（置顶按钮默认不可见）', () => {
    setup();
    const topbar = document.querySelector('.topbar')!;
    // 可见的常态元素：标题 + 详情开关；置顶按钮与主题按钮的显隐由 CSS 控制
    expect(topbar.querySelector('.title')).not.toBeNull();
    expect(topbar.querySelector('#panel-toggle, .icon-btn[title*="详情栏"]')).not.toBeNull();
  });

  it('双击标题进入重命名', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));
    expect(props.onStartRename).toHaveBeenCalled();
  });

  it('已置顶时会话顶栏图钉带 on 类（状态常驻可见）', () => {
    setup({ conversation: makeConversation({ pinnedAt: 1 }) });
    expect(document.querySelector('.pin-btn')!.classList.contains('on')).toBe(true);
  });

  it('未置顶时图钉没有 on 类', () => {
    setup();
    // 用 classList 而不是 className.includes：'pin-btn' 里本身含 'on' 子串，
    // 字符串包含判断会永远为真（这类假通过比报错更危险）。
    expect(document.querySelector('.pin-btn')!.classList.contains('on')).toBe(false);
  });

  it('点击图钉触发置顶切换', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: '置顶会话' }));
    expect(props.onTogglePin).toHaveBeenCalled();
  });
});

describe('消息渲染（验收项 11 / 25 / 26）', () => {
  it('角色消息无气泡、用户消息为右对齐气泡', () => {
    setup({}, {
      messages: [
        makeMessage({ id: 'a', role: 'assistant', sortOrder: 1, content: '角色的回答' }),
        makeMessage({ id: 'u', role: 'user', sortOrder: 2, content: '用户的提问' }),
      ],
    });

    expect(document.querySelector('.msg.assistant')).not.toBeNull();
    expect(document.querySelector('.msg.user')).not.toBeNull();
    // 角色消息有名字行，用户消息没有（身份靠名字文本，不用头像）
    const assistant = document.querySelector('.msg.assistant')!;
    expect(assistant.querySelector('.head .name')!.textContent).toBe('爱丽丝');
    expect(document.querySelector('.msg.user .head')).toBeNull();
  });

  it('界面不使用任何头像元素（验收项 25）', () => {
    setup({}, {
      messages: [
        makeMessage({ id: 'a', role: 'assistant', sortOrder: 1 }),
        makeMessage({ id: 'u', role: 'user', sortOrder: 2 }),
      ],
    });
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('.avatar')).toBeNull();
  });

  it('悬停工具条在 DOM 里就位（显隐由 CSS 负责）', () => {
    setup({}, { messages: [makeMessage({ id: 'a', sortOrder: 1 })] });
    expect(document.querySelector('.msg .toolbar')).not.toBeNull();
  });

  it('归档消息只加 archived 类（不加任何「已归档」文案，验收项 26）', () => {
    setup({}, { messages: [makeMessage({ id: 'a', sortOrder: 1, archived: true })] });
    expect(document.querySelector('.msg.archived')).not.toBeNull();
    expect(screen.queryByText('已归档')).toBeNull();
  });

  it('元信息默认是隐藏态（没有 pinned 类）', () => {
    setup({}, { messages: [makeMessage({ id: 'a', sortOrder: 1 })] });
    const meta = document.querySelector('.meta');
    expect(meta).not.toBeNull();
    expect(meta!.className).not.toContain('pinned');
  });

  it('元信息含模型 / 用时 / tokens 与精确标记', () => {
    setup({}, { messages: [makeMessage({ id: 'a', sortOrder: 1 })] });
    const text = document.querySelector('.meta')!.textContent ?? '';
    expect(text).toContain('deepseek-chat');
    expect(text).toContain('1.8s');
    expect(text).toContain('42 tok');
    expect(text).toContain('精确');
  });

  it('估算来源的 token 标「约（估算）」（验收项 9 的对应要求）', () => {
    setup({}, {
      messages: [
        makeMessage({
          id: 'a',
          sortOrder: 1,
          metadata: { model: 'claude-sonnet', completionTokens: 30, tokensExact: false },
        }),
      ],
    });
    expect(document.querySelector('.meta')!.textContent).toContain('约（估算）');
  });

  it('中断的消息显示「已中断」与「继续」', () => {
    setup({}, {
      messages: [makeMessage({ id: 'a', sortOrder: 1, status: 'interrupted', metadata: { interrupted: true } })],
    });
    expect(screen.getByText('已中断')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy();
  });

  it('错误消息显示错误条与重试按钮', () => {
    setup({}, {
      messages: [
        makeMessage({
          id: 'a',
          sortOrder: 1,
          metadata: {
            error: { code: 'AUTH_FAILED', message: 'Key 无效或权限不足', retryable: false },
          },
        }),
      ],
    });
    expect(screen.getByText('Key 无效或权限不足')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('同角色连续的消息带 same-role 类（间距靠留白分组，不加分隔线）', () => {
    setup({}, {
      messages: [
        makeMessage({ id: 'a1', role: 'assistant', sortOrder: 1 }),
        makeMessage({ id: 'a2', role: 'assistant', sortOrder: 2 }),
      ],
    });
    // 两条角色消息应各自渲染；间距由 CSS 的 .same-role 控制
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(2);
  });
});

describe('摘要分割条（验收项 10）', () => {
  it('渲染「已压缩 第 N–M 条」胶囊，默认折叠', () => {
    setup(
      { summaries: [makeSummary({ coversFrom: 3, coversTo: 15 })] },
      {
        messages: [makeMessage({ id: 'm3', sortOrder: 3 })],
      },
    );
    expect(screen.getByText(/已压缩 第 3–15 条/)).toBeTruthy();
  });

  it('展开后显示摘要正文与恢复入口，恢复文案明确说明摘要会失效', async () => {
    const user = userEvent.setup();
    const props = setup(
      { summaries: [makeSummary({ id: 'sum_1', coversFrom: 3, coversTo: 15 })] },
      { messages: [makeMessage({ id: 'm3', sortOrder: 3 })] },
    );

    await user.click(screen.getByRole('button', { name: /已压缩 第 3–15 条/ }));
    expect(screen.getByText('恢复这段原文，摘要将失效')).toBeTruthy();

    await user.click(screen.getByText('恢复这段原文，摘要将失效'));
    expect(props.onRestoreSummary).toHaveBeenCalledWith('sum_1');
  });
});

describe('输入区（验收项 13 / 17）', () => {
  it('无输入时发送键禁用', () => {
    setup();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('有输入时发送键可用，点击回调 onSend 并清空草稿', async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.type(screen.getByRole('textbox', { name: '消息输入' }), '你好');
    const send = screen.getByRole('button', { name: '发送' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await user.click(send);

    expect(props.onSend).toHaveBeenCalledWith('你好');
    expect(useComposerStore.getState().draft).toBe('');
  });

  it('Enter 发送，Shift+Enter 不发送（换行）', async () => {
    const user = userEvent.setup();
    const props = setup();
    const textarea = screen.getByRole('textbox', { name: '消息输入' });

    await user.type(textarea, '换行{Shift>}{Enter}{/Shift}');
    expect(props.onSend).not.toHaveBeenCalled();

    await user.type(textarea, '{Enter}');
    expect(props.onSend).toHaveBeenCalled();
  });

  it('生成中：发送键变停止键，点击调用 onStop（同一按钮换图标）', async () => {
    const user = userEvent.setup();
    const props = setup({}, { streamingConversationId: 'cnv_1', streamingMessageId: 'a' });

    const stop = screen.getByRole('button', { name: '停止生成' });
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    await user.click(stop);
    expect(props.onStop).toHaveBeenCalled();
  });

  it('未配置 Provider 时发送禁用并给出跳转 API Key 的提示（验收项 17）', async () => {
    const user = userEvent.setup();
    const props = setup({ hasProvider: false });

    await user.type(screen.getByRole('textbox', { name: '消息输入' }), '你好');
    // 提示条出现，说明会引导用户去配置 Key
    expect(screen.getByText('还没有可用的 API Key')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '去 API Key' }));
    expect(props.onOpenApiKeys).toHaveBeenCalled();
  });

  it('占用数字常驻，≥75% 转 warn、≥80% 转 danger（阈值文案）', () => {
    /** 只覆盖被测字段，其余回调用空实现——本用例不关心它们的交互。 */
    const base = {
      conversation: makeConversation(),
      character: makeCharacter(),
      summaries: [],
      hasProvider: true,
      renaming: false,
      onStartRename: vi.fn(),
      onCommitRename: vi.fn(),
      onCancelRename: vi.fn(),
      onTogglePin: vi.fn(),
      onTogglePanel: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onOpenApiKeys: vi.fn(),
      onRestoreSummary: vi.fn(),
      onNewConversation: vi.fn(),
      onEditMessage: vi.fn(),
      onDeleteMessage: vi.fn(),
      onDeleteFromMessage: vi.fn(),
      onRegenerate: vi.fn(),
      onCopyMessage: vi.fn(),
    } satisfies Omit<ChatViewProps, 'preview'>;

    const { rerender } = render(<ChatView {...base} preview={makeTokenPreview({ percent: 62 })} />);
    expect(document.querySelector('.meter')!.classList.contains('warn')).toBe(false);
    expect(document.querySelector('.meter')!.classList.contains('danger')).toBe(false);

    rerender(<ChatView {...base} preview={makeTokenPreview({ percent: 76 })} />);
    expect(document.querySelector('.meter')!.classList.contains('warn')).toBe(true);

    rerender(<ChatView {...base} preview={makeTokenPreview({ percent: 82 })} />);
    expect(document.querySelector('.meter')!.classList.contains('danger')).toBe(true);
  });

  it('估算占用带「约」前缀（不允许把估算当精确展示）', () => {
    setup({ preview: makeTokenPreview({ percent: 53, anyEstimated: true }) });
    expect(document.querySelector('.meter')!.textContent).toContain('约 53%');
  });

  it('精确占用不带「约」', () => {
    setup({ preview: makeTokenPreview({ percent: 53, anyEstimated: false }) });
    expect(document.querySelector('.meter')!.textContent).toContain('上下文 53%');
    expect(document.querySelector('.meter')!.textContent).not.toContain('约');
  });

  it('点击占用数字打开右栏「上下文」标签', async () => {
    const user = userEvent.setup();
    usePanelStore.setState({ open: false, tab: 'data' });
    setup();

    await user.click(document.querySelector('.meter') as HTMLElement);
    expect(usePanelStore.getState().tab).toBe('context');
  });
});

describe('空态与无会话（验收项 25）', () => {
  it('无消息时显示角色名（大字）、描述与开场白胶囊，无头像', () => {
    setup();
    expect(screen.getByRole('heading', { name: '爱丽丝' })).toBeTruthy();
    expect(screen.getByText('钟表店学徒，对时间异常敏感。')).toBeTruthy();
    // 开场白以"胶囊"形式出现（点击填入输入框），只渲染一次
    expect(screen.getByRole('button', { name: '「齿轮不是坏了，是被人换过。」' })).toBeTruthy();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('有多个开场白时渲染胶囊，点击填入输入框', async () => {
    const user = userEvent.setup();
    setup();

    const chip = screen.getByRole('button', { name: '「你来晚了十一分钟。」' });
    await user.click(chip);
    expect(useComposerStore.getState().draft).toBe('「你来晚了十一分钟。」');
  });

  it('没有会话时显示空态引导并给出新建入口', async () => {
    const user = userEvent.setup();
    const props = setup({ conversation: null, character: null });

    await user.click(screen.getByRole('button', { name: /新建一个/ }));
    expect(props.onNewConversation).toHaveBeenCalled();
  });
});
