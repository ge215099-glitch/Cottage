/**
 * 生成服务：一次「发消息」的完整编排（技术方案 6.1 的时序）。
 *
 * 步骤与文档一一对应：
 *   1. 读会话 / 角色 / persona
 *   2. core：组装 PromptSpec
 *   3. core：计数 + 超限判断
 *   4. 必要时先压缩（事务）
 *   5. safeStorage 解密 Key
 *   6. 适配器 → 请求体
 *   7. fetch(SSE) + 节流落库 + 节流推送
 *
 * 三条不可妥协的规则：
 *   - **Key 明文只活在本函数的调用栈里**，不写进任何长期变量、不落日志。
 *   - **节流落库与节流推送**：逐帧写盘与逐帧 IPC 都会把主进程拖垮
 *     （技术方案 7.6 / 7.7），所以各按 ~500ms / ~24ms 合批，结束时强制 flush。
 *   - **任何退出路径都要给消息行收尾**（status + metadata），
 *     否则会留下永远「生成中」的行（验收项 10 的反面）。
 */
import { buildRequest } from '@core/providers/request.js';
import { countPromptSpec, exceedsLimit } from '@core/tokens/index.js';
import { emptyCompletionError, makeError } from '@core/providers/errors.js';
import { EVENT } from '@shared/ipc.js';
import type { Message, MessageMetadata, MessageStatus, NormalizedError } from '@shared/types.js';
import { log } from '../log.js';
import { decryptSecret, encryptSecret } from '../secrets/index.js';
import { emitEvent, type AppContext } from '../context.js';
import {
  ContextError,
  FALLBACK_CONTEXT_LIMIT,
  assembleForConversation,
  resolveProvider,
} from './assemble.js';
import { compressConversation } from './compress.js';
import { streamChat } from '../providers/runtime.js';
import {
  appendMessageContent,
  deleteMessage,
  finishMessage,
  getMessage,
  insertMessage,
} from '../db/dao/messages.js';
import {
  getConversation,
  renameConversation,
  touchConversation,
} from '../db/dao/conversations.js';
import { getProviderSecretForMain, updateProvider } from '../db/dao/providers.js';
import { readSettings } from '../db/dao/settings.js';
import type { PromptSpec } from '@core/types.js';

/** 流式落库间隔：崩溃时最多丢 500ms 的内容（技术方案 7.6）。 */
export const PERSIST_THROTTLE_MS = 500;

/** IPC 推送合批间隔：16–32ms 之间取 24ms（技术方案 7.7）。 */
export const EMIT_THROTTLE_MS = 24;

export interface BeginGenerationInput {
  conversationId: string;
  userText: string;
  /** 临时覆盖 provider / 模型（会话级可覆盖聊天 Key） */
  providerId?: string | null;
  model?: string;
  /** 已存在的助手消息 id（重新生成时复用同一行，就地替换） */
  existingMessageId?: string;
}

export interface BeginGenerationResult {
  streamId: string;
  userMessage: Message | null;
  assistantMessage: Message;
}

let streamSeq = 0;
function newStreamId(): string {
  streamSeq = (streamSeq + 1) % 1_000_000;
  return `st_${Date.now().toString(36)}_${streamSeq.toString(36)}`;
}

/**
 * 启动一次生成。**返回后不等待生成完成**——流式过程通过事件推送。
 *
 * @throws ContextError 当 provider / 角色等前置条件不满足时（UI 据此显示引导）
 */
export async function beginGeneration(
  ctx: AppContext,
  input: BeginGenerationInput,
): Promise<BeginGenerationResult> {
  const now = Date.now();
  const settings = readSettings(ctx.db);
  const { conversation, spec } = assembleForConversation(
    ctx.db,
    input.conversationId,
    input.userText,
    now,
  );

  const { provider, model } = resolveProvider(ctx.db, conversation, {
    providerId: input.providerId,
    model: input.model,
  });

  // ---- 步骤 3：计数 + 超限判断 ----
  let breakdown = countPromptSpec(spec, {
    providerType: provider.type,
    model,
    limit: FALLBACK_CONTEXT_LIMIT,
  });

  // ---- 步骤 4：必要时先压缩（全成或全不成，见 compress 服务） ----
  if (
    settings.autoCompressEnabled &&
    (exceedsLimit(breakdown) || breakdown.ratio >= settings.autoCompressThreshold)
  ) {
    try {
      await compressConversation(ctx, { conversationId: input.conversationId, auto: true });
      // 压缩后重新组装并重新计数
      const reassembled = assembleForConversation(
        ctx.db,
        input.conversationId,
        input.userText,
        Date.now(),
      );
      breakdown = countPromptSpec(reassembled.spec, {
        providerType: provider.type,
        model,
        limit: FALLBACK_CONTEXT_LIMIT,
      });
      if (exceedsLimit(breakdown)) {
        // 产品设计文档 3.3：仍超限则**明确报错**，不做静默截断
        throw new ContextError(
          'CONTEXT_OVERFLOW',
          '上下文仍超出模型上限，请手动压缩或更换模型（不会自动截断内容）',
        );
      }
    } catch (err) {
      if (err instanceof ContextError) throw err;
      // 自动压缩失败不应阻断这轮对话：记日志后继续，让上游按超长报错
      log.warn('自动压缩失败，继续本次生成', err);
    }
  }

  // ---- 写入用户消息与助手消息行 ----
  const userMessage = input.existingMessageId
    ? null
    : insertMessage(
        ctx.db,
        { conversationId: input.conversationId, role: 'user', content: input.userText },
        now,
      );

  const assistantMessage = input.existingMessageId
    ? resetAssistantForRegenerate(ctx, input.existingMessageId, provider.id, model, now)
    : insertMessage(
        ctx.db,
        {
          conversationId: input.conversationId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          metadata: { providerId: provider.id, model, tokensExact: breakdown.total.exact },
        },
        now,
      );

  // 首条消息派生标题（不刷新 updated_at，避免「刚发一条就跳位」）
  if (userMessage && conversation.title === '新对话') {
    const derived = input.userText.trim().slice(0, 18) || '新对话';
    try {
      renameConversation(ctx.db, input.conversationId, derived);
    } catch {
      // 标题派生失败不影响对话
    }
  }

  const streamId = newStreamId();
  const controller = new AbortController();

  // 同一会话重复发送时先中断旧流，避免两条回答交错写同一条消息
  const existing = ctx.streams.get(input.conversationId);
  if (existing) existing.controller.abort();
  ctx.streams.set(input.conversationId, {
    streamId,
    conversationId: input.conversationId,
    messageId: assistantMessage.id,
    controller,
  });

  emitEvent(ctx, EVENT.messagesChanged, { ids: [assistantMessage.id], reason: 'created' });

  // ---- 步骤 5–7：解密 Key → 构造请求 → 流式执行 ----
  // 不 await：让 IPC 立刻返回，流式内容靠事件推送。
  void runStream(ctx, {
    streamId,
    conversationId: input.conversationId,
    assistantMessageId: assistantMessage.id,
    providerId: provider.id,
    providerType: provider.type,
    baseUrl: provider.baseUrl,
    model,
    spec,
    controller,
    tokensExact: breakdown.total.exact,
    promptTokensEstimate: breakdown.total.tokens,
  });

  return { streamId, userMessage, assistantMessage };
}

interface RunStreamInput {
  streamId: string;
  conversationId: string;
  assistantMessageId: string;
  providerId: string;
  providerType: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  spec: PromptSpec;
  controller: AbortController;
  tokensExact: boolean;
  promptTokensEstimate: number;
}

/** 重新生成：把已有助手消息行重置为 streaming 并清空内容（就地替换，MVP 不做多候选）。 */
function resetAssistantForRegenerate(
  ctx: AppContext,
  messageId: string,
  providerId: string,
  model: string,
  now: number,
): Message {
  const existing = getMessage(ctx.db, messageId);
  if (!existing) throw new ContextError('NOT_FOUND', '要重新生成的消息不存在');
  if (existing.role !== 'assistant') {
    throw new ContextError('NOT_FOUND', '只能重新生成助手的消息');
  }

  const metadata: MessageMetadata = { providerId, model };
  ctx.db
    .prepare('UPDATE messages SET content = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
    .run('', 'streaming', JSON.stringify(metadata), now, messageId);

  return { ...existing, content: '', status: 'streaming', metadata, updatedAt: now };
}

async function runStream(ctx: AppContext, input: RunStreamInput): Promise<void> {
  const settings = readSettings(ctx.db);
  const conversation = getConversation(ctx.db, input.conversationId);
  if (!conversation) {
    // 会话在生成途中被删掉了：清理并退出
    ctx.streams.delete(input.conversationId);
    return;
  }

  let fullText = '';
  let lastPersistAt = 0;
  let lastEmitAt = 0;
  let pendingDelta = '';

  /**
   * 本次流是否仍是该会话的"当前流"。
   *
   * 这不是防御性代码，而是一个真实竞态的修复：同一会话再次发送时，
   * 新流会先 abort 旧流（见 `beginGeneration`）。旧流的 `streamChat` 收到中断信号后
   * 会**继续走收尾流程**，而那时新流可能已经写入了自己的内容——
   * 若旧流不做判断就把自己的残留文本与 `interrupted` 状态写回去，
   * 新一次生成的结果就被覆盖掉了（表现为"重新生成后内容是空的/还是旧的"）。
   *
   * 判据：`ctx.streams` 里登记的 streamId 是否还是自己。
   * 被取代后本流的一切写操作都必须放弃，交给新流负责那一行消息。
   */
  const isCurrent = (): boolean => ctx.streams.get(input.conversationId)?.streamId === input.streamId;

  const persist = (force: boolean): void => {
    if (!isCurrent()) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < PERSIST_THROTTLE_MS) return;
    lastPersistAt = now;
    appendMessageContent(ctx.db, input.assistantMessageId, fullText, now);
  };

  const emit = (force: boolean): void => {
    if (!pendingDelta || !isCurrent()) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < EMIT_THROTTLE_MS) return;
    lastEmitAt = now;
    emitEvent(ctx, EVENT.streamChunk, {
      streamId: input.streamId,
      conversationId: input.conversationId,
      messageId: input.assistantMessageId,
      delta: pendingDelta,
    });
    pendingDelta = '';
  };

  const cleanup = (): void => {
    const active = ctx.streams.get(input.conversationId);
    if (active && active.streamId === input.streamId) ctx.streams.delete(input.conversationId);
  };

  try {
    // 现取现解密：明文只在这个局部作用域里存在
    const secretRecord = getProviderSecretForMain(ctx.db, input.providerId);
    if (!secretRecord?.apiKeyEnc) {
      throw new ContextError('NO_KEY', 'Provider 的 API Key 已失效，请重新填写');
    }
    const { plain: apiKey, shouldReEncrypt } = await decryptSecret(secretRecord.apiKeyEnc);

    // 旧格式密文顺手升级（等价于原本 shouldReEncrypt 想要的"密钥轮换后回写"）
    if (shouldReEncrypt) {
      try {
        const reEncrypted = await encryptSecret(apiKey);
        updateProvider(
          ctx.db,
          input.providerId,
          {
            name: secretRecord.name,
            type: secretRecord.type,
            baseUrl: secretRecord.baseUrl,
            models: secretRecord.models,
            defaultModel: secretRecord.defaultModel,
            compressionModel: secretRecord.compressionModel,
            enabled: secretRecord.enabled,
          },
          { apiKeyEnc: reEncrypted, now: Date.now() },
        );
      } catch (err) {
        log.warn('密钥格式回写失败（不影响本次生成）', err);
      }
    }

    const plan = buildRequest(input.spec, {
      providerType: input.providerType,
      baseUrl: input.baseUrl,
      apiKey,
      model: input.model,
      temperature: conversation.params.temperature,
      topP: conversation.params.topP,
      maxTokens: conversation.params.maxTokens,
    });

    const outcome = await streamChat(
      plan,
      {
        onDelta: (delta) => {
          fullText += delta;
          pendingDelta += delta;
          persist(false);
          emit(false);
        },
      },
      {
        timeoutMs: settings.requestTimeoutMs,
        signal: input.controller.signal,
        providerType: input.providerType,
      },
    );

    // 收尾：强制落库 + 强制推送，保证最后一段不丢。
    //
    // 被新流取代时走另一条路：**删掉自己这一行**，而不是留着不管。
    // 理由：新流是"重新问了一遍"，被取代的那半截回答没有保留价值；
    // 而如果什么都不做，这一行会永远停在 `streaming`——那正是验收项 10
    // 明令禁止的"残留生成中"状态。
    if (!isCurrent()) {
      deleteMessage(ctx.db, input.assistantMessageId);
      return;
    }
    persist(true);
    emit(true);

    /*
     * 「上游正常收流但一个字正文都没有」必须按失败处理。
     *
     * 实测过一次真事故（deepseek-flash + 会话上限 1024）：思考型模型的思考 token
     * 与正文共用输出额度，思考吃满 1024 之后 content 是空的、finish_reason=length，
     * 而上游是以 200 正常收流的。当时这里把 status 直接写成 done，结果是一条空白气泡、
     * 没有报错、日志里一个字都没有——用户看到的就是"发了消息没有返回"。
     * 判据与文案在 core 的 emptyCompletionError() 里（纯函数，可单测）。
     */
    const emptyCompletion =
      outcome.status === 'done' && outcome.text.trim() === ''
        ? emptyCompletionError({
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            contentChars: outcome.text.length,
            reasoningChars: outcome.reasoningChars,
            completionTokens: outcome.completionTokens,
            reasoningTokens: outcome.reasoningTokens,
          })
        : undefined;

    const status: MessageStatus = outcome.status === 'error' || emptyCompletion ? 'error' : outcome.status;
    const metadata: MessageMetadata = {
      providerId: input.providerId,
      model: input.model,
      promptTokens: outcome.promptTokens || input.promptTokensEstimate,
      completionTokens: outcome.completionTokens,
      elapsedMs: outcome.elapsedMs,
      tokensExact: input.tokensExact,
    };
    if (outcome.ttftMs !== null) metadata.ttftMs = outcome.ttftMs;
    if (outcome.reasoningTokens > 0) metadata.reasoningTokens = outcome.reasoningTokens;
    if (outcome.stopReason !== undefined) metadata.stopReason = outcome.stopReason;
    if (outcome.status === 'interrupted') metadata.interrupted = true;
    const finalError = outcome.error ?? emptyCompletion;
    if (finalError) metadata.error = finalError;

    /*
     * 每次生成的结局都要留下可查的痕迹（含被当成失败的"空正文"）。
     *
     * 这条日志是"黑框没了"之后的主要诊断入口：只写 UI 不写日志的代价是——
     * 出问题时 `logs/dev.log` 里只有启动那几行，"为什么没回答"完全查不到。
     * 载荷里只有计数与结束原因，没有正文内容，也没有 Key。
     */
    const outcomeFacts = {
      status,
      model: input.model,
      stopReason: outcome.stopReason ?? null,
      contentChars: outcome.text.length,
      reasoningChars: outcome.reasoningChars,
      completionTokens: outcome.completionTokens,
      reasoningTokens: outcome.reasoningTokens,
      elapsedMs: outcome.elapsedMs,
    };
    if (status === 'error') {
      log.error('生成失败', finalError?.message ?? '未知原因');
    } else if (status === 'interrupted') {
      log.info('生成被中断（保留已收到内容）', outcomeFacts);
    } else {
      log.info('生成完成', outcomeFacts);
    }
    if (emptyCompletion) log.warn('上游没有返回正文，按失败处理', outcomeFacts);

    finishMessage(ctx.db, input.assistantMessageId, status, metadata, Date.now());
    touchConversation(ctx.db, input.conversationId, Date.now());

    emitEvent(ctx, EVENT.streamEnd, {
      streamId: input.streamId,
      conversationId: input.conversationId,
      messageId: input.assistantMessageId,
      status,
      metadata,
      ...(finalError ? { error: finalError } : {}),
    });
    notifyChanged(ctx, input);
  } catch (err) {
    // 被新流取代时不写错误状态，也不留残余：直接把自己这一行删掉
    if (!isCurrent()) {
      deleteMessage(ctx.db, input.assistantMessageId);
      return;
    }

    const error: NormalizedError =
      err instanceof ContextError
        ? makeError(
            err.code === 'NO_KEY'
              ? 'NO_KEY'
              : err.code === 'NO_PROVIDER'
                ? 'NO_PROVIDER'
                : err.code === 'CONTEXT_OVERFLOW'
                  ? 'CONTEXT_OVERFLOW'
                  : 'UNKNOWN',
            err.message,
          )
        : makeError('UNKNOWN', err instanceof Error ? err.message : '生成过程中出现未知错误');

    // 出错也必须把消息行收尾，否则会残留「生成中」
    try {
      persist(true);
      finishMessage(
        ctx.db,
        input.assistantMessageId,
        'error',
        { providerId: input.providerId, model: input.model, error, tokensExact: input.tokensExact },
        Date.now(),
      );
      touchConversation(ctx.db, input.conversationId, Date.now());
    } catch (innerErr) {
      log.error('收尾失败，消息可能残留生成中状态', innerErr);
    }

    log.error('生成失败', error.message);
    emitEvent(ctx, EVENT.streamEnd, {
      streamId: input.streamId,
      conversationId: input.conversationId,
      messageId: input.assistantMessageId,
      status: 'error',
      metadata: { providerId: input.providerId, model: input.model, error },
      error,
    });
    notifyChanged(ctx, input);
  } finally {
    cleanup();
  }
}

function notifyChanged(ctx: AppContext, input: RunStreamInput): void {
  emitEvent(ctx, EVENT.messagesChanged, { ids: [input.assistantMessageId], reason: 'updated' });
  emitEvent(ctx, EVENT.conversationsChanged, { ids: [input.conversationId], reason: 'updated' });
}
