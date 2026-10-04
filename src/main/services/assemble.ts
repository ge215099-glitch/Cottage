/**
 * 组装辅助：把库里的会话状态搬成 `PromptSpec` 需要的入参（技术方案 6.1 的步骤 1–3）。
 *
 * 这一层是**主进程**的，因为它要读库；但它只做"取数据 + 调 core"，
 * 不含任何组装逻辑——组装全部在 `@core/prompt`，这样"纯函数"那条承诺才成立。
 */
import { assemblePrompt } from '@core/prompt/assemble.js';
import { countPromptSpec, occupancyPercent } from '@core/tokens/index.js';
import { getDefaultPersona, getPersona } from '../db/dao/personas.js';
import { getCharacter } from '../db/dao/characters.js';
import { getConversation } from '../db/dao/conversations.js';
import { listMessages } from '../db/dao/messages.js';
import { listSummaries } from '../db/dao/summaries.js';
import { getProvider } from '../db/dao/providers.js';
import { readSettings } from '../db/dao/settings.js';
import type { DatabaseDriver } from '../db/driver.js';
import type { CharacterCard, PromptSpec } from '@core/types.js';
import type { Conversation, TokenPreview } from '@shared/types.js';

/** 模型上下文上限的兜底值：用户没填模型上限时用它，避免除零与 0% 占用。 */
export const FALLBACK_CONTEXT_LIMIT = 20_000;

export interface AssembledContext {
  conversation: Conversation;
  spec: PromptSpec;
  /** 参与组装的非归档消息条数 */
  activeMessageCount: number;
  characterName: string;
}

/** 把 DAO 的 Character 转成 core 需要的 CharacterCard。 */
export function toCharacterCard(character: {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
}): CharacterCard {
  return {
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    firstMes: character.firstMes,
    alternateGreetings: character.alternateGreetings,
    mesExample: character.mesExample,
    systemPrompt: character.systemPrompt,
    postHistoryInstructions: character.postHistoryInstructions,
    tags: character.tags,
  };
}

export class ContextError extends Error {
  readonly code: 'NOT_FOUND' | 'NO_PROVIDER' | 'NO_KEY' | 'NO_CHARACTER' | 'CONTEXT_OVERFLOW';
  constructor(code: ContextError['code'], message: string) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

/**
 * 取会话的 persona：先看会话绑定，再退到全局默认，最后给一个占位。
 *
 * 产品设计文档 3.2 定的是"未绑定时使用全局默认 persona"，这里如实执行；
 * 连默认都没有（用户没建过 persona）时用"你"作为 `{{user}}`，而不是报错——
 * 这属于"还没配置"而不是"配置错了"。
 */
export function resolvePersona(db: DatabaseDriver, conversation: Conversation) {
  if (conversation.personaId) {
    const bound = getPersona(db, conversation.personaId);
    if (bound) return { name: bound.name, description: bound.description };
  }
  const fallback = getDefaultPersona(db);
  if (fallback) return { name: fallback.name, description: fallback.description };
  return { name: '你', description: '' };
}

/** 组装一次（不含压缩；超限处理由调用方决定）。 */
export function assembleForConversation(
  db: DatabaseDriver,
  conversationId: string,
  userInput: string,
  nowMs: number,
): AssembledContext {
  const conversation = getConversation(db, conversationId);
  if (!conversation) throw new ContextError('NOT_FOUND', '会话不存在');

  const character = getCharacter(db, conversation.characterId);
  if (!character) throw new ContextError('NO_CHARACTER', '会话绑定的角色卡已被删除');

  const persona = resolvePersona(db, conversation);
  const messages = listMessages(db, conversationId).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    archived: m.archived,
    sortOrder: m.sortOrder,
  }));
  const summaries = listSummaries(db, conversationId).map((s) => ({
    id: s.id,
    content: s.content,
    coversFrom: s.coversFrom,
    coversTo: s.coversTo,
    tokenCount: s.tokenCount,
    level: s.level,
  }));

  const spec = assemblePrompt({
    character: toCharacterCard(character),
    persona,
    summaries,
    messages,
    userInput,
    nowMs,
    // 中文优先的产品：默认按东八区展示 {{time}}/{{date}}
    timezoneOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
  });

  return {
    conversation,
    spec,
    activeMessageCount: spec.meta.historyCount,
    characterName: character.name,
  };
}

/**
 * 解析本次生成使用的 provider 与模型。
 *
 * 优先级（产品设计文档 3.1）：会话绑定 > 全局默认。都没有则明确报错，
 * 让 UI 显示"先去设置里配置 Provider"，而不是发一个必然失败的请求。
 */
export function resolveProvider(
  db: DatabaseDriver,
  conversation: Conversation,
  override?: { providerId?: string | null; model?: string },
) {
  const settings = readSettings(db);
  const providerId = override?.providerId ?? conversation.providerId ?? settings.chatProviderId;
  if (!providerId) {
    throw new ContextError('NO_PROVIDER', '还没有配置 Provider，请先到设置里添加一个');
  }

  const provider = getProvider(db, providerId);
  if (!provider) throw new ContextError('NO_PROVIDER', '所选 Provider 不存在或已被删除');
  if (!provider.enabled) throw new ContextError('NO_PROVIDER', `Provider「${provider.name}」已被停用`);
  if (!provider.hasKey) throw new ContextError('NO_KEY', `Provider「${provider.name}」还没有填写 API Key`);

  const model = override?.model || conversation.model || provider.defaultModel || provider.models[0];
  if (!model) throw new ContextError('NO_PROVIDER', `Provider「${provider.name}」还没有指定模型`);

  return { provider, model };
}

/** 解析压缩用的 provider：手动指定 > 全局压缩默认 > 会话绑定（产品设计文档 3.1）。 */
export function resolveCompressionProvider(
  db: DatabaseDriver,
  conversation: Conversation,
  override?: { providerId?: string | null; model?: string },
) {
  const settings = readSettings(db);
  const providerId =
    override?.providerId ?? settings.compressionProviderId ?? conversation.providerId ?? settings.chatProviderId;
  if (!providerId) throw new ContextError('NO_PROVIDER', '还没有配置压缩用的 Provider');

  const provider = getProvider(db, providerId);
  if (!provider) throw new ContextError('NO_PROVIDER', '压缩用的 Provider 不存在或已被删除');
  if (!provider.hasKey) throw new ContextError('NO_KEY', `Provider「${provider.name}」还没有填写 API Key`);

  const model =
    override?.model || provider.compressionModel || provider.defaultModel || provider.models[0];
  if (!model) throw new ContextError('NO_PROVIDER', `Provider「${provider.name}」还没有指定模型`);

  return { provider, model };
}

/** 生成 token 明细预览（只读投影，供 renderer 展示占用条与明细）。 */
export function buildTokenPreview(
  db: DatabaseDriver,
  conversationId: string,
  draft: string,
  nowMs: number,
  override?: { providerId?: string | null; model?: string },
): TokenPreview {
  const { conversation, spec } = assembleForConversation(db, conversationId, draft, nowMs);
  const settings = readSettings(db);

  // 预览的 provider 允许解析失败（还没配 Key 也要能看占用），退化成估算。
  let providerType: 'openai' | 'anthropic' = 'openai';
  let model = override?.model || conversation.model || '';
  try {
    const resolved = resolveProvider(db, conversation, override);
    providerType = resolved.provider.type;
    model = resolved.model;
  } catch {
    // 保持默认：用会话里的模型名做估算，UI 会标"约"
  }

  const breakdown = countPromptSpec(spec, {
    providerType,
    model,
    limit: FALLBACK_CONTEXT_LIMIT,
  });

  return {
    segments: breakdown.segments.map((s) => ({
      kind: s.kind,
      label: s.label,
      tokens: s.count.tokens,
      exact: s.count.exact,
      method: s.count.method,
      itemCount: s.itemCount ?? 0,
    })),
    total: breakdown.total.tokens,
    limit: breakdown.limit,
    percent: occupancyPercent(breakdown),
    anyEstimated: breakdown.anyEstimated,
    autoCompressAt: settings.autoCompressThreshold,
  };
}
