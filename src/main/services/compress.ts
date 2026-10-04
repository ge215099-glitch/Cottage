/**
 * 压缩服务（产品设计文档 3.4，技术方案 5.1 的"三处必须事务之一"）。
 *
 * 算法固定为**单层**，避免嵌套歧义：
 *   1. 取一段**连续的、未被归档的**最老消息区间 `[from, to]`
 *   2. 用压缩 Key 调模型，按结构化模板生成摘要
 *   3. 写入 `summaries` 一行，记录 covers_from / covers_to / token_count / level=1 / provider / model
 *   4. 该区间消息标记 `archived=1`
 *
 * 第 3、4 步在**同一事务**内（`writeSummaryAtomic`），所以：
 *   - 压缩失败或中断 → 不写摘要、不改归档标记，保持原子性；
 *   - 不会出现"摘要写进去了但原文还留在历史里"这种重复计费的状态。
 *
 * 摘要**不可再被压缩**（不产生 level=2）。`level` 字段保留仅为将来演进。
 */
import { buildRequest } from '@core/providers/request.js';
import { buildSummaryPrompt, buildTranscript } from '@core/summary/index.js';
import { countText } from '@core/tokens/index.js';
import { makeError } from '@core/providers/errors.js';
import { EVENT } from '@shared/ipc.js';
import type { CompressResult, NormalizedError } from '@shared/types.js';
import { log } from '../log.js';
import { decryptSecret } from '../secrets/index.js';
import { emitEvent, type AppContext } from '../context.js';
import { ContextError, resolveCompressionProvider, toCharacterCard } from './assemble.js';
import { streamChat } from '../providers/runtime.js';
import { getCharacter } from '../db/dao/characters.js';
import { getConversation } from '../db/dao/conversations.js';
import { getProviderSecretForMain } from '../db/dao/providers.js';
import { readSettings } from '../db/dao/settings.js';
import {
  listSummaries,
  pickCompressionCandidates,
  writeSummaryAtomic,
} from '../db/dao/summaries.js';
import { listMessages } from '../db/dao/messages.js';
import { getDefaultPersona } from '../db/dao/personas.js';

/** 一次压缩最多处理多少条：太大则单次摘要质量下降，太小则效率低。 */
export const DEFAULT_COMPRESS_BATCH = 8;

/** 低于这个条数不值得压缩（摘要本身也要花 token）。 */
export const MIN_COMPRESS_BATCH = 4;

export interface CompressInput {
  conversationId: string;
  /** 不传则由服务自己挑最老的一段 */
  from?: number;
  to?: number;
  /** 手动压缩时可临时指定 Key（产品设计文档 3.1） */
  providerId?: string | null;
  model?: string;
  /** 自动触发（阈值）时为 true；手动为 false。只影响事件文案与批次选择。 */
  auto?: boolean;
}

/**
 * 执行一次压缩。
 *
 * @throws ContextError 前置条件不满足（无 provider / 无 Key / 没有可压缩内容）
 */
export async function compressConversation(
  ctx: AppContext,
  input: CompressInput,
): Promise<CompressResult> {
  const conversation = getConversation(ctx.db, input.conversationId);
  if (!conversation) throw new ContextError('NOT_FOUND', '会话不存在');

  const settings = readSettings(ctx.db);
  const batch = input.auto ? DEFAULT_COMPRESS_BATCH : DEFAULT_COMPRESS_BATCH;
  const candidates = pickCompressionCandidates(ctx.db, input.conversationId, batch);

  if (candidates.ids.length < MIN_COMPRESS_BATCH) {
    throw new ContextError(
      'NOT_FOUND',
      `未归档的历史不足 ${MIN_COMPRESS_BATCH} 条，无需压缩`,
    );
  }

  const { provider, model } = resolveCompressionProvider(ctx.db, conversation, {
    providerId: input.providerId,
    model: input.model,
  });

  // 压缩前的占用（用于 UI 播报"1200 → 180 tokens"）
  const existingSummaries = listSummaries(ctx.db, input.conversationId);
  const tokensBefore =
    existingSummaries.reduce((sum, s) => sum + s.tokenCount, 0) +
    listMessages(ctx.db, input.conversationId)
      .filter((m) => !m.archived)
      .reduce(
        (sum, m) =>
          sum +
          countText(m.content, { providerType: provider.type, model, limit: 1 }).tokens,
        0,
      );

  const character = getCharacter(ctx.db, conversation.characterId);
  const persona = getDefaultPersona(ctx.db);

  const transcript = buildTranscript(
    candidates.messages.map((m) => ({ role: m.role, content: m.content })),
    {
      characterName: character?.name ?? '角色',
      userName: persona?.name ?? '你',
    },
  );

  const previousSummary = existingSummaries.length
    ? existingSummaries[existingSummaries.length - 1]!.content
    : null;

  const prompt = buildSummaryPrompt({
    messageCount: candidates.ids.length,
    transcript,
    characterName: character?.name ?? '角色',
    userName: persona?.name ?? '你',
    previousSummary,
  });

  emitEvent(ctx, EVENT.compressProgress, {
    conversationId: input.conversationId,
    done: 0,
    total: candidates.ids.length,
    phase: 'summarizing',
  });

  // ---- 现取现解密 ----
  const secretRecord = getProviderSecretForMain(ctx.db, provider.id);
  if (!secretRecord?.apiKeyEnc) {
    throw new ContextError('NO_KEY', '压缩用的 Provider 还没有可用的 API Key');
  }
  const { plain: apiKey } = await decryptSecret(secretRecord.apiKeyEnc);

  // 把摘要指令当成一条 user 消息发给压缩模型
  const plan = buildRequest(
    {
      segments: [{ kind: 'user', role: 'user', text: prompt }],
      meta: {
        characterName: character?.name ?? '角色',
        userName: persona?.name ?? '你',
        historyCount: candidates.ids.length,
        summaryCount: 0,
        archivedCount: 0,
      },
    },
    {
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      apiKey,
      model,
      temperature: 0.3, // 摘要要稳定，压低随机性
      topP: 0.9,
      maxTokens: 1024,
      includeUsage: true,
    },
  );

  const outcome = await streamChat(
    plan,
    {
      onDelta: () => {
        // 摘要是一次性产出，不需要逐帧推送进度之外的东西；
        // 这里只在开始时给一次"进行中"，避免把右栏刷成高频更新。
      },
    },
    {
      timeoutMs: settings.requestTimeoutMs,
      providerType: provider.type,
    },
  );

  if (outcome.status !== 'done' || !outcome.text.trim()) {
    const error: NormalizedError =
      outcome.error ??
      makeError('UPSTREAM_ERROR', '压缩模型没有返回可用的摘要内容');
    // 失败时**不写摘要、不改归档标记**（原子性）
    emitEvent(ctx, EVENT.compressProgress, {
      conversationId: input.conversationId,
      done: 0,
      total: candidates.ids.length,
      phase: 'writing',
    });
    log.warn('压缩失败，未改动数据库', error.message);
    throw new ContextError('NO_PROVIDER', `压缩失败：${error.message}`);
  }

  const summaryText = outcome.text.trim();
  const summaryTokens = countText(summaryText, {
    providerType: provider.type,
    model,
    limit: 1,
  }).tokens;

  emitEvent(ctx, EVENT.compressProgress, {
    conversationId: input.conversationId,
    done: candidates.ids.length,
    total: candidates.ids.length,
    phase: 'writing',
  });

  // ---- 关键：写摘要 + 归档原消息，同一事务 ----
  const summary = writeSummaryAtomic(
    ctx.db,
    {
      conversationId: input.conversationId,
      content: summaryText,
      coversFrom: candidates.from,
      coversTo: candidates.to,
      tokenCount: summaryTokens,
      providerId: provider.id,
      model,
      archiveMessageIds: candidates.ids,
    },
    Date.now(),
  );

  const tokensAfter =
    existingSummaries.reduce((sum, s) => sum + s.tokenCount, 0) +
    summaryTokens +
    listMessages(ctx.db, input.conversationId)
      .filter((m) => !m.archived)
      .reduce(
        (sum, m) => sum + countText(m.content, { providerType: provider.type, model, limit: 1 }).tokens,
        0,
      );

  emitEvent(ctx, EVENT.messagesChanged, { ids: candidates.ids, reason: 'updated' });
  emitEvent(ctx, EVENT.conversationsChanged, { ids: [input.conversationId], reason: 'updated' });

  return {
    from: candidates.from,
    to: candidates.to,
    tokensBefore,
    tokensAfter,
    summary,
  };
}

/**
 * 预览"压缩最老 N 条"会覆盖哪个区间（不落库、不联网）。
 * 右栏按钮上的"约省多少"用它来算。
 */
export function previewCompressionRange(
  ctx: AppContext,
  conversationId: string,
  count: number,
): { from: number; to: number; ids: string[] } {
  const candidates = pickCompressionCandidates(
    ctx.db,
    conversationId,
    Math.max(1, Math.min(count, DEFAULT_COMPRESS_BATCH)),
  );
  return { from: candidates.from, to: candidates.to, ids: candidates.ids };
}

/** 供 UI 显示压缩按钮文案：当前有多少条可压缩。 */
export function countCompressible(ctx: AppContext, conversationId: string): number {
  const candidates = pickCompressionCandidates(ctx.db, conversationId, DEFAULT_COMPRESS_BATCH);
  return candidates.ids.length;
}

export { toCharacterCard };
