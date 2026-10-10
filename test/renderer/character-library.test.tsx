// @vitest-environment jsdom
/**
 * 角色库「卡片网格 + 详情弹窗」的组件测试。
 *
 * 交互契约（用户明确要求的那套）：
 *   - 卡片是 **2:3 竖版**：上面图片、下面名字；
 *   - **不显示描述**（信息靠 `title` 悬停提示与详情弹窗承载）；
 *   - 没有图片的角色卡用**灰色色块占位**，不留空洞；
 *   - 点卡片打开**详情弹窗**，全部动作（新对话 / 编辑 / 收藏 / 导出 / 删除）在里面。
 *
 * 诚实边界：jsdom 没有排版引擎，所以"卡片真的是 2:3""网格列数自适应"这类断言
 * 在这里只能验到"渲染了对应元素与类名"，真实比例要靠 CDP 截图与 E2E。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { JSX } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CharactersPage,
  type CharactersPageProps,
} from '../../src/renderer/components/Pages.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { makeCharacter } from './helpers.js';

afterEach(() => {
  cleanup();
  // 菜单是模块级单例：不清掉会漏给下一个用例
  useMenuStore.getState().close();
});

function setup(overrides: Partial<CharactersPageProps> = {}) {
  const props: CharactersPageProps = {
    characters: [
      makeCharacter(),
      makeCharacter({ id: 'chr_2', name: '老周', description: '修表铺的老板。' }),
    ],
    tags: [{ tag: '奇幻', count: 1 }],
    onImportFile: vi.fn(),
    onSearch: vi.fn(),
    onToggleFavorite: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onNewConversation: vi.fn(),
    onSave: vi.fn(async () => null),
    ...overrides,
  };
  const view = render(<CharactersPage {...props} />);
  return { props, view };
}

describe('角色库卡片网格', () => {
  it('每张角色卡渲染一张卡片，卡片上是名字', () => {
    setup();
    expect(screen.getByRole('button', { name: '查看角色卡：爱丽丝' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看角色卡：老周' })).toBeTruthy();
  });

  it('网格里不显示描述（描述移到 title 提示与详情弹窗）', () => {
    setup();
    // 描述文本不该出现在卡片里
    expect(screen.queryByText('钟表店学徒，对时间异常敏感。')).toBeNull();
    // 但信息没丢：挂在 title 上
    expect(
      screen.getByRole('button', { name: '查看角色卡：爱丽丝' }).getAttribute('title'),
    ).toBe('钟表店学徒，对时间异常敏感。');
  });

  it('没有图片的角色卡用灰色色块占位，不渲染 img', () => {
    const { view } = setup();
    expect(view.container.querySelectorAll('img')).toHaveLength(0);
    expect(view.container.querySelectorAll('.char-card-placeholder')).toHaveLength(2);
  });

  it('有 avatarPath 时渲染自有协议的 img（CSP 只放行了这个协议）', () => {
    const { view } = setup({
      characters: [makeCharacter({ avatarPath: 'avatars/lin.png' })],
    });
    const img = view.container.querySelector('.char-card-figure img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('cottage-avatar://local/avatars/lin.png');
    expect(view.container.querySelector('.char-card-placeholder')).toBeNull();
  });

  it('收藏的卡片上带星标，且是实心 SVG 而不是文本字形', () => {
    setup({ characters: [makeCharacter({ favorite: true })] });
    const badge = screen.getByTitle('已收藏');
    /*
     * 文本 `★` 与内联 SVG 图标不是一套体系（字形来自系统字体，线宽比例都对不上），
     * 而且没有底盘时压在卡面图上会被吃掉。判据是"里面是个 svg、文本内容为空"。
     */
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.textContent).toBe('');
  });

  it('未收藏的卡片上不出现角标', () => {
    setup({ characters: [makeCharacter({ favorite: false })] });
    expect(screen.queryByTitle('已收藏')).toBeNull();
  });

  it('标签筛选点击后按标签过滤（筛选逻辑仍走主进程回调）', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: /奇幻/ }));
    expect(props.onSearch).toHaveBeenCalled();
  });
});

describe('角色详情弹窗', () => {
  it('点卡片打开弹窗，并显示详情与全部动作', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));

    const dialog = screen.getByRole('dialog', { name: '角色详情：爱丽丝' });
    expect(within(dialog).getByText('钟表店学徒，对时间异常敏感。')).toBeTruthy();
    expect(within(dialog).getByText('奇幻')).toBeTruthy();
    for (const label of ['新对话', '编辑', '收藏', '导出角色卡', '删除角色卡', '关闭']) {
      expect(within(dialog).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('弹窗里的动作回调带上被点的那个角色', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：老周' }));

    const dialog = screen.getByRole('dialog', { name: '角色详情：老周' });
    await user.click(within(dialog).getByRole('button', { name: '新对话' }));
    expect(props.onNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chr_2', name: '老周' }),
    );

    // 动作之后弹窗应当关掉，避免用户以为没生效
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('收藏 / 导出 / 删除 分别调到对应回调', async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '收藏' }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: 'chr_1' }));

    // 收藏后弹窗保持打开（用户可能还要做别的）
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '导出角色卡' }));
    // 导出要开格式菜单，所以顺带把锚点（矩形 + 触发元素）交给调用方
    expect(props.onExport).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chr_1' }),
      expect.anything(),
      expect.anything(),
    );

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除角色卡' }));
    expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'chr_1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「编辑」把详情弹窗换成编辑弹窗，而不是把整页换掉', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));

    /*
     * 同一时刻只有一层浮层：两个弹窗都监听 document 上的 Esc，
     * 叠在一起的话按一下会把两层一起关掉（先注册的那个先跑，它看不到"自己不是栈顶"）。
     */
    expect(screen.queryByRole('dialog', { name: '角色详情：爱丽丝' })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' });
    expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('爱丽丝');
    // 角色库没有被替换掉——弹窗只是浮在它上面
    expect(screen.getByRole('heading', { name: '角色库' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('保存成功后关掉编辑弹窗，并回到那张卡的详情（看到的就是刚改完的卡）', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));

    const dialog = screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chr_1' }),
      expect.objectContaining({ name: '爱丽丝' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑角色卡：爱丽丝' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: '角色详情：爱丽丝' })).toBeTruthy();
  });

  it('保存失败：弹窗留在原地报错，刚改的内容不丢', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => '入参校验失败：name 太短');
    setup({ onSave });
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));

    const dialog = screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' });
    await user.type(within(dialog).getByLabelText(/^描述/), '补了一句。');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('入参校验失败'),
    );
    const still = screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' });
    expect((within(still).getByLabelText(/^描述/) as HTMLTextAreaElement).value).toContain(
      '补了一句。',
    );
  });

  it('名称为空时「保存」是禁用的（以前会先关页面再报错，把一屏内容丢掉）', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));

    const dialog = screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' });
    await user.clear(within(dialog).getByLabelText('名称'));
    expect((within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('取消编辑回到那张卡的详情，且不调保存', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));
    await user.click(
      within(screen.getByRole('dialog', { name: '编辑角色卡：爱丽丝' })).getByRole('button', {
        name: '取消',
      }),
    );

    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '角色详情：爱丽丝' })).toBeTruthy();
  });

  it('Esc 与「关闭」都能关掉弹窗', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('只展示有内容的字段，空字段不占位', async () => {
    const user = userEvent.setup();
    setup({
      characters: [
        makeCharacter({ description: '', personality: '', scenario: '', firstMes: '' }),
      ],
    });
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    const dialog = screen.getByRole('dialog');
    for (const label of ['描述', '性格', '场景', '开场白']) {
      expect(within(dialog).queryByText(label)).toBeNull();
    }
  });

  it('菜单开着时 Esc 只关菜单，不穿透关掉弹窗', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));

    // 模拟"导出菜单已打开"这一状态（菜单层本身在 App 里，这里只验弹窗的 Esc 判据）
    useMenuStore.getState().open(
      {
        rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        targetId: 'chr_1',
        trigger: null,
      },
      [{ label: '导出为 JSON', onSelect: () => undefined }],
      '导出角色卡',
    );

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '角色详情：爱丽丝' })).toBeTruthy();

    // 菜单关掉之后，Esc 才轮到弹窗
    useMenuStore.getState().close();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 收藏的视觉反馈                                                       */
/* ------------------------------------------------------------------ */

/**
 * 这一组用例钉的是一个**真实报上来的 bug**：在详情弹窗里点了「收藏」，
 * 图标没有任何变化（空心还是空心），用户不知道自己点没点上。
 *
 * 根因是按钮**两种状态都渲染同一个空心星**，`title` / `aria-label` 虽然换了文案，
 * 但那只有悬停/读屏才看得见。所以这里的判据是"视觉契约"：
 * 未收藏 = 空心 svg（无 fill），已收藏 = 实心 svg（`fill="currentColor"`）+ 常驻暖色类名，
 * 并且 `aria-pressed` 与之一致——读屏用户和视觉用户拿到同一个事实。
 */
describe('收藏状态在弹窗里看得见', () => {
  /** 取星标按钮里那个 svg 的填充色：`null` = 空心。 */
  function starFill(button: HTMLElement): string | null {
    const path = button.querySelector('path');
    expect(path, '星标按钮里必须有一个 path，否则图标没了').not.toBeNull();
    return path!.getAttribute('fill');
  }

  it('未收藏：空心星，且 aria-pressed=false', async () => {
    const user = userEvent.setup();
    setup({ characters: [makeCharacter({ favorite: false })] });
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));

    const button = within(screen.getByRole('dialog')).getByRole('button', { name: '收藏' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).not.toContain('fav-on');
    expect(starFill(button)).toBeNull();
  });

  it('已收藏：实心星 + 常驻收藏色，且 aria-pressed=true', async () => {
    const user = userEvent.setup();
    setup({ characters: [makeCharacter({ favorite: true })] });
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));

    const button = within(screen.getByRole('dialog')).getByRole('button', { name: '取消收藏' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('fav-on');
    expect(starFill(button)).toBe('currentColor');
  });

  it('点一下「收藏」星立刻变实心，再点一下变回空心', async () => {
    const user = userEvent.setup();

    /*
     * 受控外壳：回调把 `favorite` 翻过来再渲染，模拟 App 里"更新后重新拉列表"
     * 这一步。直接给 `vi.fn()` 的话 props 永远不变，这个 bug 在测试里就隐身了——
     * 而线上真正坏掉的正是"点了之后界面没跟上"。
     */
    function Harness(): JSX.Element {
      const [character, setCharacter] = useState(makeCharacter({ favorite: false }));
      return (
        <CharactersPage
          characters={[character]}
          tags={[{ tag: '奇幻', count: 1 }]}
          onImportFile={vi.fn()}
          onSearch={vi.fn()}
          onToggleFavorite={() => setCharacter((prev) => ({ ...prev, favorite: !prev.favorite }))}
          onDelete={vi.fn()}
          onExport={vi.fn()}
          onNewConversation={vi.fn()}
          onSave={vi.fn()}
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '收藏' }));
    const onButton = within(screen.getByRole('dialog')).getByRole('button', { name: '取消收藏' });
    expect(starFill(onButton)).toBe('currentColor');

    await user.click(onButton);
    const offButton = within(screen.getByRole('dialog')).getByRole('button', { name: '收藏' });
    expect(starFill(offButton)).toBeNull();
  });
});
