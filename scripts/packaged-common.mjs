#!/usr/bin/env node
/**
 * 打包类冒烟测试的共享工具（smoke-packaged.mjs 与 smoke-portable.mjs 共用）。
 *
 * 为什么单独一个文件：这两个脚本原先互相 import（portable 从 packaged 借判据），
 * 而各自末尾都有"是否作为主模块运行"的判断。那个判断在 import 场景下不可靠——
 * `process.argv[1]` 仍是调用方脚本、但 `import.meta.url` 是被导入文件，
 * 某些调用方式下会让**被导入的那个脚本把自己的 run() 也执行一遍**。
 * 症状很隐蔽：跑 smoke-portable 输出的却是 smoke-packaged 的内容。
 * 共享代码放到这里，两个入口各自只 import 纯函数，就没有这个耦合了。
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这个模块是不是被**直接执行**的（而不是被 import 进来）。
 *
 * 为什么不用 `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`：
 * 那种写法在 import 场景下会误判——被导入文件里的 `import.meta.url` 是它自己，
 * 但 `process.argv[1]` 是调用方脚本，两者本该不等；然而一旦某个脚本忘了这层判断、
 * 或者判断写歪，**被导入的脚本会把自己的 run() 也执行一遍**。
 * 实测症状：跑 `smoke-portable.mjs` 输出的却是 `smoke-packaged.mjs` 的内容。
 *
 * 这里统一成一个函数，两个入口都用它，避免再各写一份出偏差。
 */
export function isMainModule(metaUrl) {
  const script = process.argv[1];
  if (!script) return false;
  return path.resolve(script) === fileURLToPath(metaUrl);
}

/** SQLite 文件头，用来证明"建出来的确实是一个合法 SQLite 库"。 */
export const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * 应用真实的 userData 目录（Windows 上是 %APPDATA%\<productName>）。
 * 仅供**只读判断**使用：任何测试都不允许改写它（见 smoke-packaged.mjs 的事故记录）。
 */
export function defaultUserDataDir(env = process.env) {
  const appData = env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Cottage');
}

/** 读文件头若干字节。 */
export function headBytes(file, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** 同步等待若干毫秒。 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 结束整棵进程树（Electron 会派生 GPU / 渲染子进程，只杀主进程会留下孤儿窗口）。 */
export function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill();
}

/**
 * 是否有残留的本项目 Electron / Cottage 进程占着单实例锁。
 *
 * 为什么必须查：残留的子进程（GPU / utility / renderer）会一直持有
 * `%APPDATA%\Cottage\lockfile`，此时新启动的实例会判定"已有实例在运行"、
 * 正常退出（退出码 0），测试就永远等不到建库——而不是报出真实原因。
 */
export function findBlockingProcesses() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'Cottage.exe' or Name = 'electron.exe'\" | " +
        'Where-Object { $_.CommandLine -like "*Cottage*" } | ' +
        'Select-Object -ExpandProperty ProcessId',
    ],
    { encoding: 'utf8' },
  );
  return (result.stdout ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

/**
 * 跑一次打包后的应用，直到建库 / 致命 / 超时。
 *
 * @param {{
 *   exe: string,
 *   dbPath: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   verbose?: boolean,
 *   cwd?: string,
 *   requireAlive?: boolean,
 * }} opts
 *   `requireAlive`：是否要求"建库时主进程仍存活"。安装版（dist/win-unpacked 里的
 *   Cottage.exe）成立；**免安装版不成立**——portable 的壳是 GUI 子系统的自解压器，
 *   它会拉起真正的应用后自己立即退出（退出码 0、无输出），所以那里必须传 false。
 *
 * @returns {Promise<{verdict: string, detail: string, output: string, dbPath: string}>}
 */
export async function runApp({
  exe,
  dbPath,
  args = [],
  timeoutMs = 60_000,
  verbose = false,
  cwd,
  requireAlive = true,
}) {
  const { spawn } = await import('node:child_process');
  const { statSync } = await import('node:fs');
  const { FATAL_PATTERNS } = await import('./smoke-electron.mjs');

  const env = { ...process.env };
  // 不能继承 ELECTRON_RUN_AS_NODE：若为 1，Electron 会以纯 Node 模式跑，
  // `require('electron').app` 是 undefined，报错看起来像 IPC 问题。
  delete env['ELECTRON_RUN_AS_NODE'];

  const child = spawn(exe, args, {
    cwd: cwd ?? path.dirname(exe),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let fatal = null;
  const onData = (chunk) => {
    const text = chunk.toString();
    output += text;
    if (verbose) process.stdout.write(`  [app] ${text}`);
    for (const pattern of FATAL_PATTERNS) {
      if (pattern.test(text)) fatal = `输出命中致命模式 ${pattern}`;
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = `exit:${code ?? signal}`;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fatal) break;
    if (existsSync(dbPath) && statSync(dbPath).size > 0) {
      // 再多等一拍，确认不是建到一半就崩
      await new Promise((r) => setTimeout(r, 800));
      const alive = child.exitCode === null && child.signalCode === null;
      if (requireAlive) killTree(child);
      else killByName(exe);
      return {
        verdict: alive || !requireAlive ? 'ready' : 'crashed-after-db',
        detail: alive || !requireAlive ? '已建库' : `建库后进程退出（${exitInfo}）`,
        output,
        dbPath,
      };
    }
    // 要求存活的场景（安装版）一旦退出就没戏了；免安装版壳退出是正常现象，继续等
    if (exitInfo && requireAlive) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (requireAlive) killTree(child);
  else killByName(exe);
  if (fatal) return { verdict: 'fatal', detail: fatal, output, dbPath };
  if (exitInfo) return { verdict: 'exited', detail: `进程提前退出（${exitInfo}）且未建库`, output, dbPath };
  if (/0x80000003/i.test(output)) {
    return { verdict: 'sandbox-init', detail: 'Chromium 进程沙箱初始化失败（0x80000003）', output, dbPath };
  }
  return { verdict: 'timeout', detail: `${timeoutMs}ms 内没有建出 cottage.db`, output, dbPath };
}

/**
 * 按镜像名结束本项目的残留进程。
 *
 * 用途：免安装版的壳退出后，真正的应用还在跑（且不是我们的直接子进程），
 * 只能按名字收尾，否则会一直占着单实例锁，影响后续测试。
 */
export function killByName(exe) {
  if (process.platform !== 'win32') return;
  const image = path.basename(exe);
  spawnSync('taskkill', ['/IM', image, '/T', '/F'], { stdio: 'ignore' });
}

/** 输出尾部若干字符（用于失败时打印应用日志）。 */
export function tail(text, limit = 3000) {
  return text.length > limit ? text.slice(-limit) : text;
}
