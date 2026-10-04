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
import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import { EVENT } from '@shared/ipc.js';
import { makeError } from '@core/providers/errors.js';
import { log, recentLogLines } from './log.js';
import { abortAll, createAppContext, emitEvent, type AppContext } from './context.js';
import { openBetterSqlite3Driver } from './db/better-sqlite3-driver.js';
import { migrate } from './db/migrations/index.js';
import { sweepStreamingMessages } from './db/dao/messages.js';
import { registerIpc, setAppVersion } from './ipc/index.js';
import { createMainWindow } from './window.js';

/** 单窗口引用：IPC 事件推送需要一个明确的收件人。 */
let mainWindow: BrowserWindow | null = null;
let ctx: AppContext | null = null;

/**
 * SQLite 单写者假设：两个实例同时写库会互相锁死。
 * 第二个实例立刻退出，并把已存在的窗口拉到前台。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
  const dbPath = path.join(app.getPath('userData'), 'cottage.db');
  const db = openBetterSqlite3Driver({ file: dbPath });
  ctx = createAppContext(db, dbPath);
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

  // ---- 5. 主进程未捕获异常必须可见 ----
  installGlobalErrorHandlers();

  // ---- 6. 建窗口 ----
  mainWindow = createMainWindow();
  ctx.emit = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 窗口关了就中断所有在飞的流，避免后台继续写入
    if (ctx) abortAll(ctx);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
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
