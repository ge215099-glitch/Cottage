/**
 * 行 ↔ 领域对象的映射，以及 JSON 列的 zod 校验。
 *
 * **硬约束**（产品设计文档第 4 节 / 技术方案 5.3）：JSON 列读写都必须过 schema，
 * 禁止裸字符串读取。理由很实在：这些列一旦被外部工具手改成坏 JSON，裸 `JSON.parse`
 * 会让整个库"打不开"，而 schema 解析能把它降级成一条可报错的记录。
 *
 * 这一层也是 snake_case → camelCase 的**唯一**转换点。
 */
import { z } from 'zod';
import type {
  Character,
  Conversation,
  GenerationParams,
  Message,
  MessageMetadata,
  Persona,
  Provider,
  ProviderType,
  Summary,
} from '@shared/types.js';
import { DEFAULT_GENERATION_PARAMS } from '@shared/types.js';

/* ------------------------------ JSON 列 schema ------------------------------ */

export const stringArraySchema = z.array(z.string());

export const generationParamsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1).max(1_000_000),
});

/** 错误码枚举：与 `@shared/types` 的 `ErrorCode` 一一对应，防止 JSON 里塞进未知码。 */
export const errorCodeSchema = z.enum([
  'UNREACHABLE',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'TIMEOUT',
  'CONTEXT_OVERFLOW',
  'INVALID_REQUEST',
  'UPSTREAM_ERROR',
  'NO_PROVIDER',
  'NO_KEY',
  'DB_ERROR',
  'VALIDATION_ERROR',
  'UNKNOWN_CHANNEL',
  'NOT_FOUND',
  'ABORTED',
  'UNKNOWN',
]);

export const messageMetadataSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  stopReason: z.string().optional(),
  ttftMs: z.number().optional(),
  elapsedMs: z.number().optional(),
  interrupted: z.boolean().optional(),
  tokensExact: z.boolean().optional(),
  error: z
    .object({
      code: errorCodeSchema,
      message: z.string(),
      retryable: z.boolean(),
      httpStatus: z.number().optional(),
    })
    .optional(),
});

const providerTypeSchema = z.enum(['openai', 'anthropic']);

/** 安全解析 JSON 列：坏数据降级为默认值，绝不抛异常打断整表读取。 */
export function parseJsonColumn<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  context: string,
): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // 落到 fallback
  }
  // 不打印 raw 内容，避免把用户数据写进日志（技术方案 6.4 规则 3 的同源考虑）。
  console.warn(`[dao] JSON 列解析失败，已降级为默认值：${context}`);
  return fallback;
}

export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/* ------------------------------ 行类型 ------------------------------ */

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_enc: string | null;
  models_json: string;
  default_model: string;
  compression_model: string;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/**
 * 角色卡的行形状。
 *
 * **不含 `raw_json`**：`toCharacter` 不用它，而它是整张卡的原始 JSON（真卡
 * 110 KB～600 KB，世界书都在里面）。列角色的查询刻意不取它——取了就要读盘、
 * 占内存、还要随 IPC 再抄一份。导出需要时由 `getCharacterRawJson` 单独查一列。
 */
export interface CharacterRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  alternate_greetings_json: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  tags_json: string;
  favorite: number;
  avatar_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface PersonaRow {
  id: string;
  name: string;
  description: string;
  avatar_path: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationRow {
  id: string;
  title: string;
  character_id: string;
  persona_id: string | null;
  provider_id: string | null;
  model: string;
  params_json: string;
  pinned_at: number | null;
  created_at: number;
  updated_at: number;
  message_count?: number;
  summary_count?: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata_json: string;
  archived: number;
  status: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SummaryRow {
  id: string;
  conversation_id: string;
  content: string;
  covers_from: number;
  covers_to: number;
  token_count: number;
  level: number;
  provider_id: string | null;
  model: string;
  created_at: number;
}

/* ------------------------------ 映射函数 ------------------------------ */

export function toProvider(row: ProviderRow): Provider {
  const parsedType = providerTypeSchema.safeParse(row.type);
  return {
    id: row.id,
    name: row.name,
    type: (parsedType.success ? parsedType.data : 'openai') as ProviderType,
    baseUrl: row.base_url,
    // 只暴露布尔量：renderer 连掩码片段都拿不到（技术方案 6.4 规则 1）
    hasKey: typeof row.api_key_enc === 'string' && row.api_key_enc.length > 0,
    models: parseJsonColumn(row.models_json, stringArraySchema, [], `providers.models_json#${row.id}`),
    defaultModel: row.default_model,
    compressionModel: row.compression_model,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    /*
     * 「最新使用日期」不是 providers 表的列（它属于消息的事实），
     * 因此这里给一个保守默认值，由 `dao/providers` 在能查到时覆盖掉。
     * 默认 null 的含义是"没记录"，而不是"没用过"——列表里会显示成「—」。
     */
    lastUsedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMes: row.first_mes,
    alternateGreetings: parseJsonColumn(
      row.alternate_greetings_json,
      stringArraySchema,
      [],
      `characters.alternate_greetings_json#${row.id}`,
    ),
    mesExample: row.mes_example,
    systemPrompt: row.system_prompt,
    postHistoryInstructions: row.post_history_instructions,
    tags: parseJsonColumn(row.tags_json, stringArraySchema, [], `characters.tags_json#${row.id}`),
    favorite: row.favorite === 1,
    avatarPath: row.avatar_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    avatarPath: row.avatar_path,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toGenerationParams(row: ConversationRow): GenerationParams {
  return parseJsonColumn(
    row.params_json,
    generationParamsSchema,
    { ...DEFAULT_GENERATION_PARAMS },
    `conversations.params_json#${row.id}`,
  );
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    characterId: row.character_id,
    personaId: row.persona_id,
    providerId: row.provider_id,
    model: row.model,
    params: toGenerationParams(row),
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0),
    summaryCount: Number(row.summary_count ?? 0),
  };
}

export function toMessage(row: MessageRow): Message {
  const status = row.status === 'streaming' || row.status === 'interrupted' || row.status === 'error'
    ? row.status
    : 'done';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    metadata: parseJsonColumn<MessageMetadata>(
      row.metadata_json,
      messageMetadataSchema,
      {},
      `messages.metadata_json#${row.id}`,
    ),
    archived: row.archived === 1,
    status,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    coversFrom: row.covers_from,
    coversTo: row.covers_to,
    tokenCount: row.token_count,
    level: row.level,
    providerId: row.provider_id,
    model: row.model,
    createdAt: row.created_at,
  };
}
