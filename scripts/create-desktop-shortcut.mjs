#!/usr/bin/env node
/**
 * 生成桌面快捷方式（`pnpm shortcut`）。
 *
 * ## 快捷方式为什么不直接指向 `pnpm dev`
 *
 * 三条理由，每一条都对应一种"看着能用、实际很难用"的写法：
 *
 *   1. 直接指向 `pnpm dev`（或 `cmd /c pnpm dev`）会**留下一个控制台窗口**，
 *      而且应用跑多久它就待多久——就是要消掉的那个黑框；
 *      指向 `node.exe` 也一样（node 是控制台子系统程序，会闪一下再挂一个窗口）。
 *   2. 指向 `electron.exe .`（生产模式）不需要 dev server，但那就没有 HMR，
 *      改代码必须重新 `pnpm build`——这是另一条路径，不是"省掉敲命令"。
 *   3. 指向 `wscript.exe scripts/launch-dev.vbs`：wscript 是 GUI 子系统程序，
 *      起进程**不闪任何窗口**；真正的活由 `scripts/launch-dev.mjs` 干，
 *      它把 dev server 的所有输出写进 `logs/dev.log`（黑框可以没有，日志不能没有）。
 *
 * 图标用 `node_modules/electron/dist/electron.exe` 的图标：应用窗口本身没有配置图标
 * （见 src/main/window.ts），用同一个图标，任务栏与快捷方式才是一致的。
 * 将来做打包时再补 `build/icon.ico`（docs/tech-stack.md 第 10 节已预留）。
 *
 * ## 创建完会**读回来比对**
 *
 * COM 的 `CreateShortcut` 有个讨厌的地方：写错了不报错，只是快捷方式行为不对。
 * 所以这里创建之后立刻读回 Target / Arguments / WorkingDirectory 逐个比对，
 * 不一致就以非 0 退出——不然"快捷方式做出来了但双击没反应"要靠人去发现。
 *
 * 用法：
 *   node scripts/create-desktop-shortcut.mjs                 # 建到真实桌面
 *   node scripts/create-desktop-shortcut.mjs --dest <目录>    # 建到别处（测试用）
 *   node scripts/create-desktop-shortcut.mjs --name <名字>    # 换名字（默认 Cottage）
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 快捷方式默认名字（不带 .lnk）。 */
export const DEFAULT_SHORTCUT_NAME = 'Cottage';

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Windows 自带 PowerShell 的绝对路径（不用 PATH 上的 `powershell`，避免被同名程序顶掉）。 */
export function defaultPowerShellPath(systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows') {
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Electron 二进制（拿它的图标用）。找不到就返回 null，快捷方式退回默认图标。 */
export function electronBinaryPath(repoRoot) {
  const full = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  return existsSync(full) ? full : null;
}

/**
 * 快捷方式该长什么样（纯函数，便于测试）。
 *
 * `Arguments` 的值里**带引号**：VBS 路径本身可能含空格，不引就会被 wscript 拆成两段。
 */
export function buildShortcutSpec({
  repoRoot = defaultRepoRoot(),
  desktopDir,
  name = DEFAULT_SHORTCUT_NAME,
  systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows',
} = {}) {
  if (!desktopDir) throw new Error('buildShortcutSpec 需要 desktopDir');
  const vbs = path.join(repoRoot, 'scripts', 'launch-dev.vbs');
  const icon = electronBinaryPath(repoRoot);
  return {
    linkPath: path.join(desktopDir, `${name}.lnk`),
    targetPath: path.join(systemRoot, 'System32', 'wscript.exe'),
    arguments: `"${vbs}"`,
    workingDirectory: repoRoot,
    iconLocation: icon ? `${icon},0` : '',
    description: 'Cottage 开发模式：隐藏控制台窗口启动，日志见 logs\\dev.log',
    vbsPath: vbs,
  };
}

/** PS 单引号字符串转义：内部的 `'` 要写成 `''`。 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成"创建 + 读回比对"的 PowerShell 脚本。
 *
 * 输出只有 ASCII（`created: ...` / `verify: ok` / `verify: FAIL ...`）：
 * PowerShell 5.1 把重定向的输出按本机 OEM 代码页写文件，中文输出读回来会乱码，
 * 而这段脚本的返回值要被上层解析。要写进快捷方式的中文靠 `-EncodedCommand` 传递
 * （UTF-16LE 的 base64），不经过命令行编码，所以描述里的中文是安全的。
 */
export function buildPowerShellScript(spec) {
  const checks = [
    ['TargetPath', spec.targetPath],
    ['Arguments', spec.arguments],
    ['WorkingDirectory', spec.workingDirectory],
  ];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut(${psQuote(spec.linkPath)})`,
    `$link.TargetPath = ${psQuote(spec.targetPath)}`,
    `$link.Arguments = ${psQuote(spec.arguments)}`,
    `$link.WorkingDirectory = ${psQuote(spec.workingDirectory)}`,
    spec.iconLocation ? `$link.IconLocation = ${psQuote(spec.iconLocation)}` : '',
    `$link.Description = ${psQuote(spec.description)}`,
    '$link.WindowStyle = 1',
    '$link.Save()',
    "Write-Output ('created: ' + $link.FullName)",
    // 读回来比对：CreateShortcut 写错了是不报错的
    '$back = $shell.CreateShortcut(' + psQuote(spec.linkPath) + ')',
    '$mismatch = @()',
    ...checks.map(
      ([prop, expected]) =>
        `if ($back.${prop} -ne ${psQuote(expected)}) { $mismatch += '${prop}=' + $back.${prop} }`,
    ),
    "if ($mismatch.Count -gt 0) { Write-Output ('verify: FAIL ' + ($mismatch -join '; ')); exit 1 }",
    "Write-Output 'verify: ok'",
  ];
  return `${lines.filter(Boolean).join('\n')}\n`;
}

/**
 * 跑一段 PowerShell（用 `-EncodedCommand`，中文不走命令行编码）。
 *
 * 输出**不用管道**接回来，而是重定向到一个临时文件：受限环境里子进程的管道会 EPERM，
 * 文件描述符不会（scripts/launch-dev.mjs 文件头有同样的说明）。
 */
export function runPowerShell(script, { powershellPath = defaultPowerShellPath() } = {}) {
  if (!existsSync(powershellPath)) {
    return { status: null, output: '', error: new Error(`找不到 PowerShell：${powershellPath}`) };
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const outFile = path.join(os.tmpdir(), `cottage-shortcut-${process.pid}-${Date.now()}.txt`);
  const fd = openSync(outFile, 'w');
  let result;
  try {
    result = spawnSync(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { stdio: ['ignore', fd, fd] },
    );
  } finally {
    closeSync(fd);
  }
  let output = '';
  try {
    output = readFileSync(outFile, 'utf8');
  } catch {
    /* 读不到就当没有输出 */
  }
  rmSync(outFile, { force: true });
  return { status: result.status, output: output.trim(), error: result.error ?? null };
}

/** 真正建快捷方式；返回 { ok, linkPath, output, error }。 */
export function createShortcut(spec, options = {}) {
  mkdirSync(path.dirname(spec.linkPath), { recursive: true });
  const { status, output, error } = runPowerShell(buildPowerShellScript(spec), options);
  const ok = status === 0 && output.includes('verify: ok');
  return { ok, linkPath: spec.linkPath, output, error };
}

/** 真实桌面目录（拿不到就抛错，让调用方显式传 --dest）。 */
export function defaultDesktopDir() {
  const home = os.homedir();
  const desktop = path.join(home, 'Desktop');
  if (existsSync(desktop)) return desktop;
  // 桌面可能被重定向到 OneDrive
  const oneDrive = process.env['OneDrive'];
  if (oneDrive) {
    const candidate = path.join(oneDrive, 'Desktop');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到桌面目录（${desktop}）。可用 --dest <目录> 指定。`);
}

function parseArgs(argv) {
  const args = { dest: null, name: DEFAULT_SHORTCUT_NAME };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dest') args.dest = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/create-desktop-shortcut.mjs [--dest <目录>] [--name <名字>]');
    return 0;
  }
  if (process.platform !== 'win32') {
    console.error('✗ 桌面快捷方式只支持 Windows（wscript + .lnk）。');
    return 1;
  }

  const repoRoot = defaultRepoRoot();
  const spec = buildShortcutSpec({
    repoRoot,
    desktopDir: args.dest ? path.resolve(args.dest) : defaultDesktopDir(),
    name: args.name,
  });

  if (!existsSync(spec.vbsPath)) {
    console.error(`✗ 找不到启动脚本：${spec.vbsPath}`);
    return 1;
  }

  const result = createShortcut(spec);
  if (!result.ok) {
    console.error('✗ 创建快捷方式失败。');
    if (result.output) console.error(result.output);
    if (result.error) console.error(String(result.error));
    return 1;
  }

  console.log(`✓ 已创建快捷方式：${result.linkPath}`);
  console.log(`  目标：${spec.targetPath} ${spec.arguments}`);
  console.log('  双击即可启动（无控制台窗口）；日志写在 logs/dev.log，启动失败会弹出说明。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
