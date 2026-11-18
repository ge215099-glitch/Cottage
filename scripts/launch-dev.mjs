#!/usr/bin/env node
/**
 * Cottage 开发启动器 —— **桌面快捷方式指向的那个东西**。
 *
 * ## 它解决什么
 *
 * 以前启动应用要开一个终端敲 `pnpm dev`，于是应用窗口后面永远挂着一个黑色控制台窗口。
 * 那个黑框**不是应用的一部分**，它是 `electron-vite dev` 的终端：
 *
 *   - 它跑 Vite dev server（5173 端口，renderer 的 HMR 靠它）；
 *   - 它监听源码、重建 main / preload、必要时重启 Electron；
 *   - 它把主进程的 `safeLog` 输出（含「启动完成」这条就绪标志）打在自己身上。
 *
 * 也就是说：黑框里的内容**有用**（开发反馈），黑框**这个窗口**没用。本脚本把这两件事拆开——
 * 用 `windowsHide` + 文件描述符重定向，把子进程的输出**直接写进 `logs/dev.log`**，
 * 于是既没有窗口，也没有丢掉日志。桌面快捷方式（`scripts/create-desktop-shortcut.mjs`
 * 生成）通过 `scripts/launch-dev.vbs` 调本脚本：wscript 是 GUI 子系统程序，
 * 起进程时不闪任何控制台窗口。
 *
 * ## 为什么用文件描述符，而不是 stdio: 'pipe'
 *
 * 子进程的 stdout / stderr 直接接在**日志文件的 fd** 上（`stdio: ['ignore', fd, fd]`）：
 *
 *   1. 没有管道就没有"父进程死了日志就断"的问题，子进程写日志不经过本进程内存；
 *   2. 受限环境（例如被沙箱限制命名管道的环境）里 `pipe` 会直接 EPERM，fd 不会；
 *   3. `electron-vite` 内部是用 `stdio: 'inherit'` 起 Electron 的，父进程接文件，
 *      子进程的 `inherit` 自然就跟着落到同一个文件里——包括「启动完成」。
 *
 * ## 退出码（决定快捷方式会不会弹失败提示）
 *
 *   0 = 正常情况下走到应用退出；或检测到"已有实例在运行"
 *   1 = **启动失败**（没等到「启动完成」就退了、CLI 找不到、spawn 失败）
 *
 * 失败时除了非 0 退出码，还会把原因 + 日志尾部写进 `logs/dev-failure.txt`——
 * 黑框可以没有，但"为什么没起来"不能没有：`scripts/launch-dev.vbs` 会把它弹出来。
 *
 * 用法：
 *   node scripts/launch-dev.mjs            # 或 pnpm launch
 *   COTTAGE_LAUNCH_DIR=<目录>              # 换掉 logs/ 的位置（冒烟测试用）
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FATAL_PATTERNS, READY_PATTERNS } from './smoke-electron.mjs';
import { electronViteCli } from './verify-dev-server.mjs';

/** 运行时产物的目录名（相对仓库根）。 */
export const RUNTIME_DIR_NAME = 'logs';

/** 覆盖运行时目录的环境变量（冒烟测试用它把产物丢到临时目录，不碰真实日志）。 */
export const RUNTIME_DIR_ENV = 'COTTAGE_LAUNCH_DIR';

export const LOG_FILE_NAME = 'dev.log';
export const LOCK_FILE_NAME = 'dev-launcher.lock';
export const FAILURE_FILE_NAME = 'dev-failure.txt';

/** 日志超过这个体量就轮转一次（只留一份 `.1` 备份，不做无限堆积）。 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 失败说明里附带的日志尾部长度（按字符算）。 */
export const FAILURE_TAIL_CHARS = 3000;

/** 超过这个时间还没等到「启动完成」就只在日志里提醒一句，**不杀进程**（慢机器上首轮构建就是慢）。 */
export const SLOW_STARTUP_WARN_MS = 45_000;

/** 轮询日志的间隔。 */
export const POLL_INTERVAL_MS = 250;

/**
 * "已有实例在运行"的特征。
 *
 * 主进程拿不到单实例锁时会打「未取得单实例锁」（见 src/main/index.ts）；Electron 自己
 * 也会吐 `second-instance`。这种退出**不是失败**：用户双击两次快捷方式不该看到错误弹窗。
 */
export const DUPLICATE_INSTANCE_PATTERNS = [/未取得单实例锁/, /second-instance/];

/**
 * 启动器自己写的行都带这个前缀。
 *
 * **这不是装饰，是防自欺**：启动器会往同一个日志文件里写"等待「启动完成」…"这类说明，
 * 而"就绪"的判据正是 /启动完成/——不把自家这些行剔掉，启动器就会**用自己的说明**
 * 证明自己成功了。这不是假想：第一版就是这么写坏的，失败路径（哑 Electron 直接崩）
 * 被判决为"启动成功、退出码 0"，`scripts/smoke-launcher.mjs` 当场抓住。
 */
export const LAUNCHER_LINE_PREFIX = '[launcher] ';

/** 仓库根（本文件在 `<repo>/scripts/` 下）。 */
export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 运行时目录：默认 `<repo>/logs`，可用 COTTAGE_LAUNCH_DIR 覆盖。 */
export function resolveRuntimeDir({ env = process.env, repoRoot = defaultRepoRoot() } = {}) {
  const custom = env[RUNTIME_DIR_ENV];
  return custom ? path.resolve(custom) : path.join(repoRoot, RUNTIME_DIR_NAME);
}

/** 运行时目录里的三个文件。 */
export function runtimePaths(runtimeDir) {
  return {
    runtimeDir,
    logFile: path.join(runtimeDir, LOG_FILE_NAME),
    lockFile: path.join(runtimeDir, LOCK_FILE_NAME),
    failureFile: path.join(runtimeDir, FAILURE_FILE_NAME),
  };
}

/** 解析锁文件内容；坏内容当作没有锁。 */
export function parseLock(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data.pid === 'number' && Number.isInteger(data.pid) && data.pid > 0) {
      return { pid: data.pid, startedAt: String(data.startedAt ?? ''), repoRoot: String(data.repoRoot ?? '') };
    }
  } catch {
    /* 半截写入 / 手工改坏：当作没有锁 */
  }
  return null;
}

/** 进程是否还活着（EPERM 说明进程存在但没权限发信号，同样算"活着"）。 */
export function isProcessAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 已有实例时该干什么（纯函数）。
 *
 * 只看"锁里的 pid 还活着"这一件事：活着的 pid 才说明真有一个启动器在跑。
 * 锁文件是启动器自己写的，启动器被杀（例如任务管理器结束进程）会留下残锁，
 * 但那种情况下 pid 已死，这里会照常放行并覆盖它。
 */
export function decideOnLock({ lock, processAlive }) {
  if (lock && processAlive) {
    return { action: 'already-running', reason: `已有实例在运行（启动器 pid ${lock.pid}）` };
  }
  if (lock) {
    return { action: 'start', reason: `发现残留锁（pid ${lock.pid} 已退出），照常启动` };
  }
  return { action: 'start', reason: '' };
}

/** 日志是否该轮转。 */
export function shouldRotate(size, max = LOG_MAX_BYTES) {
  return Number.isFinite(size) && size >= max;
}

/** 轮转日志：`dev.log` → `dev.log.1`（覆盖旧的那份）。 */
export function rotateLog(logFile) {
  try {
    if (!existsSync(logFile)) return false;
    if (!shouldRotate(statSync(logFile).size)) return false;
    renameSync(logFile, `${logFile}.1`);
    return true;
  } catch {
    // 轮转失败不该挡住启动：继续往原文件追加就是了
    return false;
  }
}

/** 取文本尾部（失败说明里只放得下这么多）。 */
export function tailChars(text, max = FAILURE_TAIL_CHARS) {
  const clean = String(text).replace(/\u001b\[[0-9;]*m/g, '').trim();
  return clean.length > max ? clean.slice(-max) : clean;
}

/** 读整个日志文件；读不到就当空（文件可能还没建、也可能正被删）。 */
export function readLogText(logFile) {
  try {
    return readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 只取**本次会话**之后写入的那段日志。
 *
 * 为什么要按会话头切一刀：日志是跨启动累积的，上一次成功启动留下的「启动完成」
 * 会让这一次的失败被误判成成功（真出过一次这种"绿得发亮"的假通过，见
 * scripts/smoke-electron.mjs 文件头）。会话头里带 pid 与时间戳，重复概率可忽略。
 */
export function sessionText(logFile, sessionToken) {
  const text = readLogText(logFile);
  const at = text.lastIndexOf(sessionToken);
  return at === -1 ? '' : text.slice(at);
}

/**
 * 剔除启动器自己写的那几行，只留应用（electron-vite / Electron 主进程）的输出。
 *
 * 判据（就绪 / 致命 / 重复实例）**只能**在这份文本上做，理由见 LAUNCHER_LINE_PREFIX。
 */
export function appOutput(text) {
  return String(text)
    .split('\n')
    .filter((line) => !line.startsWith(LAUNCHER_LINE_PREFIX))
    .join('\n');
}

/** 本次会话头。 */
export function sessionHeader({ pid = process.pid, now = new Date() } = {}) {
  return `=== Cottage 开发启动 ${now.toISOString()} pid=${pid} ===`;
}

/** 输出里是否出现了"已有实例在运行"的特征。 */
export function isDuplicateInstanceOutput(text) {
  return DUPLICATE_INSTANCE_PATTERNS.some((re) => re.test(text));
}

/**
 * 子进程退出后怎么判（纯函数）。
 *
 * 顺序有意为之：
 *   1. 见过「启动完成」→ 应用确实起来过，之后怎么退出（关窗口、被强杀）都不是**启动**失败；
 *   2. 见过"未取得单实例锁"→ 已有实例在运行，属于正常路径，双击第二次不该报错；
 *   3. 其余情况都是启动失败——这正是需要弹窗让人看见的那一类。
 */
export function classifyLauncherExit({ ready, duplicateInstance, code, signal }) {
  if (ready) {
    return { exitCode: 0, failureReason: null, note: `应用已退出（退出码 ${code ?? signal}）` };
  }
  if (duplicateInstance) {
    return { exitCode: 0, failureReason: null, note: '已有实例在运行，本次启动未新建实例' };
  }
  return {
    exitCode: 1,
    failureReason: `Electron 没有打印「启动完成」就退出了（退出码 ${code ?? signal}）`,
    note: '',
  };
}

/** 拼失败说明（给弹窗 / 给人看）。 */
export function buildFailureReport({ reason, logFile, logTail, hint = '' }) {
  const lines = [
    'Cottage 启动失败。',
    '',
    `原因：${reason}`,
  ];
  if (hint) lines.push(`建议：${hint}`);
  lines.push('', `完整日志：${logFile}`);
  if (logTail) lines.push('', '--- 日志尾部 ---', logTail);
  return `${lines.join('\n')}\n`;
}

/**
 * 往日志里追加一行启动器自己的说明。
 *
 * 前面**先补一个换行**：应用那边的输出可能停在没有换行的半行上，不补的话本行会跟
 * 它粘在一起，`appOutput()` 的按行前缀过滤就会失效——那正是防自欺机制的漏洞。
 * 同时也打到自己的 stdout（在终端里直接跑 `pnpm launch` 时看得见）。
 */
function note(logFile, message) {
  const line = `\n${LAUNCHER_LINE_PREFIX}${message}\n`;
  try {
    writeFileSync(logFile, line, { flag: 'a' });
  } catch {
    /* 日志写不进去也不能让启动器自己崩掉 */
  }
  process.stdout.write(`${LAUNCHER_LINE_PREFIX}${message}\n`);
  return message;
}

/** 收集子进程退出。 */
function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, error: null }));
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

/** 主流程：返回进程退出码。 */
export async function launch({ repoRoot = defaultRepoRoot(), env = process.env, kill = process.kill } = {}) {
  const runtimeDir = resolveRuntimeDir({ env, repoRoot });
  mkdirSync(runtimeDir, { recursive: true });
  const { logFile, lockFile, failureFile } = runtimePaths(runtimeDir);

  // ---- 1. 已有实例就别再起一个 ----
  let lock = null;
  try {
    lock = parseLock(readFileSync(lockFile, 'utf8'));
  } catch {
    /* 没有锁文件 */
  }
  const decision = decideOnLock({ lock, processAlive: lock ? isProcessAlive(lock.pid, kill) : false });
  if (decision.action === 'already-running') {
    note(logFile, `· ${decision.reason}，本次启动忽略（双击第二次不会起第二个 dev server）`);
    return 0;
  }

  // ---- 2. 日志轮转 + 会话头 ----
  rotateLog(logFile);
  const sessionToken = sessionHeader();
  note(logFile, sessionToken);
  if (decision.reason) note(logFile, `· ${decision.reason}`);
  // 上一次的失败说明先清掉，避免"这次没失败却弹了上次的错"
  rmSync(failureFile, { force: true });

  // ---- 3. 找 electron-vite 的 CLI ----
  const cli = electronViteCli(repoRoot);
  if (!cli) {
    const reason = '找不到 electron-vite 的 CLI（node_modules 不完整）';
    const hint = '在仓库目录执行 pnpm install 后重试。';
    note(logFile, `✗ ${reason}`);
    writeFileSync(failureFile, buildFailureReport({ reason, logFile, logTail: '', hint }), 'utf8');
    return 1;
  }

  // ---- 4. 起 dev server：stdout / stderr 直接接日志文件的 fd ----
  const childEnv = { ...env };
  // ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node，主进程拿到 undefined 的 app
  // （见 scripts/smoke-electron.mjs 的同款处理），必须清掉。
  delete childEnv['ELECTRON_RUN_AS_NODE'];

  const fd = openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [cli, 'dev'], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', fd, fd],
      // 关键：不给子进程建控制台窗口（黑框的来历就是它）
      windowsHide: true,
    });
  } catch (err) {
    closeSync(fd);
    const reason = `无法启动 electron-vite：${err instanceof Error ? err.message : String(err)}`;
    note(logFile, `✗ ${reason}`);
    writeFileSync(failureFile, buildFailureReport({ reason, logFile, logTail: '' }), 'utf8');
    return 1;
  }
  // 子进程已经拿到自己的副本，父进程这份可以关掉
  closeSync(fd);

  // ---- 5. 记锁（锁里的 pid 是 electron-vite 的 pid：它还活着就说明应用这套东西在跑） ----
  writeFileSync(
    lockFile,
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), repoRoot }, null, 2)}\n`,
    'utf8',
  );
  note(logFile, `· 已启动 electron-vite（pid ${child.pid}），等待「启动完成」…`);

  // ---- 6. 盯日志：就绪 / 致命 / 重复实例（只看应用自己的输出，见 LAUNCHER_LINE_PREFIX） ----
  let ready = false;
  let fatal = '';
  let warned = false;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const text = appOutput(sessionText(logFile, sessionToken));
    if (!ready && READY_PATTERNS.some((re) => re.test(text))) {
      ready = true;
      note(logFile, `· 就绪：主进程已建窗口（耗时 ${Date.now() - startedAt}ms）`);
    }
    if (!fatal) {
      for (const pattern of FATAL_PATTERNS) {
        if (pattern.test(text)) {
          fatal = String(pattern);
          break;
        }
      }
    }
    if (!warned && !ready && Date.now() - startedAt > SLOW_STARTUP_WARN_MS) {
      warned = true;
      note(logFile, `· 已经 ${SLOW_STARTUP_WARN_MS / 1000}s 还没等到「启动完成」，继续等（慢机器首轮构建会慢）`);
    }
  }, POLL_INTERVAL_MS);

  const { code, signal, error } = await waitForExit(child);
  clearInterval(timer);

  // ---- 7. 收尾：退出前再读一次日志，避免最后一次写入没被看到 ----
  const finalText = appOutput(sessionText(logFile, sessionToken));
  if (!ready && READY_PATTERNS.some((re) => re.test(finalText))) {
    ready = true;
    note(logFile, '· 就绪：主进程已建窗口（在退出前最后一次读取时发现）');
  }
  const duplicateInstance = isDuplicateInstanceOutput(finalText);
  rmSync(lockFile, { force: true });

  const verdict = classifyLauncherExit({ ready, duplicateInstance, code, signal });
  if (verdict.exitCode === 0) {
    note(logFile, `· ${verdict.note}`);
    return 0;
  }

  const reason = error
    ? `启动 electron-vite 失败：${error.message}`
    : fatal
      ? `${verdict.failureReason}；输出命中致命特征 ${fatal}`
      : verdict.failureReason;
  const hint = '先看日志尾部；依赖没装好时执行 pnpm install（原生模块见 pnpm rebuild:native）。';
  note(logFile, `✗ ${reason}`);
  writeFileSync(
    failureFile,
    buildFailureReport({ reason, logFile, logTail: tailChars(finalText), hint }),
    'utf8',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // 启动器自己出错：也得留下痕迹，否则黑框没了之后就彻底静默了
      process.exitCode = 1;
      try {
        const repoRoot = defaultRepoRoot();
        const runtimeDir = resolveRuntimeDir({ repoRoot });
        mkdirSync(runtimeDir, { recursive: true });
        const { logFile, failureFile } = runtimePaths(runtimeDir);
        const reason = `启动器自身出错：${err instanceof Error ? err.stack ?? err.message : String(err)}`;
        writeFileSync(logFile, `✗ ${reason}\n`, { flag: 'a' });
        writeFileSync(failureFile, buildFailureReport({ reason, logFile, logTail: '' }), 'utf8');
      } catch {
        // 连日志都写不下去：至少让终端里的调用方看见
        process.stderr.write(`✗ Cottage 启动器出错：${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
}
