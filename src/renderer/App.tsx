/**
 * 应用外壳：把 IPC、状态切片与视图接起来（UI 文档第 12 节的组件结构）。
 *
 * 这个文件承担"唯一的编排点"这一角色，刻意不做任何渲染细节：
 *   - 所有 IPC 调用集中在这里，视图组件只拿到回调；
 *   - 所有主进程事件在这里订阅一次（含清理），避免多处订阅造成重复处理；
 *   - 删除确认框、菜单层、toast 层在末尾统一挂载。
 *
 * 之所以不把 IPC 调用散进各组件：技术方案 9.3 要求"写操作先走 IPC 成功后再更新
 * 本地投影"。集中之后，"先 IPC 再更新"这条顺序在代码里是可见的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type {
  AppDiagnostics,
  Character,
  CompressResult,
  NormalizedError,
  ProviderTestResult,
  Summary,
  TokenPreview,
} from '@shared/types.js';
import { useAppStore } from './stores/app.js';
import { useChatStore } from './stores/chat.js';
import { useComposerStore } from './stores/composer.js';
import { tabFromShortcut, usePanelStore } from './stores/panel.js';
import { useCompressStore } from './stores/compress.js';
import { useMenuStore } from './stores/menu.js';
import { toast } from './stores/toast.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatView } from './components/ChatView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { CharactersPage, PersonasPage, SettingsPage } from './components/Pages.js';
import { ConfirmDialog, MenuLayer, ToastLayer } from './components/Overlays.js';
import {
  NewConversationWizard,
  type NewConversationChoice,
} from './components/NewConversationWizard.js';

/** 待确认的删除操作。 */
interface PendingDelete {
  kind: 'conversation' | 'character' | 'persona';
  id: string;
  title: string;
  paragraphs: string[];
}

const api = (): Window['cottage'] => window.cottage;

export function App(): JSX.Element {
  /* ------------------------------ store 读取 ------------------------------ */

  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const conversations = useAppStore((s) => s.conversations);
  const characters = useAppStore((s) => s.characters);
  const personas = useAppStore((s) => s.personas);
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const storageWarning = useAppStore((s) => s.storageWarning);

  const chat = useChatStore();
  const composer = useComposerStore();
  const panel = usePanelStore();

  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [preview, setPreview] = useState<TokenPreview | null>(null);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [compressCandidates, setCompressCandidates] = useState(0);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === chat.conversationId) ?? null,
    [conversations, chat.conversationId],
  );
  const activeCharacter = useMemo(
    () => characters.find((c) => c.id === activeConversation?.characterId) ?? null,
    [characters, activeConversation],
  );
  const hasProvider = providers.some((p) => p.hasKey && p.enabled);

  /* ------------------------------ 数据加载 ------------------------------ */

  const refreshConversations = useCallback(async () => {
    const result = await api().conversations.list();
    if (result.ok) useAppStore.getState().setConversations(result.data);
    else useAppStore.getState().setLastError(result.error);
  }, []);

  const refreshCharacters = useCallback(async (search?: string) => {
    const result = await api().characters.list(search ? { search } : undefined);
    if (result.ok) useAppStore.getState().setCharacters(result.data);
    const tagResult = await api().characters.tags();
    if (tagResult.ok) setTags(tagResult.data);
  }, []);

  const refreshPersonas = useCallback(async () => {
    const result = await api().personas.list();
    if (result.ok) useAppStore.getState().setPersonas(result.data);
  }, []);

  const refreshProviders = useCallback(async () => {
    const result = await api().providers.list();
    if (result.ok) useAppStore.getState().setProviders(result.data);
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const [messageResult, summaryResult] = await Promise.all([
      api().messages.list(conversationId),
      api().summaries.list(conversationId),
    ]);
    if (messageResult.ok) useChatStore.getState().setMessages(messageResult.data);
    if (summaryResult.ok) {
      useChatStore.getState().setSummaries(summaryResult.data);
      setSummaries(summaryResult.data);
    }
    const range = await api().summaries.previewRange(conversationId, 8);
    setCompressCandidates(range.ok ? range.data.ids.length : 0);
  }, []);

  /** 首次挂载：批量拉取所有基础数据。 */
  useEffect(() => {
    void (async () => {
      const [convResult, charResult, personaResult, providerResult, settingsResult, diagResult, tagResult] =
        await Promise.all([
          api().conversations.list(),
          api().characters.list(),
          api().personas.list(),
          api().providers.list(),
          api().settings.get(),
          api().app.diagnostics(),
          api().characters.tags(),
        ]);

      const store = useAppStore.getState();
      if (convResult.ok) store.setConversations(convResult.data);
      if (charResult.ok) store.setCharacters(charResult.data);
      if (personaResult.ok) store.setPersonas(personaResult.data);
      if (providerResult.ok) store.setProviders(providerResult.data);
      if (settingsResult.ok) {
        store.setSettings(settingsResult.data);
        usePanelStore.setState({ open: settingsResult.data.panelOpen, tab: settingsResult.data.panelTab as never });
      }
      if (diagResult.ok) {
        setDiagnostics(diagResult.data);
        store.setStorageWarning(diagResult.data.storageWarning);
      }
      if (tagResult.ok) setTags(tagResult.data);

      // 应用主题（settings 里可能存了 dark）
      if (settingsResult.ok && settingsResult.data.theme !== 'system') {
        document.documentElement.dataset['theme'] = settingsResult.data.theme;
      }

      // 默认选中第一个会话
      if (convResult.ok && convResult.data.length) {
        const first = convResult.data[0]!;
        useChatStore.getState().setActive(first.id);
        await loadMessages(first.id);
      }
    })();
  }, [loadMessages]);

  /* ------------------------------ 主进程事件订阅 ------------------------------ */

  useEffect(() => {
    const events = api().events;
    const unsubscribers = [
      events.onStreamChunk((event) => {
        const state = useChatStore.getState();
        // 只接受当前会话的推送：切换会话不打断生成，但也不该往别的会话里插字
        if (state.conversationId !== event.conversationId) return;
        if (state.streamId !== event.streamId && state.streamId !== null) return;
        if (!event.delta) return;
        state.appendStreamDelta(event.messageId, event.delta);
      }),

      events.onStreamEnd(async (event) => {
        const state = useChatStore.getState();
        // 用数据库里的最终状态覆盖投影，保证与权威数据一致
        const list = await api().messages.list(event.conversationId);
        if (list.ok && state.conversationId === event.conversationId) {
          state.setMessages(list.data);
        }
        state.endStream(event.messageId, null);
        if (event.status === 'error' && event.error) {
          toast(`生成失败：${event.error.message}`, 'error');
        }
        void refreshConversations();
      }),

      events.onCompressProgress((event) => {
        useCompressStore.getState().progress(event.done, event.total, event.phase);
      }),

      events.onConversationsChanged(() => {
        void refreshConversations();
      }),

      events.onMessagesChanged(async () => {
        const id = useChatStore.getState().conversationId;
        if (id) await loadMessages(id);
      }),

      events.onAppError((error: NormalizedError) => {
        useAppStore.getState().setLastError(error);
        toast(error.message, 'error');
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [loadMessages, refreshConversations]);

  /* ------------------------------ token 预览 ------------------------------ */

  // 草稿变化时重新计算占用（防抖：打字期间不必每次 IPC）
  useEffect(() => {
    if (!chat.conversationId) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await api().tokens.preview({
          conversationId: chat.conversationId!,
          draft: composer.draft,
        });
        if (result.ok) setPreview(result.data);
      })();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [chat.conversationId, composer.draft, chat.messages.length, summaries.length]);

  /* ------------------------------ 会话操作 ------------------------------ */

  /**
   * 选中一个会话。
   *
   * 两件事必须一起做，少一个都是用户看得见的 bug：
   *   1. **切回对话视图**——否则在角色库 / 人设 / 设置页点会话行「点了没反应」；
   *   2. 已经选中的会话也必须切视图，所以不能因为 id 相同就整体早退
   *      （以前那样写，在设置页点当前会话会彻底没有任何反应）。
   */
  const selectConversation = useCallback(
    async (id: string) => {
      setView('chat');
      if (useChatStore.getState().conversationId === id) return;
      useChatStore.getState().setActive(id);
      await loadMessages(id);
    },
    [loadMessages, setView],
  );

  /* ------------------------------ 新建对话（向导） ------------------------------ */

  const [wizard, setWizard] = useState<{
    open: boolean;
    characterId: string | null;
    busy: boolean;
    error: string | null;
  }>({ open: false, characterId: null, busy: false, error: null });

  /**
   * 打开「新建对话」向导。
   *
   * 传 character 表示"角色已经定了"（从角色卡上的「新对话」进来），
   * 向导会直接从「选人设」那一步开始，省掉一次无意义的确认。
   */
  const openNewConversation = useCallback((character?: Character) => {
    setWizard({ open: true, characterId: character?.id ?? null, busy: false, error: null });
  }, []);

  const closeNewConversation = useCallback(() => {
    setWizard({ open: false, characterId: null, busy: false, error: null });
  }, []);

  /**
   * 向导确认后才真的建会话，并把用户选的**角色 / 人设 / Provider** 一起写进去。
   *
   * 旧实现是"点一下就用 activeCharacter ?? characters[0] 和全局默认 Provider 建"，
   * 用户既看不见也改不了——这正是这次要换掉的东西。
   */
  const confirmNewConversation = useCallback(
    async ({ characterId, personaId, providerId }: NewConversationChoice) => {
      setWizard((w) => ({ ...w, busy: true, error: null }));
      const provider = providers.find((p) => p.id === providerId);
      const result = await api().conversations.create({
        characterId,
        personaId,
        providerId,
        ...(provider?.defaultModel ? { model: provider.defaultModel } : {}),
        useFirstMessage: true,
      });
      if (!result.ok) {
        // 失败就留在向导里显示原因：把用户刚选的三项丢掉、让他重选一遍是最差的做法
        setWizard((w) => ({ ...w, busy: false, error: result.error.message }));
        return;
      }
      useAppStore.getState().upsertConversation(result.data);
      await refreshConversations();
      useChatStore.getState().setActive(result.data.id);
      await loadMessages(result.data.id);
      setWizard({ open: false, characterId: null, busy: false, error: null });
      setView('chat');
    },
    [loadMessages, providers, refreshConversations, setView],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const result = await api().conversations.rename(id, title);
      if (result.ok) useAppStore.getState().upsertConversation(result.data);
      else toast(result.error.message, 'error');
    },
    [],
  );

  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    const result = await api().conversations.setPinned(id, pinned);
    if (result.ok) useAppStore.getState().upsertConversation(result.data);
    else toast(result.error.message, 'error');
  }, []);

  const requestDeleteConversation = useCallback(
    async (id: string) => {
      const stats = await api().conversations.stats(id);
      const conversation = useAppStore.getState().conversations.find((c) => c.id === id);
      const paragraphs = [
        `「${conversation?.title ?? ''}」`,
        stats.ok
          ? `共 ${stats.data.messageCount} 条消息${
              stats.data.summaryCount ? `，其中 ${stats.data.summaryCount} 段摘要将一并删除` : ''
            }。`
          : '',
        '此操作不可撤销。',
      ].filter(Boolean);
      setDeleteError(null);
      setPendingDelete({ kind: 'conversation', id, title: conversation?.title ?? '', paragraphs });
    },
    [],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleteError(null);

    if (pendingDelete.kind === 'conversation') {
      const result = await api().conversations.remove(pendingDelete.id);
      if (!result.ok) {
        // 删除失败要在对话框内联报错，并说明数据未改动（UI 文档第 7 节）
        setDeleteError(`删除失败：${result.error.message}。数据未改动。`);
        return;
      }
      const store = useAppStore.getState();
      store.removeConversation(pendingDelete.id);
      setPendingDelete(null);
      if (useChatStore.getState().conversationId === pendingDelete.id) {
        // 焦点交给相邻会话（优先下一条，无则上一条）
        const remaining = store.conversations.filter((c) => c.id !== pendingDelete.id);
        const next = remaining[0] ?? null;
        if (next) {
          useChatStore.getState().setActive(next.id);
          await loadMessages(next.id);
        } else {
          useChatStore.getState().setActive(null);
          useChatStore.getState().setMessages([]);
        }
      }
      return;
    }

    if (pendingDelete.kind === 'character') {
      const result = await api().characters.delete(pendingDelete.id);
      if (!result.ok) {
        setDeleteError(`删除失败：${result.error.message}`);
        return;
      }
      if (!result.data.ok) {
        setDeleteError(result.data.reason ?? '该角色无法删除');
        return;
      }
      setPendingDelete(null);
      await refreshCharacters();
      return;
    }

    const removed = await api().personas.delete(pendingDelete.id);
    if (!removed.ok || !removed.data.ok) {
      setDeleteError(removed.ok ? (removed.data.reason ?? '无法删除') : removed.error.message);
      return;
    }
    setPendingDelete(null);
    await refreshPersonas();
  }, [pendingDelete, loadMessages, refreshCharacters, refreshPersonas]);

  /* ------------------------------ 生成 ------------------------------ */

  const sendMessage = useCallback(
    async (text: string) => {
      if (!chat.conversationId) return;
      const conversationId = chat.conversationId;
      const result = await api().messages.send({
        conversationId,
        text,
        providerId: composer.providerOverrideId,
        ...(composer.modelOverride ? { model: composer.modelOverride } : {}),
      });

      if (!result.ok) {
        toast(result.error.message, 'error');
        if (result.error.code === 'NO_PROVIDER' || result.error.code === 'NO_KEY') setView('settings');
        return;
      }

      useChatStore.getState().upsertMessage(result.data.userMessage ?? result.data.assistantMessage);
      if (result.data.userMessage) useChatStore.getState().upsertMessage(result.data.userMessage);
      useChatStore.getState().upsertMessage(result.data.assistantMessage);
      useChatStore
        .getState()
        .beginStream(conversationId, result.data.assistantMessage.id, result.data.streamId);
      // 用户消息与助手消息行都已落库，这里重新拉一次以获得权威排序
      await loadMessages(conversationId);
    },
    [chat.conversationId, composer.modelOverride, composer.providerOverrideId, loadMessages, setView],
  );

  const stopGeneration = useCallback(async () => {
    if (!chat.conversationId) return;
    await api().messages.abort(chat.conversationId);
  }, [chat.conversationId]);

  const regenerate = useCallback(
    async (messageId: string) => {
      const result = await api().messages.regenerate(messageId);
      if (!result.ok) {
        toast(result.error.message, 'error');
        return;
      }
      useChatStore.getState().beginStream(chat.conversationId!, messageId, result.data.streamId);
    },
    [chat.conversationId],
  );

  /* ------------------------------ 压缩与恢复 ------------------------------ */

  const runCompress = useCallback(async () => {
    if (!chat.conversationId) return;
    const range = await api().summaries.previewRange(chat.conversationId, 8);
    const total = range.ok ? range.data.ids.length : 0;
    useCompressStore.getState().start(chat.conversationId, total);
    const result = await api().summaries.compress({ conversationId: chat.conversationId });
    if (!result.ok) {
      useCompressStore.getState().fail(result.error);
      return;
    }
    useCompressStore.getState().succeed(result.data as CompressResult);
    await loadMessages(chat.conversationId);
    toast(
      `已将第 ${result.data.from}–${result.data.to} 条压缩（${result.data.tokensBefore.toLocaleString('en-US')} → ${result.data.tokensAfter.toLocaleString('en-US')} tokens）`,
    );
  }, [chat.conversationId, loadMessages]);

  const restoreSummary = useCallback(
    async (summaryId: string) => {
      const result = await api().summaries.restore(summaryId);
      if (!result.ok) {
        toast(result.error.message, 'error');
        return;
      }
      await loadMessages(chat.conversationId!);
      toast(`已恢复第 ${result.data.from}–${result.data.to} 条，对应摘要已失效`);
    },
    [chat.conversationId, loadMessages],
  );

  /* ------------------------------ 全局快捷键 ------------------------------ */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (mod && key === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (mod && key === 'n') {
        event.preventDefault();
        openNewConversation();
        return;
      }
      if (mod && key === 'b') {
        event.preventDefault();
        useAppStore.getState().toggleSidebar();
        return;
      }
      if (mod && key === 'i') {
        event.preventDefault();
        const panelState = usePanelStore.getState();
        panelState.setOpen(!panelState.open);
        return;
      }
      if (mod && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        const tab = tabFromShortcut(event.key);
        if (tab) usePanelStore.getState().setTab(tab);
        return;
      }
      if (event.key === 'Escape') {
        const menu = useMenuStore.getState();
        if (menu.anchor) {
          const trigger = menu.anchor.trigger;
          menu.close();
          trigger?.focus();
          return;
        }
        if (pendingDelete) {
          setPendingDelete(null);
          return;
        }
        // 生成中按 Esc 是最后一道停止（UI 文档第 8 节）
        if (useChatStore.getState().streamingConversationId) void stopGeneration();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openNewConversation, pendingDelete, stopGeneration]);

  /* ------------------------------ 设置持久化 ------------------------------ */

  const updateSettings = useCallback(async (patch: Record<string, unknown>) => {
    const result = await api().settings.update(patch as never);
    if (result.ok) {
      useAppStore.getState().setSettings(result.data);
      if (result.data.theme !== 'system') document.documentElement.dataset['theme'] = result.data.theme;
    }
  }, []);

  // 右栏开关与标签落库（UI 文档第 8 节）
  useEffect(() => {
    void api().settings.update({ panelOpen: panel.open, panelTab: panel.tab });
  }, [panel.open, panel.tab]);

  /* ------------------------------ 渲染 ------------------------------ */

  const sidebar = (
    <Sidebar
      onNewChat={() => openNewConversation()}
      onSelectConversation={(id) => void selectConversation(id)}
      onRenameConversation={renameConversation}
      onTogglePin={(id, pinned) => void togglePin(id, pinned)}
      onDeleteConversation={(id) => void requestDeleteConversation(id)}
      onOpenPersonaMenu={(rect, trigger) => {
        useMenuStore.getState().open(
          { rect, targetId: 'persona', trigger },
          [
            { label: '切换人设', onSelect: () => usePanelStore.getState().setTab('conversation') },
            { label: '人设管理', onSelect: () => setView('personas') },
          ],
          '人设选项',
        );
      }}
      searchInputRef={searchInputRef}
    />
  );

  return (
    <>
      <div id="shell">
        {sidebar}

        {view === 'chat' ? (
          <ChatView
            conversation={activeConversation}
            character={activeCharacter}
            summaries={summaries}
            preview={preview}
            hasProvider={hasProvider}
            renaming={renaming}
            onStartRename={() => setRenaming(true)}
            onCommitRename={(title) => {
              if (activeConversation) void renameConversation(activeConversation.id, title);
              setRenaming(false);
            }}
            onCancelRename={() => setRenaming(false)}
            onTogglePin={() => {
              if (activeConversation) {
                void togglePin(activeConversation.id, activeConversation.pinnedAt === null);
              }
            }}
            onTogglePanel={() => usePanelStore.getState().toggle()}
            onSend={(text) => void sendMessage(text)}
            onStop={() => void stopGeneration()}
            onOpenSettings={() => setView('settings')}
            onRestoreSummary={(id) => void restoreSummary(id)}
            onNewConversation={() => openNewConversation()}
            onEditMessage={(messageId, content, truncate) => {
              void (async () => {
                const result = await api().messages.edit({ messageId, content, truncate });
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await loadMessages(chat.conversationId!);
                toast(
                  truncate
                    ? `已保存并截断后续消息${
                        result.data.invalidatedSummaries
                          ? `，${result.data.invalidatedSummaries} 段摘要失效`
                          : ''
                      }`
                    : '已保存',
                );
              })();
            }}
            onDeleteMessage={(messageId) => {
              void (async () => {
                const result = await api().messages.remove(messageId);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await loadMessages(chat.conversationId!);
                toast(
                  result.data.invalidatedSummaries
                    ? `已删除，${result.data.invalidatedSummaries} 段摘要失效`
                    : '已删除 1 条消息',
                );
              })();
            }}
            onDeleteFromMessage={(messageId) => {
              void (async () => {
                const target = chat.messages.find((m) => m.id === messageId);
                if (!target) return;
                const result = await api().messages.removeFrom(target.conversationId, target.sortOrder);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await loadMessages(chat.conversationId!);
                toast(`已删除 ${result.data.deletedCount} 条消息`);
              })();
            }}
            onRegenerate={(messageId) => void regenerate(messageId)}
            onCopyMessage={(message) => {
              void navigator.clipboard
                .writeText(message.content)
                .then(() => toast('已复制这条消息'))
                .catch(() => toast('复制失败', 'error'));
            }}
          />
        ) : view === 'characters' ? (
          <CharactersPage
            characters={characters}
            tags={tags}
            onImportFile={() => {
              void (async () => {
                const result = await api().characters.importFile();
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                if (!result.data) return; // 用户取消
                await refreshCharacters();
                toast(`已导入「${result.data.character.name}」`);
              })();
            }}
            onSearch={(search) => void refreshCharacters(search || undefined)}
            onToggleFavorite={(character) => {
              void (async () => {
                await api().characters.update(character.id, { favorite: !character.favorite });
                await refreshCharacters(useAppStore.getState().query || undefined);
              })();
            }}
            onDelete={(character) => {
              setDeleteError(null);
              setPendingDelete({
                kind: 'character',
                id: character.id,
                title: character.name,
                paragraphs: [`「${character.name}」`, '此操作不可撤销。'],
              });
            }}
            onExport={(character) => {
              void (async () => {
                const result = await api().characters.export(character.id);
                if (!result.ok) toast(result.error.message, 'error');
              })();
            }}
            onNewConversation={(character) => openNewConversation(character)}
            onSave={(character, patch) => {
              void (async () => {
                const result = await api().characters.update(character.id, {
                  name: patch.name,
                  description: patch.description,
                  personality: patch.personality,
                  scenario: patch.scenario,
                  firstMes: patch.firstMes,
                  alternateGreetings: patch.alternateGreetings,
                  mesExample: patch.mesExample,
                  systemPrompt: patch.systemPrompt,
                  postHistoryInstructions: patch.postHistoryInstructions,
                  tags: patch.tags,
                });
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await refreshCharacters(useAppStore.getState().query || undefined);
                toast('角色卡已保存');
              })();
            }}
          />
        ) : view === 'personas' ? (
          <PersonasPage
            personas={personas}
            onCreate={(input) => {
              void (async () => {
                const result = await api().personas.create(input);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await refreshPersonas();
              })();
            }}
            onUpdate={(id, patch) => {
              void (async () => {
                await api().personas.update(id, { name: patch.name, description: patch.description });
                await refreshPersonas();
              })();
            }}
            onDelete={(persona) => {
              setDeleteError(null);
              setPendingDelete({
                kind: 'persona',
                id: persona.id,
                title: persona.name,
                paragraphs: [`「${persona.name}」`, '绑定该人设的会话会被解除绑定。'],
              });
            }}
            onSetDefault={(persona) => {
              void (async () => {
                const result = await api().personas.setDefault(persona.id);
                if (result.ok) useAppStore.getState().setPersonas(result.data);
              })();
            }}
          />
        ) : (
          <SettingsPage
            providers={providers}
            settings={settings}
            diagnostics={diagnostics}
            storageWarning={storageWarning}
            onSaveProvider={async (input) => {
              const result = input.id
                ? await api().providers.update(input.id, {
                    name: input.name,
                    type: input.type,
                    baseUrl: input.baseUrl,
                    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
                    ...(input.clearKey ? { clearKey: input.clearKey } : {}),
                    models: input.models,
                    defaultModel: input.defaultModel,
                    compressionModel: input.compressionModel,
                    enabled: input.enabled,
                  })
                : await api().providers.create({
                    name: input.name,
                    type: input.type,
                    baseUrl: input.baseUrl,
                    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
                    models: input.models,
                    defaultModel: input.defaultModel,
                    compressionModel: input.compressionModel,
                    enabled: input.enabled,
                  });
              if (!result.ok) {
                toast(result.error.message, 'error');
                return;
              }
              await refreshProviders();
              toast(input.id ? 'Provider 已更新' : 'Provider 已添加');
            }}
            onDeleteProvider={(id) => {
              void (async () => {
                const result = await api().providers.delete(id);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await refreshProviders();
              })();
            }}
            onTestProvider={async (id): Promise<ProviderTestResult> => {
              const result = await api().providers.test(id);
              if (!result.ok) {
                return {
                  outcome: 'unreachable',
                  httpStatus: null,
                  probe: 'chat-completions',
                  message: result.error.message,
                  models: [],
                  storageWarning: null,
                };
              }
              return result.data;
            }}
            onUpdateSettings={(patch) => void updateSettings(patch)}
            onExportPlainConfig={() => {
              // 二次确认（技术方案 6.4 规则 5）
              setPendingDelete({
                kind: 'conversation',
                id: '__plain_config__',
                title: '导出明文配置包？',
                paragraphs: [
                  '导出的文件将包含**明文 API Key**，请妥善保管。',
                  'safeStorage 的密文绑定本机用户凭据，直接拷贝 cottage.db 到另一台机器无法解密；换机请使用本文件。',
                ],
              });
            }}
          />
        )}

        {view === 'chat' ? (
          <DetailPanel
            conversation={activeConversation}
            character={activeCharacter}
            providers={providers}
            personas={personas}
            summaries={summaries}
            preview={preview}
            compressCandidateCount={compressCandidates}
            onCompress={() => void runCompress()}
            onCancelCompress={() => useCompressStore.getState().cancel()}
            onRestoreSummary={(id) => void restoreSummary(id)}
            onUpdateConversation={(patch) => {
              if (!activeConversation) return;
              void (async () => {
                const result = await api().conversations.update(activeConversation.id, patch);
                if (result.ok) useAppStore.getState().upsertConversation(result.data);
                else toast(result.error.message, 'error');
              })();
            }}
            onRestart={() => {
              if (!activeConversation) return;
              void (async () => {
                const result = await api().conversations.restart(activeConversation.id);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await loadMessages(activeConversation.id);
                toast('会话已用开场白重开');
              })();
            }}
            onExport={(kind) => {
              if (!activeConversation) return;
              void (async () => {
                const result =
                  kind === 'md'
                    ? await api().exportData.conversationMarkdown(activeConversation.id)
                    : await api().exportData.conversationJson(activeConversation.id);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                toast(result.data.path ? `已导出到 ${result.data.path}` : '已生成导出内容（未选择保存位置）');
              })();
            }}
            onCopyConversation={() => {
              if (!activeConversation) return;
              void (async () => {
                const result = await api().exportData.conversationJson(activeConversation.id);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                await navigator.clipboard.writeText(result.data.content);
                toast('已复制整段会话');
              })();
            }}
            onDeleteConversation={() => {
              if (activeConversation) void requestDeleteConversation(activeConversation.id);
            }}
            onEditCharacter={() => setView('characters')}
          />
        ) : null}
      </div>

      <MenuLayer />
      <ToastLayer />
      {wizard.open ? (
        <NewConversationWizard
          characters={characters}
          personas={personas}
          providers={providers}
          initialCharacterId={wizard.characterId}
          defaultProviderId={settings?.chatProviderId ?? null}
          busy={wizard.busy}
          error={wizard.error}
          onConfirm={(choice) => void confirmNewConversation(choice)}
          onCancel={closeNewConversation}
          onGoCharacters={() => {
            closeNewConversation();
            setView('characters');
          }}
          onGoPersonas={() => {
            closeNewConversation();
            setView('personas');
          }}
          onGoSettings={() => {
            closeNewConversation();
            setView('settings');
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.kind === 'conversation' && pendingDelete.id === '__plain_config__'
            ? '导出明文配置包？'
            : pendingDelete.kind === 'conversation'
              ? '删除对话？'
              : pendingDelete.kind === 'character'
                ? '删除角色卡？'
                : '删除人设？'}
          paragraphs={pendingDelete.paragraphs}
          confirmLabel={
            pendingDelete.id === '__plain_config__'
              ? '确认导出'
              : pendingDelete.kind === 'conversation'
                ? '删除'
                : '删除'
          }
          danger
          error={deleteError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (pendingDelete.id === '__plain_config__') {
              void (async () => {
                const result = await api().exportData.plainConfig(true);
                setPendingDelete(null);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return;
                }
                toast(result.data.path ? `已导出到 ${result.data.path}` : '已生成明文配置包');
              })();
              return;
            }
            void confirmDelete();
          }}
        />
      ) : null}
    </>
  );
}
