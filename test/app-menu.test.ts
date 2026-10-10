/**
 * 原生菜单栏策略测试（`src/main/app-menu.ts`）。
 *
 * 守的是什么：Windows / Linux 的窗口里**不该出现** `File / Edit / View / Window / Help`
 * 那一条。Electron 只要没被显式告知，就会自动装上这份默认菜单，所以"没写代码"并不
 * 等于"没有菜单栏"——这条断言必须存在，否则哪天有人把 `Menu.setApplicationMenu`
 * 那两行删掉，界面上会悄悄长回一条英文菜单，而**没有任何测试会红**。
 *
 * 为什么是"纯函数 + 静态锚点"两层：
 *   - 纯函数那层能真跑：`appMenuTemplate` 刻意不 import electron 的运行时值，
 *     所以"Windows 上返回 null、macOS 上返回哪三组"可以在纯 Node 下断言。
 *   - `window.ts` 那层跑不了：它 `import { BrowserWindow }`，在 vitest 里拿不到真
 *     Electron（也不该为此拉起整个 Electron）。于是照 `test/ipc-registration.test.ts`
 *     的做法读源码断言——证明的是"建窗口的路径确实按这个决定装配了菜单"，
 *     不证明 Electron 渲染出来的菜单栏长什么样（那属于冒烟/E2E 的事）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appMenuTemplate } from '../src/main/app-menu.js';

const windowSource = readFileSync(path.join(process.cwd(), 'src/main/window.ts'), 'utf8');

describe('应用菜单栏：Windows / Linux 上一整条都不要', () => {
  it('win32 与 linux 都不装配应用菜单', () => {
    expect(appMenuTemplate('win32')).toBeNull();
    expect(appMenuTemplate('linux')).toBeNull();
  });

  it('其余平台同样按"非 macOS 即无菜单"处理（不需要为每个平台单独登记）', () => {
    expect(appMenuTemplate('freebsd')).toBeNull();
    expect(appMenuTemplate('openbsd')).toBeNull();
  });
});

describe('应用菜单栏：macOS 只留系统级三组', () => {
  it('保留应用 / 编辑 / 窗口三组（⌘C、⌘V、⌘Q 靠它们）', () => {
    const roles = appMenuTemplate('darwin')?.map((item) => item.role);
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu']);
  });

  it('返回的是副本：调用方改模板不会污染下一次建窗口', () => {
    const first = appMenuTemplate('darwin')!;
    first[0]!.label = '被改过的';
    expect(appMenuTemplate('darwin')![0]!.label).toBeUndefined();
  });
});

describe('窗口创建路径真的按这个决定装配菜单（静态锚点）', () => {
  it('window.ts 引用了 appMenuTemplate 并调用 Menu.setApplicationMenu', () => {
    expect(windowSource).toContain("from './app-menu.js'");
    expect(windowSource).toContain('appMenuTemplate(process.platform)');
    expect(windowSource).toMatch(/Menu\.setApplicationMenu\(/);
  });

  it('装配发生在建窗口之前（先定菜单栏，再画窗口）', () => {
    const setMenu = windowSource.indexOf('Menu.setApplicationMenu(');
    const createWindow = windowSource.indexOf('new BrowserWindow({');
    expect(setMenu).toBeGreaterThan(-1);
    expect(createWindow).toBeGreaterThan(-1);
    expect(setMenu).toBeLessThan(createWindow);
  });

  it('开发者工具入口只在开发模式注册（生产不带这条路径）', () => {
    // 菜单栏没了，View → Toggle Developer Tools 也没了；dev 下补的那一个必须
    // 关在 DEV_SERVER_URL 分支里，否则成品会给用户一个开发者入口。
    const guard = windowSource.indexOf('if (DEV_SERVER_URL) {');
    const toggle = windowSource.indexOf('toggleDevTools()');
    expect(toggle).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(toggle);
    expect(windowSource.match(/toggleDevTools\(\)/g)).toHaveLength(1);
  });
});
