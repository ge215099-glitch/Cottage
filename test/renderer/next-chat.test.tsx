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
    onStartRename: vi.fn(), onCommitRename: vi.fn(), onCancelRename: vi.fn(), onTogglePin: vi.fn(), onTogglePanel: vi.fn(), onSend: vi.fn(async () => true), onStop: vi.fn(), onOpenApiKeys: vi.fn(), onRestoreSummary: vi.fn(), onNewConversation: vi.fn(), onEditMessage: vi.fn(), onDeleteMessage: vi.fn(), onDeleteFromMessage: vi.fn(), onRegenerate: vi.fn(), onCopyMessage: vi.fn(), ...patch };
}
beforeEach(() => {
  useAppStore.setState({ view: 'chat', sidebarCollapsed: false, providers: [makeProvider()], characters: [makeCharacter()], conversations: [makeConversation()], settings: makeSettings() });
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
  it('左栏能搜索会话，管理功能收纳到设置', async () => {
    useAppStore.setState({ conversations: [makeConversation(), makeConversation({ id: 'cnv_2', title: '海边的灯塔' })] });
    render(<Sidebar onNewChat={vi.fn()} onSelectConversation={vi.fn()} onRenameConversation={vi.fn()} onTogglePin={vi.fn()} onDeleteConversation={vi.fn()} onOpenPersonaMenu={vi.fn()}/>);
    await userEvent.type(screen.getByRole('textbox', { name: '搜索对话' }), '灯塔');
    expect(screen.queryByText('夜巡酒馆的第三夜')).toBeNull();
    expect(screen.getByText('海边的灯塔')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'API Key' })).toBeNull();
  });
  it('新建对话一个窗口完成，不改写共享角色卡', async () => {
    const save = vi.fn(); const confirm = vi.fn();
    render(<NewConversationWizard characters={[makeCharacter()]} personas={[makePersona()]} providers={[makeProvider()]} initialCharacterId="chr_1" onSaveCharacter={save} onConfirm={confirm} onCancel={vi.fn()} onGoCharacters={vi.fn()} onGoPersonas={vi.fn()} onGoApiKeys={vi.fn()}/>);
    await userEvent.click(screen.getByRole('button', { name: '开始对话' }));
    expect(confirm).toHaveBeenCalledWith({ characterId: 'chr_1', personaId: 'per_1', providerId: 'prv_1' });
    expect(save).not.toHaveBeenCalled();
  });
  it('默认不渲染记忆面板；打开后不展示虚假的取消压缩', () => {
    const p: DetailPanelProps = { conversation: makeConversation(), character: makeCharacter(), providers: [makeProvider()], personas: [], summaries: [], preview: makeTokenPreview({ anyEstimated: true }), compressCandidateCount: 8, onCompress: vi.fn(), onRestoreSummary: vi.fn(), onUpdateConversation: vi.fn(async () => true), onRestart: vi.fn(async () => true), onExport: vi.fn(), onCopyConversation: vi.fn(), onDeleteConversation: vi.fn(), onEditCharacter: vi.fn() };
    render(<DetailPanel {...p}/>); expect(screen.queryByRole('dialog')).toBeNull();
    act(() => usePanelStore.getState().setTab('context'));
    expect(screen.getByRole('dialog', { name: '对话记忆' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消压缩' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
