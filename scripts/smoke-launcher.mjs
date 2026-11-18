#!/usr/bin/env node
/**
 * 开发启动器（`scripts/launch-dev.mjs` + 桌面快捷方式指向的 `launch-dev.vbs`）的冒烟测试。
 *
 * ## 存在的理由
 *
 * 启动器是**唯一一个跑起来之后看不见任何东西**的入口：黑框被有意去掉了，所以
 * "它到底有没有把应用拉起来、失败时有没有留下痕迹"只能靠证据说话。这里不打印"通过"
 * 就完事，而是真的把启动器跑一遍，验三件事：
 *
 *   1. **正常路径**：应用起来（日志里出现应用打的「启动完成」）→ 关掉应用 → 启动器退出码 0、
 *      锁清掉、dev server 也真的没了（否则会留一个占着 5173 的孤儿）。
 *   2. **重复双击**：应用已经在跑时再点一次快捷方式 → 立刻退出 0，**不会**起第二个
 *      dev server，也不会覆盖锁；用户不该因为双击两次就看到错误弹窗。
 *   3. **失败路径**：起不来的时候必须留下 `logs/dev-failure.txt` 并退出非 0。
 *      黑框可以没有，但"为什么没起来"不能没有——那正是这个文件存在的全部意义。
 *
 * ## 为什么不需要图形界面
 *
 * 用 `ELECTRON_EXEC_PATH` / `ELECTRON_ENTRY` 把 electron-vite 要起的 Electron
 * 换成一个哑进程（`scripts/smoke-launcher-stub.mjs`），与
 * `scripts/verify-dev-server.mjs` 是同一个套路：本脚本验的是**启动器这条链路**
 * （隐藏启动、日志落盘、就绪判定、锁、退出码），真 Electron 能不能起来由
 * `scripts/smoke-electron.mjs` 负责，两个脚本各管一半，谁都不假装覆盖另一半。
 *
 * ## 环境受限时**不假装通过**
 *
 * `electron-vite` / Vite 要靠 esbuild 起子进程。在禁止创建子进程的环境里（实测：
 * 沙箱下 `spawn EPERM`，栈里能看到 `esbuild` 的 `ensureServiceIsRunning`），
 * 这条链路根本跑不起来——**那不是启动器坏了**。此时本脚本照 `scripts/smoke-electron.mjs`
 * 的规矩办：明确打印"**未能完成校验**"并说明原因，绝不打印"通过"。
 * CI 上要求严格可设 `COTTAGE_SMOKE_STRICT=1`，那时环境受限按失败处理。
 *
 * 用法：node scripts/smoke-launcher.mjs
 * 退出码：0 = 三条路径全部符合预期，或环境受限（默认不算失败）；1 = 有不符合的
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAILURE_FILE_NAME,
  LOCK_FILE_NAME,
  LOG_FILE_NAME,
  isProcessAlive,
  parseLock,
} from './launch-dev.mjs';
import { READY_PATTERNS } from './smoke-electron.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 冷启动要跑三段构建 + Vite，给足 90 秒。 */
export const READY_TIMEOUT_MS = 90_000;

/** 关掉"应用"之后，启动器与 dev server 都该收干净。 */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

/** 重复双击、以及"启动器自己判成就绪"的等待上限。 */
export const SHORT_TIMEOUT_MS = 20_000;

/** 失败路径：起不来应该很快，但冷构建可能拖一会儿。 */
export const FAILURE_TIMEOUT_MS = 90_000;

const POLL_INTERVAL_MS = 200;

/**
 * 等"应用真的打出就绪日志"时用的特征。
 *
 * 为什么不直接用 `READY_PATTERNS`：启动器自己也会往同一个日志文件里写
 * "等待「启动完成」…"这种说明，拿 /启动完成/ 去匹配原始日志会**匹配到启动器的说明**，
 * 于是"应用到底起来没有"就没被验到（启动器第一版正是这样自己骗过了自己，
 * 所以它现在用 appOutput() 剔除自家那几行；本脚本同样得看应用侧的完整日志形态）。
 */
export const STUB_READY_PATTERN = /\[info\] 启动完成/;

/** 启动器自己判定"就绪"时写的那行。 */
export const LAUNCHER_READY_NOTE = /\[launcher\] · 就绪/;

/**
 * "环境受限"的特征：子进程建不起来（沙箱 / 受限目录）。
 *
 * 与启动器本身的对错无关，所以既不能报"通过"，也不该报成启动器的缺陷。
 */
export const ENVIRONMENT_BLOCKED_PATTERNS = [
  { re: /spawn EPERM/i, why: '无权创建子进程（spawn EPERM）：esbuild / Vite 起不来' },
  { re: /esbuild[\s\S]{0,200}EPERM|EPERM[\s\S]{0,200}esbuild/i, why: 'esbuild 无法启动它的服务进程' },
];

/** 判定日志里是否出现了"环境受限"。 */
export function detectEnvironmentBlock(logText) {
  for (const { re, why } of ENVIRONMENT_BLOCKED_PATTERNS) {
    if (re.test(logText)) return why;
  }
  return null;
}

/** 轮询直到条件成立或超时。 */
async function waitFor(predicate, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 起一个启动器进程（stdio 用 ignore：受限环境里管道会 EPERM，而这里不需要它的输出）。 */
function startLauncher(env) {
  return spawn(process.execPath, [path.join(repoRoot, 'scripts', 'launch-dev.mjs')], {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** 等子进程退出，拿到退出码。 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

/** 哑 Electron 的环境：把 electron-vite 要起的 Electron 换成 stub，并把日志/锁丢进临时目录。 */
export function stubEnv({ runtimeDir, mode = 'ready', pidFile, closeFile, base = process.env }) {
  const env = {
    ...base,
    // 不碰仓库里真实的 logs/，也不碰真实 userData
    COTTAGE_LAUNCH_DIR: runtimeDir,
    ELECTRON_EXEC_PATH: process.execPath,
    ELECTRON_ENTRY: path.join(repoRoot, 'scripts', 'smoke-launcher-stub.mjs'),
    ELECTRON_CLI_ARGS: '[]',
    COTTAGE_STUB_MODE: mode,
    COTTAGE_STUB_PID_FILE: pidFile,
    COTTAGE_STUB_CLOSE_FILE: closeFile,
  };
  // 主进程若以纯 Node 模式跑起来，`electron.app` 会是 undefined（见 smoke-electron.mjs）
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

/** 一次检查的临时目录与文件。 */
function makeWorkspace(prefix) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    runtimeDir,
    logFile: path.join(runtimeDir, LOG_FILE_NAME),
    lockFile: path.join(runtimeDir, LOCK_FILE_NAME),
    failureFile: path.join(runtimeDir, FAILURE_FILE_NAME),
    pidFile: path.join(runtimeDir, 'stub.pid'),
    closeFile: path.join(runtimeDir, 'stub.close'),
  };
}

/**
 * 哑 Electron 打的那行必须真的能被 `READY_PATTERNS` 认出。
 *
 * 两边是同一份契约的两端：启动器认 `READY_PATTERNS`（来自 smoke-electron.mjs），
 * 哑 Electron 模仿真实主进程打日志。这条断言把"模仿得像不像"钉住，
 * 否则哑 Electron 说一套、启动器认另一套，本脚本会变成永远为真的假通过。
 */
function checkStubLogContract(issues) {
  const sample = '[info] 启动完成 {"windowId":1}';
  if (!STUB_READY_PATTERN.test(sample)) {
    issues.push('哑 Electron 的就绪日志形态变了，本脚本等的特征已经不匹配');
  }
  if (!READY_PATTERNS.some((re) => re.test(sample))) {
    issues.push('哑 Electron 的就绪日志匹配不上启动器用的 READY_PATTERNS，链路根本没被验证');
  }
}

/** 正常路径 + 重复双击。返回环境受限的原因（没有则 null）。 */
async function checkHappyPath(issues, logs) {
  const ws = makeWorkspace('cottage-launch-');
  let child = null;
  let childExit = null;
  try {
    child = startLauncher(stubEnv({ runtimeDir: ws.runtimeDir, pidFile: ws.pidFile, closeFile: ws.closeFile }));

    const ready = await waitFor(
      () => STUB_READY_PATTERN.test(readText(ws.logFile)),
      READY_TIMEOUT_MS,
    );
    if (!ready) {
      const log = readText(ws.logFile);
      logs.push(log);
      const blocked = detectEnvironmentBlock(log);
      if (blocked) return blocked;
      issues.push(`正常路径：${READY_TIMEOUT_MS}ms 内日志里没有出现应用打出的「启动完成」`);
      return null;
    }

    // 应用侧证据有了，还得确认启动器**自己也**判成了就绪：否则它会把成功当失败，
    // 关掉应用之后弹一个假错误。
    const launcherSawReady = await waitFor(
      () => LAUNCHER_READY_NOTE.test(readText(ws.logFile)),
      SHORT_TIMEOUT_MS,
    );
    if (!launcherSawReady) {
      issues.push('正常路径：应用已打出「启动完成」，但启动器没有记录自己判成就绪');
    }

    const lock = parseLock(readText(ws.lockFile));
    if (!lock) {
      issues.push('正常路径：应用起来了，但锁文件没写出来（重复双击就挡不住了）');
      return null;
    }
    const lockPid = lock.pid;
    if (!isProcessAlive(lock.pid)) {
      issues.push(`正常路径：锁里的 pid ${lock.pid} 不是活进程，锁的语义不对`);
    }

    // ---- 重复双击：必须立刻退出 0、不起第二个实例、不覆盖锁 ----
    const second = startLauncher(
      stubEnv({ runtimeDir: ws.runtimeDir, pidFile: ws.pidFile, closeFile: ws.closeFile }),
    );
    const secondExit = await waitForExit(second, SHORT_TIMEOUT_MS);
    if (secondExit.timedOut) {
      second.kill();
      issues.push('重复双击：第二个启动器没有退出，可能会出现两个 dev server 抢端口');
    } else if (secondExit.code !== 0) {
      issues.push(`重复双击：第二个启动器退出码 ${secondExit.code}，应当是 0（用户没做错什么）`);
    }
    if (!/已有实例在运行/.test(readText(ws.logFile))) {
      issues.push('重复双击：日志里没有「已有实例在运行」的记录，挡没挡住无从判断');
    }
    const lockAfterSecond = parseLock(readText(ws.lockFile));
    if (!lockAfterSecond || lockAfterSecond.pid !== lockPid) {
      issues.push('重复双击：锁被第二个启动器覆盖了，原实例的退出将清不掉它');
    }

    // ---- 模拟"用户关掉窗口"：哑 Electron 见到 close 文件即退出 ----
    writeFileSync(ws.closeFile, '');
    childExit = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
    if (childExit.timedOut) {
      child.kill();
      issues.push(`正常路径：关掉应用后启动器 ${SHUTDOWN_TIMEOUT_MS}ms 内没有退出（会留下孤儿进程）`);
      return null;
    }
    if (childExit.code !== 0) {
      issues.push(
        `正常路径：应用正常退出后启动器退出码是 ${childExit.code}，应当是 0（否则快捷方式会弹失败提示）`,
      );
    }
    if (existsSync(ws.lockFile)) {
      issues.push('正常路径：启动器退出后锁文件还在，下次双击会被自己的残锁挡住');
    }
    if (existsSync(ws.failureFile)) {
      issues.push('正常路径：写下了失败说明，说明被误判成启动失败了');
    }
    if (isProcessAlive(lockPid)) {
      issues.push(`正常路径：dev server（pid ${lockPid}）还活着，成了占着 5173 的孤儿`);
    }
    if (!/应用已退出/.test(readText(ws.logFile))) {
      issues.push('正常路径：日志里没有退出记录，日志不再能说明"这套东西什么时候结束的"');
    }
    return null;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childExit === null && child) await waitForExit(child, 5_000);
    rmSync(ws.runtimeDir, { recursive: true, force: true });
  }
}

/** 失败路径：起不来时必须留下痕迹。返回环境受限的原因（没有则 null）。 */
async function checkFailurePath(issues, logs) {
  const ws = makeWorkspace('cottage-launch-fail-');
  let child = null;
  try {
    child = startLauncher(
      stubEnv({ runtimeDir: ws.runtimeDir, mode: 'crash', pidFile: ws.pidFile, closeFile: ws.closeFile }),
    );
    const exit = await waitForExit(child, FAILURE_TIMEOUT_MS);
    if (exit.timedOut) {
      child.kill();
      issues.push(`失败路径：启动器 ${FAILURE_TIMEOUT_MS}ms 内没有退出（失败被挂住了）`);
      return null;
    }

    const log = readText(ws.logFile);
    const report = readText(ws.failureFile);
    // 环境受限时 electron-vite 压根没跑到哑 Electron 那一步：这一轮不算数
    const blocked = detectEnvironmentBlock(log);
    if (blocked && !report.includes('哑 Electron')) {
      logs.push(log);
      return blocked;
    }

    if (exit.code !== 1) {
      issues.push(`失败路径：退出码是 ${exit.code}，应当是 1（非 0 才会触发快捷方式的失败提示）`);
    }
    if (!report) {
      issues.push('失败路径：没有写下 logs/dev-failure.txt —— 黑框没有了，这等于彻底静默');
      return null;
    }
    for (const [needle, why] of [
      ['Cottage 启动失败', '失败说明缺少标题'],
      ['启动完成', '失败说明里没有引用「启动完成」这条判据'],
      ['--- 日志尾部 ---', '失败说明里没有日志尾部，等于让人自己去猜'],
      ['启动失败', '失败说明的日志尾部没带上子进程的输出'],
    ]) {
      if (!report.includes(needle)) issues.push(`失败路径：${why}（找不到「${needle}」）`);
    }
    if (existsSync(ws.lockFile)) {
      issues.push('失败路径：失败退出后锁文件还在，下次双击会被残锁挡住');
    }
    if (!log.includes('✗')) {
      issues.push('失败路径：日志里没有失败记录（✗）');
    }
    return null;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(ws.runtimeDir, { recursive: true, force: true });
  }
}

async function run() {
  const issues = [];
  const logs = [];
  checkStubLogContract(issues);

  process.stdout.write('· 正常路径（启动 → 就绪 → 关掉应用 → 收干净）…\n');
  const blockedHappy = await checkHappyPath(issues, logs);
  process.stdout.write('· 失败路径（起不来 → 必须留下失败说明）…\n');
  const blockedFail = blockedHappy ? blockedHappy : await checkFailurePath(issues, logs);

  const blocked = blockedHappy ?? blockedFail;
  if (blocked && issues.length === 0) {
    const strict = process.env['COTTAGE_SMOKE_STRICT'] === '1';
    console.log(`⚠ 开发启动器冒烟测试**未能完成校验**：${blocked}`);
    console.log('  含义：当前环境不允许创建子进程（或不允许 esbuild 起服务），');
    console.log('        electron-vite / Vite 起不来——这与启动器本身的对错无关。');
    console.log('  完全没有被验证的部分：隐藏启动、日志落盘、就绪判定、锁、退出码、失败说明。');
    console.log(
      strict
        ? '  COTTAGE_SMOKE_STRICT=1：按失败处理。'
        : '  默认按"环境受限"处理（退出 0）；CI 上要求严格请设 COTTAGE_SMOKE_STRICT=1。',
    );
    if (logs[0]) console.log(`\n--- 启动器日志尾部 ---\n${logs[0].slice(-1500)}`);
    process.exit(strict ? 1 : 0);
  }

  if (issues.length) {
    console.error('✗ 开发启动器冒烟测试失败：');
    for (const issue of issues) console.error(`  - ${issue}`);
    if (logs[0]) console.error(`\n--- 启动器日志尾部 ---\n${logs[0].slice(-1500)}`);
    process.exit(1);
  }

  console.log('✓ 开发启动器冒烟测试通过');
  console.log('  隐藏启动：子进程输出落进 logs/dev.log，日志里能看到「启动完成」与退出记录');
  console.log('  重复双击：第二个启动器立刻退出 0，不起第二个 dev server、不覆盖锁');
  console.log('  收尾：应用退出后启动器退出码 0、锁清掉、dev server 进程也没了');
  console.log('  失败路径：退出码 1 且写下 logs/dev-failure.txt（供 scripts/launch-dev.vbs 弹出来）');
  console.log('  （真实 Electron 能否起来由 scripts/smoke-electron.mjs 验证）');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error('✗ 启动器冒烟测试自身出错', err);
    process.exit(1);
  });
}
