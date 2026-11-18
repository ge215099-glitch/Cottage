import type { JSX } from "react";
import { useAppStore } from "./stores/app.js";
import { usePanelStore } from "./stores/panel.js";

import { useMenuStore } from "./stores/menu.js";
import { toast } from "./stores/toast.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { CharactersPage, PersonasPage, SettingsPage } from "./components/Pages.js";
import { ApiKeysPage } from "./components/ApiKeysPage.js";
import { UsagePage } from "./components/UsagePage.js";
import { ConfirmDialog, MenuLayer, ToastLayer } from "./components/Overlays.js";
import { SettingsNavigation } from "./components/SettingsNavigation.js";
import { UiIcon } from "./components/UiIcon.js";
import { NewConversationWizard } from "./components/NewConversationWizard.js";
import { useCottageController } from './app/useCottageController.js';

const api = (): Window['cottage'] => window.cottage;

export function App(): JSX.Element {
  const { view, setView, characters, personas, providers, settings, storageWarning, chat, summaries, preview, tags, diagnostics, pendingDelete, setPendingDelete, deleteError, setDeleteError, renaming, setRenaming, compressCandidates, testingProviderId, providerTestResults, activeConversation, activeCharacter, hasProvider, refreshCharacters, saveCharacter, refreshPersonas, loadMessages, selectConversation, wizard, openNewConversation, closeNewConversation, confirmNewConversation, renameConversation, togglePin, openCharacterExportMenu, importing, importCharacterFile, searchCharacters, saveProvider, testProvider, requestDeleteProvider, selectProviderUsage, requestDeleteConversation, confirmDelete, sendMessage, stopGeneration, regenerate, runCompress, restoreSummary, updateSettings } = useCottageController();
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
    />
  );

  return (
    <>
      <div id="shell">
        {sidebar}
        <div className="next-workspace">
        {view !== 'chat' && <><header className="workspace-topbar"><button className="icon-btn" aria-label="开关侧栏" onClick={() => useAppStore.getState().toggleSidebar()}><UiIcon name="sidebar"/></button><button onClick={() => setView('chat')}>返回对话</button></header>{view !== 'characters' && <SettingsNavigation/>}</>}
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
            onSend={sendMessage}
            onStop={() => void stopGeneration()}
            onOpenApiKeys={() => setView('apiKeys')}
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
            importing={importing}
            onImportFile={() => void importCharacterFile()}
            onSearch={searchCharacters}
            onToggleFavorite={(character) => {
              void (async () => {
                await api().characters.update(character.id, { favorite: !character.favorite });
                await refreshCharacters();
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
            onExport={(character, rect, trigger) => openCharacterExportMenu(character, rect, trigger)}
            onNewConversation={(character) => openNewConversation(character)}
            onSave={saveCharacter}
          />
        ) : view === 'personas' ? (
          <PersonasPage
            personas={personas}
            /*
             * 新建与编辑共用一个入口（与 API Key 页同形）。
             *
             * 关键点是**把错误文案返回给弹窗**，而不是在这里 toast 后静默关闭：
             * 用户填了一屏内容，失败时应该留在原地看到原因、内容还在。
             * 「设为默认」也在这里顺手做掉——它与人设本身是两处状态
             * （`personas.is_default` 与"谁是全局默认"），勾了就得两处都落。
             */
            onSave={async (input) => {
              /*
               * 编辑的 id 在 await 之前就定下来，后面「设为默认」用的是**它**，
               * 不是 `update` 返回对象里的 id。理由：命令行的目标是人设本身，
               * 不该依赖返回值再告诉我改的是谁——那是"用回参当输入"。
               * （这个坑是测试帮我们抓到的：此前渲染层的假 API 无论更新谁
               *   都返回同一条人设，于是"改 B 把默认落给了 A"这种情况谁也看不见。）
               */
              const editingId = input.id;
              const result = editingId
                ? await api().personas.update(editingId, {
                    name: input.name,
                    description: input.description,
                  })
                : await api().personas.create({
                    name: input.name,
                    description: input.description,
                  });
              if (!result.ok) return result.error.message;

              if (input.isDefault) {
                // 创建时 id 由主进程生成，只能从返回值拿；编辑时用编辑前那个 id
                const targetId = editingId ?? result.data.id;
                const changed = await api().personas.setDefault(targetId);
                if (!changed.ok) return changed.error.message;
                // setDefault 返回的是"改完之后"的整份列表，直接写回 store
                useAppStore.getState().setPersonas(changed.data);
              } else {
                await refreshPersonas();
              }
              return null;
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
          />
        ) : view === 'usage' ? (
          <UsagePage providers={providers} />
        ) : view === 'apiKeys' ? (
          <ApiKeysPage
            providers={providers}
            busyId={testingProviderId}
            testResults={providerTestResults}
            onTest={testProvider}
            onSave={saveProvider}
            onDelete={requestDeleteProvider}
            onViewUsage={(provider) =>
              void selectProviderUsage(provider.id)
            }
          />
        ) : (
          <SettingsPage
            providers={providers}
            settings={settings}
            diagnostics={diagnostics}
            storageWarning={storageWarning}
            onUpdateSettings={(patch) => void updateSettings(patch)}
          />
        )}

        </div>
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
            onRestoreSummary={(id) => void restoreSummary(id)}
            onUpdateConversation={async (patch) => {
              if (!activeConversation) return false;
                const result = await api().conversations.update(activeConversation.id, patch);
                if (result.ok) useAppStore.getState().upsertConversation(result.data);
                else toast(result.error.message, 'error');
                return result.ok;
            }}
            onRestart={async () => {
              if (!activeConversation) return false;
                const result = await api().conversations.restart(activeConversation.id);
                if (!result.ok) {
                  toast(result.error.message, 'error');
                  return false;
                }
                await loadMessages(activeConversation.id);
                toast('会话已用开场白重开');
                return true;
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
                const text = chat.messages.map(m => `${m.role === 'user' ? '你' : activeCharacter?.name ?? '角色'}\n${m.content}`).join('\n\n');
                await navigator.clipboard.writeText(text);
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
          onSaveCharacter={saveCharacter}
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
          onGoApiKeys={() => {
            // 第 3 步缺 Provider：去的是 API Key 模块，不是设置页
            closeNewConversation();
            setView('apiKeys');
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={
            pendingDelete.kind === 'conversation'
              ? '删除对话？'
              : pendingDelete.kind === 'character'
                ? '删除角色卡？'
                : pendingDelete.kind === 'provider'
                  ? '删除 API Key？'
                  : '删除人设？'
          }
          paragraphs={pendingDelete.paragraphs}
          confirmLabel="删除"
          danger
          error={deleteError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  );

}
