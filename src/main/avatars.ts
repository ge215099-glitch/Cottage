/**
 * 头像协议的主进程侧：把 `cottage-avatar://local/...` 映射回磁盘文件。
 *
 * **本文件是安全边界**，所以刻意独立、且不 import electron：路径校验必须能被
 * 单元测试直接断言（目录穿越、绝对路径、畸形编码……），而不是只能"跑起来试试"。
 *
 * 威胁模型：renderer 里运行的任何东西（包括模型输出渲染出的内容）都能构造一个
 * `cottage-avatar://` URL。如果这里不校验，它就能读到 `userData` 之外的任意文件，
 * 而 `img-src` 白名单恰好放行了这个协议。所以规则只有一条：
 * **解析结果必须落在 `<userData>/avatars/` 之内**，否则一律拒绝。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AVATAR_HOST, AVATAR_SCHEME } from '@shared/avatar-url.js';

/** 允许的图片类型 → Content-Type。不在表里的一律拒绝。 */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 头像目录名（product-design 3.2：文件存 `userData/avatars/`）。 */
export const AVATAR_DIR = 'avatars';

export interface ResolvedAvatar {
  filePath: string;
  contentType: string;
}

/**
 * 请求 URL → 磁盘文件。
 *
 * 返回 `null` 表示"拒绝"（协议不对、host 不对、路径穿越、扩展名不在白名单、文件不存在），
 * 调用方应当回一个 4xx，而不是回退到别的目录去找。
 */
export function resolveAvatarRequest(
  userDataDir: string,
  requestUrl: string,
): ResolvedAvatar | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${AVATAR_SCHEME}:`) return null;
  // host 必须是我们约定的占位值；`cottage-avatar://evil/...` 直接拒
  if (url.hostname !== AVATAR_HOST) return null;

  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    // 畸形百分号编码（例如 "%zz"）会让 decodeURIComponent 抛错
    return null;
  }

  relative = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative) return null;
  // NUL 字节可以截断底层系统调用的路径
  if (relative.includes('\0')) return null;

  /*
   * DB 里存的就是**相对 userData 的路径**（`avatars/xxx.png`，产品文档 3.2），
   * URL 里带的也是它，所以这里对 userData 求绝对路径——不要再去拼一次 `avatars/`，
   * 那会得到 `userData/avatars/avatars/xxx.png`。
   * 之后再用 path.relative 检查它确实落在 `avatars/` 之内。
   */
  const avatarRoot = path.resolve(userDataDir, AVATAR_DIR);
  const target = path.resolve(userDataDir, relative);

  // 关键一步：解析之后必须仍在 avatars/ 之内。
  // 用 path.relative 判断，而不是 startsWith——后者会把 `<root>-evil` 也放过去。
  const rel = path.relative(avatarRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()];
  if (!contentType) return null;
  if (!existsSync(target)) return null;

  return { filePath: target, contentType };
}
