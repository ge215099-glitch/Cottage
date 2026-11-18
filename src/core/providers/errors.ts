/**
 * 错误规范化（产品设计文档 3.7 的失败矩阵）。
 *
 * 统一结构 `{ code, message, retryable, httpStatus? }`（技术方案 6.3）。
 *
 * **脱敏在这里做**：上游经常把 Key 回显在错误正文里，所以 `message` 必须过一遍
 * 脱敏再往上抛（技术方案 6.4 规则 4）。这一层不认识具体 Key，只按形态抹掉。
 */
import type { NormalizedError } from '@shared/types.js';

/** 常见密钥形态：`sk-...`、`Bearer ...`、长十六进制/Base64 串。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|apikey|authorization|x-api-key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
];

/**
 * 抹掉文本里可能的密钥。
 *
 * 注意：这是**兜底**，不是主要防线。主要防线是"Key 从不进入错误对象与日志"，
 * 这里只处理上游回显这种我们控制不了的情况。
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[已脱敏]');
  return out;
}

/** 把上游错误正文裁成一段可展示的摘要（过长时截断并标注）。 */
export function summarizeUpstreamBody(body: string, limit = 300): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit)}…（已截断）`;
}

/**
 * 从 HTTP 状态与响应正文构造 NormalizedError。
 *
 * 三态划分（产品设计文档 3.1 的连接测试）：
 *   可达 + 鉴权通过 / 可达 + 鉴权失败 / 不可达
 */
export function normalizeHttpError(
  status: number,
  body: string,
  context = '',
): NormalizedError {
  const detail = summarizeUpstreamBody(redactSecrets(body));
  const prefix = context ? `${context}：` : '';

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_FAILED',
      message: `${prefix}Key 无效或权限不足${detail ? `（${detail}）` : ''}`,
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: `${prefix}限流${detail ? `（${detail}）` : ''}`,
      retryable: true,
      httpStatus: status,
    };
  }
  if (status === 408 || status === 504) {
    return {
      code: 'TIMEOUT',
      message: `${prefix}上游超时${detail ? `（${detail}）` : ''}`,
      retryable: true,
      httpStatus: status,
    };
  }
  // 上下文超长：各家文案不同，只能按关键词识别
  if (/context length|context_length|too long|maximum context|prompt is too long|token limit/i.test(body)) {
    return {
      code: 'CONTEXT_OVERFLOW',
      message: `${prefix}上下文超出模型上限${detail ? `（${detail}）` : ''}`,
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      code: 'INVALID_REQUEST',
      message: `${prefix}请求被拒绝${detail ? `（${detail}）` : ''}`,
      retryable: false,
      httpStatus: status,
    };
  }
  if (status >= 500) {
    return {
      code: 'UPSTREAM_ERROR',
      message: `${prefix}上游服务异常（HTTP ${status}）${detail ? `（${detail}）` : ''}`,
      retryable: true,
      httpStatus: status,
    };
  }
  return {
    code: 'UPSTREAM_ERROR',
    message: `${prefix}HTTP ${status}${detail ? `（${detail}）` : ''}`,
    retryable: false,
    httpStatus: status,
  };
}

/** 网络层异常（DNS / 连接被拒 / TLS / 中断）→ NormalizedError。 */
export function normalizeFetchError(error: unknown, context = ''): NormalizedError {
  const prefix = context ? `${context}：` : '';
  const raw = error instanceof Error ? error : new Error(String(error));
  const message = redactSecrets(raw.message);

  if (raw.name === 'AbortError' || /aborted|abort/i.test(message)) {
    return { code: 'ABORTED', message: `${prefix}请求已中断`, retryable: false };
  }
  if (raw.name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return { code: 'TIMEOUT', message: `${prefix}请求超时`, retryable: true };
  }
  return {
    code: 'UNREACHABLE',
    // 不可达时 message 里可能含主机名，含敏感信息就一并脱敏
    message: `${prefix}无法连接端点（${message}）`,
    retryable: false,
  };
}

/** 业务侧错误（无 provider / 无 Key / 数据库错误）。 */
export function makeError(
  code: NormalizedError['code'],
  message: string,
  retryable = false,
): NormalizedError {
  return { code, message: redactSecrets(message), retryable };
}

/** 「上游一个字正文都没产出」的现场证据。 */
export interface EmptyCompletionFacts {
  /** 上游给的结束原因（finish_reason / stop_reason）；没有则 undefined */
  stopReason?: string;
  /** 累计正文长度（字符） */
  contentChars: number;
  /** 累计思考内容长度（字符）；上游不给 reasoning_content 时为 0 */
  reasoningChars: number;
  /** 输出 token 总数（含思考） */
  completionTokens: number;
  /** 其中用在思考上的 token；上游不给时为 0 */
  reasoningTokens: number;
}

/**
 * 上游"正常结束但正文为空"时的错误（产品设计文档 3.7 的失败矩阵）。
 *
 * 为什么要有这个函数：**这条路径曾经是静默的**。实测过一次（deepseek-flash，
 * 会话 max_tokens=1024）：思考型模型的思考 token 同样计入输出额度，思考把 1024
 * 吃满之后 `content` 是空的、`finish_reason=length`，而上游是以 200 正常收流的。
 * 应用当时把"没有正文"当成 `done`，于是消息是一条空白气泡、没有报错、日志里也
 * 一个字都没有——用户的感受就是"发了消息没有返回"，且无从排查。
 *
 * 口径：**没有正文就不是成功**。这里按现场证据给出可执行的原因，而不是一句"失败了"：
 *   1. 有思考痕迹（思考内容或思考 token）→ 额度被思考吃满，抬高上限或换非思考模型；
 *   2. `content_filter` → 上游内容过滤，改措辞/系统提示；
 *   3. `length` → 触发了输出上限；
 *   4. 其余 → 上游返回空流，可以重试。
 */
export function emptyCompletionError(facts: EmptyCompletionFacts): NormalizedError {
  const {
    stopReason,
    contentChars,
    reasoningChars,
    completionTokens,
    reasoningTokens,
  } = facts;
  const thinkEvidence = reasoningTokens > 0 || reasoningChars > 0;
  const stop = stopReason ? `finish_reason=${stopReason}` : '上游没有给 finish_reason';
  const budget = completionTokens > 0 ? `${completionTokens} token` : '未知用量';

  if (thinkEvidence) {
    const spent = reasoningTokens > 0 ? `${reasoningTokens} token` : `${reasoningChars} 字`;
    return {
      code: 'UPSTREAM_ERROR',
      message:
        `上游只产出了思考内容，没有正文：${spent} 花在思考上，输出额度共 ${budget}（${stop}）。` +
        '思考 token 与正文共用同一个「上限」，把右栏「上限」调大（例如 4096）或改用非思考模型后重试。',
      // 同样的参数重试还是同样的结果，所以不标可重试——要改的是额度
      retryable: false,
    };
  }

  if (stopReason === 'content_filter') {
    return {
      code: 'UPSTREAM_ERROR',
      message: `上游因内容过滤没有返回正文（${stop}）。请调整措辞或系统提示后重试。`,
      retryable: false,
    };
  }

  if (stopReason === 'length') {
    return {
      code: 'UPSTREAM_ERROR',
      message: `上游达到输出上限但没有返回正文（${stop}，共 ${budget}）。请把「上限」调大后重试。`,
      retryable: false,
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: `上游返回了空内容（${stop}，正文 ${contentChars} 字）。可以重试，或检查模型名与端点是否匹配。`,
    retryable: true,
  };
}
