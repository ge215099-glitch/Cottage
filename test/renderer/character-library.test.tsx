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
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CharactersPage,
  type CharactersPageProps,
} from '../../src/renderer/components/Pages.js';
import { makeCharacter } from './helpers.js';

afterEach(cleanup);

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
    onSave: vi.fn(),
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

  it('收藏的卡片上带星标', () => {
    setup({ characters: [makeCharacter({ favorite: true })] });
    expect(screen.getByTitle('已收藏')).toBeTruthy();
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
    expect(props.onExport).toHaveBeenCalledWith(expect.objectContaining({ id: 'chr_1' }));

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除角色卡' }));
    expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'chr_1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「编辑」切到编辑器并关掉弹窗', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '查看角色卡：爱丽丝' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // 编辑器是整页视图，带「保存」按钮
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
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
});
