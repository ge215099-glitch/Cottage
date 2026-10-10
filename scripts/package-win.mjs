#!/usr/bin/env node
/**
 * 打包 Windows 安装包（NSIS）（docs/tech-stack.md 10）。
 *
 * 为什么需要这层包装，而不是在 package.json 里直接写 `electron-builder --win`：
 *
 *   1. **原生模块 ABI 必须先自检**。`better-sqlite3` 的 `.node` 是按 Electron ABI 编的，
 *      一旦它其实是 Node ABI（例如刚跑过 `pnpm install` 让原生 postinstall 覆盖了），
 *      electron-builder 照样能打出一个"看起来完全正常"的安装包，装完启动才报
 *      "找不到模块"。构建期拦住，比让用户装完才发现便宜得多。
 *
 *   2. **产物路径要能报出来**。打包完成后把文件绝对路径与体积打到 stdout，
 *      上传 Release 时不用去翻 dist/ 猜文件名。
 *
 * 原生模块就绪判据复用 scripts/rebuild-native.mjs 的 `binaryPath()`，
 * 避免两处各写一套 `.pnpm` 虚拟目录的查找逻辑。
 *
 * 退出码约定：
 *   0 = 打包成功
 *   1 = 未就绪（原生模块）或打包失败，原因已打印
 *
 * 用法：
 *   node scripts/package-win.mjs              # 先构建再打包
 *   node scripts/package-win.mjs --skip-build # 复用已有 out/
 *   node scripts/package-win.mjs --dir        # 只产出解包目录，不打安装包（排错用）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryPath, readElectronVersion } from './rebuild-native.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const skipBuild = process.argv.includes('--skip-build');
const dirOnly = process.argv.includes('--dir');

/** electron-builder 的 dist 目录（与 electron-builder.yml 的 directories.output 保持一致）。 */
export const DIST_DIR = 'dist';

/**
 * 原生模块是否已按 Electron ABI 就绪。
 * @returns {{ ready: boolean, reason: string, electron: string | null, binary: string | null }}
 */
export function checkNativeReady(cwd = repoRoot) {
  const electron = readElectronVersion(cwd);
  const binary = binaryPath(cwd);

  if (!electron) {
    return {
      ready: false,
      reason: '找不到 node_modules/electron/dist/version，请先执行 pnpm install',
      electron: null,
      binary,
    };
  }
  if (!binary || !existsSync(binary)) {
    return {
      ready: false,
      reason: 'better-sqlite3 原生模块缺失，请执行 pnpm rebuild:native',
      electron,
      binary,
    };
  }
  return { ready: true, reason: 'ok', electron, binary };
}

/**
 * electron-builder 会产出的文件名（与 electron-builder.yml 的 artifactName 对应）。
 * 抽成函数是为了让测试能在不真跑 electron-builder 的前提下断言命名规则。
 */
export function installerName(version, ext = 'exe') {
  return `Cottage-Setup-${version}.${ext}`;
}

function readVersion(cwd = repoRoot) {
  return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;
}

/** 列出一个目录下的文件（非递归），按名字排序；目录不存在返回空数组。 */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((p) => statSync(p).isFile())
    .sort();
}

export function findInstaller(cwd = repoRoot) {
  const dist = path.join(cwd, DIST_DIR);
  const expected = path.join(dist, installerName(readVersion(cwd)));
  if (existsSync(expected)) return expected;
  // 命名规则变了（或带了 arch 后缀）时的兜底：直接找 Setup*.exe
  const fallback = listFiles(dist).filter((p) => /^Cottage-Setup.*\.exe$/i.test(path.basename(p)));
  return fallback.length ? fallback[0] : null;
}

function run(command, args, label) {
  console.log(`· ${label}`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败（退出码 ${result.status ?? 'spawn 失败'}）`);
    process.exit(1);
  }
}

/**
 * 跑 `pnpm build` 等价物：直接调 electron-vite 的 CLI。
 *
 * 为什么不 spawn('pnpm', ['build'])：在 Windows 上 `pnpm` 常常解析到 `pnpm.ps1` / `pnpm.cmd`
 * 这类壳脚本，`spawnSync` 配 `shell: false` 执行不了（报 "spawn 失败"）。项目里调用
 * electron-builder 也是用 `node <pkg>/cli.js` 这条路，保持一致，也就不依赖 PATH。
 *
 * CLI 若不存在则退回到 `pnpm build` 并显式开 shell，避免在别的 Node 发行版上直接卡死。
 */
function runBuild() {
  const cli = path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  if (existsSync(cli)) {
    run(process.execPath, [cli, 'build'], '构建 out/（electron-vite build）');
    return;
  }
  console.log('· 未找到 electron-vite CLI，回退到 pnpm build');
  const fallback = spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (fallback.status !== 0) {
    console.error('✗ 构建 out/ 失败（pnpm build）');
    process.exit(1);
  }
}

export function main() {
  const native = checkNativeReady(repoRoot);
  if (!native.ready) {
    console.error(
      [
        '',
        `✗ 无法打包：${native.reason}`,
        '  原因：better-sqlite3 是按 Electron ABI 编译的，ABI 不匹配的安装包',
        '        装完会在首次启动时报"找不到模块"。',
        '  处理方式：pnpm rebuild:native',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`✓ 原生模块就绪（Electron ${native.electron}）`);

  if (skipBuild) {
    const entry = path.join(repoRoot, 'out', 'main', 'index.js');
    if (!existsSync(entry)) {
      console.error(`✗ --skip-build 要求 out/ 已存在，但找不到 ${path.relative(repoRoot, entry)}`);
      process.exit(1);
    }
    console.log('✓ 跳过构建，复用已有 out/（--skip-build）');
  } else {
    runBuild();
  }

  const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!existsSync(cli)) {
    console.error('✗ 找不到 electron-builder，请先执行 pnpm install');
    process.exit(1);
  }

  const args = [cli, '--win', ...(dirOnly ? ['--dir'] : [])];
  run(process.execPath, args, dirOnly ? '打包解包目录（--dir）' : '打包 NSIS 安装包');

  const version = readVersion(repoRoot);
  if (dirOnly) {
    const unpacked = path.join(repoRoot, DIST_DIR, 'win-unpacked');
    console.log(`\n✓ 解包目录：${unpacked}`);
    return;
  }

  const installer = findInstaller(repoRoot);
  if (!installer) {
    console.error(`\n✗ 打包流程结束，但没在 ${DIST_DIR}/ 下找到安装包`);
    process.exit(1);
  }
  console.log(`\n✓ 安装包：${installer}`);
  console.log(`  版本 ${version} / 体积 ${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
