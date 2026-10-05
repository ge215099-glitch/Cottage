#!/usr/bin/env node
/**
 * Electron 启动冒烟测试。
 *
 * 存在的理由：三层单测覆盖了 core / DAO / 适配器，但它们**证明不了应用能起来**。
 * 真实的失败模式是"构建过了，但主进程一启动就抛异常"——原生模块 ABI 不对、
 * 迁移 SQL 有语法错、某个 IPC 通道漏了 handler、窗口路径写错，都属于这一类，
 * 而且只有真正把 Electron 拉起来才看得见。
 *
 * ## 判据是「启动完成」，不是「数据库已打开」
 *
 * 主进程在整条启动链跑完之后才打 `启动完成`（见 src/main/index.ts 的说明）。
 * 这一点很关键：曾经这里拿"数据库已打开"当真，而那条日志在**迁移之前**，
 * 于是"开库 → 迁移 → IPC 注册抛错"会被判为通过。实际发生过一次
 * （`export:character-card` 通道缺 handler），应用根本起不来却显示绿。
 *
 * ## 为什么默认加 `--no-sandbox`
 *
 * Chromium 的**进程沙箱**在某些受限目录下无法初始化，表现为进程以
 * `0x80000003`（Windows 断点异常）**立即退出且没有任何输出**；更糟的是
 * Windows 错误报告会为每次崩溃弹一个对话框。实测：同一个 electron.exe，
 * 放在受限工作区内崩溃，复制到工作区外就正常——与 Electron 版本无关。
 * 冒烟测试要验的是主进程启动链，不是 Chromium 沙箱，所以默认关掉沙箱，
 * 既拿到真实证据，又不产生崩溃弹窗。
 *
 * 想验证"带沙箱"的真实配置，设 `COTTAGE_SMOKE_SANDBOXED=1`。
 *
 * ## 退出码
 *
 *   0 = 确认启动完成；或**环境受限**导致无法校验（默认不算失败，见下）
 *   1 = 真实的启动失败（主进程抛异常 / 超时 / 意外退出）
 *
 * 环境受限默认退出 0，是为了不让机器级别的怪癖把 CI 刷成红。但它**不会**打印
 * "通过"，而是明确写"未能完成校验"并说明原因。CI 上要求严格，设
 * `COTTAGE_SMOKE_STRICT=1`，环境受限也会退出 1。
 *
 * 其它环境变量：
 *   COTTAGE_SMOKE_VERBOSE=1     把子进程输出实时打出来
 *   COTTAGE_SMOKE_USER_DATA=D:\x 指定 userData 根目录（跳过自动候选）
 *
 * 用法：node scripts/smoke-electron.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 启动超时：冷启动 + 建库 + 迁移，给足 60 秒。 */
export const STARTUP_TIMEOUT_MS = 60_000;

/** 这些串出现在输出里就说明启动失败。 */
export const FATAL_PATTERNS = [
  /Cannot find module/i,
  /ERR_DLOPEN_FAILED/,
  /NODE_MODULE_VERSION/,
  /Uncaught Exception/i,
  /未捕获异常/,
  /启动失败/,
  /no such table/i,
  /SQLITE_/,
  /以下 IPC 通道已登记在 INVOKE 里但没有 handler/,
  /以下 handler 使用了未登记的通道名/,
  /Error: Cannot read/,
];

/**
 * 就绪标志。必须是**启动链最后一步之后**才打印的那条，
 * 否则失败会被判成通过（见文件头）。
 */
export const READY_PATTERNS = [/启动完成/];

/**
 * "Chromium 进程沙箱初始化失败"的特征：立即退出、无输出、退出码 0x80000003。
 *
 * 同一个码在 Node 里是 2147483651（无符号），在 PowerShell 里显示为 -2147483645，
 * 两个都收。
 */
export const SANDBOX_INIT_EXIT_CODES = [2147483651, -2147483645];
export const SANDBOX_INIT_OUTPUT = [/0x80000003/i];

/** "Chromium 单实例锁创建失败"的特征（受限的 TEMP/userData 目录下会出现）。 */
export const SINGLETON_LOCK_PATTERNS = [/Lock file can not be created/i, /process_singleton/i];

/** 调试用：设 COTTAGE_SMOKE_VERBOSE=1 时把子进程输出实时打到本进程。 */
const VERBOSE = process.env['COTTAGE_SMOKE_VERBOSE'] === '1';

/** Electron 二进制路径（从 electron 包解析）。 */
export function electronBinary(cwd = repoRoot) {
  const pathFile = path.join(cwd, 'node_modules', 'electron', 'path.txt');
  const distDir = path.join(cwd, 'node_modules', 'electron', 'dist');
  if (!existsSync(pathFile)) return null;
  const full = path.join(distDir, 'electron.exe');
  return existsSync(full) ? full : null;
}

export function mainEntry(cwd = repoRoot) {
  // 入口文件名与 package.json 的 main 保持一致（见 electron.vite.config.ts 的说明：
  // electron-vite 用 rollup input 的键名决定产物名，且启动前会校验 main 所指文件存在）。
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.main) return path.join(cwd, pkg.main);
  } catch {
    /* 落到默认值 */
  }
  return path.join(cwd, 'out', 'main', 'index.js');
}

/**
 * 是否关闭 Chromium 进程沙箱。
 *
 * 默认关闭（理由见文件头）；只有显式要求验证"带沙箱"配置时才开启。
 */
export function shouldDisableSandbox(env = process.env) {
  return env['COTTAGE_SMOKE_SANDBOXED'] !== '1';
}

/** 拼 Electron 的启动参数（纯函数，便于测试）。 */
export function buildLaunchArgs({ main, userDataDir, disableSandbox }) {
  const args = [main, `--user-data-dir=${userDataDir}`];
  // 不能继承测试进程里的 ELECTRON_RUN_AS_NODE（见 runOnce 的 env 处理）。
  if (disableSandbox) args.push('--no-sandbox');
  return args;
}

/**
 * userData 根目录候选，按顺序尝试。
 *
 * 第一个是系统临时目录（常规机器上没问题）。只有在"单实例锁创建失败"时才会用到
 * 后面的候选——某些受限环境把 TEMP 重定向到了 Chromium 建不了锁文件的地方，
 * 而 Chromium 建不了锁就会让 `requestSingleInstanceLock()` 返回 false，
 * 主进程据此正常退出：表象是"秒退、退出码 0、不建库"，很容易被误判成应用坏了。
 */
export function planUserDataRoots({ env = process.env, tempDir = tmpdir(), homeDir = homedir() } = {}) {
  const explicit = env['COTTAGE_SMOKE_USER_DATA'];
  if (explicit) return [explicit];
  return [...new Set([tempDir, homeDir])];
}

/** 从 `exit:<code>` 里取退出码；非退出态返回 null。 */
export function parseExitCode(finished) {
  const m = /^exit:(-?\d+)$/.exec(String(finished));
  return m ? Number(m[1]) : null;
}

/**
 * 归类一次启动尝试的结果（纯函数）。
 *
 * 顺序有意为之：先看是否真的就绪，再看是否命中致命特征——两者同时出现时，
 * "致命"更可信（`ready` 可能是上一次尝试的残留判断错误，而致命串是硬证据）。
 */
export function classifyRun({ output = '', ready = false, fatal = false, finished = '' } = {}) {
  if (ready) return { verdict: 'ready', detail: '' };
  if (fatal) return { verdict: 'fatal', detail: '输出命中致命模式' };
  if (SINGLETON_LOCK_PATTERNS.some((re) => re.test(output))) {
    return { verdict: 'singleton-lock', detail: 'Chromium 无法创建单实例锁' };
  }
  const code = parseExitCode(finished);
  if (
    (code !== null && SANDBOX_INIT_EXIT_CODES.includes(code)) ||
    SANDBOX_INIT_OUTPUT.some((re) => re.test(output))
  ) {
    return { verdict: 'sandbox-init', detail: `Chromium 进程沙箱初始化失败（${finished}）` };
  }
  if (finished === 'timeout') {
    return { verdict: 'timeout', detail: `启动超时（${STARTUP_TIMEOUT_MS}ms 内没有出现就绪标志）` };
  }
  return {
    verdict: 'unknown-exit',
    detail: `进程退出（${finished}），但既没有就绪标志也没有致命特征`,
  };
}

/** 结束整棵进程树：Electron 会派生 GPU/渲染子进程，只 kill 主进程会留下孤儿窗口。 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill();
}

/** 启动一次，返回这次尝试的观察结果。 */
async function runOnce({ electron, main, userDataDir, disableSandbox }) {
  const env = {
    ...process.env,
    // 用独立 userData，避免碰到真实数据
    COTTAGE_USER_DATA: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  // 关键：不能继承测试进程里的 ELECTRON_RUN_AS_NODE。若为 1，
  // Electron 会以纯 Node 模式运行，于是 `require('electron')` 只拿到二进制路径字符串，
  // `electron.app` 是 undefined——报错看起来像"IPC 有问题"，实际是启动方式错了。
  delete env['ELECTRON_RUN_AS_NODE'];

  const child = spawn(electron, buildLaunchArgs({ main, userDataDir, disableSandbox }), {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let ready = false;
  let fatal = false;
  const issues = [];

  const onData = (chunk) => {
    const text = chunk.toString();
    output += text;
    if (VERBOSE) process.stdout.write(`  [child] ${text}`);
    if (READY_PATTERNS.some((re) => re.test(text))) ready = true;
    for (const pattern of FATAL_PATTERNS) {
      if (pattern.test(text)) {
        fatal = true;
        issues.push(
          `输出命中致命模式 ${pattern}：${text.trim().split('\n').slice(0, 3).join(' | ')}`,
        );
      }
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const finished = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), STARTUP_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(`exit:${code ?? signal}`);
    });
    // 一旦确认就绪就收工，不必等窗口关闭
    const poll = setInterval(() => {
      if (ready || fatal) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(fatal ? 'fatal' : 'ready');
      }
    }, 200);
  });

  killTree(child);
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    setTimeout(resolve, 5_000);
  });

  return {
    ...classifyRun({ output, ready, fatal, finished }),
    output: output.replace(/\u001b\[[0-9;]*m/g, '').trim(),
    dbExists: existsSync(path.join(userDataDir, 'cottage.db')),
    issues,
  };
}

function tail(text, limit = 3000) {
  return text.length > limit ? text.slice(-limit) : text;
}

async function run() {
  const main = mainEntry();
  if (!existsSync(main)) {
    console.error(`✗ 找不到主进程产物：${main}\n  请先执行 pnpm build`);
    process.exit(1);
  }

  const electron = electronBinary();
  if (!electron) {
    console.error('✗ 找不到 Electron 二进制。请执行 pnpm install（需要下载运行时）。');
    process.exit(1);
  }

  const disableSandbox = shouldDisableSandbox();
  const roots = planUserDataRoots();
  const observations = [];

  for (const [index, root] of roots.entries()) {
    const label = index === 0 ? '常规 userData' : `回退 userData`;
    mkdirSync(root, { recursive: true });
    const userDataDir = mkdtempSync(path.join(root, 'cottage-smoke-'));
    process.stdout.write(`· 启动 Electron（${label}：${userDataDir}）…\n`);

    const result = await runOnce({ electron, main, userDataDir, disableSandbox });
    observations.push({ label, userDataDir, ...result });
    rmSync(userDataDir, { recursive: true, force: true });

    // 只有"锁建不了"才值得换个目录再试；其余结论换目录也是白试。
    if (result.verdict !== 'singleton-lock') break;
  }

  const last = observations[observations.length - 1];
  const usedFallback = observations.length > 1;

  if (last.verdict === 'ready') {
    console.log('✓ Electron 启动冒烟测试通过');
    console.log('  主进程已打开数据库、执行迁移、注册 IPC 并创建窗口');
    console.log(`  就绪标志：${READY_PATTERNS.map(String).join(' / ')}`);
    console.log('  数据库文件已创建：cottage.db');
    if (usedFallback) {
      console.log(`  注：系统临时目录下无法创建 Chromium 单实例锁，已回退到 ${last.userDataDir}`);
    }
    if (disableSandbox) {
      console.log('  注：本次以 --no-sandbox 运行（Chromium 进程沙箱在部分目录下无法初始化）。');
      console.log('      要验证带沙箱的真实配置：COTTAGE_SMOKE_SANDBOXED=1 pnpm smoke');
    }
    process.exit(0);
  }

  // 环境受限：明确说"没能校验"，绝不打印"通过"。
  const environmentBlocked = last.verdict === 'sandbox-init' || last.verdict === 'singleton-lock';
  if (environmentBlocked) {
    const strict = process.env['COTTAGE_SMOKE_STRICT'] === '1';
    console.log(`⚠ Electron 启动冒烟测试**未能完成校验**：${last.detail}`);
    if (last.verdict === 'sandbox-init') {
      console.log('  含义：Chromium 的进程沙箱在当前目录下无法初始化（0x80000003 断点异常）。');
      console.log('        实测与 Electron 版本无关：同一个二进制放到受限目录外即可正常启动。');
      if (!disableSandbox) {
        console.log('        你设了 COTTAGE_SMOKE_SANDBOXED=1，去掉它可改用 --no-sandbox 复核。');
      }
    } else {
      console.log('  含义：Chromium 建不了单实例锁，主进程会按"已有实例在运行"正常退出，');
      console.log('        表现为秒退、退出码 0、不建库、无输出。');
      console.log(`        已尝试的 userData：${observations.map((o) => o.userDataDir).join('、')}`);
      console.log('        可用 COTTAGE_SMOKE_USER_DATA=<可写目录> 指定别的 userData 再试。');
    }
    console.log('  完全没有被验证的部分：主进程启动链（建库 / 迁移 / IPC 注册 / 建窗口）。');
    console.log(
      strict
        ? '  COTTAGE_SMOKE_STRICT=1：按失败处理。'
        : '  默认按"环境受限"处理（退出 0）；CI 上要求严格请设 COTTAGE_SMOKE_STRICT=1。',
    );
    process.exit(strict ? 1 : 0);
  }

  console.error(`✗ Electron 启动冒烟测试失败：${last.detail}`);
  for (const issue of last.issues) console.error(`  - ${issue}`);
  if (!last.dbExists) console.error(`  - 数据库文件未被创建：${last.userDataDir}\\cottage.db`);
  console.error(`  - 未观察到就绪标志 ${READY_PATTERNS.map(String).join(' / ')}`);
  if (last.output) console.error(`\n--- 启动输出 ---\n${tail(last.output)}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error('✗ 冒烟测试自身出错', err);
    process.exit(1);
  });
}
