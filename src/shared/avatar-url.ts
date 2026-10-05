/**
 * 头像 URL 的构造（技术方案 5.4 / 产品文档 3.2）。
 *
 * 角色卡图片存在 `userData/avatars/` 下，DB 里只记录**相对路径**（`avatars/xxx.png`）。
 * 界面要显示它就需要一个 URL，但生产 CSP 是 `img-src 'self' data:`——
 * `file://` 会被直接拦掉。所以这里约定一个**自有协议**，
 * 主进程侧的同名 handler 负责把 URL 映射回磁盘文件并校验路径
 * （见 `src/main/avatars.ts`，那边是安全边界，必须拒绝目录穿越）。
 *
 * 本文件刻意不 import 任何 `node:` 模块：renderer 也要用它拼 URL。
 *
 * URL 形状：`cottage-avatar://local/avatars/xxx.png`
 *   - host 固定为 `local`，只是为了让 `standard` 协议能正常解析；
 *   - 路径部分就是 DB 里的相对路径（逐段 encodeURIComponent）。
 */
/** 自有协议的 scheme 名（CSP 与主进程 handler 都引用它，避免两处写字符串写歪）。 */
export const AVATAR_SCHEME = 'cottage-avatar';

/** 固定的 host 占位（不表示任何真实主机）。 */
export const AVATAR_HOST = 'local';

/**
 * 相对路径 → 可放进 `<img src>` 的 URL。
 *
 * 返回 `null` 表示"没有图片"，调用方应回退到灰色占位块，而不是渲染一个坏 `<img>`。
 */
export function buildAvatarUrl(avatarPath: string | null | undefined): string | null {
  if (typeof avatarPath !== 'string') return null;
  const trimmed = avatarPath.trim();
  if (!trimmed) return null;
  // 反斜杠统一成斜杠：DB 里是相对路径，但 Windows 侧可能写进来反斜杠
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return null;
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  return `${AVATAR_SCHEME}://${AVATAR_HOST}/${encoded}`;
}
