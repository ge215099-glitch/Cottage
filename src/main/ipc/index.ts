/**
 * IPC handler 注册（技术方案 6.2 / 6.3）。
 *
 * 三条纪律，都能在本文件里一眼验证：
 *   1. **每个 handler 的入参都过 zod**（`validated` 包装）。
 *   2. **未登记的通道一律拒绝**：所有 handler 先登记进一个 `Map`，注册阶段再断言
 *      "map 的键集合 == `INVOKE` 的值集合"。少写一个 handler 会在启动时立刻炸，
 *      而不是等用户点到那个功能才发现（验收项 4 的后半句）。
 *   3. **错误统一成 NormalizedError**：handler 抛异常不会打穿到 renderer，
 *      而是变成 `{ ok: false, error }`，逼迫 UI 处理失败分支。
 */
import { dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ALL_INVOKE_CHANNELS, EVENT, INVOKE } from '@shared/ipc.js';
import type { Result } from '@shared/api.js';
import type { NormalizedError } from '@shared/types.js';
import { CharacterCardError } from '@core/character-card.js';
import { makeError } from '@core/providers/errors.js';
import type { AppContext } from '../context.js';
import { abortConversation, emitEvent } from '../context.js';
import { log } from '../log.js';
import { getStorageStatus } from '../secrets/index.js';
import { LATEST_VERSION } from '../db/migrations/index.js';

import * as providersDao from '../db/dao/providers.js';
import * as charactersDao from '../db/dao/characters.js';
import * as personasDao from '../db/dao/personas.js';
import * as conversationsDao from '../db/dao/conversations.js';
import * as messagesDao from '../db/dao/messages.js';
import * as summariesDao from '../db/dao/summaries.js';
import * as settingsDao from '../db/dao/settings.js';

import {
  characterExportFormatSchema,
  characterUpdateSchema,
  compressInputSchema,
  conversationPatchSchema,
  createConversationInputSchema,
  editMessageInputSchema,
  exportConversationSchema,
  importCharacterInputSchema,
  listCharactersInputSchema,
  personaInputSchema,
  providerInputSchema,
  sendMessageInputSchema,
  settingsPatchSchema,
  tokensPreviewInputSchema,
} from '@shared/schemas.js';

import { ContextError, buildTokenPreview } from '../services/assemble.js';
import { beginGeneration } from '../services/generate.js';
import { compressConversation, previewCompressionRange } from '../services/compress.js';
import { importCharacterFromFile } from '../services/character-import.js';
import {
  ExportError,
  conversationStats,
  exportConversationJson,
  exportConversationMarkdown,
  exportPlainConfig,
  prepareCharacterExport,
} from '../services/export.js';
import { ProviderTestError, fetchModelsFromProvider, testProvider } from '../services/provider-test.js';
import { encryptSecret } from '../secrets/index.js';
import { sanitizeFileName, withExportExtension } from '../services/file-name.js';

/** 诊断页要用到；由主进程入口注入，避免此处 import main/index 造成循环。 */
let appVersion = '0.1.0';
export function setAppVersion(version: string): void {
  appVersion = version;
}

/** 结构化错误 → 对外错误码。 */
function toNormalizedError(err: unknown): NormalizedError {
  if (err instanceof ContextError) {
    const map: Record<ContextError['code'], NormalizedError['code']> = {
      NOT_FOUND: 'NOT_FOUND',
      NO_PROVIDER: 'NO_PROVIDER',
      NO_KEY: 'NO_KEY',
      NO_CHARACTER: 'NOT_FOUND',
      CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
    };
    return makeError(map[err.code], err.message);
  }
  if (err instanceof ExportError) {
    // 导不出 PNG 卡不是"没找到东西"，而是"这个请求对这张卡不成立"——
    // 用 NOT_FOUND 会让 UI 提示"角色不存在"，跟用户的感受完全对不上。
    const code: NormalizedError['code'] =
      err.code === 'NO_AVATAR' || err.code === 'BAD_AVATAR'
        ? 'INVALID_REQUEST'
        : err.code === 'NEEDS_CONFIRMATION'
          ? 'INVALID_REQUEST'
          : 'NOT_FOUND';
    return makeError(code, err.message);
  }
  if (err instanceof ProviderTestError) return makeError('INVALID_REQUEST', err.message);
  if (err instanceof CharacterCardError) return makeError('VALIDATION_ERROR', err.message);
  if (err instanceof z.ZodError) {
    return makeError(
      'VALIDATION_ERROR',
      `入参校验失败：${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`,
    );
  }
  if (err instanceof Error) {
    // 带 code 的普通错误（DAO 层抛的 NOT_FOUND 之类）
    const code = (err as { code?: unknown }).code;
    if (code === 'NOT_FOUND') return makeError('NOT_FOUND', err.message);
    return makeError('UNKNOWN', err.message);
  }
  return makeError('UNKNOWN', '未知错误');
}

/** 抛出带 code 的错误，供 DAO 缺失分支使用。 */
function notFound(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = 'NOT_FOUND';
  return err;
}

/** 一个可注册的 handler：入参已由 zod 校验。 */
type Handler = (...args: never[]) => unknown;

/**
 * 把 zod schema 与处理函数合成一个 IPC handler。
 *
 * 入参约定：renderer 侧调用 `invoke(channel, a, b)` 时，主进程收到 `(event, a, b)`。
 * 单参数时直接把该参数交给 schema；多参数时必须用 `z.tuple`，形状对不上就报校验失败。
 */
function validated<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  handler: (parsed: z.infer<TSchema>) => unknown,
): (event: unknown, ...args: unknown[]) => Promise<Result<unknown>> {
  return async (_event, ...args) => {
    const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: makeError(
          'VALIDATION_ERROR',
          `入参校验失败：${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('；')}`,
        ),
      };
    }
    try {
      const data = await handler(parsed.data);
      return { ok: true, data };
    } catch (err) {
      const error = toNormalizedError(err);
      log.warn('IPC 调用失败', `${error.code}: ${error.message}`);
      return { ok: false, error };
    }
  };
}

/* ------------------------------ 复用的 schema ------------------------------ */

const idArg = z.string().min(1).max(128);
const idAndTitle = z.tuple([idArg, z.string().max(200)]);
const idAndBool = z.tuple([idArg, z.boolean()]);
const noArgs = z.void();

/** 收集全部 handler，最后一次性注册（顺便做"通道齐全"断言）。 */
function buildHandlers(ctx: AppContext): Map<string, Handler> {
  const db = ctx.db;
  const handlers = new Map<string, Handler>();

  /* ------------------------------ Provider ------------------------------ */

  handlers.set(
    INVOKE.providersList,
    validated(noArgs, () => providersDao.listProviders(db)),
  );

  handlers.set(
    INVOKE.providersGet,
    validated(idArg, (id) => providersDao.getProvider(db, id)),
  );

  handlers.set(
    INVOKE.providersCreate,
    validated(providerInputSchema, async (input) => {
      // 明文 Key 只在这一行内存在：加密后立刻不再引用原字符串
      const apiKeyEnc = input.apiKey ? await encryptSecret(input.apiKey) : null;
      return providersDao.createProvider(db, input, { apiKeyEnc, now: Date.now() });
    }),
  );

  handlers.set(
    INVOKE.providersUpdate,
    validated(z.tuple([idArg, providerInputSchema]), async ([id, input]) => {
      const apiKeyEnc = input.apiKey ? await encryptSecret(input.apiKey) : undefined;
      const updated = providersDao.updateProvider(db, id, input, {
        ...(apiKeyEnc === undefined ? {} : { apiKeyEnc }),
        ...(input.clearKey ? { clearKey: true } : {}),
        now: Date.now(),
      });
      if (!updated) throw notFound('Provider 不存在');
      return updated;
    }),
  );

  handlers.set(
    INVOKE.providersDelete,
    validated(idArg, (id) => providersDao.deleteProvider(db, id)),
  );

  handlers.set(
    INVOKE.providersTest,
    validated(idArg, (id) => testProvider(ctx, id)),
  );

  handlers.set(
    INVOKE.providersFetchModels,
    validated(idArg, async (id) => {
      const models = await fetchModelsFromProvider(ctx, id);
      const updated = providersDao.setProviderModels(db, id, models, Date.now());
      if (!updated) throw notFound('Provider 不存在');
      return updated;
    }),
  );

  /* ------------------------------ 角色卡 ------------------------------ */

  handlers.set(
    INVOKE.charactersList,
    validated(listCharactersInputSchema, (query) => charactersDao.listCharacters(db, query ?? {})),
  );

  handlers.set(
    INVOKE.charactersGet,
    validated(idArg, (id) => charactersDao.getCharacter(db, id)),
  );

  handlers.set(
    INVOKE.charactersImport,
    validated(importCharacterInputSchema, (payload) => {
      const result = charactersDao.importCharacter(db, payload.card, Date.now());
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [], reason: 'refreshed' });
      return result;
    }),
  );

  handlers.set(
    INVOKE.charactersImportFile,
    validated(noArgs, async () => {
      const picked = await dialog.showOpenDialog({
        title: '导入角色卡',
        properties: ['openFile'],
        filters: [
          { name: '角色卡（PNG / JSON）', extensions: ['png', 'json'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (picked.canceled || !picked.filePaths.length) return null;

      // PNG 卡走 service：解析出 JSON 入库，并把图片存成头像。
      // 解析失败时异常会在入库之前抛出，所以不会留下半截记录。
      return importCharacterFromFile(db, ctx.userDataDir, picked.filePaths[0]!, Date.now());
    }),
  );

  handlers.set(
    INVOKE.charactersUpdate,
    validated(z.tuple([idArg, characterUpdateSchema]), ([id, patch]) => {
      const updated = charactersDao.updateCharacter(db, id, patch, Date.now());
      if (!updated) throw notFound('角色不存在');
      return updated;
    }),
  );

  handlers.set(
    INVOKE.charactersDelete,
    validated(idArg, (id) => charactersDao.deleteCharacter(db, id)),
  );

  handlers.set(
    INVOKE.charactersExport,
    validated(z.tuple([idArg, characterExportFormatSchema]), async ([id, format]) => {
      /*
       * 先把内容生成好，再弹保存对话框。
       *
       * 顺序反过来的话，"这个角色没有卡面图"会变成"用户先挑一遍保存位置、
       * 然后才被告知导不出来"。内容生成是纯读操作，先做没有副作用。
       */
      const prepared = await prepareCharacterExport(ctx, id, format);
      const isPng = prepared.bytes !== null;
      const card = prepared.card;

      const picked = await dialog.showSaveDialog({
        title: isPng ? '导出 PNG 角色卡' : '导出角色卡 JSON',
        defaultPath: `${sanitizeFileName(String(card['name'] ?? 'character'))}.${isPng ? 'png' : 'json'}`,
        filters: isPng
          ? [{ name: 'PNG 角色卡（卡面图 + 数据）', extensions: ['png'] }]
          : [{ name: '角色卡 JSON', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePath) return { format, path: null, card };

      // 用户可能手输了个没有扩展名的文件名；补上，否则双击打不开
      const target = withExportExtension(picked.filePath, isPng ? 'png' : 'json');
      if (prepared.bytes) await writeFile(target, prepared.bytes);
      else await writeFile(target, JSON.stringify(card, null, 2), 'utf8');

      return { format, path: target, card };
    }),
  );

  handlers.set(
    INVOKE.charactersTags,
    validated(noArgs, () => charactersDao.listCharacterTags(db)),
  );

  /* ------------------------------ 人设 ------------------------------ */

  handlers.set(
    INVOKE.personasList,
    validated(noArgs, () => personasDao.listPersonas(db)),
  );

  handlers.set(
    INVOKE.personasCreate,
    validated(personaInputSchema, (input) => personasDao.createPersona(db, input, Date.now())),
  );

  handlers.set(
    INVOKE.personasUpdate,
    validated(z.tuple([idArg, personaInputSchema.partial()]), ([id, patch]) => {
      const updated = personasDao.updatePersona(db, id, patch, Date.now());
      if (!updated) throw notFound('人设不存在');
      return updated;
    }),
  );

  handlers.set(
    INVOKE.personasDelete,
    validated(idArg, (id) => personasDao.deletePersona(db, id)),
  );

  handlers.set(
    INVOKE.personasSetDefault,
    validated(idArg, (id) => {
      personasDao.setDefaultPersona(db, id);
      return personasDao.listPersonas(db);
    }),
  );

  /* ------------------------------ 会话 ------------------------------ */

  handlers.set(
    INVOKE.conversationsList,
    validated(noArgs, () => conversationsDao.listConversations(db)),
  );

  handlers.set(
    INVOKE.conversationsGet,
    validated(idArg, (id) => conversationsDao.getConversation(db, id)),
  );

  handlers.set(
    INVOKE.conversationsCreate,
    validated(createConversationInputSchema, (input) => {
      const character = charactersDao.getCharacter(db, input.characterId);
      if (!character) throw notFound('角色不存在');

      const now = Date.now();
      const conversation = conversationsDao.createConversation(
        db,
        {
          // 默认用角色名命名；重名则 " 2"、" 3"……（用户显式传了标题就尊重它）
          title: input.title?.trim() || conversationsDao.nextConversationTitle(db, character.name),
          characterId: input.characterId,
          personaId: input.personaId ?? null,
          providerId: input.providerId ?? null,
          model: input.model ?? '',
        },
        now,
      );

      // 开场白：用角色卡 first_mes 写入首条助手消息
      if (input.useFirstMessage !== false && character.firstMes.trim()) {
        messagesDao.insertMessage(
          db,
          { conversationId: conversation.id, role: 'assistant', content: character.firstMes },
          now,
        );
      }

      emitEvent(ctx, EVENT.conversationsChanged, { ids: [conversation.id], reason: 'created' });
      return conversationsDao.getConversation(db, conversation.id)!;
    }),
  );

  handlers.set(
    INVOKE.conversationsRename,
    validated(idAndTitle, ([id, title]) => {
      const updated = conversationsDao.renameConversation(db, id, title);
      if (!updated) throw notFound('会话不存在');
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [id], reason: 'updated' });
      return updated;
    }),
  );

  handlers.set(
    INVOKE.conversationsSetPinned,
    validated(idAndBool, ([id, pinned]) => {
      const updated = conversationsDao.setPinned(db, id, pinned, Date.now());
      if (!updated) throw notFound('会话不存在');
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [id], reason: 'updated' });
      return updated;
    }),
  );

  handlers.set(
    INVOKE.conversationsUpdate,
    validated(z.tuple([idArg, conversationPatchSchema]), ([id, patch]) => {
      const updated = conversationsDao.updateConversation(db, id, patch, Date.now());
      if (!updated) throw notFound('会话不存在');
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [id], reason: 'updated' });
      return updated;
    }),
  );

  handlers.set(
    INVOKE.conversationsStats,
    validated(idArg, (id) => conversationStats(ctx, id)),
  );

  handlers.set(
    INVOKE.conversationsDelete,
    validated(idArg, (id) => {
      // 生成中的会话要先中断，避免残留写入（UI 文档 4.7 / 验收项 13）
      abortConversation(ctx, id);
      const result = conversationsDao.deleteConversation(db, id);
      if (!result.ok) throw notFound('会话不存在');
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [id], reason: 'deleted' });
      return result.deleted;
    }),
  );

  handlers.set(
    INVOKE.conversationsRestart,
    validated(z.tuple([idArg, z.string().max(200_000).nullable()]), ([id, greeting]) => {
      abortConversation(ctx, id);
      const conversation = conversationsDao.getConversation(db, id);
      if (!conversation) throw notFound('会话不存在');

      const now = Date.now();
      messagesDao.clearConversation(db, id, now);

      const character = charactersDao.getCharacter(db, conversation.characterId);
      const text = (greeting ?? character?.firstMes ?? '').trim();
      if (text) {
        messagesDao.insertMessage(db, { conversationId: id, role: 'assistant', content: text }, now);
      }

      emitEvent(ctx, EVENT.messagesChanged, { ids: [], reason: 'refreshed' });
      emitEvent(ctx, EVENT.conversationsChanged, { ids: [id], reason: 'updated' });
      return conversationsDao.getConversation(db, id)!;
    }),
  );

  /* ------------------------------ 消息与生成 ------------------------------ */

  handlers.set(
    INVOKE.messagesList,
    validated(idArg, (conversationId) => messagesDao.listMessages(db, conversationId)),
  );

  handlers.set(
    INVOKE.messagesSend,
    validated(sendMessageInputSchema, (input) =>
      beginGeneration(ctx, {
        conversationId: input.conversationId,
        userText: input.text,
        providerId: input.providerId ?? null,
        ...(input.model === undefined ? {} : { model: input.model }),
      }),
    ),
  );

  handlers.set(
    INVOKE.messagesAbort,
    validated(idArg, (conversationId) => abortConversation(ctx, conversationId)),
  );

  handlers.set(
    INVOKE.messagesEdit,
    validated(editMessageInputSchema, (input) => {
      const result = messagesDao.editMessageWithOptionalTruncate(
        db,
        input.messageId,
        input.content,
        input.truncate,
        Date.now(),
      );
      emitEvent(ctx, EVENT.messagesChanged, { ids: [input.messageId], reason: 'updated' });
      return {
        truncatedCount: result.truncatedCount,
        invalidatedSummaries: result.invalidatedSummaries,
      };
    }),
  );

  handlers.set(
    INVOKE.messagesDelete,
    validated(idArg, (messageId) => {
      const result = messagesDao.deleteMessageWithCascade(db, messageId, Date.now());
      emitEvent(ctx, EVENT.messagesChanged, { ids: [messageId], reason: 'deleted' });
      return result;
    }),
  );

  handlers.set(
    INVOKE.messagesDeleteFrom,
    validated(z.tuple([idArg, z.number().int().min(1)]), ([conversationId, sortOrder]) => {
      const result = messagesDao.deleteMessagesFrom(db, conversationId, sortOrder, Date.now());
      emitEvent(ctx, EVENT.messagesChanged, { ids: [conversationId], reason: 'refreshed' });
      return result;
    }),
  );

  handlers.set(
    INVOKE.messagesRegenerate,
    validated(idArg, async (messageId) => {
      const message = messagesDao.getMessage(db, messageId);
      if (!message) throw notFound('消息不存在');
      if (message.role !== 'assistant') throw notFound('只能重新生成助手的消息');

      // 重新生成的输入 = 该助手消息之前最近的一条用户消息
      const before = messagesDao
        .listMessages(db, message.conversationId)
        .filter((m) => m.sortOrder < message.sortOrder && m.role === 'user');
      const lastUser = before[before.length - 1];

      const result = await beginGeneration(ctx, {
        conversationId: message.conversationId,
        userText: lastUser?.content ?? '',
        existingMessageId: messageId,
      });
      return { streamId: result.streamId };
    }),
  );

  /* ------------------------------ 摘要与压缩 ------------------------------ */

  handlers.set(
    INVOKE.summariesList,
    validated(idArg, (conversationId) => summariesDao.listSummaries(db, conversationId)),
  );

  handlers.set(
    INVOKE.summariesCompress,
    validated(compressInputSchema, (input) =>
      compressConversation(ctx, {
        conversationId: input.conversationId,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.model === undefined ? {} : { model: input.model }),
      }),
    ),
  );

  handlers.set(
    INVOKE.summariesRestore,
    validated(idArg, (summaryId) => {
      const result = summariesDao.restoreSummary(db, summaryId, Date.now());
      if (!result.restored) throw notFound('摘要不存在');
      emitEvent(ctx, EVENT.messagesChanged, { ids: [], reason: 'refreshed' });
      return { from: result.from, to: result.to, unarchivedCount: result.unarchivedCount };
    }),
  );

  handlers.set(
    INVOKE.summariesPreviewRange,
    validated(z.tuple([idArg, z.number().int().min(1).max(100)]), ([conversationId, count]) =>
      previewCompressionRange(ctx, conversationId, count),
    ),
  );

  /* ------------------------------ Token 预览 ------------------------------ */

  handlers.set(
    INVOKE.tokensPreview,
    validated(tokensPreviewInputSchema, (input) =>
      buildTokenPreview(
        db,
        input.conversationId,
        input.draft ?? '',
        Date.now(),
        input.providerId === undefined && input.model === undefined
          ? undefined
          : {
              ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
              ...(input.model === undefined ? {} : { model: input.model }),
            },
      ),
    ),
  );

  /* ------------------------------ 设置与诊断 ------------------------------ */

  handlers.set(
    INVOKE.settingsGet,
    validated(noArgs, () => settingsDao.readSettings(db)),
  );

  handlers.set(
    INVOKE.settingsUpdate,
    validated(settingsPatchSchema, (patch) => settingsDao.writeSettings(db, patch, Date.now())),
  );

  handlers.set(
    INVOKE.appDiagnostics,
    validated(noArgs, () => {
      const storage = getStorageStatus();
      return {
        dbPath: ctx.dbPath,
        userVersion: db.getUserVersion(),
        latestVersion: LATEST_VERSION,
        storageBackend: storage.backend,
        storageWarning: storage.warning,
        platform: process.platform,
        appVersion,
        electronVersion: process.versions.electron ?? 'unknown',
      };
    }),
  );

  /* ------------------------------ 导出 ------------------------------ */

  handlers.set(
    INVOKE.exportConversationMarkdown,
    validated(exportConversationSchema, async ({ conversationId }) => {
      const content = exportConversationMarkdown(ctx, conversationId);
      const path = await saveExport(conversationId, content, 'md');
      return { path, content };
    }),
  );

  handlers.set(
    INVOKE.exportConversationJson,
    validated(exportConversationSchema, async ({ conversationId }) => {
      const content = exportConversationJson(ctx, conversationId);
      const path = await saveExport(conversationId, content, 'json');
      return { path, content };
    }),
  );

  handlers.set(
    INVOKE.exportPlainConfig,
    validated(z.boolean(), async (confirmed) => {
      const content = await exportPlainConfig(ctx, confirmed);
      const picked = await dialog.showSaveDialog({
        title: '导出明文配置包',
        defaultPath: 'cottage-明文配置.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      let path: string | null = null;
      if (!picked.canceled && picked.filePath) {
        await writeFile(picked.filePath, content, 'utf8');
        path = picked.filePath;
      }
      return { path, content };
    }),
  );

  return handlers;
}

/** 让用户选保存位置并写入；取消时只返回内容。 */
async function saveExport(
  conversationId: string,
  content: string,
  extension: 'md' | 'json',
): Promise<string | null> {
  const picked = await dialog.showSaveDialog({
    title: '导出会话',
    defaultPath: `${sanitizeFileName(conversationId)}.${extension}`,
    filters:
      extension === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return null;
  await writeFile(picked.filePath, content, 'utf8');
  return picked.filePath;
}

/**
 * 注册全部通道。
 *
 * 最后那道断言是刻意的：**少登记一个通道就在启动时报错**，
 * 而不是等用户点到那个按钮才发现"方法不存在"。
 */
export function registerIpc(ctx: AppContext): void {
  const handlers = buildHandlers(ctx);

  const missing = [...ALL_INVOKE_CHANNELS].filter((channel) => !handlers.has(channel));
  if (missing.length) {
    throw new Error(`以下 IPC 通道已登记在 INVOKE 里但没有 handler：${missing.join('、')}`);
  }
  const extra = [...handlers.keys()].filter((channel) => !ALL_INVOKE_CHANNELS.has(channel));
  if (extra.length) {
    throw new Error(`以下 handler 使用了未登记的通道名：${extra.join('、')}`);
  }

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
  }
}

/** 供测试与诊断：不触达 electron 的通道清单断言。 */
export function assertHandlerCoverage(channels: Iterable<string>): string[] {
  const present = new Set(channels);
  return [...ALL_INVOKE_CHANNELS].filter((c) => !present.has(c));
}
