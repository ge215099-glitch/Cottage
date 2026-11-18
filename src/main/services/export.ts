/**
 * 导出服务（产品设计文档 3.1 / 3.2 / 3.6-⑧）。
 *
 * 四条安全规则在这里落地：
 *   - **导出范围永不含 Key**。会话导出、JSON 卡导出、PNG 卡导出全都碰不到密钥。
 *   - 角色卡导出**不新造图片**：PNG 卡用的就是这张卡原来的卡面图，没有就报错，
 *     而不是生成一张灰色占位图冒充卡面。
 *
 * 这里曾经有一个 `exportPlainConfig`（把明文 Key 写进"换机配置包"）。它已按需求移除：
 * 应用里**不存在任何写出明文 Key 的出口**，密钥边界随之收窄到"只进不出"。
 */
import { readFile } from 'node:fs/promises';
import { cardTextChunkKeyword } from '@core/character-card.js';
import { embedPngCardPayload, isPngFile } from '@core/png-card.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import type { CharacterExportFormat } from '@shared/types.js';
import type { AppContext } from '../context.js';
import { AVATAR_DIR, resolveAvatarRequest } from '../avatars.js';
import { exportCharacter as exportCharacterCard, getCharacter } from '../db/dao/characters.js';
import { getConversation, getConversationStats } from '../db/dao/conversations.js';
import { listMessages } from '../db/dao/messages.js';
import { listSummaries } from '../db/dao/summaries.js';
import { getDefaultPersona, getPersona } from '../db/dao/personas.js';

export class ExportError extends Error {
  readonly code: 'NOT_FOUND' | 'NEEDS_CONFIRMATION' | 'DECRYPT_FAILED' | 'NO_AVATAR' | 'BAD_AVATAR';
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

/**
 * 导出角色卡（`raw_json` 为基底，只覆盖 Cottage 管理的字段）。
 *
 * 具体拼装交给 DAO 层（`characters.exportCharacter`）：它同时握着 `raw_json`
 * 与角色字段，是唯一不该有第二份实现的地方。
 */
export function exportCharacter(ctx: AppContext, characterId: string): Record<string, unknown> {
  const card = exportCharacterCard(ctx.db, characterId);
  if (!card) throw new ExportError('NOT_FOUND', '角色不存在');
  return card;
}

/**
 * 导出 PNG 卡：**原卡面图 + 新写进去的角色数据**。
 *
 * 卡面图必须是当初导入时存下来的那张 PNG——我们只往它的文本块里写数据，
 * 不重新编码图片，所以像素与其它元数据都是原样。
 *
 * 读盘走 `resolveAvatarRequest`（头像协议那套校验）：路径必须落在
 * `<userData>/avatars/` 之内、扩展名在白名单里。这里刻意复用它而不是自己拼路径，
 * 免得出现"协议读取被严格校验、导出读取却放行"的第二套规则。
 */
export async function exportCharacterPng(
  ctx: AppContext,
  characterId: string,
): Promise<{ card: Record<string, unknown>; bytes: Uint8Array }> {
  const card = exportCharacter(ctx, characterId);
  const avatarPath = getCharacter(ctx.db, characterId)?.avatarPath ?? null;

  if (!avatarPath) {
    throw new ExportError(
      'NO_AVATAR',
      '这个角色没有卡面图，导不出 PNG 卡（PNG 卡必须带图）；请改用 JSON 导出',
    );
  }

  const resolved = resolveAvatarRequest(ctx.userDataDir, buildAvatarUrl(avatarPath) ?? '');
  if (!resolved) {
    throw new ExportError('NO_AVATAR', `卡面图文件已丢失（${AVATAR_DIR}/…），无法导出 PNG 卡`);
  }

  const bytes = new Uint8Array(await readFile(resolved.filePath));
  if (!isPngFile(bytes)) {
    throw new ExportError('BAD_AVATAR', '卡面图不是 PNG，角色数据写不回去；请改用 JSON 导出');
  }

  return {
    card,
    bytes: embedPngCardPayload(bytes, JSON.stringify(card, null, 2), cardTextChunkKeyword(card)),
  };
}

/**
 * 按格式准备导出内容（**只生成，不落盘**）。
 *
 * 落盘那一步要过系统保存对话框，只能在 IPC 层做；但"导出什么内容"属于业务，
 * 由这里一处决定，免得 handler 里长出 if/else 分支。
 * `bytes` 为 null 表示 JSON 卡（内容就是 `card` 本身，不需要额外字节）。
 */
export async function prepareCharacterExport(
  ctx: AppContext,
  characterId: string,
  format: CharacterExportFormat,
): Promise<{ card: Record<string, unknown>; bytes: Uint8Array | null }> {
  if (format === 'png') return await exportCharacterPng(ctx, characterId);
  return { card: exportCharacter(ctx, characterId), bytes: null };
}

/** 会话统计，供删除确认框展示（UI 文档 4.7）。 */
export function conversationStats(ctx: AppContext, conversationId: string) {
  return getConversationStats(ctx.db, conversationId);
}
