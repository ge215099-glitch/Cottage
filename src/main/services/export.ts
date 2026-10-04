/**
 * 导出服务（产品设计文档 3.1 / 3.6-⑧）。
 *
 * 两条安全规则在这里落地：
 *   - **默认导出范围不含 Key**。`exportConversation` / `exportCharacter` 都碰不到密钥。
 *   - 只有 `exportPlainConfig` 会带 Key，且必须 `confirmed === true`
 *     （用户显式二次确认），文案里还要说明"密文绑定本机，拷库到另一台机器也解不开"。
 */
import { exportCharacterCard } from '@core/character-card.js';
import { decryptSecret } from '../secrets/index.js';
import type { AppContext } from '../context.js';
import { getCharacter } from '../db/dao/characters.js';
import {
  getConversation,
  getConversationStats,
  listConversations,
} from '../db/dao/conversations.js';
import { listMessages } from '../db/dao/messages.js';
import { listSummaries } from '../db/dao/summaries.js';
import { getDefaultPersona, getPersona } from '../db/dao/personas.js';
import { getProviderSecretForMain, listProviders } from '../db/dao/providers.js';
import { readSettings } from '../db/dao/settings.js';

export class ExportError extends Error {
  readonly code: 'NOT_FOUND' | 'NEEDS_CONFIRMATION' | 'DECRYPT_FAILED';
  constructor(code: ExportError['code'], message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

/** 导出会话为 Markdown。 */
export function exportConversationMarkdown(ctx: AppContext, conversationId: string): string {
  const conversation = getConversation(ctx.db, conversationId);
  if (!conversation) throw new ExportError('NOT_FOUND', '会话不存在');

  const character = getCharacter(ctx.db, conversation.characterId);
  const persona = conversation.personaId ? getPersona(ctx.db, conversation.personaId) : getDefaultPersona(ctx.db);
  const messages = listMessages(ctx.db, conversationId);
  const summaries = listSummaries(ctx.db, conversationId);

  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push(
    [
      `- 角色：${character?.name ?? '（已删除）'}`,
      `- 人设：${persona?.name ?? '（未设置）'}`,
      `- 模型：${conversation.model || '（未指定）'}`,
      `- 消息：${messages.length} 条（其中归档 ${messages.filter((m) => m.archived).length} 条）`,
      `- 摘要：${summaries.length} 段`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    ].join('\n'),
  );
  lines.push('');

  if (summaries.length) {
    lines.push('## 摘要');
    lines.push('');
    for (const summary of summaries) {
      lines.push(`### 第 ${summary.coversFrom}–${summary.coversTo} 条（${summary.tokenCount} tok，${summary.model}）`);
      lines.push('');
      lines.push(summary.content);
      lines.push('');
    }
  }

  lines.push('## 对话');
  lines.push('');
  for (const message of messages) {
    const speaker = message.role === 'user' ? (persona?.name ?? '用户') : (character?.name ?? '角色');
    const flag = message.status === 'interrupted' ? '（已中断）' : '';
    lines.push(`**${speaker}**${flag}`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** 导出会话为 JSON。**刻意不含任何密钥字段。** */
export function exportConversationJson(ctx: AppContext, conversationId: string): string {
  const conversation = getConversation(ctx.db, conversationId);
  if (!conversation) throw new ExportError('NOT_FOUND', '会话不存在');

  const character = getCharacter(ctx.db, conversation.characterId);
  const persona = conversation.personaId ? getPersona(ctx.db, conversation.personaId) : getDefaultPersona(ctx.db);

  const payload = {
    format: 'cottage.conversation',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversation: {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      params: conversation.params,
      pinnedAt: conversation.pinnedAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    character: character
      ? { id: character.id, name: character.name, tags: character.tags }
      : null,
    persona: persona ? { id: persona.id, name: persona.name } : null,
    summaries: listSummaries(ctx.db, conversationId),
    messages: listMessages(ctx.db, conversationId),
  };

  return JSON.stringify(payload, null, 2);
}

/** 导出角色卡（raw_json 为基底，只覆盖 Cottage 管理的字段）。 */
export function exportCharacter(ctx: AppContext, characterId: string): Record<string, unknown> {
  const character = getCharacter(ctx.db, characterId);
  if (!character) throw new ExportError('NOT_FOUND', '角色不存在');

  const raw = ctx.db
    .prepare<{ raw_json: string }>('SELECT raw_json FROM characters WHERE id = ?')
    .get(characterId);
  let rawJson: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw.raw_json) : null;
    if (parsed && typeof parsed === 'object') rawJson = parsed as Record<string, unknown>;
  } catch {
    rawJson = {};
  }

  return exportCharacterCard(
    rawJson,
    {
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
    },
    { avatar: character.avatarPath },
  );
}

/**
 * 导出**明文配置包**，用于换机。
 *
 * 必须 `confirmed === true`：这是唯一会把 Key 明文写进文件的出口，
 * 所以强制由 UI 做二次确认（技术方案 6.4 规则 5）。
 *
 * 明文 Key 解出来后**只用于拼这一个 JSON 串**，函数返回后即失去引用。
 */
export async function exportPlainConfig(
  ctx: AppContext,
  confirmed: boolean,
): Promise<string> {
  if (!confirmed) {
    throw new ExportError('NEEDS_CONFIRMATION', '导出明文配置包含 API Key，需要二次确认');
  }

  const settings = readSettings(ctx.db);
  const providers = listProviders(ctx.db);
  const conversations = listConversations(ctx.db);

  const providerEntries = [];
  for (const provider of providers) {
    let apiKey: string | null = null;
    if (provider.hasKey) {
      const secret = getProviderSecretForMain(ctx.db, provider.id);
      if (secret?.apiKeyEnc) {
        try {
          const { plain } = await decryptSecret(secret.apiKeyEnc);
          apiKey = plain;
        } catch {
          // 解不开就留空，并如实标注，而不是让整个导出失败
          apiKey = null;
        }
      }
    }
    providerEntries.push({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey,
      keyDecrypted: apiKey !== null,
      models: provider.models,
      defaultModel: provider.defaultModel,
      compressionModel: provider.compressionModel,
      enabled: provider.enabled,
      sortOrder: provider.sortOrder,
    });
  }

  const payload = {
    format: 'cottage.plain-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    // 强提示直接写进文件里：用户换机时未必记得这条限制
    warning: [
      '本文件包含明文 API Key，请妥善保管，不要提交到版本库或发送给他人。',
      'safeStorage 的密文绑定本机用户凭据，因此直接拷贝 cottage.db 到另一台机器无法解密；',
      '换机时请使用本文件，而不是拷贝数据库文件。',
    ],
    settings,
    providers: providerEntries,
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      characterId: c.characterId,
      personaId: c.personaId,
      providerId: c.providerId,
      model: c.model,
      params: c.params,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

/** 会话统计，供删除确认框展示（UI 文档 4.7）。 */
export function conversationStats(ctx: AppContext, conversationId: string) {
  return getConversationStats(ctx.db, conversationId);
}
