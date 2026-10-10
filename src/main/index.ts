/**
 * 主进程入口（技术方案 3.2 / 7.6）。
 *
 * 启动顺序是刻意的，每一步都有理由：
 *
 * ```
 *   单实例锁            ← SQLite 单写者假设下不能有两个实例同时写库
 *   app.whenReady()
 *     打开数据库        ← 早于 IPC 注册，避免"窗口能发消息但库还没开"
 *     执行迁移
 *     清扫残留 streaming ← 早于 IPC 注册，否则窗口可能先读到"生成中"（验收项 10）
 *     注册 IPC
 *     创建窗口
 * ```
 *
 * 另外两条纪律（技术方案 3.2）：
 *   - 单窗口 + `requestSingleInstanceLock()`。
 *   - 主进程**不得吞异常**：未捕获异常必须落日志（已脱敏）并让 UI 可见。
 */
import { BrowserWindow, app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EVENT } from '@shared/ipc.js';
import { AVATAR_SCHEME } from '@shared/avatar-url.js';
import { makeError } from '@core/providers/errors.js';
import { log, recentLogLines } from './log.js';
import { abortAll, createAppContext, emitEvent, type AppContext } from './context.js';
import { resolveAvatarRequest } from './avatars.js';
import { openBetterSqlite3Driver } from './db/better-sqlite3-driver.js';
import { migrate } from './db/migrations/index.js';
import { sweepStreamingMessages } from './db/dao/messages.js';
import { registerIpc, setAppVersion, setMainWindow } from './ipc/index.js';
import { createMainWindow } from './window.js';

/*
 * 头像协议必须在 app ready **之前**登记为 privileged。
 *
 * `standard: true` 很关键：否则 `cottage-avatar://local/a/b.png` 会被当成 opaque path，
 * URL 解析拿不到正常的 host/path，主进程侧的路径校验就没法按段判断。
 * 这里只是声明协议身份，真正的文件读取在 ready 之后的 handler 里做。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: AVATAR_SCHEME, privileges: { standard: true, secure: true } },
]);

/** 单窗口引用：IPC 事件推送需要一个明确的收件人。 */
let mainWindow: BrowserWindow | null = null;
let ctx: AppContext | null = null;

/**
 * SQLite 单写者假设：两个实例同时写库会互相锁死。
 * 第二个实例立刻退出，并把已存在的窗口拉到前台。
 *
 * 注意"没拿到锁"有两种完全不同的原因，而 Electron 不区分：
 *   1. 确实已有实例在跑 —— 正常路径，本进程安静退出即可；
 *   2. 锁文件/命名对象创建失败（受限的环境、被占用的 userData 等）—— 异常路径。
 *
 * 以前这里只写 `app.quit()`，于是第 2 种情况的表象是"进程瞬间退出、退出码 0、
 * 不建库、不打一行字"，排查时几乎无从下手（实测就踩过：Chromium 报
 * `process_singleton_win.cc ... Lock file can not be created! Error code: 5`，
 * 但那条日志只在 stderr 且很容易被忽略）。所以这里把决定和原因显式写出来，
 * 代价是一行输出，收益是整个失败模式可诊断。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.warn(
    '启动中止',
    '未取得单实例锁：可能已有实例在运行；也可能是锁文件无法创建（受限环境 / userData 不可写）。',
  );
  for (const line of recentLogLines()) console.error(line);
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(bootstrap).catch(reportFatal);
}

async function bootstrap(): Promise<void> {
  setAppVersion(app.getVersion());

  // ---- 1. 打开数据库（DB 路径只在主进程解析） ----
  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, 'cottage.db');
  const db = openBetterSqlite3Driver({ file: dbPath });
  ctx = createAppContext(db, dbPath, userDataDir);
  log.info('数据库已打开', { dbPath });

  // ---- 2. 迁移（幂等，重复启动不做事） ----
  const migration = migrate(db);
  if (migration.applied.length) {
    log.info('已应用迁移', `${migration.from} → ${migration.to}：${migration.applied.join(', ')}`);
  }

  // ---- 3. 崩溃清扫：把残留的 streaming 改成 interrupted ----
  // 必须在注册 IPC 之前，否则窗口可能先读到"生成中"的旧状态
  const swept = sweepStreamingMessages(db, Date.now());
  if (swept > 0) log.info(`已清扫 ${swept} 条残留的生成中消息，标记为已中断`);

  // ---- 4. 注册 IPC ----
  registerIpc(ctx);

  // ---- 4.5 头像协议：cottage-avatar:// → userData/avatars/ ----
  // 只放行这一个目录，且由 resolveAvatarRequest 拒绝目录穿越与不在白名单的扩展名。
  // 因此 renderer 拿到的是一个"能显示角色卡图片"的通道，而不是读任意本地文件的能力。
  protocol.handle(AVATAR_SCHEME, async (request) => {
    const resolved = resolveAvatarRequest(userDataDir, request.url);
    if (!resolved) return new Response(null, { status: 404 });
    try {
      const data = await readFile(resolved.filePath);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': resolved.contentType, 'cache-control': 'no-cache' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  // ---- 5. 主进程未捕获异常必须可见 ----
  installGlobalErrorHandlers();

  // ---- 6. 建窗口 ----
  const window = createMainWindow();
  mainWindow = window;
  // 让原生对话框（导入角色卡等）归主窗口所有并保持模态，见 ipc/index.ts 的 dialogParent
  setMainWindow(window);
  ctx.emit = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  window.on('closed', () => {
    mainWindow = null;
    setMainWindow(null);
    // 窗口关了就中断所有在飞的流，避免后台继续写入
    if (ctx) abortAll(ctx);
  });

  /*
   * 这一行是**契约**，不只是日志：scripts/smoke-electron.mjs 以它作为"启动成功"的判据。
   * 因此必须留在整条启动链的最后一步之后。
   *
   * 为什么非要有它：在这行存在之前，冒烟测试只能拿"数据库已打开"当真，而那是**迁移之前**
   * 打的日志。于是"开完库、迁移、然后 IPC 注册抛错"这种失败会被判为通过——实测踩过一次
   * （`export:character-card` 通道缺 handler），应用实际起不来却显示绿。
   */
  log.info('启动完成', { windowId: window.id });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      setMainWindow(mainWindow);
      if (ctx) {
        ctx.emit = (channel, payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
        };
      }
    }
  });
}

/**
 * 未捕获异常与未处理的 Promise 拒绝。
 *
 * 不弹原生对话框（会阻塞主进程），而是推事件让 UI 显示——这就是技术方案 3.2
 * "让 UI 可见"的具体做法。
 */
function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常', err);
    if (ctx) emitEvent(ctx, EVENT.appError, makeError('UNKNOWN', err.message));
  });

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', reason);
    if (ctx) {
      emitEvent(
        ctx,
        EVENT.appError,
        makeError('UNKNOWN', reason instanceof Error ? reason.message : String(reason)),
      );
    }
  });
}

function reportFatal(err: unknown): void {
  log.error('启动失败', err);
  // 启动阶段连窗口都没有，只能靠 stderr + 退出码
  for (const line of recentLogLines()) console.error(line);
  app.exit(1);
}

// 所有窗口关闭即退出（macOS 除外，符合平台习惯）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前中断在飞的流，避免写入到一半
app.on('before-quit', () => {
  if (ctx) abortAll(ctx);
});
