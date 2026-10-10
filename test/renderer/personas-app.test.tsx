// @vitest-environment jsdom
/**
 * 人设模块在真实应用外壳里的联动测试。
 *
 * 与 `personas.test.tsx` 的分工：那一边只挂 `PersonasPage`，测列表与弹窗自身的交互；
 * 这一边挂完整的 `App`，测**接线**——导航能不能进、编辑有没有真的调 `personas.update`
 * 并重新拉列表、勾「设为默认」有没有走 `personas.setDefault`、删除有没有先过确认框。
 *
 * 单独成文件而不是塞进 `personas.test.tsx`：那边定的是组件契约，这边定的是
 * "谁把哪个 IPC 接进来了"，混在一起以后改错层会看不出来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { installFakeApi, makeCharacter, makeConversation, makePersona } from './helpers.js';

afterEach(() => {
  cleanup();
  useMenuStore.getState().close();
});

/** 挂载 App 并停在人设页。 */
async function mountPersonas(personas = [makePersona({ name: 'ASMobbin' })]) {
  const spies = installFakeApi({
    conversations: [makeConversation()],
    characters: [makeCharacter()],
    personas,
  }).spies;
  useAppStore.setState({ view: 'chat' });
  useChatStore.setState({ conversationId: null, messages: [] });
  render(<App />);
  await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '人设' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '新建人设' })).toBeTruthy());
  return { user, spies };
}

describe('人设模块（App 级）', () => {
  // 打字逐字符派发事件，整仓并行跑时会明显变慢，给足超时
  it(
    '点「编辑」改名字会真的调 personas.update（回归锚点：以前静默失效）',
    async () => {
      const { user, spies } = await mountPersonas();

      await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
      const nameInput = screen.getByLabelText('名称');
      await user.clear(nameInput);
      await user.type(nameInput, '林晚');
      await user.click(screen.getByRole('button', { name: '保存修改' }));

      await waitFor(() => expect(spies['personas.update']).toHaveBeenCalledTimes(1));
      expect(spies['personas.update']).toHaveBeenCalledWith('per_1', {
        name: '林晚',
        description: '',
      });
      // 保存成功后弹窗自己关掉（失败才会留着报错）
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    },
    20_000,
  );

  it('编辑默认人设时勾选框本来就是勾上的，保存会把它重新落成默认', async () => {
    // 回归锚点：以前这一页只有行内 `window.prompt` 改名，"谁是默认"整件事
    // 只能靠行里那个按钮，编辑弹窗里根本改不了。
    const { user, spies } = await mountPersonas();

    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    expect((screen.getByRole('checkbox', { name: '设为默认人设' }) as HTMLInputElement).checked).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(spies['personas.update']).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(spies['personas.setDefault']).toHaveBeenCalledWith('per_1'));
  });

  it('新建走 personas.create，不带 id', async () => {
    const { user, spies } = await mountPersonas();

    await user.click(screen.getByRole('button', { name: '新建人设' }));
    await user.type(screen.getByLabelText('名称'), '旅人');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(spies['personas.create']).toHaveBeenCalledTimes(1));
    expect(spies['personas.create']).toHaveBeenCalledWith({ name: '旅人', description: '' });
  });

  it('勾「设为默认」时先落库再调 personas.setDefault，并把返回的列表写回 store', async () => {
    const { user, spies } = await mountPersonas([
      makePersona({ id: 'per_1', name: 'ASMobbin', isDefault: true }),
      makePersona({ id: 'per_2', name: '林晚', isDefault: false }),
    ]);

    await user.click(screen.getByRole('button', { name: '编辑 林晚' }));
    const checkbox = screen.getByRole('checkbox', { name: '设为默认人设' }) as HTMLInputElement;
    await user.click(checkbox);
    // 先确认点中的就是勾选框本体，否则下面的断言会指向别的原因
    expect(checkbox.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(spies['personas.update']).toHaveBeenCalledTimes(1));
    // 关键：改的是林晚，默认就必须落到林晚头上（回归锚点：以前拿 update 的
    // 返回值当目标，假 API 恰好总回同一条，于是"改 B 默认给 A"谁也看不见）
    await waitFor(() => expect(spies['personas.setDefault']).toHaveBeenCalledWith('per_2'));
    // 互斥状态落在 setDefault 返回的整份列表里，store 必须跟着换
    await waitFor(() =>
      expect(useAppStore.getState().personas.find((p) => p.id === 'per_2')?.isDefault).toBe(true),
    );
    expect(useAppStore.getState().personas.find((p) => p.id === 'per_1')?.isDefault).toBe(false);
  });

  it('不勾「设为默认」时不碰 personas.setDefault', async () => {
    const { user, spies } = await mountPersonas([
      makePersona({ id: 'per_1', name: 'ASMobbin', isDefault: true }),
      makePersona({ id: 'per_2', name: '林晚', isDefault: false }),
    ]);

    await user.click(screen.getByRole('button', { name: '编辑 林晚' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(spies['personas.update']).toHaveBeenCalledTimes(1));
    expect(spies['personas.setDefault']).not.toHaveBeenCalled();
  });

  it('保存失败时留在弹窗里报错，不丢用户已填的内容', async () => {
    const spies = installFakeApi({
      conversations: [makeConversation()],
      characters: [makeCharacter()],
      personas: [makePersona({ name: 'ASMobbin' })],
      overrides: {
        'personas.update': async () => ({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: '人设名不能为空', retryable: false },
        }),
      },
    }).spies;
    useAppStore.setState({ view: 'chat' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '人设' }));
    await user.click(screen.getByRole('button', { name: '编辑 ASMobbin' }));
    await user.type(screen.getByLabelText('名称'), ' 2');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('人设名不能为空'),
    );
    expect(screen.getByRole('dialog', { name: '编辑人设：ASMobbin' })).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('ASMobbin 2');
    expect(spies['personas.update']).toHaveBeenCalledTimes(1);
  });

  it('删除人设先弹确认框，确认后才调 personas.delete', async () => {
    const { user, spies } = await mountPersonas();

    await user.click(screen.getByRole('button', { name: '删除 ASMobbin' }));
    const dialog = screen.getByRole('dialog', { name: '删除人设？' });
    // 确认文案必须说清后果：绑定该人设的会话会解绑
    expect(dialog.textContent).toContain('解除绑定');
    expect(spies['personas.delete']).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(spies['personas.delete']).toHaveBeenCalledWith('per_1'));
  });

  it('人设页上没有常驻的创建表单（回归锚点：以前页头下面就是一排输入框）', async () => {
    const { user } = await mountPersonas();

    expect(screen.queryByLabelText('名称')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // 旧实现的那个「设为默认」行内按钮也不该再出现
    expect(screen.queryByRole('button', { name: '设为默认' })).toBeNull();
    await user.keyboard('{Escape}');
  });
});
