// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView, type ChatViewProps } from '../../src/renderer/components/ChatView.js';
import { DetailPanel, type DetailPanelProps } from '../../src/renderer/components/DetailPanel.js';
import { NewConversationWizard } from '../../src/renderer/components/NewConversationWizard.js';
import { Sidebar } from '../../src/renderer/components/Sidebar.js';
import { MessageItem } from '../../src/renderer/components/MessageItem.js';
import { useAppStore } from '../../src/renderer/stores/app.js';
import { useChatStore } from '../../src/renderer/stores/chat.js';
import { useComposerStore } from '../../src/renderer/stores/composer.js';
import { usePanelStore } from '../../src/renderer/stores/panel.js';
import { useCompressStore } from '../../src/renderer/stores/compress.js';
import { makeCharacter, makeConversation, makeMessage, makePersona, makeProvider, makeSettings, makeTokenPreview } from './helpers.js';

function chatProps(patch: Partial<ChatViewProps> = {}): ChatViewProps {
  return { conversation: makeConversation(), character: makeCharacter(), summaries: [], preview: makeTokenPreview(), hasProvider: true, renaming: false,
    onStartRename: vi.fn(), onCommitRename: vi.fn(), onCancelRename: vi.fn(), onTogglePin: vi.fn(), onSend: vi.fn(async () => true), onStop: vi.fn(), onOpenApiKeys: vi.fn(), onRestoreSummary: vi.fn(), onNewConversation: vi.fn(), onEditMessage: vi.fn(), onDeleteMessage: vi.fn(), onDeleteFromMessage: vi.fn(), onRegenerate: vi.fn(), onCopyMessage: vi.fn(), ...patch };
}
beforeEach(() => {
  useAppStore.setState({ view: 'chat', settingsView: null, sidebarCollapsed: false, providers: [makeProvider()], characters: [makeCharacter()], conversations: [makeConversation()], settings: makeSettings() });
  useChatStore.setState({ conversationId: 'cnv_1', messages: [makeMessage()], summaries: [], loading: false, activeStreams: {}, completedStreams: [], streamId: null, streamingConversationId: null, streamingMessageId: null });
  useComposerStore.setState({ draft: '', drafts: {}, sendErrors: {} });
  usePanelStore.setState({ open: false, tab: 'context' });
  useCompressStore.setState({ tasks: {} });
});
afterEach(cleanup);

describe('新版聊天', () => {
  it('生成前失败时保留输入草稿', async () => {
    const p = chatProps({ onSend: vi.fn(async () => false) });
    render(<ChatView {...p}/>);
    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '未发送的故事');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('未发送的故事'));
    expect((screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement).value).toBe('未发送的故事');
    expect(screen.getByRole('alert').textContent).toContain('草稿已保留');
  });
  it('发送成功才清空草稿', async () => {
    render(<ChatView {...chatProps()}/>);
    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '你好');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(useComposerStore.getState().draft).toBe(''));
  });
  it('中文输入法确认不发送，随后 Enter 才发送', async () => {
    const p = chatProps(); render(<ChatView {...p}/>);
    const input = screen.getByRole('textbox', { name: '输入消息' });
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(p.onSend).toHaveBeenCalledOnce());
  });
  it('Ctrl+Enter 设置开启后，单独 Enter 不发送', async () => {
    useAppStore.setState({ settings: makeSettings({ sendWithCtrlEnter: true }) });
    const p = chatProps(); render(<ChatView {...p}/>);
    const input = screen.getByRole('textbox', { name: '输入消息' });
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' }); expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(p.onSend).toHaveBeenCalledOnce());
  });
  it('后台生成只对当前会话呈现停止按钮', async () => {
    useChatStore.setState({ messages: [makeMessage({ status: 'streaming' })] });
    const p = chatProps(); render(<ChatView {...p}/>);
    await userEvent.click(screen.getAllByRole('button', { name: '停止生成' }).at(-1)!);
    expect(p.onStop).toHaveBeenCalledOnce();
  });
  it('不同会话分别记住草稿', () => {
    const chat = useChatStore.getState(); const composer = useComposerStore.getState();
    composer.setDraft('第一段草稿'); chat.setActive('cnv_2'); composer.activateDraft('cnv_2');
    expect(useComposerStore.getState().draft).toBe('');
    composer.setDraft('第二段草稿'); chat.setActive('cnv_1'); composer.activateDraft('cnv_1');
    expect(useComposerStore.getState().draft).toBe('第一段草稿');
  });
  it('发送期间切换会话，成功只清除原会话已发送的草稿', async () => {
    let finish!: (value: boolean) => void;
    const p = chatProps({ onSend: () => new Promise<boolean>(resolve => { finish = resolve; }) });
    const view = render(<ChatView {...p}/>);
    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '发给第一位角色');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    act(() => { useChatStore.getState().setActive('cnv_2'); useComposerStore.getState().activateDraft('cnv_2'); useComposerStore.getState().setDraft('第二段草稿'); });
    view.rerender(<ChatView {...p} conversation={makeConversation({ id: 'cnv_2' })}/>);
    await act(async () => finish(true));
    expect(useComposerStore.getState().draft).toBe('第二段草稿');
    expect(useComposerStore.getState().drafts.cnv_1).toBe('');
  });
  it('消息读取完成后才定位到最新内容', () => {
    useChatStore.setState({ loading: true });
    const view = render(<ChatView {...chatProps()}/>);
    const scroll = view.container.querySelector('.next-thread-scroll') as HTMLElement;
    Object.defineProperty(scroll, 'scrollHeight', { value: 2000 });
    act(() => useChatStore.getState().setLoading(false));
    expect(scroll.scrollTop).toBe(2000);
  });
  it('另一会话的结束事件不会清空当前生成状态', () => {
    const state = useChatStore.getState();
    state.beginStream('cnv_1', 'msg_1', 'stream_1'); state.setActive('cnv_2'); state.beginStream('cnv_2', 'msg_2', 'stream_2');
    state.endStream('msg_1', null);
    expect(useChatStore.getState().streamId).toBe('stream_2');
    state.setActive('cnv_1'); expect(useChatStore.getState().streamId).toBeNull();
  });
  it('先收到结束事件时，迟到的发送返回不会令界面一直生成', () => {
    const state = useChatStore.getState();
    state.endStream('msg_fast', null, 'fast');
    state.beginStream('cnv_1', 'msg_fast', 'fast');
    expect(useChatStore.getState().activeStreams.cnv_1).toBeUndefined();
  });
  it('同一消息重新生成时，旧流结束不会清除新流', () => {
    const state = useChatStore.getState();
    state.beginStream('cnv_1', 'msg_a', 'old');
    state.beginStream('cnv_1', 'msg_a', 'new');
    state.endStream('msg_a', null, 'old');
    expect(useChatStore.getState().streamId).toBe('new');
  });
  it('每个会话独立保留整理状态，失败只结束相应任务', () => {
    const state = useCompressStore.getState();
    state.progress('a', 0, 8, 'summarizing'); state.progress('b', 0, 4, 'summarizing');
    state.fail('a', { code: 'UNKNOWN', message: '测试失败', retryable: true });
    expect(useCompressStore.getState().tasks.a?.status).toBe('error');
    expect(useCompressStore.getState().tasks.b?.status).toBe('running');
  });
  it('编辑历史的截断操作先说明后果再执行', async () => {
    const onEdit = vi.fn();
    render(<MessageItem message={makeMessage({ role: 'user' })} characterName="角色" showMetaAlways={false} streaming={false} onEdit={onEdit}/>);
    await userEvent.click(screen.getByRole('button', { name: '编辑消息' }));
    await userEvent.click(screen.getByRole('button', { name: '保存并截断' }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('不可撤销');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('简化后的入口', () => {
  it('左栏直接显示会话，移除搜索与设备说明', () => {
    useAppStore.setState({ conversations: [makeConversation(), makeConversation({ id: 'cnv_2', title: '海边的灯塔' })] });
    render(<Sidebar onNewChat={vi.fn()} onSelectConversation={vi.fn()} onRenameConversation={vi.fn()} onTogglePin={vi.fn()} onDeleteConversation={vi.fn()} onOpenPersonaMenu={vi.fn()}/>);
    expect(screen.queryByRole('textbox', { name: '搜索对话' })).toBeNull();
    expect(screen.getByText('夜巡酒馆的第三夜')).toBeTruthy();
    expect(screen.getByText('海边的灯塔')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'API Key' })).toBeNull();
    expect(screen.queryByText('对话保存在此设备')).toBeNull();
  });
  it('新建对话一个窗口完成，不改写共享角色卡', async () => {
    const save = vi.fn(); const confirm = vi.fn();
    render(<NewConversationWizard characters={[makeCharacter()]} personas={[makePersona()]} providers={[makeProvider()]} initialCharacterId="chr_1" onSaveCharacter={save} onConfirm={confirm} onCancel={vi.fn()} onGoCharacters={vi.fn()} onGoPersonas={vi.fn()} onGoApiKeys={vi.fn()}/>);
    await userEvent.click(screen.getByRole('button', { name: '开始对话' }));
    expect(confirm).toHaveBeenCalledWith({ characterId: 'chr_1', personaId: 'per_1', providerId: 'prv_1' });
    expect(save).not.toHaveBeenCalled();
  });
  it('右侧栏直接切换分类，收起和切换分类均保留未保存设置', async () => {
    const p: DetailPanelProps = { conversation: makeConversation(), character: makeCharacter(), providers: [makeProvider()], personas: [], summaries: [], preview: makeTokenPreview({ anyEstimated: true }), compressCandidateCount: 8, onCompress: vi.fn(), onRestoreSummary: vi.fn(), onUpdateConversation: vi.fn(async () => true), onRestart: vi.fn(async () => true), onExport: vi.fn(), onCopyConversation: vi.fn(), onDeleteConversation: vi.fn() };
    act(() => usePanelStore.getState().setOpen(true));
    render(<DetailPanel {...p}/>);
    expect(screen.getByRole('complementary', { name: '对话详情' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: '对话' }));
    await userEvent.click(screen.getByText('高级生成参数'));
    fireEvent.change(screen.getByRole('textbox', { name: '最大输出 token' }), { target: { value: '4096' } });
    await userEvent.click(screen.getByRole('tab', { name: '角色' }));
    await userEvent.click(screen.getByRole('button', { name: '收起右侧栏' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    act(() => usePanelStore.getState().setOpen(true));
    await userEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect((screen.getByRole('textbox', { name: '最大输出 token' }) as HTMLInputElement).value).toBe('4096');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(p.onUpdateConversation).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ maxTokens: 4096 }) })));
    expect(screen.getByRole('complementary', { name: '对话详情' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
    expect(screen.queryByRole('button', { name: '取消压缩' })).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
  });
  it('聊天页没有会话三点菜单与发送提示', async () => {
    const p = chatProps();
    render(<ChatView {...p}/>);
    expect(screen.queryByRole('button', { name: '会话操作' })).toBeNull();
    expect(screen.queryByText('Enter 发送 · Shift + Enter 换行')).toBeNull();
  });
  it('使用同一个开关收放侧栏并恢复焦点', async () => {
    const p: DetailPanelProps = { conversation: makeConversation(), character: makeCharacter(), providers: [makeProvider()], personas: [], summaries: [], preview: null, compressCandidateCount: 0, onCompress: vi.fn(), onRestoreSummary: vi.fn(), onUpdateConversation: vi.fn(async () => true), onRestart: vi.fn(async () => true), onExport: vi.fn(), onCopyConversation: vi.fn(), onDeleteConversation: vi.fn() };
    usePanelStore.setState({ open: true });
    render(<><ChatView {...chatProps()}/><DetailPanel {...p}/></>);
    const original = screen.getByRole('button', { name: '收起右侧栏' });
    expect(screen.queryByRole('button', { name: '展开右侧栏' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '收起右侧栏' }));
    const toggle = screen.getByRole('button', { name: '展开右侧栏' });
    expect(toggle).toBe(original);
    expect(document.activeElement).toBe(toggle);
    await userEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '收起右侧栏' }));
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开右侧栏' }));
  });
  it('输出上限可清空重输，空值及越界、小数不能保存，重置恢复已保存值', async () => {
    const onUpdateConversation = vi.fn(async () => true);
    const p: DetailPanelProps = { conversation: makeConversation(), character: makeCharacter(), providers: [], personas: [], summaries: [], preview: null, compressCandidateCount: 0, onCompress: vi.fn(), onRestoreSummary: vi.fn(), onUpdateConversation, onRestart: vi.fn(async () => true), onExport: vi.fn(), onCopyConversation: vi.fn(), onDeleteConversation: vi.fn() };
    usePanelStore.setState({ open: true, tab: 'conversation' });
    render(<DetailPanel {...p}/>);
    await userEvent.click(screen.getByText('高级生成参数'));
    const input = screen.getByRole('textbox', { name: '最大输出 token' }) as HTMLInputElement;
    const save = screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement;
    await userEvent.clear(input);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('1–1,000,000（整数）');
    expect(save.disabled).toBe(true);
    for (const value of ['0', '1000001', '2.5', '-1', '1e3']) {
      fireEvent.change(input, { target: { value } });
      expect(save.disabled).toBe(true);
    }
    for (const value of ['1', '1000000', '8192']) {
      fireEvent.change(input, { target: { value } });
      expect(save.disabled).toBe(false);
    }
    await userEvent.click(save);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ maxTokens: 8192 }) })));
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(input.value).toBe('1024');
  });
  it('角色简介支持折叠，移除角色库编辑入口', async () => {
    const p: DetailPanelProps = { conversation: makeConversation(), character: makeCharacter(), providers: [], personas: [], summaries: [], preview: null, compressCandidateCount: 0, onCompress: vi.fn(), onRestoreSummary: vi.fn(), onUpdateConversation: vi.fn(async () => true), onRestart: vi.fn(async () => true), onExport: vi.fn(), onCopyConversation: vi.fn(), onDeleteConversation: vi.fn() };
    usePanelStore.setState({ open: true, tab: 'character' });
    render(<DetailPanel {...p}/>);
    const summary = screen.getByText('角色简介');
    expect(summary.closest('details')!.open).toBe(true);
    await userEvent.click(summary);
    expect(summary.closest('details')!.open).toBe(false);
    expect(screen.queryByRole('button', { name: '前往角色库编辑' })).toBeNull();
  });
});
