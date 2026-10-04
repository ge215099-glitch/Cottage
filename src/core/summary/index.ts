/**
 * 摘要模板与解析（产品设计文档 3.4）。
 *
 * 结构化输出固定六段：人物关系 / 关键事件 / 当前场景 / 情绪与态度 / 未回收伏笔 /
 * 事实状态（时间、地点、持有物）。
 *
 * 设计取舍：模板用**固定小标题**而不是 JSON，原因是这里要的是"给人看也合适"的
 * 摘要正文——它会直接进右栏与消息流摘要条。JSON 会让正文变成一坨转义字符串。
 * 解析器因此要能容忍模型不按格式回答（退回整段正文），而不是把坏输出当致命错误。
 */

export const SUMMARY_SECTIONS = [
  '人物关系',
  '关键事件',
  '当前场景',
  '情绪与态度',
  '未回收伏笔',
  '事实状态',
] as const;

export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

export interface SummaryDraftInput {
  /** 被压缩区间的消息条数，用于提示模型"这段有多长" */
  messageCount: number;
  /** 被压缩区间的原文（已按角色拼好） */
  transcript: string;
  /** 该会话已有的摘要（若有），用于保持人称与线索连续 */
  previousSummary?: string | null;
  /** 角色名，帮助模型保持人物一致 */
  characterName: string;
  /** 用户名（已做过 {{user}} 替换的展示名） */
  userName: string;
}

/**
 * 生成摘要指令。
 *
 * 明确写"不要复述原文、不要编造"这类约束，是因为压缩最常见的失败是
 * 把原文抄一遍（省不了 token）或补出不存在的剧情（污染后续对话）。
 */
export function buildSummaryPrompt(input: SummaryDraftInput): string {
  const lines: string[] = [];
  lines.push(
    `你是一个对话压缩器。请把给定的 ${input.messageCount} 条对话压缩成一段结构化摘要，供后续对话继续使用。`,
  );
  lines.push('');
  lines.push('要求：');
  lines.push('1. 只保留对后续剧情有用的信息，不要复述原文，不要逐句转述。');
  lines.push('2. 不要编造原文中不存在的事实、人物或事件。');
  lines.push('3. 保持人称与称谓：角色名为「' + input.characterName + '」，用户名为「' + input.userName + '」。');
  lines.push('4. 严格按下面六个小标题输出，每个标题一行，标题后直接写内容；没有内容的标题也要保留，写「无」。');
  lines.push('');
  for (const section of SUMMARY_SECTIONS) {
    lines.push(`${section}：`);
  }
  lines.push('');
  if (input.previousSummary) {
    lines.push('已有的前序摘要（用于保持线索连续，不要与之矛盾）：');
    lines.push(input.previousSummary);
    lines.push('');
  }
  lines.push('待压缩的对话：');
  lines.push(input.transcript);
  return lines.join('\n');
}

/** 把一段消息拼成"角色名：内容"的转写文本。 */
export function buildTranscript(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { characterName: string; userName: string; maxChars?: number },
): string {
  const maxChars = opts.maxChars ?? 24_000;
  const parts: string[] = [];
  let used = 0;

  // 超出预算时保留**最近的**内容：越靠后的剧情对"接下来怎么演"越重要
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    const speaker = m.role === 'user' ? opts.userName : opts.characterName;
    const line = `${speaker}：${m.content}`;
    if (used + line.length > maxChars && parts.length > 0) break;
    parts.unshift(line);
    used += line.length;
  }
  return parts.join('\n\n');
}

export interface ParsedSummary {
  /** 原始正文（原样保留，用于展示与导出） */
  text: string;
  /** 解析出的分节；解析不出任何分节时为空对象 */
  sections: Partial<Record<SummarySection, string>>;
  /** 是否成功解析出结构化分节（false 说明模型没按模板回答） */
  structured: boolean;
}

/** 小标题识别：先剥掉 Markdown 装饰（`##`、`-`、`*`、`1.`、加粗星号），再匹配。 */
const HEADER_PATTERN = new RegExp(`^(${SUMMARY_SECTIONS.join('|')})\\s*[:：]\\s*(.*)$`);

/** 去掉行首的 Markdown 装饰与整行的加粗标记，保留正文。 */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*>\s*/, '')
    .trim();
}

/** 逐行找"小标题："，其余行并入上一个小标题。 */
export function parseSummary(text: string): ParsedSummary {
  const cleaned = (text ?? '').trim();
  const sections: Partial<Record<SummarySection, string>> = {};
  let current: SummarySection | null = null;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const m = HEADER_PATTERN.exec(stripMarkdown(rawLine));
    if (m) {
      current = m[1] as SummarySection;
      sections[current] = (m[2] ?? '').trim();
      continue;
    }
    if (current) {
      const line = stripMarkdown(rawLine);
      if (!line) continue;
      const existing = sections[current];
      sections[current] = existing ? `${existing}\n${line}` : line;
    }
  }

  // 丢掉只写了"无"的空节，避免在 UI 里堆一堆"无"
  for (const key of Object.keys(sections) as SummarySection[]) {
    if (/^(无|none|n\/a|—|-)\s*$/i.test(sections[key] ?? '')) delete sections[key];
  }

  const structured = Object.keys(sections).length > 0;
  return { text: cleaned, sections, structured };
}

/** 摘要正文的 token 估算（压缩收益播报用；精确计数由 tokens 模块负责）。 */
export function summarizeBenefit(tokensBefore: number, tokensAfter: number): string {
  const saved = Math.max(0, tokensBefore - tokensAfter);
  const percent = tokensBefore > 0 ? Math.round((saved / tokensBefore) * 100) : 0;
  return `${tokensBefore.toLocaleString('en-US')} → ${tokensAfter.toLocaleString('en-US')} tokens（省 ${percent}%）`;
}
