/**
 * 窗口与安全策略（技术方案 6.3）。
 *
 * 这些取值不是"建议"，是硬约束——每一条都能在上面的表格里找到理由：
 *   - `contextIsolation: true`：渲染进程不可触达 preload 作用域。
 *   - `nodeIntegration: false`：渲染进程无 Node 能力。
 *   - `sandbox: true`：**把模型输出当不可信内容对待**（这是本产品的实际威胁模型：
 *     角色卡的 first_mes、模型回答都是外部输入）。
 *   - CSP：生产与开发两套，构造逻辑在 `csp.ts`（不依赖 electron，可直接单测）。
 *   - 外链一律 deny，正文里的链接交给 `shell.openExternal` 且只允许 http/https。
 *   - 拦截 `will-navigate`，只允许应用自身。
 *   - **不装配原生菜单栏**：Windows / Linux 上不出现 `File / Edit / View / Window / Help`
 *     那一条（策略与理由见 `app-menu.ts`）。
 */
import { BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { appMenuTemplate } from './app-menu.js';
import { buildContentSecurityPolicy, isInternalNavigation } from './csp.js';
import { log } from './log.js';

/** 开发模式下 electron-vite 会注入这个变量；生产为空。 */
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'] ?? null;

/** 只允许这两种协议的链接用系统浏览器打开。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function createMainWindow(): BrowserWindow {
  /*
   * 菜单栏必须在**建窗口之前**定下来。
   *
   * 置空之后系统不会再画那一条；如果反过来（先建窗口再置空），Windows 上会经历
   * "菜单已经画上去、又消失"的一帧。这里也不依赖 Electron 的默认菜单会不会被装上——
   * 自己显式装配一次，Windows / Linux 拿到的就是 `null`（见 `app-menu.ts`）。
   */
  const menuTemplate = appMenuTemplate(process.platform);
  Menu.setApplicationMenu(menuTemplate ? Menu.buildFromTemplate(menuTemplate) : null);

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    // UI 文档第 9 节的自适应下限：再小就进入浮层侧栏档，而不是把主区压塌
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Cottage',
    webPreferences: {
      // preload 与 main 一样输出到 out/<name>/index.js（见 electron.vite.config.ts 的说明）
      preload: path.join(__dirname, '../preload/index.js'),
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
  // 按模式构造：生产是 connect-src 'none'（renderer 不许发请求），
  // 开发必须放行 dev server 与它的 WebSocket，否则 HMR 不工作。
  const policy = buildContentSecurityPolicy(DEV_SERVER_URL);
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
  log.info('已下发 CSP', DEV_SERVER_URL ? '开发模式（已放行 dev server 与 HMR）' : '生产模式');

  // ---- 导航与窗口打开策略 ----
  window.webContents.setWindowOpenHandler(({ url }) => {
    // 一律拒绝在应用窗口内打开新页面
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isInternalNavigation(url, DEV_SERVER_URL)) {
      event.preventDefault();
      openExternalIfSafe(url);
      log.warn('已拦截窗口内导航', url);
    }
  });

  // 渲染进程崩溃要能看见，不能静默白屏
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('渲染进程异常退出', details);
  });

  /*
   * 菜单栏去掉之后，`View → Toggle Developer Tools` 与它的 F12 / ⌘⌥I 也一起没了。
   * 生产环境这是想要的（成品不该带开发者入口），但 `pnpm dev` 的调试仍需一条路径，
   * 所以**只在开发模式**（有 dev server 时）补一个快捷键。
   */
  if (DEV_SERVER_URL) {
    window.webContents.on('before-input-event', (event, input) => {
      const isToggle =
        input.type === 'keyDown' &&
        (input.key === 'F12' ||
          ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'));
      if (!isToggle) return;
      event.preventDefault();
      window.webContents.toggleDevTools();
    });

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
