#!/usr/bin/env node
/**
 * 开发模式（`pnpm dev`）冒烟测试。
 *
 * 存在的理由：`pnpm build` 通过**不代表** `pnpm dev` 能用。这两条路径在
 * electron-vite 里走不同的入口校验，实测就踩过一次：
 *
 *   - 产物命名是 `out/main/index.cjs`，而 `package.json` 的 `main` 指向
 *     `out/main/index.js`。`electron-vite dev` 在启动 Electron 前会调
 *     `ensureElectronEntryFile()` 检查 `main` 所指文件存在，于是直接抛
 *     "No electron app entry file found" —— **构建全绿、开发起不来**。
 *
 * 所以这里把"dev server 真的起来了、真的能提供 renderer 入口"变成可执行断言。
 *
 * ## 怎么在无图形界面的环境里也能跑
 *
 * 真实的 Electron 拉起后如果立刻崩溃，`electron-vite` 会因为子进程退出而整体退出，
 * dev server 也跟着没了，于是什么都测不到。这里用 `ELECTRON_EXEC_PATH` 把
 * "Electron 可执行文件"替换成一个长时间挂起的哑进程，从而把 **Vite dev server
 * 这条链路单独隔离出来验证**。
 *
 * 这**不代表**验证了 Electron 本身能启动——那件事由 `scripts/smoke-electron.mjs`
 * 负责。两个脚本各管一半，且都不会假装覆盖另一半。
 *
 * 用法：node scripts/verify-dev-server.mjs
 * 退出码：0 = dev server 正常；1 = 起不来
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 等待 dev server 就绪的上限：三段构建 + Vite 起来。 */
export const READY_TIMEOUT_MS = 90_000;

/** 轮询间隔。 */
const POLL_INTERVAL_MS = 500;

/** dev server 默认端口（与 electron-vite 的默认行为一致）。 */
export const DEV_PORT = 5173;

/** 判定 renderer 入口被正确提供的特征串。 */
export const REQUIRED_MARKERS = [
  { pattern: /id="root"/, why: 'HTML 应包含 #root 挂载点' },
  { pattern: /@vite\/client/, why: 'HTML 应包含 Vite HMR 客户端（否则热更新不生效）' },
  { pattern: /main\.tsx/, why: 'HTML 应引用 renderer 入口 main.tsx' },
];

/** 端口是否有进程在监听。逐个试常见地址，避免只探一种而漏判。 */
export const PROBE_HOSTS = ['127.0.0.1', '::1', 'localhost'];

function tryConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 判断 dev server 是否已就绪，返回**可用的基础 URL**。
 *
 * 为什么要遍历多个地址：Vite 在 Windows 上可能只绑定 `localhost`（解析到 `::1`），
 * 这时只探 `127.0.0.1` 会得到"端口没开"的错误结论——而实际上 server 好好的。
 * 这类假失败会让人去改本来没问题的代码。
 */
export async function waitForDevServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const host of PROBE_HOSTS) {
      if (await tryConnect(port, host)) {
        // 统一用 localhost：它与 server 打印的地址一致，且能被 fetch 解析
        return `http://localhost:${port}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

/** 取一个 URL 的文本内容。 */
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** 找 electron-vite 的 CLI 入口。 */
export function electronViteCli(cwd = repoRoot) {
  const candidates = [
    path.join(cwd, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    path.join(cwd, 'node_modules', 'electron-vite', 'dist', 'cli.mjs'),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

async function main() {
  const cli = electronViteCli();
  if (!cli) {
    console.error('✗ 找不到 electron-vite 的 CLI。请先执行 pnpm install。');
    process.exit(1);
  }

  // 先确认 main 字段所指的产物路径与 pkg.main 一致——这正是踩过的那个坑，
  // 单独提前断言，失败信息比"dev server 起不来"直接得多。
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const mainEntry = path.join(repoRoot, pkg.main ?? '');
  if (!pkg.main) {
    console.error('✗ package.json 缺少 main 字段');
    process.exit(1);
  }

  const env = { ...process.env };
  // 必须清掉：为 1 时 Electron 会以纯 Node 模式跑，主进程拿到的是 undefined 的 app
  delete env['ELECTRON_RUN_AS_NODE'];
  // 把 Electron 换成"挂起不退出"的哑进程，隔离出 Vite dev server 这条链路
  env['ELECTRON_EXEC_PATH'] =
    process.platform === 'win32'
      ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'ping.exe')
      : '/bin/sleep';
  env['ELECTRON_CLI_ARGS'] =
    process.platform === 'win32' ? '["-n","600","127.0.0.1"]' : '["600"]';

  process.stdout.write('· 启动 electron-vite dev（Electron 用哑进程替代）…\n');

  const child = spawn(process.execPath, [cli, 'dev'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const issues = [];
  let baseUrl = null;
  let ready = false;

  // 边等端口边盯子进程：子进程先退出就没必要再等了
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    baseUrl = await waitForDevServer(DEV_PORT, POLL_INTERVAL_MS * 2);
    if (baseUrl) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
  }

  // 无论结果如何都要收掉子进程与它的哑 Electron
  const kill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  };

  if (!ready || !baseUrl) {
    kill();
    issues.push(`dev server 在 ${READY_TIMEOUT_MS}ms 内没有监听 ${DEV_PORT} 端口`);
    if (child.exitCode !== null) issues.push(`electron-vite 进程提前退出，退出码 ${child.exitCode}`);
    if (!existsSync(mainEntry)) {
      issues.push(
        `package.json 的 main 指向 ${pkg.main}，但该文件不存在（electron-vite 会因此拒绝启动）`,
      );
    }
  } else {
    // dev server 起来了，再确认它真的提供了 renderer 入口，而不只是"占了个端口"
    try {
      const html = await fetchText(`${baseUrl}/`);
      for (const { pattern, why } of REQUIRED_MARKERS) {
        if (!pattern.test(html)) issues.push(`dev server 返回的 HTML 缺少特征：${why}`);
      }
    } catch (err) {
      issues.push(`无法读取 dev server 的根页面：${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const module = await fetchText(`${baseUrl}/main.tsx`);
      if (!/createRoot/.test(module)) {
        issues.push('renderer 入口 main.tsx 没有被 Vite 正确转译（未找到 createRoot）');
      }
    } catch (err) {
      issues.push(`无法读取 main.tsx：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  kill();
  // 给哑进程一点时间被回收，避免残留
  await new Promise((resolve) => setTimeout(resolve, 800));

  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const mainBuilt = /build the electron main process successfully/.test(clean);
  const preloadBuilt = /build the electron preload files successfully/.test(clean);
  if (!mainBuilt) issues.push('没有观察到主进程构建成功的标志');
  if (!preloadBuilt) issues.push('没有观察到 preload 构建成功的标志');

  if (issues.length) {
    console.error('✗ 开发模式冒烟测试失败：');
    for (const issue of issues) console.error(`  - ${issue}`);
    if (clean.trim()) console.error(`\n--- electron-vite 输出 ---\n${clean.trim().slice(-2500)}`);
    process.exit(1);
  }

  console.log('✓ 开发模式冒烟测试通过');
  console.log(`  主进程 / preload 均已构建；Vite dev server 监听 ${DEV_PORT} 并正常提供 renderer 入口`);
  console.log('  （Electron 自身的启动由 scripts/smoke-electron.mjs 验证）');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('✗ 开发模式冒烟测试自身出错', err);
    process.exit(1);
  });
}
