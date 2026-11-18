/**
 * 主键与时间戳。
 *
 * 不用 `crypto.randomUUID`：它要 import `node:crypto`，会让 DAO 无法在纯 Node 测试与
 * 渲染预览之间共用。这里用"时间前缀 + 随机后缀 + 单进程内自增"，排序友好且无依赖。
 */

let counter = 0;

/** 生成一个单调递增、可按创建时间大致排序的主键。 */
export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(3, '0');
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(36)
    .padStart(5, '0');
  return `${prefix}_${time}${seq}${rand}`;
}

export const ID_PREFIX = {
  provider: 'prv',
  character: 'chr',
  persona: 'per',
  conversation: 'cnv',
  message: 'msg',
  summary: 'sum',
} as const;
