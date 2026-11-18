/**
 * 文件名净化：会话标题会被用作导出文件名，必须去掉路径分隔符。
 * 单独成文件是为了能在纯 Node 下测试（`ipc/index.ts` import 了 electron）。
 */
import { basename, extname } from 'node:path';

export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base.length ? base.slice(0, 80) : 'cottage-export';
}

/**
 * 保存路径缺扩展名时补上。
 *
 * 为什么需要：Windows 的保存对话框会按"保存类型"自动补扩展名，但**用户可以
 * 手输文件名覆盖它**，其它平台更是默认不补。补一个缺失的扩展名是为了让文件
 * 双击能打开；用户明确写了别的扩展名就尊重他，不硬改。
 */
export function withExportExtension(filePath: string, extension: string): string {
  return extname(filePath) ? filePath : `${filePath}.${extension}`;
}
