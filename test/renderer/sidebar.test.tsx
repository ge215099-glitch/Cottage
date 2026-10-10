// @vitest-environment jsdom
/**
 * 左侧栏组件测试（UI 文档第 13 节的验收清单）。
 *
 * 覆盖范围与**诚实边界**（技术方案 11.2 明确要求）：
 *   - 这里能验：DOM 结构、`⋯` 的出现机制、菜单项与危险色、行内重命名行为、
 *     列表两段分组、**② 区没有会话搜索**（v1.8 的移除锚点）、侧栏两态的表现、键盘导航。
 *   - 这里**测不了**：悬停前后 `getBoundingClientRect()` 是否位移、
 *     菜单在视口边缘是否翻转、真实布局宽度——jsdom 没有排版引擎，
 *     把它们写在这里只会得到永远为真的假通过。那三项留给 E2E。
 *
 * 所有用例都遵守"先设 store、后渲染"的顺序：RTL 的 render 是同步的，
 * 反过来写会让首次渲染拿到空列表，产生一堆假失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar, TITLE_MAX_LENGTH } from '../../src/renderer/components/Sidebar.js';
import { MenuLayer } from '../../src/renderer/components/Overlays.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { makeConversation, makePersona, T0 } from './helpers.js';

type SidebarProps = Parameters<typeof Sidebar>[0];
/** 只描述"与默认不同的字段"即可，避免每个用例都写全 20+ 个字段。 */
type AppStatePatch = Partial<Parameters<typeof useAppStore.setState>[0]>;
type ChatStatePatch = Partial<Parameters<typeof useChatStore.setState>[0]>;

/** 先设 store，再渲染侧栏与菜单层（菜单是 Portal，必须一起挂）。 */
function setup(
  appState: AppStatePatch = {},
  chatState: ChatStatePatch = {},
  props: Partial<SidebarProps> = {},
): { props: SidebarProps; container: HTMLElement } {
  useAppStore.setState(appState as never);
  useChatStore.setState(chatState as never);

  const fullProps: SidebarProps = {
    onNewChat: vi.fn(),
    onSelectConversation: vi.fn(),
    onRenameConversation: vi.fn(async () => undefined),
    onTogglePin: vi.fn(),
    onDeleteConversation: vi.fn(),
    onOpenPersonaMenu: vi.fn(),
    ...props,
  };

  const { container } = render(
    <>
      <Sidebar {...fullProps} />
      <MenuLayer />
    </>,
  );
  return { props: fullProps, container };
}

/** 打开第一行的 ⋯ 菜单。 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /更多操作/ }));
  return screen.getByRole('menu');
}

beforeEach(() => {
  useAppStore.setState({
    view: 'chat',
    sidebarCollapsed: false,
    conversations: [],
    characters: [],
    personas: [makePersona()],
    providers: [],
    settings: null,
    storageWarning: null,
    lastError: null,
  });
  useChatStore.setState({
    conversationId: null,
    messages: [],
    summaries: [],
    streamingConversationId: null,
    streamingMessageId: null,
    streamId: null,
    loading: false,
  });
  useMenuStore.getState().close();
});

afterEach(() => {
  cleanup();
});

describe('会话行与 ⋯ 按钮（验收项 1 / 2 / 3 / 16）', () => {
  it('每行都有 ⋯ 按钮，且默认不进入 Tab 序列', () => {
    setup({ conversations: [makeConversation()] });

    const menuButtons = screen.getAllByRole('button', { name: /更多操作/ });
    expect(menuButtons).toHaveLength(1);
    // 1000 条会话不该产生 2000 个 Tab 停留点，所以 ⋯ 必须 tabIndex=-1
    expect(menuButtons[0]!.getAttribute('tabindex')).toBe('-1');
    expect(menuButtons[0]!.closest('.conv-row')).not.toBeNull();
  });

  it('⋯ 的占位恒在 DOM 里（显隐交给 CSS 的 hover 规则，避免标题横跳）', () => {
    const { container } = setup({ conversations: [makeConversation()] });
    expect(container.querySelector('.row-menu-btn')).not.toBeNull();
  });

  it('点击 ⋯ 打开菜单，含「重命名 / 置顶 / 删除」三项，删除为危险色', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    const menu = await openRowMenu(user);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['重命名F2', '置顶', '删除']);

    expect(within(menu).getByRole('menuitem', { name: '删除' }).className).toContain('danger');
  });

  it('已置顶会话的菜单显示「取消置顶」', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation({ pinnedAt: T0 + 1000 })] });

    const menu = await openRowMenu(user);
    expect(within(menu).getByRole('menuitem', { name: '取消置顶' })).toBeTruthy();
  });

  it('菜单项数不超过 5 条（超过就砍，UI 文档 4.3）', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });
    const menu = await openRowMenu(user);
    expect(within(menu).getAllByRole('menuitem').length).toBeLessThanOrEqual(5);
  });

  it('菜单用分隔线把破坏性动作隔开', async () => {
    const user = userEvent.setup();
    const menu = await (async () => {
      setup({ conversations: [makeConversation()] });
      return openRowMenu(user);
    })();
    expect(menu.querySelector('hr')).not.toBeNull();
  });

  it('选「置顶」会回调 onTogglePin(true)', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });
    const menu = await openRowMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: '置顶' }));
    expect(props.onTogglePin).toHaveBeenCalledWith('cnv_1', true);
  });

  it('选「删除」把确认交给上层（不在侧栏内弹窗）', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });
    const menu = await openRowMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: '删除' }));
    expect(props.onDeleteConversation).toHaveBeenCalledWith('cnv_1');
  });
});

describe('菜单键盘与关闭（验收项 5 / 15）', () => {
  it('Esc 关闭菜单', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    await openRowMenu(user);
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Shift+F10 也能打开菜单（⋯ 不在 Tab 序列时的键盘等效入口）', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    screen.getByRole('listitem').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');

    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('右键行也能打开与 ⋯ 相同的菜单', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    await user.pointer({ target: screen.getByRole('listitem'), keys: '[MouseRight]' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('菜单内的「重命名」进入行内编辑态', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    const menu = await openRowMenu(user);
    // 用正则匹配：可访问名里含右侧的快捷键提示（"重命名 F2"），
    // 精确字符串在不同 RTL 版本下对嵌套 span 的拼接结果不一致。
    await user.click(within(menu).getByRole('menuitem', { name: /^重命名/ }));

    expect(screen.getByRole('textbox', { name: '重命名对话' })).toBeTruthy();
  });
});

describe('行内重命名（验收项 8 / 9）', () => {
  it('双击标题进入行内输入框', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));
    expect(screen.getByRole('textbox', { name: '重命名对话' })).toBeTruthy();
  });

  it('输入框带 maxLength=80（超出即截断，不等到提交才报错）', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));
    expect(screen.getByRole('textbox', { name: '重命名对话' }).getAttribute('maxlength')).toBe(
      String(TITLE_MAX_LENGTH),
    );
  });

  it('Enter 提交新标题', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });
    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));

    const input = screen.getByRole('textbox', { name: '重命名对话' });
    await user.clear(input);
    await user.type(input, '新标题{Enter}');

    expect(props.onRenameConversation).toHaveBeenCalledWith('cnv_1', '新标题');
  });

  it('Esc 回滚：不提交、退出编辑态并保留原标题', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });
    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));

    const input = screen.getByRole('textbox', { name: '重命名对话' });
    await user.clear(input);
    await user.type(input, '不想要的名字{Escape}');

    expect(props.onRenameConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '重命名对话' })).toBeNull();
    expect(screen.getByText('夜巡酒馆的第三夜')).toBeTruthy();
  });

  it('空标题不提交、不弹窗，只标 invalid + aria-live 播报，并保持编辑态（验收项 8）', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });
    await user.dblClick(screen.getByText('夜巡酒馆的第三夜'));

    const input = screen.getByRole('textbox', { name: '重命名对话' });
    await user.clear(input);
    await user.type(input, '   {Enter}');

    expect(props.onRenameConversation).not.toHaveBeenCalled();
    const stillEditing = screen.getByRole('textbox', { name: '重命名对话' });
    expect(stillEditing.className).toContain('invalid');
    expect(stillEditing.getAttribute('aria-invalid')).toBe('true');
    // 通过 aria-live 播报，而不是弹窗
    expect(screen.getByText('标题不能为空')).toBeTruthy();
  });

  it('F2 也能进入重命名', async () => {
    const user = userEvent.setup();
    setup({ conversations: [makeConversation()] });

    screen.getByRole('listitem').focus();
    await user.keyboard('{F2}');

    expect(screen.getByRole('textbox', { name: '重命名对话' })).toBeTruthy();
  });
});

describe('列表分组与空态（验收项 23 / 5.1）', () => {
  it('有置顶时渲染「已置顶」段，且置顶项排最前', () => {
    setup({
      conversations: [
        makeConversation({ id: 'c1', title: '普通会话', updatedAt: T0 + 5000 }),
        makeConversation({ id: 'c2', title: '置顶会话', pinnedAt: T0 + 1000, updatedAt: T0 }),
      ],
    });

    expect(screen.getByText('已置顶')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('置顶会话');
    expect(rows[1]!.textContent).toContain('普通会话');
  });

  it('没有置顶时一个分组标题都不渲染（验收项 23）', () => {
    setup({
      conversations: [
        makeConversation({ id: 'c1', title: 'A' }),
        makeConversation({ id: 'c2', title: 'B' }),
      ],
    });

    expect(screen.queryByText('已置顶')).toBeNull();
    for (const label of ['今天', '昨天', '前 7 天', '更早']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('其余会话按 updatedAt 倒序', () => {
    setup({
      conversations: [
        makeConversation({ id: 'c1', title: '旧', updatedAt: T0 }),
        makeConversation({ id: 'c2', title: '新', updatedAt: T0 + 9000 }),
      ],
    });

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('新');
    expect(rows[1]!.textContent).toContain('旧');
  });

  it('列表为空时显示「还没有对话　新建一个 →」，点击即新建', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [] });

    expect(screen.getByText(/还没有对话/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /新建一个/ }));
    expect(props.onNewChat).toHaveBeenCalled();
  });

  it('生成中的会话标题右侧有呼吸圆点', () => {
    const { container } = setup({ conversations: [makeConversation()] }, { streamingConversationId: 'cnv_1' });
    expect(container.querySelector('.stream-dot')).not.toBeNull();
  });

  it('非生成中的会话没有圆点', () => {
    const { container } = setup({ conversations: [makeConversation()] });
    expect(container.querySelector('.stream-dot')).toBeNull();
  });
});

describe('会话搜索已移除（验收项 14 的反向锚点，v1.8）', () => {
  /*
   * 这一组断言守的是"**别再把它加回来**"。
   *
   * 曾经这里有一个常驻搜索框（② 区第二行）+ ⌘K 聚焦 + 2 字以上按标题过滤，
   * 并在过滤态把「已置顶」标题换成「找到 N 个对话」。它被整体去掉的原因写在
   * UI 文档 5.2 / 第 14 节：② 区是"一屏一个主动作"（P1）的地盘，而列表本身
   * 已经是"最近用过的在最上面"的有序队列，常驻输入框的收益不抵它的占位。
   */
  it('② 区只有「新对话」一个控件，没有搜索输入框', () => {
    const { container } = setup({ conversations: [makeConversation()] });

    const actions = container.querySelector('.sidebar-actions');
    expect(actions).not.toBeNull();
    expect(actions!.querySelectorAll('input')).toHaveLength(0);
    expect(actions!.textContent).toBe('新对话');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(container.querySelector('.search-row')).toBeNull();
  });

  it('列表恒为全部会话：标题命中关键词也不会被过滤掉', () => {
    setup({
      conversations: [
        makeConversation({ id: 'c1', title: '夜巡酒馆的第三夜' }),
        makeConversation({ id: 'c2', title: '修钟的代价' }),
      ],
    });

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // 过滤态的两种文案都不该再出现
    expect(screen.queryByText(/找到 \d+ 个对话/)).toBeNull();
    expect(screen.queryByText('没有匹配的对话')).toBeNull();
  });

  it('store 不再暴露会话搜索的状态与方法（UI 文档 5.2 已作废）', () => {
    const state = useAppStore.getState();
    expect('query' in state).toBe(false);
    expect('setQuery' in state).toBe(false);
  });
});

describe('侧栏两态与导航（验收项 19 / 24 / 25）', () => {
  it('折叠态在根元素上以 .collapsed 表达', () => {
    const { container } = setup({ sidebarCollapsed: true });
    expect(container.querySelector('#sidebar')!.className).toContain('collapsed');
  });

  it('展开态没有 .collapsed', () => {
    const { container } = setup();
    expect(container.querySelector('#sidebar')!.className).not.toContain('collapsed');
  });

  it('折叠钮点击切换折叠状态', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '折叠侧栏' }));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it('固定导航是五项「去别处」的入口（含用量与 API Key），刻意没有「对话」', () => {
    // 回归锚点①：这里以前是四项（含「对话」）。它与正下方的会话列表重复——
    // 同一个动作两个入口，用户点会话行还会疑惑"为什么点了不跳转"，
    // 所以「对话」被移除，回到对话靠点会话行或新建一个。
    // 回归锚点②：Provider 与密钥原本挤在设置页里，现在独立成「API Key」模块，
    // 用量有独立页面，所以导航从三项变成五项。顺序也钉住：用量在 API Key 之前。
    setup();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '角色库',
      '人设',
      '用量',
      'API Key',
      '设置',
    ]);
    expect(within(nav).queryByRole('button', { name: '对话' })).toBeNull();
  });

  it('点击「API Key」导航切到该视图', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'API Key' }));
    expect(useAppStore.getState().view).toBe('apiKeys');
  });

  it('停在角色库页时，导航高亮角色库（aria-current=page）', () => {
    setup({ view: 'characters' });
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('button', { current: 'page' }).textContent).toBe('角色库');
  });

  it('对话视图不在导航里，所以导航上没有任何 aria-current', () => {
    setup({ view: 'chat' });
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).queryByRole('button', { current: 'page' })).toBeNull();
  });

  it('点击导航切换视图', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '角色库' }));
    expect(useAppStore.getState().view).toBe('characters');
  });

  it('底部人设显示默认人设名', () => {
    setup();
    expect(screen.getByText('ASMobbin')).toBeTruthy();
  });

  it('界面没有任何头像元素（验收项 25）', () => {
    const { container } = setup({ conversations: [makeConversation()] });
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('.avatar')).toBeNull();
  });

  it('不存在调宽手柄（验收项 24：只保留拉出/收起两态）', () => {
    const { container } = setup({ conversations: [makeConversation()] });
    expect(container.querySelector('.resizer')).toBeNull();
    expect(container.querySelectorAll('[class*="resize"]')).toHaveLength(0);
  });
});

describe('行键盘导航（验收项 15）', () => {
  it('Delete 触发删除确认回调', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });

    screen.getByRole('listitem').focus();
    await user.keyboard('{Delete}');

    expect(props.onDeleteConversation).toHaveBeenCalledWith('cnv_1');
  });

  it('Enter 打开聚焦的会话', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });

    screen.getByRole('listitem').focus();
    await user.keyboard('{Enter}');

    expect(props.onSelectConversation).toHaveBeenCalledWith('cnv_1');
  });

  it('↑/↓ 在会话行之间移动焦点', async () => {
    const user = userEvent.setup();
    setup({
      conversations: [
        makeConversation({ id: 'c1', title: 'A', updatedAt: T0 + 2 }),
        makeConversation({ id: 'c2', title: 'B', updatedAt: T0 + 1 }),
      ],
    });

    const rows = screen.getAllByRole('listitem');
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(rows[1]);
  });

  it('点击行切换当前会话', async () => {
    const user = userEvent.setup();
    const { props } = setup({ conversations: [makeConversation()] });

    await user.click(screen.getByRole('listitem'));
    expect(props.onSelectConversation).toHaveBeenCalledWith('cnv_1');
  });

  it('当前会话带 aria-current', () => {
    setup({ conversations: [makeConversation()] }, { conversationId: 'cnv_1' });
    expect(screen.getByRole('listitem').getAttribute('aria-current')).toBe('true');
  });

  it('不在对话视图时，会话行不再显示选中态（会话本身仍保留）', () => {
    // 回归锚点：以前只看 conversationId，于是停在角色库/设置页时会话行还亮着，
    // 看起来像"当前页面是那个对话"。conversationId 必须保留——回对话时还得是它。
    const { container } = setup(
      { view: 'characters', conversations: [makeConversation()] },
      { conversationId: 'cnv_1' },
    );
    const row = screen.getByRole('listitem');
    expect(row.className).not.toContain('active');
    expect(row.getAttribute('aria-current')).toBeNull();
    expect(container.querySelectorAll('.conv-row.active')).toHaveLength(0);
    // 状态没被改掉：回到对话视图后它依然是当前会话
    expect(useChatStore.getState().conversationId).toBe('cnv_1');
  });
});
