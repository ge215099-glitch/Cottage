/**
 * 文件名净化：会话标题会被用作导出文件名，必须去掉路径分隔符。
 * 单独成文件是为了能在纯 Node 下测试（`ipc/index.ts` import 了 electron）。
 */
import { basename } from 'node:path';

export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base.length ? base.slice(0, 80) : 'cottage-export';
}
