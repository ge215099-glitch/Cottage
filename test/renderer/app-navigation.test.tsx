// @vitest-environment jsdom
/**
 * 应用外壳级的导航回归测试。
 *
 * 守的是一个用户直接报上来的 bug：**在角色库 / 人设 / 设置页点会话行，不跳回对话**。
 * 它其实是两层，两层都得覆盖：
 *   1. `selectConversation` 只换了会话、没有切视图；
 *   2. 它还写了"id 相同就 return"——于是在设置页点**当前已选中**的会话会彻底没反应。
 *
 * 另外守两条交互决策：
 *   1. 「新对话」不再一键建库，而是打开四步向导
 *      （选角色 → 自定义角色信息 → 选人设 → 选 Key）；
 *   2. 向导第 2 步的「保存并继续」写回的是**角色卡本身**，而且只发可编辑字段
 *      （`raw_json` / `favorite` / `avatarPath` 不许搭车）。
 *
 * API Key 模块与用量页的 App 级联动在 `api-keys-app.test.tsx` 里，不混进这份文件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { installFakeApi, makeCharacter, makeConversation, makeProvider } from './helpers.js';

afterEach(() => {
  cleanup();
  // 菜单是模块级单例：不清掉会漏给下一个用例
  useMenuStore.getState().close();
});

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

  it('侧栏「新对话」打开四步向导，而不是直接建一个会话', async () => {
    const user = userEvent.setup();
    await mount();

    // 侧栏主按钮与列表标题行的 ＋ 同名，取第一个（主按钮）
    await user.click(screen.getAllByRole('button', { name: '新对话' })[0]!);

    expect(screen.getByRole('dialog', { name: '新建对话' })).toBeTruthy();
    expect(screen.getByText(/第 1 步 \/ 共 4 步/)).toBeTruthy();
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
    // 选完角色 → 自定义角色信息（这一步不改动，按钮就是普通的「下一步」）
    await user.click(screen.getByRole('button', { name: '下一步' }));
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

  it('向导第 2 步改动写回角色卡本身，且只发可编辑字段（raw_json/收藏/头像不搭车）', async () => {
    const user = userEvent.setup();
    const { spies } = installFakeApi({
      conversations: [makeConversation()],
      characters: [makeCharacter({ favorite: true, avatarPath: 'avatars/lin.png' })],
      providers: [makeProvider()],
    });
    useAppStore.setState({ view: 'chat' });
    useChatStore.setState({ conversationId: null, messages: [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    await user.click(screen.getAllByRole('button', { name: '新对话' })[0]!);
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    // 第 2 步：改开场白，然后「保存并继续」
    await user.type(screen.getByLabelText(/^开场白/), '（改过）');
    await user.click(screen.getByRole('button', { name: '保存并继续' }));

    await waitFor(() => expect(spies['characters.update']).toHaveBeenCalledTimes(1));
    const [id, patch] = spies['characters.update']!.mock.calls[0]! as [string, Record<string, unknown>];
    expect(id).toBe('chr_1');
    expect(patch['firstMes']).toBe('「齿轮不是坏了，是被人换过。」（改过）');
    /*
     * 白名单：`raw_json`（第三方字段的唯一载体）与 `favorite` / `avatarPath`
     * 都不许从这条路径写回去——收藏状态被"顺手覆盖"过一次就很难解释。
     */
    expect(Object.keys(patch).sort()).toEqual(
      [
        'alternateGreetings',
        'description',
        'firstMes',
        'mesExample',
        'name',
        'personality',
        'postHistoryInstructions',
        'scenario',
        'systemPrompt',
        'tags',
      ].sort(),
    );

    // 保存成功后照常进下一步，最终能建会话
    expect(screen.getByText(/第 3 步 \/ 共 4 步/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '开始对话' }));
    await waitFor(() => expect(spies['conversations.create']).toHaveBeenCalled());
  });
});

describe('角色卡导出：先选格式再导出', () => {
  /** 挂载 App → 进角色库 → 开详情弹窗，停在"可以点导出"这一步。 */
  async function openDetail(
    characters = [makeCharacter({ avatarPath: 'avatars/lin.png' })],
  ) {
    const spies = installFakeApi({
      conversations: [makeConversation()],
      characters,
      providers: [makeProvider()],
    }).spies;
    useAppStore.setState({ view: 'chat' });
    useChatStore.setState({ conversationId: null, messages: [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '角色库' }));
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(screen.getByRole('button', { name: '导出角色卡' }));
    return { user, spies };
  }

  it('导出按钮开的是格式菜单，不是直接导出', async () => {
    const { spies } = await openDetail();
    const menu = await screen.findByRole('menu', { name: '导出角色卡' });
    expect(within(menu).getByRole('menuitem', { name: '导出为 JSON' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: '导出为 PNG 卡' })).toBeTruthy();
    // 还没选格式，就不该已经发起导出
    expect(spies['characters.export']).not.toHaveBeenCalled();
  });

  it('选「导出为 PNG 卡」时按 png 调主进程', async () => {
    const { user, spies } = await openDetail();
    const menu = await screen.findByRole('menu', { name: '导出角色卡' });
    await user.click(within(menu).getByRole('menuitem', { name: '导出为 PNG 卡' }));

    await waitFor(() => expect(spies['characters.export']).toHaveBeenCalledWith('chr_1', 'png'));
  });

  it('选「导出为 JSON」时按 json 调主进程', async () => {
    const { user, spies } = await openDetail();
    const menu = await screen.findByRole('menu', { name: '导出角色卡' });
    await user.click(within(menu).getByRole('menuitem', { name: '导出为 JSON' }));

    await waitFor(() => expect(spies['characters.export']).toHaveBeenCalledWith('chr_1', 'json'));
  });

  it('没有卡面图的角色：PNG 项是灰的，并说明原因', async () => {
    await openDetail([makeCharacter({ avatarPath: null })]);
    const menu = await screen.findByRole('menu', { name: '导出角色卡' });
    const pngItem = within(menu).getByRole('menuitem', { name: /PNG/ });
    expect((pngItem as HTMLButtonElement).disabled).toBe(true);
    expect(pngItem.textContent).toContain('没有卡面图');
  });

  it('菜单开着时 Esc 只收菜单：弹窗留着，再按一次才关弹窗', async () => {
    /*
     * 这条覆盖的是「应用外壳的全局 Esc 处理先跑」那条顺序。
     *
     * 组件测试里只挂 CharactersPage 时，菜单状态是手动塞进 store 的，
     * 走的是另一个分支；真实使用中按键先经过 #root 上的 React 监听
     * （菜单层自己会 close + preventDefault），弹窗必须能识别出"这一下已被消费"。
     * 用非 cancelable 的事件测不出问题——真实按键是 cancelable 的。
     */
    const { user } = await openDetail();
    await screen.findByRole('menu', { name: '导出角色卡' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: '角色详情：爱丽丝' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
