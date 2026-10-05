/**
 * IPC 入参 / 出参的 zod schema（技术方案 6.3）。
 *
 * **每个 handler 的入参都必须过一遍 schema**（验收项 4）：renderer 被 XSS 时也不能
 * 构造越权调用。这里刻意只放"穿过边界的形状"，业务规则（如"标题不能超过 80 字"）
 * 留在 DAO 里，避免同一规则两处实现。
 */
import { z } from 'zod';

/* ------------------------------ 基础 ------------------------------ */

export const idSchema = z.string().min(1).max(128);
export const providerTypeSchema = z.enum(['openai', 'anthropic']);
export const messageRoleSchema = z.enum(['user', 'assistant']);

export const generationParamsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1).max(1_000_000),
});

/** 密钥：只允许"传新值"或"显式清除"，不允许把密文从 renderer 传回来。 */
export const providerInputSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().min(1).max(120),
    type: providerTypeSchema,
    baseUrl: z.string().min(1).max(2048),
    /** 明文 Key。留空表示不改动已存的值。 */
    apiKey: z.string().max(4096).optional(),
    clearKey: z.boolean().optional(),
    models: z.array(z.string().max(200)).max(500),
    defaultModel: z.string().max(200),
    compressionModel: z.string().max(200),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => !(v.apiKey && v.clearKey), {
    message: '不能同时提交新密钥与"清除密钥"',
  });

export const characterUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(200_000).optional(),
  personality: z.string().max(200_000).optional(),
  scenario: z.string().max(200_000).optional(),
  firstMes: z.string().max(200_000).optional(),
  alternateGreetings: z.array(z.string().max(200_000)).max(100).optional(),
  mesExample: z.string().max(200_000).optional(),
  systemPrompt: z.string().max(200_000).optional(),
  postHistoryInstructions: z.string().max(200_000).optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  favorite: z.boolean().optional(),
  avatarPath: z.string().max(1024).nullable().optional(),
});

export const personaInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(10_000).optional(),
  avatarPath: z.string().max(1024).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const createConversationInputSchema = z.object({
  characterId: idSchema,
  title: z.string().max(80).optional(),
  providerId: idSchema.nullable().optional(),
  model: z.string().max(200).optional(),
  personaId: idSchema.nullable().optional(),
  /** 是否用角色卡 first_mes 作为开场白写入首条消息 */
  useFirstMessage: z.boolean().optional(),
});

export const conversationPatchSchema = z.object({
  personaId: idSchema.nullable().optional(),
  providerId: idSchema.nullable().optional(),
  model: z.string().max(200).optional(),
  params: generationParamsSchema.partial().optional(),
});

export const sendMessageInputSchema = z.object({
  conversationId: idSchema,
  /** 允许空串：表示"重新生成/继续"由主进程按最后一条消息判断 */
  text: z.string().max(200_000),
  /** 临时覆盖本次生成使用的 Key（产品设计文档 3.1：会话级可覆盖聊天 Key） */
  providerId: idSchema.nullable().optional(),
  model: z.string().max(200).optional(),
});

export const editMessageInputSchema = z.object({
  messageId: idSchema,
  content: z.string().max(200_000),
  truncate: z.boolean(),
});

export const compressInputSchema = z.object({
  conversationId: idSchema,
  /** 不传则让主进程按阈值自动挑最老的若干条 */
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
  /** 本次手动压缩使用的 provider（产品设计文档 3.1 允许临时指定） */
  providerId: idSchema.nullable().optional(),
  model: z.string().max(200).optional(),
});

/**
 * 角色列表查询。**三种"不筛选"的写法都必须接受**：`{}`、`undefined`、`null`。
 *
 * 为什么必须显式接受 `null`：preload 用 `query ?? null` 发送这个可选参数
 * （见 src/preload/index.ts 的 `characters.list`），所以"不传查询"到主进程时是 `null`
 * 而不是 `undefined`。这里原本只写 `.optional()`，于是 `characters.list()` 被判成
 * 入参校验失败——角色库列表**永远显示"还没有角色卡"**，而标签筛选却是正常的
 * （`characters:tags` 不走这个 schema），看起来很像渲染 bug。这个坑真的踩过。
 */
export const listCharactersInputSchema = z
  .object({
    search: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    favoriteOnly: z.boolean().optional(),
  })
  .nullish();

export const tokensPreviewInputSchema = z.object({
  conversationId: idSchema,
  /** 输入框里的草稿，用来算"本次输入"那一项 */
  draft: z.string().max(200_000).optional(),
  /** 预览用的 provider（决定精确还是估算） */
  providerId: idSchema.nullable().optional(),
  model: z.string().max(200).optional(),
});

export const settingsPatchSchema = z.object({
  chatProviderId: idSchema.nullable().optional(),
  compressionProviderId: idSchema.nullable().optional(),
  autoCompressEnabled: z.boolean().optional(),
  autoCompressThreshold: z.number().min(0.1).max(1).optional(),
  sendWithCtrlEnter: z.boolean().optional(),
  panelOpen: z.boolean().optional(),
  panelTab: z.enum(['context', 'conversation', 'character', 'data']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const importCharacterInputSchema = z.object({
  /** 角色卡原文：可以是已解析的对象，也可以是 JSON 字符串 */
  card: z.union([z.record(z.unknown()), z.string().max(2_000_000)]),
});

/**
 * 角色卡导出格式。
 *
 * 不给默认值：preload 已经把「没传」归一成 `'json'`（见 `src/preload/index.ts`），
 * 所以主进程收到的永远是这两个值之一，schema 可以严格到底。
 */
export const characterExportFormatSchema = z.enum(['json', 'png']);

export const exportConversationSchema = z.object({
  conversationId: idSchema,
});

/* ------------------------------ 类型导出 ------------------------------ */

export type ProviderInputPayload = z.infer<typeof providerInputSchema>;
export type CharacterUpdatePayload = z.infer<typeof characterUpdateSchema>;
export type PersonaInputPayload = z.infer<typeof personaInputSchema>;
export type CreateConversationPayload = z.infer<typeof createConversationInputSchema>;
export type ConversationPatchPayload = z.infer<typeof conversationPatchSchema>;
export type SendMessagePayload = z.infer<typeof sendMessageInputSchema>;
export type EditMessagePayload = z.infer<typeof editMessageInputSchema>;
export type CompressPayload = z.infer<typeof compressInputSchema>;
export type ListCharactersPayload = z.infer<typeof listCharactersInputSchema>;
export type TokensPreviewPayload = z.infer<typeof tokensPreviewInputSchema>;
export type SettingsPatchPayload = z.infer<typeof settingsPatchSchema>;
export type ImportCharacterPayload = z.infer<typeof importCharacterInputSchema>;
