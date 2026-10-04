/**
 * 变量替换：`{{char}}` / `{{user}}` / `{{time}}` / `{{date}}` 等。
 *
 * 三条纪律（产品设计文档 3.3）：
 *   1. 替换发生在**组装阶段**，对全部文本统一执行，不在渲染层各做一遍。
 *   2. 时间是入参，core 不得自己读时钟（tech-stack 不变量 I3）。
 *   3. 未知变量**原样保留**——静默删掉会让角色卡里的 `{{random}}` 之类
 *      悄悄失效，用户看不出原因。
 */

export interface VariableContext {
  char: string;
  user: string;
  /** 毫秒时间戳，由调用方传入 */
  nowMs: number;
  /** 展示用 UTC 偏移（分钟），东八区 = 480 */
  timezoneOffsetMinutes: number;
}

const CJK_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 与 SillyTavern 对齐的时间格式集合。 */
export function formatTime(nowMs: number, offsetMinutes: number): string {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatDate(nowMs: number, offsetMinutes: number): string {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatWeekday(nowMs: number, offsetMinutes: number): string {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return CJK_WEEKDAYS[d.getUTCDay()]!;
}

export function formatIso(nowMs: number, offsetMinutes: number): string {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 变量表：键为不带花括号的变量名。 */
export function variableTable(ctx: VariableContext): Record<string, string> {
  const offset = ctx.timezoneOffsetMinutes;
  return {
    char: ctx.char,
    user: ctx.user,
    time: formatTime(ctx.nowMs, offset),
    date: formatDate(ctx.nowMs, offset),
    weekday: formatWeekday(ctx.nowMs, offset),
    isotime: formatIso(ctx.nowMs, offset),
  };
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 对一段文本做变量替换。未知变量原样保留。
 *
 * 纯函数：同一 `text` + 同一 `ctx` 必然得到同一结果。
 */
export function replaceVariables(text: string, ctx: VariableContext): string {
  if (!text) return text;
  const table = variableTable(ctx);
  return text.replace(VARIABLE_PATTERN, (whole, name: string) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : whole;
  });
}

/** 找出文本里出现的全部变量名（去重、保序），用于"角色卡用了哪些变量"的提示。 */
export function collectVariableNames(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(VARIABLE_PATTERN)) {
    const name = m[1]!.toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}
