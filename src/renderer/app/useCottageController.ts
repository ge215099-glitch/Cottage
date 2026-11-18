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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppDiagnostics, Character, CharacterExportFormat, CompressResult, NormalizedError, Provider, ProviderTestResult, Summary, TokenPreview } from "@shared/types.js";
import { useAppStore } from "../stores/app.js";
import { useChatStore } from "../stores/chat.js";
import { useComposerStore } from "../stores/composer.js";
import { usePanelStore } from "../stores/panel.js";
import { useCompressStore } from "../stores/compress.js";
import { useMenuStore } from "../stores/menu.js";
import { toast } from "../stores/toast.js";
import { type CharacterEditPatch } from "../components/CharacterEditor.js";
import { type NewConversationChoice } from "../components/NewConversationWizard.js";

interface PendingDelete {
  kind: 'conversation' | 'character' | 'persona' | 'provider';
  id: string;
  title: string;
  paragraphs: string[];
}

const api = (): Window['cottage'] => window.cottage;

export function useCottageController() {
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

  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [preview, setPreview] = useState<TokenPreview | null>(null);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [compressCandidates, setCompressCandidates] = useState(0);
  /** API Key 页：正在测试连接的那一条；以及每条最近一次的测试结果 */
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<
    Record<string, ProviderTestResult>
  >({});

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === chat.conversationId) ?? null,
    [conversations, chat.conversationId],
  );
  const activeCharacter = useMemo(
    () => characters.find((c) => c.id === activeConversation?.characterId) ?? null,
    [characters, activeConversation],
  );
  const hasProvider = providers.some((p) => p.hasKey && p.enabled);

  useEffect(() => { useComposerStore.getState().activateDraft(chat.conversationId); }, [chat.conversationId]);

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

  /**
   * 保存角色卡。**角色库的编辑弹窗**与**新建对话向导的第 2 步**共用这一个入口。
   *
   * 返回错误文案而不是自己 toast 掉，是刻意的（与人设 / API Key 同一个口径）：
   * 两个调用方都是弹窗，失败时必须**留在原地显示原因**——用户刚填了一屏，
   * 在这里 toast 一下再把弹窗关掉，等于把他输的内容扔掉。
   *
   * 字段白名单也在这里：只发可编辑字段，`raw_json`（第三方字段的唯一载体）
   * 与 `favorite` / `avatarPath` 一律不经过这条路径。
   */
  const saveCharacter = useCallback(
    async (character: Character, patch: CharacterEditPatch): Promise<string | null> => {
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
      if (!result.ok) return result.error.message;
      await refreshCharacters();
      toast('角色卡已保存');
      return null;
    },
    [refreshCharacters],
  );

  const refreshPersonas = useCallback(async () => {    const result = await api().personas.list();
    if (result.ok) useAppStore.getState().setPersonas(result.data);
  }, []);

  const refreshProviders = useCallback(async () => {
    const result = await api().providers.list();
    if (result.ok) useAppStore.getState().setProviders(result.data);
  }, []);

  const messageLoadSeq = useRef(0);
  const loadMessages = useCallback(async (conversationId: string) => {
    if (useChatStore.getState().conversationId !== conversationId) return;
    const seq = ++messageLoadSeq.current;
    useChatStore.getState().setLoading(true);
    const [messageResult, summaryResult] = await Promise.all([
      api().messages.list(conversationId),
      api().summaries.list(conversationId),
    ]);
    if (seq !== messageLoadSeq.current || useChatStore.getState().conversationId !== conversationId) return;
    if (messageResult.ok) useChatStore.getState().setMessages(messageResult.data);
    if (summaryResult.ok) {
      useChatStore.getState().setSummaries(summaryResult.data);
      setSummaries(summaryResult.data);
    }
    const range = await api().summaries.previewRange(conversationId, 8);
    if (seq !== messageLoadSeq.current || useChatStore.getState().conversationId !== conversationId) return;
    setCompressCandidates(range.ok ? range.data.ids.length : 0);
    useChatStore.getState().setLoading(false);
  }, []);

  /** 首次挂载：批量拉取所有基础数据。 */
  useEffect(() => {
    let disposed = false;
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

      if (disposed) return;
      const store = useAppStore.getState();
      if (convResult.ok) store.setConversations(convResult.data);
      if (charResult.ok) store.setCharacters(charResult.data);
      if (personaResult.ok) store.setPersonas(personaResult.data);
      if (providerResult.ok) store.setProviders(providerResult.data);
      if (settingsResult.ok) {
        store.setSettings(settingsResult.data);
        usePanelStore.setState({ open: false, tab: 'context' });
      }
      if (diagResult.ok) {
        setDiagnostics(diagResult.data);
        store.setStorageWarning(diagResult.data.storageWarning);
      }
      if (tagResult.ok) setTags(tagResult.data);

      // 应用主题（settings 里可能存了 dark）

      // 默认选中第一个会话
      if (convResult.ok && convResult.data.length) {
        const first = convResult.data[0]!;
        useChatStore.getState().setActive(first.id);
        await loadMessages(first.id);
      }
    })().catch((error: unknown) => toast(error instanceof Error ? error.message : '加载失败，请重启应用', 'error'));
    return () => { disposed = true; };
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
        // 先记录终态，兼容极快响应早于 send 的返回值；迟到旧流不能结束新流。
        state.endStream(event.messageId, null, event.streamId);
        const current = useChatStore.getState();
        if (current.conversationId === event.conversationId && !current.activeStreams[event.conversationId]) await loadMessages(event.conversationId);
        if (event.status === 'error' && event.error) {
          toast(`生成失败：${event.error.message}`, 'error');
        }
        void refreshConversations();
      }),

      events.onCompressProgress((event) => {
        const store = useCompressStore.getState();
        if (event.phase === 'complete' && event.result) store.succeed(event.conversationId, event.result);
        else if (event.phase === 'error' && event.error) store.fail(event.conversationId, event.error);
        else if (event.phase === 'summarizing' || event.phase === 'writing') store.progress(event.conversationId, event.done, event.total, event.phase);
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
    let disposed = false;
    setPreview(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await api().tokens.preview({
          conversationId: chat.conversationId!,
          draft: composer.draft,
        });
        if (result.ok && !disposed) setPreview(result.data);
      })();
    }, 180);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [chat.conversationId, composer.draft, chat.messages.length, summaries.length, activeConversation?.providerId, activeConversation?.model]);

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
      usePanelStore.getState().setOpen(false);
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

  /**
   * 导出角色卡：**先选格式，再过系统保存对话框**。
   *
   * 格式由应用自己选（而不是在保存对话框的"保存类型"下拉里选）：那个下拉在不同
   * 平台的表现不一致，而且 PNG 卡要求角色有卡面图——没有的话菜单项直接置灰，
   * 比"挑完路径才被告知导不出来"清楚得多。
   */
  const runCharacterExport = useCallback(
    async (character: Character, format: CharacterExportFormat) => {
      const result = await api().characters.export(character.id, format);
      if (!result.ok) {
        toast(result.error.message, 'error');
        return;
      }
      // path 为 null = 用户在保存对话框里点了取消，不是失败
      toast(result.data.path ? `已导出到 ${result.data.path}` : '已取消导出');
    },
    [toast],
  );

  const openCharacterExportMenu = useCallback(
    (character: Character, rect: DOMRect, trigger: HTMLElement) => {
      const hasArt = Boolean(character.avatarPath);
      useMenuStore.getState().open(
        { rect, targetId: character.id, trigger },
        [
          {
            label: '导出为 JSON',
            onSelect: () => void runCharacterExport(character, 'json'),
          },
          {
            // 没卡面图就说清为什么灰着，而不是给一个点了报错的选项
            label: hasArt ? '导出为 PNG 卡' : '导出为 PNG 卡（该角色没有卡面图）',
            disabled: !hasArt,
            onSelect: () => void runCharacterExport(character, 'png'),
          },
        ],
        '导出角色卡',
      );
    },
    [runCharacterExport],
  );

  /* ------------------------------ 角色卡导入 ------------------------------ */

  /**
   * 导入角色卡。
   *
   * **必须防重入**（`importing` 状态 + `importingRef` 同步闸门），两个理由都是实测到的：
   *   1. 主进程那条通道会**弹一个原生文件对话框**，而 `dialog.showOpenDialog` 是异步的。
   *      用户在"点了没反应"的几秒里连点几次，就会叠出好几个对话框——原生对话框在
   *      Windows 上会模态地霸占输入，叠起来之后关掉一个还有下一个，看起来就是"卡死动不了"。
   *   2. 每次调用都会真的导一次（`characters:import-file` 没有去重语义），连点几下就
   *      多出好几张一模一样的卡，还得各自落一份头像文件。
   *
   * `importingRef` 用 ref 而不是只靠 state：State 更新是异步的，连点发生在同一帧内时
   * 状态还没变，闸门必须同步生效。状态则负责把按钮禁用掉，让用户看得见"正在进行"。
   */
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);

  const importCharacterFile = useCallback(async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    try {
      const result = await api().characters.importFile();
      if (!result.ok) {
        toast(result.error.message, 'error');
        return;
      }
      if (!result.data) return; // 用户取消，不是失败
      await refreshCharacters();
      toast(`已导入「${result.data.character.name}」`);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [refreshCharacters]);

  /**
   * 角色库搜索。
   *
   * 用 `useCallback` 定住身份：`CharactersPage` 的搜索 effect 依赖它，
   * 内联箭头函数会在每次渲染都换一个身份，把"query 变了才搜索"变成"每渲染都搜索"。
   */
  const searchCharacters = useCallback(
    (search: string) => void refreshCharacters(search || undefined),
    [refreshCharacters],
  );

  /* ------------------------------ API Key（导航模块） ------------------------------ */

  /**
   * 保存一条 API Key 配置。
   *
   * **返回错误字符串而不是抛异常**：调用方是弹窗，它要把失败原因就地显示在表单下方
   * （关掉弹窗会让用户刚填的一屏内容白填）。成功返回 null。
   */
  const saveProvider = useCallback(
    async (input: {
      id?: string;
      name: string;
      type: 'openai' | 'anthropic';
      baseUrl: string;
      apiKey?: string;
      clearKey?: boolean;
      models: string[];
      defaultModel: string;
      compressionModel: string;
      enabled: boolean;
    }): Promise<string | null> => {
      const payload = {
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        models: input.models,
        defaultModel: input.defaultModel,
        compressionModel: input.compressionModel || input.defaultModel,
        enabled: input.enabled,
      };
      const result = input.id
        ? await api().providers.update(input.id, {
            ...payload,
            ...(input.clearKey ? { clearKey: true } : {}),
          })
        : await api().providers.create(payload);
      if (!result.ok) return result.error.message;
      await refreshProviders();
      // 改了名字/停用之后，旧的测试结果就不再对应当前配置，清掉重测
      setProviderTestResults((prev) => {
        const next = { ...prev };
        delete next[result.data.id];
        return next;
      });
      toast(input.id ? 'API Key 已更新' : 'API Key 已创建');
      return null;
    },
    [refreshProviders],
  );

  const testProvider = useCallback(async (id: string) => {
    setTestingProviderId(id);
    try {
      const result = await api().providers.test(id);
      const value: ProviderTestResult = result.ok
        ? result.data
        : {
            outcome: 'unreachable',
            httpStatus: null,
            probe: 'chat-completions',
            message: result.error.message,
            models: [],
            storageWarning: null,
          };
      setProviderTestResults((prev) => ({ ...prev, [id]: value }));
    } finally {
      setTestingProviderId(null);
    }
  }, []);

  const requestDeleteProvider = useCallback((provider: Provider) => {
    setDeleteError(null);
    setPendingDelete({
      kind: 'provider',
      id: provider.id,
      title: provider.name,
      paragraphs: [
        `「${provider.name}」`,
        '删除后密钥一并丢弃，无法恢复。',
        '绑定到这条配置的会话会被解除绑定（历史消息保留）。',
      ],
    });
  }, []);

  /** 从 API Key 列表跳到用量页，并只看这一把 Key。 */
  const selectProviderUsage = useCallback(
    async (providerId: string) => {
      useAppStore.getState().setUsageFilter({ providerId });
      setView('usage');
    },
    [setView],
  );

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

    if (pendingDelete.kind === 'provider') {
      const result = await api().providers.delete(pendingDelete.id);
      if (!result.ok) {
        setDeleteError(`删除失败：${result.error.message}`);
        return;
      }
      setPendingDelete(null);
      setProviderTestResults((prev) => {
        const next = { ...prev };
        delete next[pendingDelete.id];
        return next;
      });
      await refreshProviders();
      return;
    }

    const removed = await api().personas.delete(pendingDelete.id);
    if (!removed.ok || !removed.data.ok) {
      setDeleteError(removed.ok ? (removed.data.reason ?? '无法删除') : removed.error.message);
      return;
    }
    setPendingDelete(null);
    await refreshPersonas();
  }, [pendingDelete, loadMessages, refreshCharacters, refreshPersonas, refreshProviders]);

  /* ------------------------------ 生成 ------------------------------ */

  const sendMessage = useCallback(
    async (text: string) => {
      if (!chat.conversationId) return false;
      const conversationId = chat.conversationId;
      const result = await api().messages.send({
        conversationId,
        text,
        providerId: composer.providerOverrideId,
        ...(composer.modelOverride ? { model: composer.modelOverride } : {}),
      });

      if (!result.ok) {
        useComposerStore.getState().setSendError(conversationId, `${result.error.message}（草稿已保留）`);
        toast(result.error.message, 'error');
        if (result.error.code === 'NO_PROVIDER' || result.error.code === 'NO_KEY') setView('apiKeys');
        return false;
      }

      if (useChatStore.getState().conversationId === conversationId) {
        if (result.data.userMessage) useChatStore.getState().upsertMessage(result.data.userMessage);
        useChatStore.getState().upsertMessage(result.data.assistantMessage);
      }
      useChatStore
        .getState()
        .beginStream(conversationId, result.data.assistantMessage.id, result.data.streamId);
      // 用户消息与助手消息行都已落库，这里重新拉一次以获得权威排序
      if (useChatStore.getState().conversationId === conversationId) await loadMessages(conversationId);
      return true;
    },
    [chat.conversationId, composer.modelOverride, composer.providerOverrideId, loadMessages, setView],
  );

  const stopGeneration = useCallback(async () => {
    if (!chat.conversationId) return;
    await api().messages.abort(chat.conversationId);
  }, [chat.conversationId]);

  const regenerate = useCallback(
    async (messageId: string) => {
      const conversationId = chat.conversationId;
      if (!conversationId) return;
      const result = await api().messages.regenerate(messageId);
      if (!result.ok) {
        toast(result.error.message, 'error');
        return;
      }
      useChatStore.getState().beginStream(conversationId, messageId, result.data.streamId);
      if (useChatStore.getState().conversationId === conversationId) await loadMessages(conversationId);
    },
    [chat.conversationId, loadMessages],
  );

  /* ------------------------------ 压缩与恢复 ------------------------------ */

  const runCompress = useCallback(async () => {
    if (!chat.conversationId) return;
    const conversationId = chat.conversationId;
    if (useCompressStore.getState().tasks[conversationId]?.status === 'running') return;
    const range = await api().summaries.previewRange(conversationId, 8);
    const total = range.ok ? range.data.ids.length : 0;
    useCompressStore.getState().start(conversationId, total);
    const result = await api().summaries.compress({ conversationId });
    if (!result.ok) {
      useCompressStore.getState().fail(conversationId, result.error);
      return;
    }
    useCompressStore.getState().succeed(conversationId, result.data as CompressResult);
    if (useChatStore.getState().conversationId === conversationId) await loadMessages(conversationId);
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
      if (event.key === 'Escape' && !event.defaultPrevented) {
        const menu = useMenuStore.getState();
        if (menu.anchor) {
          const trigger = menu.anchor.trigger;
          menu.close();
          trigger?.focus();
          /*
           * 标记这一下 Esc 已被栈顶的菜单消费掉。
           *
           * 注册在后面的浮层（例如角色详情弹窗）会看到 `defaultPrevented`，
           * 于是"按一下 Esc"只收起菜单，不会把底下的弹窗一起关掉。
           */
          event.preventDefault();
          return;
        }
        if (pendingDelete) {
          setPendingDelete(null);
          return;
        }
        // Escape 只关闭浮层，不隐式中断后台生成。
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
    }
  }, []);

  // 主题跟随系统，监听系统主题变化。
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset['theme'] = settings?.theme === 'system' || !settings?.theme ? media.matches ? 'dark' : 'light' : settings.theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings?.theme]);

  /* ------------------------------ 渲染 ------------------------------ */


  return { view, setView, conversations, characters, personas, providers, settings, storageWarning, chat, summaries, preview, tags, diagnostics, pendingDelete, setPendingDelete, deleteError, setDeleteError, renaming, setRenaming, compressCandidates, testingProviderId, providerTestResults, activeConversation, activeCharacter, hasProvider, refreshCharacters, saveCharacter, refreshPersonas, loadMessages, selectConversation, wizard, openNewConversation, closeNewConversation, confirmNewConversation, renameConversation, togglePin, openCharacterExportMenu, importing, importCharacterFile, searchCharacters, saveProvider, testProvider, requestDeleteProvider, selectProviderUsage, requestDeleteConversation, confirmDelete, sendMessage, stopGeneration, regenerate, runCompress, restoreSummary, updateSettings };
}
