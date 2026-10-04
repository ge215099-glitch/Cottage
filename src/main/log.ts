/**
 * 日志与错误脱敏（技术方案 6.4 规则 3）。
 *
 * 关键设计：**脱敏在写日志的函数里统一做，而不是靠调用方自觉**。
 * 只要有一处 `console.log(err)` 没脱敏，Key 就可能进日志文件——这类问题在
 * 评审时看不出来，只能靠"唯一出口"来保证。
 *
 * 因此本模块导出的是 `safeLog` / `safeError`，主进程不允许直接 `console.log` 对象。
 * `scripts/verify-*.mjs` 里另有"密钥形态"正则检查作为第二道防线。
 */
import { redactSecrets } from '@core/providers/errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 主进程内累积的日志行，供诊断页与崩溃报告使用（有上限，避免无限增长）。 */
const MAX_BUFFERED_LINES = 500;
const buffered: string[] = [];

/** 记录一份"脱敏后的可读文本"；对象会被安全序列化。 */
export function redactValue(value: unknown): string {
  if (typeof value === 'string') return redactSecrets(value);
  if (value instanceof Error) {
    // 只取 name/message/stack，且整段过脱敏——stack 里也可能带上 URL query
    return redactSecrets(`${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`);
  }
  try {
    return redactSecrets(JSON.stringify(value, replacer));
  } catch {
    return redactSecrets(String(value));
  }
}

/** 序列化时跳过可能含密钥的字段名，双保险。 */
const SECRET_KEYS = /^(api_?key|apikey|authorization|x-api-key|apiKeyEnc|api_key_enc|password|token)$/i;

function replacer(key: string, value: unknown): unknown {
  if (SECRET_KEYS.test(key)) return '[已脱敏]';
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * 统一的日志出口。
 *
 * 输出的每一行都会：脱敏 → 记录到内存环形缓冲 → 写到 stderr/stdout。
 */
export function safeLog(level: LogLevel, message: string, detail?: unknown): void {
  const safeMessage = redactSecrets(message);
  const suffix = detail === undefined ? '' : ` ${redactValue(detail)}`;
  const line = `[${level}] ${safeMessage}${suffix}`;

  buffered.push(line);
  if (buffered.length > MAX_BUFFERED_LINES) buffered.splice(0, buffered.length - MAX_BUFFERED_LINES);

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, detail?: unknown) => safeLog('debug', message, detail),
  info: (message: string, detail?: unknown) => safeLog('info', message, detail),
  warn: (message: string, detail?: unknown) => safeLog('warn', message, detail),
  error: (message: string, detail?: unknown) => safeLog('error', message, detail),
};

/** 取最近的日志（已脱敏），供诊断页展示。 */
export function recentLogLines(): string[] {
  return [...buffered];
}

/** 仅供测试：清空缓冲。 */
export function clearLogBuffer(): void {
  buffered.length = 0;
}
