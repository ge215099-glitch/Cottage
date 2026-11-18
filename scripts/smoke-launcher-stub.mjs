#!/usr/bin/env node
/**
 * 冒烟测试用的**哑 Electron** —— 不是应用代码，谁的运行时都别引用它。
 *
 * `scripts/smoke-launcher.mjs` 用 `ELECTRON_EXEC_PATH` + `ELECTRON_ENTRY` 把
 * electron-vite 要起的"Electron"换成这个脚本，于是能**在无图形界面、而且不需要真窗口**
 * 的情况下验证启动器的整条链路：
 *
 *   1. 子进程的输出确实落进了 `logs/dev.log`（哑 Electron 打的就绪日志能被找到）；
 *   2. 「启动完成」被判成就绪 → 关掉"应用"后启动器退出码是 0，不弹失败提示；
 *   3. 锁文件在启动时写入、在退出时清掉（不会第二次双击就被自己的残锁挡住）。
 *
 * 这套"用哑进程替代 Electron"的做法与 `scripts/verify-dev-server.mjs` 一致：
 * 真 Electron 能不能起来由 `scripts/smoke-electron.mjs` 负责，两个脚本各管一半。
 *
 * 环境变量：
 *   COTTAGE_STUB_MODE=ready|crash   ready：打就绪日志后常驻；crash：打一行错就退出 1
 *   COTTAGE_STUB_PID_FILE=<路径>     把自己的 pid 写进去（便于确认进程真的没了）
 *   COTTAGE_STUB_CLOSE_FILE=<路径>   该文件一出现就退出 0（模拟"用户关掉窗口"）
 *
 * 就绪日志的格式**必须**能被 `scripts/smoke-electron.mjs` 的 `READY_PATTERNS` 匹配：
 * 那份常量是"主进程日志 ↔ 冒烟判据"之间唯一的契约，这里刻意复用它而不是另写一份。
 */
import { existsSync, writeFileSync } from 'node:fs';

const mode = process.env['COTTAGE_STUB_MODE'] ?? 'ready';
const pidFile = process.env['COTTAGE_STUB_PID_FILE'];
const closeFile = process.env['COTTAGE_STUB_CLOSE_FILE'];

if (pidFile) {
  try {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  } catch {
    /* 写不了就当没这个功能 */
  }
}

if (mode === 'crash') {
  // 与真实主进程的失败形态对齐：一行错、然后非 0 退出，永远不打「启动完成」
  console.error('[error] 启动失败 {"reason":"哑 Electron 按 COTTAGE_STUB_MODE=crash 故意失败"}');
  process.exit(1);
}

// 模拟主进程"建完窗口"之后打的那条日志
console.log('[info] 启动完成 {"windowId":1}');

const timer = setInterval(() => {
  if (closeFile && existsSync(closeFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 100);

// 被外部杀掉时不要让 Node 打出难看的堆栈
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
