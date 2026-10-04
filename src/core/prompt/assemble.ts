/**
 * Prompt 组装：`AssembleInput` → `PromptSpec`（产品设计文档 3.3）。
 *
 * **这是 `src/core` 的核心，也是"纯函数"这条承诺的落点**：
 * 不读时钟、不读数据库、不读环境变量，全部外部状态来自入参。
 * 相同输入必须得到完全相同的输出（验收项 3）。
 *
 * 组装顺序（逻辑顺序，非最终 wire 格式）：
 *   1. system        角色卡 system_prompt，为空则用 描述/性格/场景 拼接
 *   2. few-shot      mes_example 解析成成对的 user/assistant 示例
 *   3. summaries     已归档历史对应的摘要，按覆盖区间升序
 *   4. history       未归档的历史消息
 *   5. post_history  post_history_instructions
 *   6. user          用户新消息
 */
import { CoreError } from '../errors.js';
import type {
  AssembleInput,
  CharacterCard,
  PromptMessage,
  PromptSegment,
  PromptSpec,
} from '../types.js';
import { replaceVariables, type VariableContext } from './variables.js';

/** `<START>` 是 SillyTavern 的示例分隔符；没有它时整段按一个例子处理。 */
const START_MARKER = /<START>/gi;

/** 默认 system 拼接顺序与分隔（产品设计文档 3.3 第 1 条）。 */
function buildDefaultSystem(character: CharacterCard): string {
  const parts: string[] = [];
  if (character.description.trim()) parts.push(`角色描述：${character.description.trim()}`);
  if (character.personality.trim()) parts.push(`性格：${character.personality.trim()}`);
  if (character.scenario.trim()) parts.push(`场景：${character.scenario.trim()}`);
  return parts.join('\n\n');
}

/**
 * 解析 `mes_example` 为成对的示例消息。
 *
 * 识别的行为 `{{user}}:` / `{{char}}:`（大小写不敏感，冒号允许为中文冒号），
 * 其余行并入上一条。解析不出任何成对结构时返回空数组——**不猜**，避免把普通
 * 文本硬塞进 few-shot 改变语义。
 */
export function parseExampleDialogue(
  mesExample: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const raw = (mesExample ?? '').trim();
  if (!raw) return [];

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const blocks = raw.split(START_MARKER);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let current: { role: 'user' | 'assistant'; content: string } | null = null;
    for (const line of lines) {
      const m = /^\s*\{\{\s*(user|char)\s*\}\}\s*[:：]\s?(.*)$/i.exec(line);
      if (m) {
        if (current && current.content.trim()) out.push(current);
        current = {
          role: m[1]!.toLowerCase() === 'user' ? 'user' : 'assistant',
          content: m[2] ?? '',
        };
        continue;
      }
      if (current) current.content += (current.content ? '\n' : '') + line;
    }
    if (current && current.content.trim()) out.push(current);
  }

  for (const item of out) item.content = item.content.trim();
  return out.filter((i) => i.content.length > 0);
}

/** 历史消息排序：按 sortOrder 升序；相同 sortOrder 时保持传入顺序（稳定）。 */
function sortMessages(messages: PromptMessage[]): PromptMessage[] {
  return messages
    .map((m, index) => ({ m, index }))
    .sort((a, b) => a.m.sortOrder - b.m.sortOrder || a.index - b.index)
    .map((x) => x.m);
}

/** 把文本切成分段；空文本不产生分段，保证 token 明细里没有 0 值噪音。 */
function pushSegment(
  segments: PromptSegment[],
  kind: PromptSegment['kind'],
  role: PromptSegment['role'],
  text: string,
  extra?: Partial<PromptSegment>,
): void {
  if (!text.trim()) return;
  segments.push({ kind, role, text, ...extra });
}

/**
 * 组装 PromptSpec。**无副作用，无隐藏状态。**
 *
 * @throws CoreError(`EMPTY_ASSEMBLY`) 当除 system 外没有任何内容可发送时
 */
export function assemblePrompt(input: AssembleInput): PromptSpec {
  const { character, persona, summaries, messages, userInput, nowMs } = input;
  const ctx: VariableContext = {
    char: character.name,
    user: persona.name,
    nowMs,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? 0,
  };
  const v = (text: string): string => replaceVariables(text, ctx);

  const sorted = sortMessages(messages ?? []);
  const active = sorted.filter((m) => !m.archived);
  const archivedCount = sorted.length - active.length;

  const segments: PromptSegment[] = [];

  // 1. system
  const systemText = character.systemPrompt.trim() || buildDefaultSystem(character);
  pushSegment(segments, 'system', 'system', v(systemText));

  // 2. few-shot
  for (const ex of parseExampleDialogue(character.mesExample)) {
    pushSegment(segments, 'fewShot', ex.role, v(ex.content));
  }

  // 3. summaries：按覆盖区间升序（产品设计文档 3.4：互不重叠、时间升序）
  const orderedSummaries = [...(summaries ?? [])].sort(
    (a, b) => a.coversFrom - b.coversFrom || a.coversTo - b.coversTo,
  );
  for (const s of orderedSummaries) {
    pushSegment(segments, 'summary', 'system', v(s.content), {
      coversFrom: s.coversFrom,
      coversTo: s.coversTo,
      sourceId: s.id,
    });
  }

  // 4. history
  for (const m of active) {
    pushSegment(segments, 'history', m.role, v(m.content));
  }

  // 5. post_history
  pushSegment(segments, 'postHistory', 'system', v(character.postHistoryInstructions));

  // 6. user
  pushSegment(segments, 'user', 'user', v(userInput));

  if (!segments.length) {
    throw new CoreError('EMPTY_ASSEMBLY', '组装结果为空：角色卡本身没有任何可发送的文本');
  }

  return {
    segments,
    meta: {
      characterName: character.name,
      userName: persona.name,
      historyCount: active.length,
      summaryCount: orderedSummaries.length,
      archivedCount,
    },
  };
}

/** 供 UI 预览用的分组视图（不改动 IR，只是换个角度看它）。 */
export function groupSegments(spec: PromptSpec): Array<{
  kind: PromptSegment['kind'];
  label: string;
  role: PromptSegment['role'];
  text: string;
  itemCount: number;
}> {
  const order: PromptSegment['kind'][] = [
    'system',
    'fewShot',
    'summary',
    'history',
    'postHistory',
    'user',
  ];
  const labels: Record<PromptSegment['kind'], string> = {
    system: 'system',
    fewShot: 'few-shot',
    summary: '摘要',
    history: '历史',
    postHistory: 'post_history',
    user: '本次输入',
  };
  return order
    .map((kind) => {
      const items = spec.segments.filter((s) => s.kind === kind);
      return {
        kind,
        label: labels[kind],
        role: (items[0]?.role ?? 'system') as PromptSegment['role'],
        text: items.map((s) => s.text).join('\n\n'),
        itemCount: items.length,
      };
    })
    .filter((g) => g.itemCount > 0);
}
