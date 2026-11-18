// @vitest-environment jsdom
/**
 * 人设页（导航模块）测试。
 *
 * 守四条约定，前两条直接来自用户报上来的问题：
 *
 *   1. **编辑不能再走 `window.prompt`**。Electron 的 renderer 里 `prompt()` 是
 *      未实现的空函数（立刻返回 null，也不弹任何界面），所以"点编辑改名字"那条路径
 *      此前是**静默失效**的。这条用"点了编辑必须出现一个能改的输入框"来守。
 *   2. **页面上不常驻创建表单**：新建也进弹窗（与 API Key 页同形）。
 *   3. **「设为默认」在弹窗里**，不做成每行一个按钮。
 *   4. 失败留在弹窗里报错、不丢用户已填内容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PersonasPage } from '../../src/renderer/components/Pages.js';
import { makePersona } from './helpers.js';
import type { Persona } from '../../src/shared/types.js';

afterEach(cleanup);

interface Handlers {
  onSave: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
}

function setup(personas: Persona[] = [makePersona()]): Handlers {
  const onSave = vi.fn(async () => null);
  const onDelete = vi.fn();
  render(<PersonasPage personas={personas} onSave={onSave} onDelete={onDelete} />);
  return { onSave, onDelete };
}

describe('页面形态：列表 + 按钮，不常驻表单', () => {
  it('页面上没有常驻的创建表单，也没有弹窗', () => {
    setup();
    expect(screen.queryByLabelText('名称')).toBeNull();
    expect(screen.queryByLabelText('描述（可选）')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('页头有「新建人设」按钮，但点它之前不建任何东西', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    expect(screen.getByRole('dialog', { name: '新建人设' })).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('空列表给出「新建人设」的引导文案，且同样没有常驻表单', () => {
    setup([]);
    expect(screen.getByText(/还没有人设/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建人设' })).toBeTruthy();
    expect(screen.queryByLabelText('名称')).toBeNull();
  });

  it('列表显示名称、默认标记与描述', () => {
    setup([
      makePersona({ id: 'per_1', name: 'ASMobbin', isDefault: true, description: '旅人' }),
      makePersona({ id: 'per_2', name: '林晚', isDefault: false, description: '' }),
    ]);

    expect(screen.getByText('ASMobbin')).toBeTruthy();
    expect(screen.getByText('默认')).toBeTruthy();
    expect(screen.getByText('旅人')).toBeTruthy();
    expect(screen.getByText('（没有描述）')).toBeTruthy();
  });

  it('行上只有「编辑 / 删除」两个动作，没有「设为默认」按钮', () => {
    setup([
      makePersona({ id: 'per_1', name: 'ASMobbin', isDefault: true }),
      makePersona({ id: 'per_2', name: '林晚', isDefault: false }),
    ]);

    expect(screen.queryByRole('button', { name: '设为默认' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^编辑 / })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^删除 / })).toHaveLength(2);
  });
});

describe('编辑走弹窗（回归锚点：以前是 window.prompt，静默失效）', () => {
  it('点「编辑」打开弹窗，且**不再调用 window.prompt**', async () => {
    const user = userEvent.setup();
    // Electron renderer 里 prompt 不存在/不可用：这里装一个探针，
    // 一旦代码回退到 prompt 就会立刻被抓住。
    const promptSpy = vi.fn(() => '改了名');
    Object.defineProperty(window, 'prompt', { value: promptSpy, writable: true, configurable: true });

    setup([makePersona({ name: 'ASMobbin' })]);

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    expect(promptSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: '编辑人设：ASMobbin' });
    expect(within(dialog).getByLabelText('名称')).toHaveProperty('value', 'ASMobbin');
  });

  // 打字是逐字符派发事件的，整仓并行跑时这套用例会明显变慢，给足超时
  it(
    '改完名称点「保存修改」把 id 与全部字段一起提交',
    async () => {
      const user = userEvent.setup();
      const { onSave } = setup([makePersona({ name: 'ASMobbin', description: '旅人' })]);

      await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
      const nameInput = screen.getByLabelText('名称');
      await user.clear(nameInput);
      await user.type(nameInput, '林晚');
      await user.clear(screen.getByLabelText('描述（可选）'));
      await user.type(screen.getByLabelText('描述（可选）'), '话不多');
      await user.click(screen.getByRole('button', { name: '保存修改' }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenCalledWith({
        id: 'per_1',
        name: '林晚',
        description: '话不多',
        isDefault: true,
      });
      // 成功后弹窗自动关闭
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    },
    20_000,
  );

  it('名称为空时「保存修改」是禁用的（不提交半截人设）', async () => {
    const user = userEvent.setup();
    setup([makePersona({ name: 'ASMobbin' })]);

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    await user.clear(screen.getByLabelText('名称'));

    expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('新建与「设为默认」', () => {
  it('新建提交时不带 id，并把勾选的默认一起交给上层', async () => {
    const user = userEvent.setup();
    const { onSave } = setup([makePersona({ name: 'ASMobbin' })]);

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    await user.type(screen.getByLabelText('名称'), '旅人');
    await user.click(screen.getByRole('checkbox', { name: '设为默认人设' }));
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect('id' in payload).toBe(false);
    expect(payload).toMatchObject({ name: '旅人', description: '', isDefault: true });
  });

  it('库里还没有人设时，「新建」弹窗默认就勾上「设为默认人设」', async () => {
    const user = userEvent.setup();
    setup([]);

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    expect((screen.getByRole('checkbox', { name: '设为默认人设' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('编辑已是默认的人设时，勾选框反映当前状态而不是重置', async () => {
    const user = userEvent.setup();
    setup([makePersona({ name: 'ASMobbin', isDefault: true })]);

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    expect((screen.getByRole('checkbox', { name: '设为默认人设' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
});

describe('错误与删除', () => {
  it('保存失败时留在弹窗里就地报错，不丢用户已填的内容', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => '人设名不能为空');
    render(
      <PersonasPage personas={[makePersona({ name: 'ASMobbin' })]} onSave={onSave} onDelete={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), '林晚');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('人设名不能为空'),
    );
    expect(screen.getByRole('dialog', { name: '编辑人设：ASMobbin' })).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('林晚');
  });

  it('Esc 关闭弹窗', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('行内「删除」走确认回调，不自己直接删', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup([makePersona({ name: 'ASMobbin' })]);

    await user.click(screen.getByRole('button', { name: '删除 ASMobbin' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'per_1' }));
  });

  it('编辑弹窗里的「删除」也走同一个确认回调，且先关掉弹窗', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup([makePersona({ name: 'ASMobbin' })]);

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'per_1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('新建弹窗里没有「删除」按钮（还没落库的东西没什么可删）', async () => {
    const user = userEvent.setup();
    setup([]);

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('正在编辑的人设从列表里消失（外部删除）时，弹窗自己关掉', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => null);
    const { rerender } = render(
      <PersonasPage personas={[makePersona({ name: 'ASMobbin' })]} onSave={onSave} onDelete={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    expect(screen.getByRole('dialog', { name: '编辑人设：ASMobbin' })).toBeTruthy();

    // 列表刷新后这条没了 —— 弹窗不该退化成标题写着「新建人设」的空框
    rerender(<PersonasPage personas={[]} onSave={onSave} onDelete={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
