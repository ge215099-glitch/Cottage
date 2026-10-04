/**
 * `src/core` 的错误类型。core 不依赖 `src/shared`（依赖方向见 tech-stack 4.2），
 * 因此这里定义自己的一层错误，由主进程在 IPC 边界翻译成对外的 NormalizedError。
 */

export type CoreErrorCode =
  | 'CONTEXT_OVERFLOW'
  | 'EMPTY_ASSEMBLY'
  | 'INVALID_CHARACTER_CARD'
  | 'UNSUPPORTED_PROVIDER';

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: CoreErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.detail = detail;
  }
}
