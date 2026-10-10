#!/usr/bin/env node
/**
 * 打包产物（安装包解出来的应用）启动冒烟测试。
 *
 * 存在的理由：`pnpm smoke` 验的是 **out/ + node_modules 里的 Electron**，
 * 它证明不了打包产物能跑。打包这条链上有一整类只在这里才暴露的失败：
 *
 *   - asarUnpack 没覆盖 **\/*.node → 装完首次启动报"找不到模块"；
 *   - files 漏了 package.json → 主进程入口字段 main 丢失，应用起不来；
 *   - renderer 产物没进 asar → 白屏；
 *   - 打包时原生模块被建成 Node ABI（而非 Electron ABI）→ DLL 加载失败。
 *
 * docs/tech-stack.md 验收清单第 13 条要求"打包产物中 better-sqlite3 原生模块
 * 位于 asarUnpack 范围，安装后首次启动能正常建库"，这个脚本就是那条的证据。
 *
 * ## 两条判据
 *
 *   1. **结构性**（不启动就能查，默认执行）：.node 必须落在 `app.asar.unpacked/` 里；
 *   2. **行为**（需要 `--launch`）：把 Cottage.exe 拉起来，确认它建出合法的 SQLite 库
 *      （`cottage.db` 且文件头是 "SQLite format 3"）。
 *
 * ## 为什么行为验证必须显式授权
 *
 * 本测试原先会自动"备份→删除→重建"**真实**的 `%APPDATA%\Cottage\cottage.db`
 * 来验证"启动时会建库"。那等于拿用户的真实数据当试验场：只要还原那一步出任何岔子
 * （进程占用、句柄未释放、中途手工介入），数据就没了——实际丢过一次。
 *
 * 所以现在：默认只跑结构性检查；`--launch` 才启动应用，且在**独立 userData**
 * （临时目录）里跑，测完把该目录整个删掉。任何情况下都不读写真实 userData。
 *
 * 独立 userData 由 Chromium 的 `--user-data-dir` 指定。注意本机（含 DSH 沙箱环境）
 * 下，自定义 profile 目录常常建不出 Chromium 单实例锁，应用会判"已有实例在运行"并
 * 正常退出——这属**环境受限**，测试会明确报"未能校验"，绝不打印"通过"。
 *
 * ## 退出码
 *
 *   0 = 通过；或环境受限未能校验（默认不算失败，与 smoke-electron.mjs 一致）
 *   1 = 真实失败（找不到产物 / 原生模块没解包 / 启动即退出 / 超时未见库 / 非法库）
 *
 * 环境变量：
 *   COTTAGE_PACKAGE_STRICT=1    环境受限也按失败处理（CI 用）
 *   COTTAGE_PACKAGE_VERBOSE=1   把子进程输出实时打出来
 *   COTTAGE_PACKAGE_SANDBOXED=1 不追加 --no-sandbox（验证带沙箱配置）
 *   COTTAGE_PACKAGE_USER_DATA=… --launch 时改用指定的可写目录存放临时 userData
 *
 * 用法：
 *   pnpm package:win                                  # 先产出 dist/win-unpacked
 *   node scripts/smoke-packaged.mjs                   # 结构性检查
 *   node scripts/smoke-packaged.mjs --launch          # 再验证能启动建库
 *   node scripts/smoke-packaged.mjs --installer       # 要求安装包也存在
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DIST_DIR, findInstaller } from './package-win.mjs';
import {
  SQLITE_MAGIC,
  findBlockingProcesses,
  headBytes,
  isMainModule,
  repoRoot,
  runApp,
  tail,
} from './packaged-common.mjs';

const VERBOSE = process.env['COTTAGE_PACKAGE_VERBOSE'] === '1';
const wantInstaller = process.argv.includes('--installer');
/** 行为验证（真的启动应用）必须显式要求，默认不碰任何 userData。 */
const wantLaunch = process.argv.includes('--launch');

/** 打包后的可执行文件（electron-builder 用 productName 命名）。 */
export function packagedExe(cwd = repoRoot) {
  const dir = path.join(cwd, DIST_DIR, 'win-unpacked');
  for (const name of ['Cottage.exe', 'cottage.exe']) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * 尽力删除，失败不抛。
 *
 * 用途：清理**测试自己创建的**临时目录。应用刚被结束，句柄可能还没释放，
 * 删不掉就留着（临时目录里的东西），不该让它变成"测试自身出错"。
 */
function retryOrIgnore(fn) {
  try {
    fn();
  } catch {
    // 临时目录残留无害
  }
}

/**
 * 结构性判据：原生模块必须在 asar 之外。
 * @returns {{ ok: boolean, detail: string, files: string[] }}
 */
export function checkNativeUnpacked(cwd = repoRoot) {
  const root = path.join(cwd, DIST_DIR, 'win-unpacked', 'resources');
  const asar = path.join(root, 'app.asar');
  const unpackedDir = path.join(root, 'app.asar.unpacked');

  if (!existsSync(asar)) {
    return { ok: false, detail: `找不到 ${path.relative(cwd, asar)}（打包产物不完整）`, files: [] };
  }
  if (!existsSync(unpackedDir)) {
    return {
      ok: false,
      detail: 'resources/app.asar.unpacked 不存在：没有任何文件被解包，原生模块会留在 asar 内',
      files: [],
    };
  }

  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.node')) found.push(path.relative(unpackedDir, full));
    }
  };
  walk(unpackedDir);

  if (!found.length) {
    return {
      ok: false,
      detail: 'app.asar.unpacked 里没有 .node：asarUnpack 没生效，启动时会报找不到模块',
      files: [],
    };
  }
  const sqlite = found.find((f) => f.includes('better-sqlite3'));
  if (!sqlite) {
    return {
      ok: false,
      detail: `解包目录里没有 better-sqlite3 的原生模块（只有 ${found.join('、')}）`,
      files: found,
    };
  }
  return { ok: true, detail: sqlite, files: found };
}

async function run() {
  const exe = packagedExe();
  if (!exe) {
    console.error(
      `✗ 找不到打包产物：${path.join(DIST_DIR, 'win-unpacked', 'Cottage.exe')}\n  请先执行 pnpm package:win`,
    );
    process.exit(1);
  }

  console.log(`· 打包产物：${exe}`);
  console.log(`  体积 ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB`);

  // ---- 判据 1：结构性（不启动就能查）----
  const native = checkNativeUnpacked();
  if (!native.ok) {
    console.error(`✗ 结构性检查未通过：${native.detail}`);
    process.exit(1);
  }
  console.log(`✓ 原生模块已解包到 asar 之外：${native.detail}`);

  if (wantInstaller) {
    const installer = findInstaller();
    if (!installer) {
      console.error(`✗ 要求检查安装包，但 ${DIST_DIR}/ 下没有 Setup*.exe`);
      process.exit(1);
    }
    console.log(
      `✓ 安装包存在：${path.basename(installer)}（${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB）`,
    );
  }

  // ---- 判据 2：真的拉起来，确认能建库（**必须显式授权**）----
  /*
   * 这段默认不跑，原因是一次真实事故：
   *
   * 本测试原先会自动备份→删除→重建 `%APPDATA%\Cottage\cottage.db` 来验证"启动时会建库"。
   * 那等于**拿用户的真实数据当试验场**：只要还原那一步出任何岔子（进程占用、句柄未释放、
   * 中途手工介入），用户的数据就没了。实际就丢过一次。
   *
   * 所以现在拆成两条路，都不碰真实数据：
   *   - 默认（不带参数）：只做结构性检查，行为验证明确报"未执行"；
   *   - `--launch`：在**独立 userData**（临时目录）里启动，验证建库，测完删除该目录。
   *
   * 独立 userData 用 Chromium 的 `--user-data-dir` 指定。注意：在本机（含 DSH 沙箱环境）
   * 自定义 profile 目录常常建不出 Chromium 单实例锁，应用会判"已有实例在运行"并正常退出——
   * 这属于**环境受限**，测试会明确报"未能校验"，绝不伪装成通过（绝不打印"通过"）。
   */
  if (!wantLaunch) {
    console.log('· 行为验证未执行（默认跳过）');
    console.log('  结构性检查已覆盖"原生模块在 asar 之外"这条硬约束。');
    console.log('  要验证"安装后首次启动能建库"，显式执行：');
    console.log('    node scripts/smoke-packaged.mjs --launch');
    console.log('  该模式在独立 userData 下启动应用，不会读写你的真实数据。');
    process.exit(0);
  }

  const root = process.env['COTTAGE_PACKAGE_USER_DATA'] || tmpdir();
  mkdirSync(root, { recursive: true });
  const userDataDir = mkdtempSync(path.join(root, 'cottage-pkg-'));
  const dbPath = path.join(userDataDir, 'cottage.db');

  // 先确认没有残留进程占着单实例锁，否则下面的启动必定"已有实例在运行"而秒退
  const blockers = findBlockingProcesses();
  if (blockers.length) {
    rmSync(userDataDir, { recursive: true, force: true });
    const strict = process.env['COTTAGE_PACKAGE_STRICT'] === '1';
    console.log(
      `⚠ 打包产物冒烟测试**未能完成校验**：有 ${blockers.length} 个本项目的 Electron/Cottage 进程正在运行` +
        `（PID ${blockers.join('、')}）`,
    );
    console.log('  结构性检查已通过（原生模块确实在 asar 之外），但"能否启动建库"没有被验证。');
    console.log('  原因：这些进程占着单实例锁，新实例会判定"已有实例在运行"并直接退出。');
    console.log('  处理：关闭正在运行的 Cottage / 结束残留的 electron 进程后重跑。');
    console.log(strict ? '  COTTAGE_PACKAGE_STRICT=1：按失败处理。' : '  默认按"环境受限"处理。');
    process.exit(strict ? 1 : 0);
  }

  console.log(`· 启动打包后的应用（独立 userData：${userDataDir}）…`);

  let result;
  try {
    // 最多试 3 次：强杀一次应用之后，Windows 不会立刻回收它持有的**命名内核对象**
    // （Chromium 的单实例锁就是命名 mutex），紧接着启动的新实例会拿不到锁而秒退。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        const waitMs = 3000;
        console.log(`· 单实例锁尚未释放，${waitMs / 1000}s 后重试（第 ${attempt}/3 次）…`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      result = await runApp({
        exe,
        dbPath,
        // Chromium 的进程沙箱在本机受限目录下会以 0x80000003 立即退出（同
        // smoke-electron.mjs 的说明）。这里验的是启动链，不是 Chromium 沙箱。
        args: process.env['COTTAGE_PACKAGE_SANDBOXED'] === '1' ? [] : ['--no-sandbox'],
        verbose: VERBOSE,
      });
      // 只有"确实因为锁而没建库"才值得重试（此时库文件根本没出现）
      if (!/Lock file can not be created/i.test(result.output) || existsSync(dbPath)) break;
    }
  } finally {
    // 独立目录，整棵删掉即可；这里绝不触碰真实 userData
    retryOrIgnore(() => rmSync(userDataDir, { recursive: true, force: true }));
  }

  if (result.verdict === 'ready') {
    const head = headBytes(result.dbPath, SQLITE_MAGIC.length).toString('latin1');
    if (head !== SQLITE_MAGIC) {
      console.error(`✗ cottage.db 已创建但不是合法 SQLite 文件（文件头：${JSON.stringify(head)}）`);
      process.exit(1);
    }
    console.log('✓ 打包产物启动冒烟测试通过');
    console.log('  应用在打包形态下正常启动，并建出合法 SQLite 库');
    console.log('  含义：better-sqlite3 原生模块能在 asar 之外被加载，迁移已执行');
    if (process.env['COTTAGE_PACKAGE_SANDBOXED'] !== '1') {
      console.log('  注：本次以 --no-sandbox 运行（Chromium 进程沙箱在受限目录下无法初始化）。');
    }
    process.exit(0);
  }

  // 环境受限：明确说"没能校验"，绝不打印"通过"
  const lockFailed = /Lock file can not be created/i.test(result.output);
  if (lockFailed || result.verdict === 'sandbox-init') {
    const strict = process.env['COTTAGE_PACKAGE_STRICT'] === '1';
    console.log(
      `⚠ 打包产物冒烟测试**未能完成校验**：${
        lockFailed ? 'Chromium 无法创建单实例锁' : 'Chromium 沙箱初始化失败（0x80000003）'
      }`,
    );
    console.log('  结构性检查已通过（原生模块确实在 asar 之外），但"能否启动建库"没有被验证。');
    console.log('  说明：自定义 userData 目录下 Chromium 常建不出单实例锁，属环境受限。');
    console.log('        可用 COTTAGE_PACKAGE_USER_DATA=<可写目录> 换一个位置再试。');
    console.log(strict ? '  COTTAGE_PACKAGE_STRICT=1：按失败处理。' : '  默认按"环境受限"处理。');
    process.exit(strict ? 1 : 0);
  }

  console.error(`✗ 打包产物启动失败：${result.detail}`);
  if (result.output) console.error(`\n--- 应用输出 ---\n${tail(result.output)}`);
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  run().catch((err) => {
    console.error('✗ 冒烟测试自身出错', err);
    process.exit(1);
  });
}
