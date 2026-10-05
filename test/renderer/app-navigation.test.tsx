// @vitest-environment jsdom
/**
 * 应用外壳级的导航回归测试。
 *
 * 守的是一个用户直接报上来的 bug：**在角色库 / 人设 / 设置页点会话行，不跳回对话**。
 * 它其实是两层，两层都得覆盖：
 *   1. `selectConversation` 只换了会话、没有切视图；
 *   2. 它还写了"id 相同就 return"——于是在设置页点**当前已选中**的会话会彻底没反应。
 *
 * 另外守一条交互决策：「新对话」不再一键建库，而是打开三步向导
 * （选角色 → 选人设 → 选 Key）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { installFakeApi, makeCharacter, makeConversation, makeProvider } from './helpers.js';

afterEach(cleanup);

const COMPOSER_PLACEHOLDER = '和角色聊聊…（Enter 发送，Shift+Enter 换行）';

/** 挂载真实 App，并等到侧栏列表渲染出来（首屏批量拉取是异步的）。 */
async function mount() {
  installFakeApi({
    conversations: [makeConversation()],
    characters: [makeCharacter()],
    providers: [makeProvider()],
  });
  useAppStore.setState({ view: 'chat' });
  useChatStore.setState({ conversationId: null, messages: [] });

  render(<App />);
  await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());
}

const onChatView = (): boolean => screen.queryByPlaceholderText(COMPOSER_PLACEHOLDER) !== null;

describe('应用外壳的导航', () => {
  it('在角色库页点会话行会切回对话视图', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: '角色库' }));
    expect(screen.getByRole('heading', { name: '角色库' })).toBeTruthy();
    expect(onChatView()).toBe(false);

    await user.click(screen.getByRole('listitem'));

    await waitFor(() => expect(onChatView()).toBe(true));
    expect(screen.queryByRole('heading', { name: '角色库' })).toBeNull();
  });

  it('在设置页点「当前已选中」的会话也要切回对话（旧实现这里彻底没反应）', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();

    // 关键前提：这个会话在挂载时就已经被选中了，正是旧代码里"整体早退"的那条路径
    expect(useChatStore.getState().conversationId).toBe('cnv_1');

    await user.click(screen.getByRole('listitem'));
    await waitFor(() => expect(onChatView()).toBe(true));
  });

  it('侧栏「新对话」打开三步向导，而不是直接建一个会话', async () => {
    const user = userEvent.setup();
    await mount();

    // 侧栏主按钮与列表标题行的 ＋ 同名，取第一个（主按钮）
    await user.click(screen.getAllByRole('button', { name: '新对话' })[0]!);

    expect(screen.getByRole('dialog', { name: '新建对话' })).toBeTruthy();
    expect(screen.getByText(/第 1 步 \/ 共 3 步/)).toBeTruthy();
  });

  it('向导确认后才真的建会话，并把选中的角色 / 人设 / Provider 一起提交', async () => {
    const user = userEvent.setup();
    const { spies } = installFakeApi({
      conversations: [makeConversation()],
      characters: [makeCharacter()],
      providers: [makeProvider()],
    });
    useAppStore.setState({ view: 'chat' });
    useChatStore.setState({ conversationId: null, messages: [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    await user.click(screen.getAllByRole('button', { name: '新对话' })[0]!);
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '开始对话' }));

    await waitFor(() => expect(spies['conversations.create']).toHaveBeenCalled());
    expect(spies['conversations.create']).toHaveBeenCalledWith({
      characterId: 'chr_1',
      personaId: 'per_1',
      providerId: 'prv_1',
      model: 'deepseek-chat',
      useFirstMessage: true,
    });
  });
});
