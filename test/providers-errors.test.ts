/**
 * `core/providers/errors` 的单元测试。
 *
 * 这里只挑**会决定用户体验**的那部分来钉：`emptyCompletionError`——
 * 「上游正常收流但正文为空」怎么判定、给出什么文案。
 *
 * 为什么它值得单独一个文件：这条判定曾经不存在。实测事故（deepseek-flash + 上限 1024）
 * 里，思考 token 把输出额度吃满、正文为空，上游却是 200 正常收流；当时编排层把它当成功，
 * 用户看到的是"发了消息没有返回"，而且没有任何可查的痕迹。判据与文案现在都收在这个纯函数里，
 * 于是"什么时候算失败、失败要说什么"可以被逐条断言，而不是散在编排代码里靠人记。
 */
import { describe, expect, it } from 'vitest';

import { emptyCompletionError, makeError, redactSecrets } from '../src/core/providers/errors.js';

describe('emptyCompletionError：正文为空的现场判定', () => {
  it('有思考痕迹（思考 token）→ 指向"额度被思考吃满"，并给出可执行建议', () => {
    const error = emptyCompletionError({
      stopReason: 'length',
      contentChars: 0,
      reasoningChars: 9,
      completionTokens: 1024,
      reasoningTokens: 1024,
    });
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toContain('思考');
    expect(error.message).toContain('1024 token');
    expect(error.message).toContain('finish_reason=length');
    expect(error.message).toContain('上限');
    // 同样的参数重试还是同样的结果：不该引导用户去点"重试"
    expect(error.retryable).toBe(false);
  });

  it('只有思考内容、但没有思考 token 统计时，用字数兜底', () => {
    const error = emptyCompletionError({
      stopReason: 'length',
      contentChars: 0,
      reasoningChars: 512,
      completionTokens: 1024,
      reasoningTokens: 0,
    });
    expect(error.message).toContain('512 字');
  });

  it('content_filter → 指向内容过滤，而不是让用户去调上限', () => {
    const error = emptyCompletionError({
      stopReason: 'content_filter',
      contentChars: 0,
      reasoningChars: 0,
      completionTokens: 30,
      reasoningTokens: 0,
    });
    expect(error.message).toContain('内容过滤');
    expect(error.message).not.toContain('思考');
    expect(error.retryable).toBe(false);
  });

  it('length 但没有思考痕迹 → 仍是"调大上限"', () => {
    const error = emptyCompletionError({
      stopReason: 'length',
      contentChars: 0,
      reasoningChars: 0,
      completionTokens: 1024,
      reasoningTokens: 0,
    });
    expect(error.message).toContain('输出上限');
    expect(error.retryable).toBe(false);
  });

  it('没有任何线索 → 说明是空内容，并允许重试', () => {
    const error = emptyCompletionError({
      contentChars: 0,
      reasoningChars: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
    expect(error.message).toContain('空内容');
    expect(error.message).toContain('没有给 finish_reason');
    expect(error.retryable).toBe(true);
  });

  it('文案里不带任何上游原始内容（它只由计数与结束原因拼出来）', () => {
    const error = emptyCompletionError({
      stopReason: 'stop',
      contentChars: 0,
      reasoningChars: 0,
      completionTokens: 10,
      reasoningTokens: 0,
    });
    expect(error.message).not.toMatch(/sk-|Bearer/i);
  });
});

describe('既有错误工具（顺带锁住行为）', () => {
  it('redactSecrets 抹掉密钥形态', () => {
    expect(redactSecrets('Authorization: Bearer sk-abcdefghijklmn')).not.toContain('sk-abcdefghijklmn');
  });

  it('makeError 也会过一遍脱敏', () => {
    expect(makeError('UNKNOWN', 'key=sk-abcdefghijklmn').message).not.toContain('sk-abcdefghijklmn');
  });
});
