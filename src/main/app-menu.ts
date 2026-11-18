/**
 * 原生应用菜单栏策略。
 *
 * 背景：只要没有调用过 `Menu.setApplicationMenu`，Electron 就自动装一份默认菜单，
 * Windows / Linux 上的表现是标题栏下面横着一条 `File / Edit / View / Window / Help`。
 * 那五项对 Cottage 全是样板：File 里只有退出、Edit 里是复制粘贴、View 里是
 * reload / toggleDevTools、Window 是最小化与关闭。产品自己**没有任何菜单项要放**
 * （动作全在界面里，见 `ui-design-sidebar-chat.md` 第 12 节），而一个中文优先的界面
 * 顶着一条英文系统菜单，看起来像半成品。所以：
 *
 *   - **Windows / Linux（`null`）**：不装配菜单栏。复制/粘贴/全选/撤销这些编辑快捷键
 *     由 Chromium 自己在输入框里处理，去掉菜单不影响它们。
 *   - **macOS（三组）**：**不能置空**。那一条菜单栏同时承担 ⌘C / ⌘V / ⌘Q / ⌘W 这些
 *     **系统级**快捷键，置空之后连复制粘贴都会失效。因此只留应用菜单（关于 / 退出）、
 *     编辑（复制粘贴）、窗口（最小化 / 缩放 / 关闭）三组，其余照旧去掉。
 *
 * 判断做成**不依赖 electron 运行时值的纯函数**：一来 `Menu` / `BrowserWindow` 只在
 * 主进程里存在，二来"Windows 上不给菜单"这条决定因此能在纯 Node 单测里断言
 * （`test/app-menu.test.ts`），不必把 Electron 拉起来。
 */
import type { MenuItemConstructorOptions } from 'electron';

/** macOS 上必须保留的三组系统菜单（`role` 由 Electron 自己填文案与快捷键）。 */
const DARWIN_SYSTEM_MENU: MenuItemConstructorOptions[] = [
  { role: 'appMenu' },
  { role: 'editMenu' },
  { role: 'windowMenu' },
];

/**
 * 要装配的应用菜单；返回 `null` 表示"不要菜单栏"。
 *
 * 返回副本而不是共享的那份常量：调用方拿到的是 `MenuItemConstructorOptions[]`，
 * 免得某天有人在建模板时顺手改一个字段，把"下一次建窗口"也一起改了。
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return DARWIN_SYSTEM_MENU.map((item) => ({ ...item }));
}
