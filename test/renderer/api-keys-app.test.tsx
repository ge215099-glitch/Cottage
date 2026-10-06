// @vitest-environment jsdom
/**
 * API Key 模块在真实应用外壳里的联动测试。
 *
 * 与 `api-keys.test.tsx` 的分工：那一边只挂 `ApiKeysPage`，测的是列表与弹窗自身的交互；
 * 这一边挂完整的 `App`，测的是**接线是否正确**——导航能不能进、保存后有没有重新拉列表、
 * 删除有没有真的走确认框、以及「按 API Key 查看用量」有没有把筛选条件带过去。
 *
 * 单独成文件而不是塞进 `app-navigation.test.tsx`：后者守的是"点会话行要回到对话"
 * 那条回归线，混进一整套 API Key 用例会让那份文件的主旨变得含糊。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { DEFAULT_USAGE_FILTER, useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { installFakeApi, makeCharacter, makeConversation, makeProvider } from './helpers.js';

afterEach(() => {
  cleanup();
  useMenuStore.getState().close();
  useAppStore.setState({ usageFilter: { ...DEFAULT_USAGE_FILTER } });
});

/** 挂载 App 并停在 API Key 页。 */
async function mountApiKeys() {
  const spies = installFakeApi({
    conversations: [makeConversation()],
    characters: [makeCharacter()],
    providers: [makeProvider({ name: '本地端点' })],
  }).spies;
  useAppStore.setState({ view: 'chat', usageFilter: { ...DEFAULT_USAGE_FILTER } });
  useChatStore.setState({ conversationId: null, messages: [] });
  render(<App />);
  await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'API Key' }));
  await waitFor(() => expect(screen.getByRole('table', { name: 'API Key 列表' })).toBeTruthy());
  return { user, spies };
}

describe('API Key 模块（App 级）', () => {
  it('导航能进 API Key 页，弹窗里创建后调 providers.create 并刷新列表', async () => {
    const { user, spies } = await mountApiKeys();

    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    await user.type(screen.getByLabelText('名称'), '备用端点');
    await user.type(screen.getByLabelText('base_url'), 'https://b.invalid/v1');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(spies['providers.create']).toHaveBeenCalledTimes(1));
    expect(spies['providers.create']).toHaveBeenCalledWith(
      expect.objectContaining({ name: '备用端点', baseUrl: 'https://b.invalid/v1', enabled: true }),
    );
    // 创建后必须重新拉列表，否则新 Key 要等下次进页面才出现
    await waitFor(() => expect(spies['providers.list']).toHaveBeenCalledTimes(2));
  });

  it('保存失败时留在弹窗里报错，不丢用户已填的内容', async () => {
    const spies = installFakeApi({
      conversations: [makeConversation()],
      characters: [makeCharacter()],
      providers: [makeProvider({ name: '本地端点' })],
      overrides: {
        'providers.create': async () => ({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: '基地址不是一个 URL', retryable: false },
        }),
      },
    }).spies;
    useAppStore.setState({ view: 'chat' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'API Key' }));
    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    await user.type(screen.getByLabelText('名称'), '备用端点');
    await user.type(screen.getByLabelText('base_url'), '不是一个地址');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('基地址不是一个 URL'),
    );
    expect(screen.getByRole('dialog', { name: '创建 API Key' })).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('备用端点');
    expect(spies['providers.create']).toHaveBeenCalledTimes(1);
  });

  it('删除 API Key 先弹确认框，确认后才调 providers.delete', async () => {
    const { user, spies } = await mountApiKeys();

    await user.click(screen.getByRole('button', { name: '删除 本地端点' }));
    const dialog = screen.getByRole('dialog', { name: '删除 API Key？' });
    // 确认文案必须说清后果：密钥丢弃 + 会话解绑
    expect(dialog.textContent).toContain('密钥一并丢弃');
    expect(dialog.textContent).toContain('解除绑定');
    expect(spies['providers.delete']).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(spies['providers.delete']).toHaveBeenCalledWith('prv_1'));
  });

  it('删除确认框可以取消，取消后不调主进程', async () => {
    const { user, spies } = await mountApiKeys();

    await user.click(screen.getByRole('button', { name: '删除 本地端点' }));
    const dialog = screen.getByRole('dialog', { name: '删除 API Key？' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: '删除 API Key？' })).toBeNull();
    expect(spies['providers.delete']).not.toHaveBeenCalled();
  });
});

describe('「按 API Key 查看用量」', () => {
  it('把这一把 Key 记进筛选条件，并切到用量视图', async () => {
    const { user } = await mountApiKeys();

    await user.click(screen.getByRole('button', { name: '按 API Key 查看用量' }));

    expect(useAppStore.getState().usageFilter.providerId).toBe('prv_1');
    expect(useAppStore.getState().view).toBe('usage');
  });
});

describe('设置页的收窄（回归锚点）', () => {
  it('设置页不再有长期驻留的 Provider 表单，也没有明文导出入口', async () => {
    installFakeApi({
      conversations: [makeConversation()],
      characters: [makeCharacter()],
      providers: [makeProvider()],
    });
    useAppStore.setState({ view: 'chat' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('listitem')).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '设置' }));

    // 回归锚点：这几块原来都长在设置页上，现在分别搬到 API Key 模块 / 直接删除
    expect(screen.queryByText('Provider 与密钥')).toBeNull();
    expect(screen.queryByText('添加 Provider')).toBeNull();
    expect(screen.queryByText(/导出明文配置包/)).toBeNull();
    expect(screen.queryByText(/本地优先（BYOK）/)).toBeNull();
    expect(screen.queryByText(/api_key_enc/)).toBeNull();
    // 该留的还在：默认 Provider 与诊断
    expect(screen.getByText('聊天默认 Provider')).toBeTruthy();
    expect(screen.getByText('诊断')).toBeTruthy();
  });
});
