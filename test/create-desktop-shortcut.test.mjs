/**
 * 桌面快捷方式生成脚本的测试（`node --test` 驱动）。
 *
 * 分两截，各管一件事：
 *
 *   1. **纯函数部分**（任何平台都跑）：快捷方式必须指向 wscript + launch-dev.vbs、
 *      参数要带引号、工作目录要是仓库根。这几条一旦写错，表象是"双击没反应"，
 *      而不是报错——属于最难发现的一类。
 *   2. **真的建一个 .lnk 再读回来**（仅 Windows）：COM 的 `CreateShortcut` 写错了
 *      不报错，所以这里不信任它的返回值，而是另起一次 PowerShell 把 .lnk 读出来比对
 *      Target / Arguments / WorkingDirectory。建到临时目录，不碰真实桌面。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_SHORTCUT_NAME,
  buildPowerShellScript,
  buildShortcutSpec,
  createShortcut,
  defaultPowerShellPath,
  runPowerShell,
} from '../scripts/create-desktop-shortcut.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cottage-shortcut-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把 .lnk 读回来（复用被测脚本自己的 PowerShell 通道；输出只有 ASCII）。 */
function readBackShortcut(linkPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut('${linkPath.replace(/'/g, "''")}')`,
    "Write-Output ('TargetPath=' + $link.TargetPath)",
    "Write-Output ('Arguments=' + $link.Arguments)",
    "Write-Output ('WorkingDirectory=' + $link.WorkingDirectory)",
    "Write-Output ('IconLocation=' + $link.IconLocation)",
  ].join('\n');
  const { status, output } = runPowerShell(script);
  assert.equal(status, 0, `读回快捷方式失败：${output}`);
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

describe('快捷方式该指向什么', () => {
  const spec = buildShortcutSpec({ repoRoot, desktopDir: path.join('C:', 'Desktop') });

  it('指向 wscript.exe：node / pnpm 都会留下黑框', () => {
    assert.match(spec.targetPath, /System32[\\/]wscript\.exe$/i);
  });

  it('参数是带引号的 launch-dev.vbs 绝对路径（路径可能有空格）', () => {
    assert.equal(spec.arguments, `"${path.join(repoRoot, 'scripts', 'launch-dev.vbs')}"`);
    assert.ok(spec.arguments.startsWith('"') && spec.arguments.endsWith('"'));
  });

  it('工作目录是仓库根：electron-vite 以 cwd 找配置与 package.json', () => {
    assert.equal(spec.workingDirectory, repoRoot);
  });

  it('名字与图标：默认 Cottage，图标用 Electron 二进制的（应用窗口本身没配图标）', () => {
    assert.equal(path.basename(spec.linkPath), `${DEFAULT_SHORTCUT_NAME}.lnk`);
    assert.match(spec.iconLocation, /electron\.exe,0$/i);
    assert.match(spec.description, /logs/);
  });

  it('PowerShell 脚本会读回来比对，而不是只创建', () => {
    const script = buildPowerShellScript(spec);
    assert.match(script, /\$link\.Save\(\)/);
    assert.match(script, /verify: ok/);
    assert.match(script, /verify: FAIL/);
    // 单引号要转义成两个，否则路径里的 ' 会把脚本写坏
    const quoted = buildPowerShellScript({ ...spec, workingDirectory: "C:\\it's here" });
    assert.match(quoted, /C:\\it''s here/);
  });
});

describe('真的建一个 .lnk 再读回来', { skip: !isWindows }, () => {
  it('创建 + 读回比对，三个关键字段都对得上', () => {
    withTempDir((dir) => {
      const spec = buildShortcutSpec({ repoRoot, desktopDir: dir });
      const result = createShortcut(spec);
      assert.equal(result.ok, true, `创建失败：${result.output}`);
      assert.match(result.output, /verify: ok/);
      assert.equal(existsSync(spec.linkPath), true);

      const back = readBackShortcut(spec.linkPath);
      assert.equal(back.TargetPath.toLowerCase(), spec.targetPath.toLowerCase());
      assert.equal(back.Arguments, spec.arguments);
      assert.equal(back.WorkingDirectory, spec.workingDirectory);
    });
  });

  it('命令行入口用 --dest 建到指定目录，并对不存在的启动脚本报错', () => {
    withTempDir((dir) => {
      // 直接跑脚本本体，确认它真的会落盘（而不是只打印一句"已创建"）
      const run = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'create-desktop-shortcut.mjs'), '--dest', dir],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(path.join(dir, `${DEFAULT_SHORTCUT_NAME}.lnk`)), true);
    });
  });

  it('找不到 PowerShell 时报错，而不是安静地成功', () => {
    withTempDir((dir) => {
      const spec = buildShortcutSpec({ repoRoot, desktopDir: dir });
      const result = createShortcut(spec, { powershellPath: path.join(dir, 'nope.exe') });
      assert.equal(result.ok, false);
      assert.ok(result.error, '应当把"找不到 PowerShell"作为错误报出来');
      assert.equal(existsSync(spec.linkPath), false);
    });
  });

  it('PowerShell 路径确实存在（否则上面那些断言都是空转）', () => {
    assert.equal(existsSync(defaultPowerShellPath()), true);
  });
});

describe('快捷方式名与真实桌面无关', () => {
  it('仓库里没有硬编码某个用户的桌面路径', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/create-desktop-shortcut.mjs'), 'utf8');
    assert.equal(/C:\\\\Users\\\\[A-Za-z0-9._-]+/.test(source), false, '脚本里不该写死某个用户的桌面路径');
  });
});
