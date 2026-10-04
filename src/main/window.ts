/**
 * 窗口与安全策略（技术方案 6.3）。
 *
 * 这些取值不是"建议"，是硬约束——每一条都能在上面的表格里找到理由：
 *   - `contextIsolation: true`：渲染进程不可触达 preload 作用域。
 *   - `nodeIntegration: false`：渲染进程无 Node 能力。
 *   - `sandbox: true`：**把模型输出当不可信内容对待**（这是本产品的实际威胁模型：
 *     角色卡的 first_mes、模型回答都是外部输入）。
 *   - CSP `default-src 'self'` / `img-src 'self' data:` / 禁 `unsafe-eval`：
 *     阻断模型输出里的外链图片与脚本。
 *   - 外链一律 deny，正文里的链接交给 `shell.openExternal` 且只允许 http/https。
 *   - 拦截 `will-navigate`，只允许应用自身。
 */
import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

/** 开发模式下 electron-vite 会注入这个变量。 */
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

/** 只允许这两种协议的链接用系统浏览器打开。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 内容安全策略。
 *
 * 注意 `connect-src 'none'`：renderer **不允许发任何网络请求**——
 * DB 与 API 调用只在主进程（技术方案 4.2 的 renderer 禁止项）。
 * 这条比"靠 code review 拦住"可靠得多。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // 样式需要允许内联：React 的 style 属性与我们的主题变量都靠它
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    // UI 文档 9 节的自适应下限：再小就进入浮层侧栏档，而不是把主区压塌
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Cottage',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 明确关掉不需要的能力，缩小攻击面
      webviewTag: false,
      spellcheck: false,
    },
  });

  // 首帧就绪后再显示，避免白闪
  window.once('ready-to-show', () => window.show());

  // ---- CSP ----
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });

  // ---- 导航与窗口打开策略 ----
  window.webContents.setWindowOpenHandler(({ url }) => {
    // 一律拒绝在应用窗口内打开新页面
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : false;
    const isSelf = url.startsWith('file://');
    if (!allowed && !isSelf) {
      event.preventDefault();
      openExternalIfSafe(url);
      log.warn('已拦截窗口内导航', url);
    }
  });

  // 渲染进程崩溃要能看见，不能静默白屏
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('渲染进程异常退出', details);
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}

/** 只把 http/https 交给系统浏览器；其余协议（file:、javascript:…）直接丢弃。 */
export function openExternalIfSafe(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    log.warn('已拒绝打开非 http(s) 链接', parsed.protocol);
    return;
  }
  void shell.openExternal(url).catch((err: unknown) => log.warn('打开外链失败', err));
}

/** 供 electron-vite 定位 preload 目录时复用。 */
export const PRELOAD_DIR = fileURLToPath(new URL('../preload', import.meta.url));
