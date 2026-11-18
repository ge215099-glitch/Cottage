#!/usr/bin/env node
/**
 * 按 Electron ABI 重建原生模块（docs/tech-stack.md 5.4）。
 *
 * 为什么需要它、而不是让 better-sqlite3 自己的 postinstall 干活：
 *   better-sqlite3 的 postinstall 走 node-gyp，在没有 Visual Studio C++ 工具链的
 *   机器上会失败，并且**失败时会删掉已有的 .node 文件**——把"能跑"变成"不能跑"。
 *   而 @electron/rebuild（经 electron-builder install-app-deps 调用）会优先取官方
 *   预编译产物，不需要本地编译器。
 *
 * 退出码约定：
 *   0 = 已就绪（重建成功，或本来就已是可用的 Electron ABI）
 *   1 = 未就绪，原因已打印
 *
 * 用法：
 *   node scripts/rebuild-native.mjs            # 重建并自检
 *   node scripts/rebuild-native.mjs --quiet     # 供 postinstall 调用
 *   node scripts/rebuild-native.mjs --check     # 只自检，不重建
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_NAME = 'better-sqlite3';

const quiet = process.argv.includes('--quiet');
const checkOnly = process.argv.includes('--check');

/** Electron 版本从它的 dist/version 读，不依赖 npm 元数据。 */
export function readElectronVersion(cwd = repoRoot) {
  const file = path.join(cwd, 'node_modules', 'electron', 'dist', 'version');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim();
}

/** 原生模块产物路径（pnpm 的虚拟store 里带版本后缀，需要查目录）。 */
export function binaryPath(cwd = repoRoot) {
  const pnpmDir = path.join(cwd, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith(`${MODULE_NAME}@`));
  if (!dir) return null;
  return path.join(pnpmDir, dir, 'node_modules', MODULE_NAME, 'build', 'Release', 'better_sqlite3.node');
}

function isReady(cwd) {
  const bin = binaryPath(cwd);
  return bin !== null && existsSync(bin);
}

function main() {
  const version = readElectronVersion(repoRoot);
  if (!version) {
    console.error('✗ 找不到 Electron 二进制版本文件（node_modules/electron/dist/version）。请先执行 pnpm install。');
    process.exit(1);
  }

  if (checkOnly) {
    if (isReady(repoRoot)) {
      console.log(`✓ ${MODULE_NAME} 原生模块已就绪（Electron ${version}）。`);
      process.exit(0);
    }
    console.error(`✗ ${MODULE_NAME} 原生模块缺失。请执行：pnpm rebuild:native`);
    process.exit(1);
  }

  if (!quiet) console.log(`· 按 Electron ${version} 的 ABI 重建 ${MODULE_NAME} …`);

  const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install-app-deps'], {
    cwd: repoRoot,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
  });

  if (isReady(repoRoot)) {
    if (!quiet) console.log(`✓ ${MODULE_NAME} 原生模块已按 Electron ${version} 重建。`);
    process.exit(0);
  }

  console.error(
    [
      '',
      `✗ ${MODULE_NAME} 原生模块未就绪，应用启动时会报"找不到模块"。`,
      `  重建命令退出码：${result.status ?? 'spawn 失败'}`,
      '  处理方式：',
      '    1) 确认网络可访问 GitHub Releases（@electron/rebuild 需要下载预编译产物）；',
      '    2) 或安装 Visual Studio「使用 C++ 的桌面开发」工作负载后重跑 pnpm rebuild:native；',
      '    3) 单元测试与 DAO 测试**不依赖**该原生模块（走内存驱动），仍可正常运行。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
