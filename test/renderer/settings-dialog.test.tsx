// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useComposerStore } from '../../src/renderer/stores/composer.js';
import { useMenuStore } from '../../src/renderer/stores/menu.js';
import { installFakeApi, makeSettings, ok } from './helpers.js';

beforeEach(() => {
  useAppStore.setState({ view: 'chat', settingsView: null, sidebarCollapsed: false });
  useChatStore.setState({ conversationId: null, messages: [], activeStreams: {}, completedStreams: [], loading: false });
  useComposerStore.setState({ draft: '', drafts: {}, sendErrors: {} });
  useMenuStore.getState().close();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function start() {
  const fake = installFakeApi({ overrides: {
    'settings.update': async (patch: unknown) => ok(makeSettings(patch as Partial<ReturnType<typeof makeSettings>>)),
  } });
  render(<App/>);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '输入消息' })).toBeTruthy());
  await waitFor(() => expect(useChatStore.getState().loading).toBe(false));
  return fake;
}

describe('独立设置面板', () => {
  it('保持聊天节点、草稿和右栏状态，关闭后恢复触发按钮焦点', async () => {
    await start();
    const input = screen.getByRole('textbox', { name: '输入消息' });
    const thread = document.querySelector('.next-thread-scroll');
    await userEvent.type(input, '还没发出的消息');
    const trigger = screen.getByRole('button', { name: '设置' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(document.getElementById('shell')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.next-thread-scroll')).toBe(thread);
    expect(document.querySelector('.detail-sidebar')?.getAttribute('aria-hidden')).toBe('false');
    await userEvent.click(within(dialog).getByRole('tab', { name: '我的人设' }));
    await userEvent.click(within(dialog).getByRole('tab', { name: '通用设置' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('textbox', { name: '输入消息' })).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe('还没发出的消息');
    expect(document.activeElement).toBe(trigger);
    expect(document.getElementById('shell')?.hasAttribute('inert')).toBe(false);
  });

  it('分类键盘导航、主题保存和嵌套表单的 Escape 只关闭最上层', async () => {
    const { spies } = await start();
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = screen.getByRole('dialog', { name: '设置' });
    await userEvent.click(within(settings).getByRole('button', { name: '深色' }));
    await waitFor(() => expect(spies['settings.update']).toHaveBeenCalledWith({ theme: 'dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    const general = within(settings).getByRole('tab', { name: '通用设置' });
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(settings).getByRole('tab', { name: '模型连接' }));
    await userEvent.click(within(settings).getByRole('button', { name: '创建 API Key' }));
    const editor = screen.getByRole('dialog', { name: '创建 API Key' });
    await userEvent.type(within(editor).getByRole('textbox', { name: '名称' }), '未保存的连接');
    fireEvent.keyDown(document, { key: 'n', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: '新对话' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创建 API Key' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '设置' })).toBe(settings);
    expect(document.activeElement).toBe(within(settings).getByRole('button', { name: '创建 API Key' }));
    expect(spies['providers.test']).not.toHaveBeenCalled();
    expect(spies['providers.create']).not.toHaveBeenCalled();
    await userEvent.click(within(settings).getByRole('button', { name: '关闭设置' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('从角色库打开或直接打开模型连接，关闭后返回原页面', async () => {
    await start();
    await userEvent.click(screen.getByRole('button', { name: '角色库' }));
    const library = screen.getByRole('heading', { name: '角色库' });
    act(() => useAppStore.getState().setView('apiKeys'));
    expect(screen.getByRole('tab', { name: '模型连接' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '设置' }).parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: '角色库' })).toBe(library);
    expect(useAppStore.getState().view).toBe('characters');
  });

  it('角色库收起侧栏后仍可从固定按钮重新展开', async () => {
    await start();
    await userEvent.click(screen.getByRole('button', { name: '角色库' }));

    act(() => useAppStore.getState().setSidebarCollapsed(true));
    const expand = screen.getByRole('button', { name: '展开侧栏' });
    await userEvent.click(expand);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull();
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBe(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBe(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('false');
  });
});
