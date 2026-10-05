/**
 * 开发启动器（scripts/launch-dev.mjs）自身的测试（`node --test` 驱动）。
 *
 * 为什么一个"启动脚本"值得单测：
 *
 *   1. 它**没有界面**。黑框被有意拿掉之后，它的判定错了不会有人当场发现——
 *      应用起不来却判成成功、或者退出码不是 0（于是弹一个假错误），都得靠这里拦住。
 *   2. 其中一条是真踩过的：启动器会把自己的说明写进同一个日志文件，而"就绪"的判据正是
 *      /启动完成/，于是它**用自己的说明证明自己成功了**——哑 Electron 直接崩掉的
 *      失败路径被判决成"启动成功、退出码 0"。`appOutput()` 就是为这件事存在的，
 *      下面第一条用例把它钉住。
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  LAUNCHER_LINE_PREFIX,
  LOG_MAX_BYTES,
  appOutput,
  buildFailureReport,
  classifyLauncherExit,
  decideOnLock,
  defaultRepoRoot,
  isDuplicateInstanceOutput,
  isProcessAlive,
  parseLock,
  resolveRuntimeDir,
  rotateLog,
  runtimePaths,
  sessionHeader,
  sessionText,
  shouldRotate,
  tailChars,
} from '../scripts/launch-dev.mjs';
import { READY_PATTERNS } from '../scripts/smoke-electron.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cottage-launch-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('启动器不得用自己的说明证明自己成功了', () => {
  const sessionLog = [
    `${LAUNCHER_LINE_PREFIX}=== Cottage 开发启动 2026-01-01T00:00:00.000Z pid=1 ===`,
    '',
    `${LAUNCHER_LINE_PREFIX}· 已启动 electron-vite（pid 2），等待「启动完成」…`,
    '',
    '[error] 启动失败 {"reason":"哑 Electron 按 COTTAGE_STUB_MODE=crash 故意失败"}',
    '',
    `${LAUNCHER_LINE_PREFIX}✗ Electron 没有打印「启动完成」就退出了（退出码 1）`,
    '',
  ].join('\n');

  it('appOutput 剔除 [launcher] 行之后，就绪判据不再命中启动器自己的说明', () => {
    const app = appOutput(sessionLog);
    assert.ok(
      READY_PATTERNS.every((re) => !re.test(app)),
      '剔除后仍然命中「启动完成」：说明剔除规则没覆盖启动器的说明行',
    );
    // 而没有剔除的话，它确实会命中——这正是当初那个假通过
    assert.ok(READY_PATTERNS.some((re) => re.test(sessionLog)));
    assert.match(app, /启动失败/, '应用自己的输出必须留下来，否则失败说明里就没有证据了');
  });

  it('崩溃的日志被判成启动失败，而不是"成功"', () => {
    const app = appOutput(sessionLog);
    const ready = READY_PATTERNS.some((re) => re.test(app));
    const verdict = classifyLauncherExit({ ready, duplicateInstance: false, code: 1, signal: null });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.failureReason, /启动完成/);
  });

  it('启动器的说明行都带前缀，且写入前先换行', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/launch-dev.mjs'), 'utf8');
    assert.ok(
      source.includes('`\\n${LAUNCHER_LINE_PREFIX}${message}\\n`'),
      'note() 不再"先换行再写前缀"，应用输出的半行会把前缀吃掉，过滤就会失效',
    );
  });
});

describe('锁：重复双击不该起第二个 dev server', () => {
  it('活着的 pid 视为已有实例', () => {
    const verdict = decideOnLock({ lock: { pid: 4321 }, processAlive: true });
    assert.equal(verdict.action, 'already-running');
    assert.match(verdict.reason, /4321/);
  });

  it('残锁（pid 已死）照常启动', () => {
    const verdict = decideOnLock({ lock: { pid: 4321 }, processAlive: false });
    assert.equal(verdict.action, 'start');
    assert.match(verdict.reason, /残留锁/);
  });

  it('没有锁就什么都不说', () => {
    assert.deepEqual(decideOnLock({ lock: null, processAlive: false }), { action: 'start', reason: '' });
  });

  it('parseLock 只认带正整数 pid 的 JSON', () => {
    assert.deepEqual(parseLock('{"pid":9,"startedAt":"x","repoRoot":"y"}'), {
      pid: 9,
      startedAt: 'x',
      repoRoot: 'y',
    });
    for (const bad of ['', 'not json', '{}', '{"pid":"9"}', '{"pid":0}', '{"pid":-3}', '{"pid":1.5}']) {
      assert.equal(parseLock(bad), null, `坏锁内容应当被忽略：${bad}`);
    }
  });

  it('isProcessAlive：EPERM 算活着，ESRCH 算死了', () => {
    assert.equal(isProcessAlive(1234, () => {}), true);
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    assert.equal(
      isProcessAlive(1234, () => {
        throw esrch;
      }),
      false,
    );
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    assert.equal(
      isProcessAlive(1234, () => {
        throw eperm;
      }),
      true,
    );
    assert.equal(isProcessAlive(0, () => {}), false);
    assert.equal(isProcessAlive('x', () => {}), false);
  });

  it('锁里存的是 electron-vite 的 pid（进程还在就说明这套东西在跑）', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/launch-dev.mjs'), 'utf8');
    assert.match(source, /pid:\s*child\.pid/, '锁文件不再记录子进程 pid，重复双击的判定就没依据了');
    assert.match(source, /rmSync\(lockFile, \{ force: true \}\)/, '退出时不清锁，下次双击会被残锁挡住');
  });
});

describe('日志：轮转 / 会话切分 / 失败说明', () => {
  it('超过上限才轮转，且只留一份 .1', () => {
    withTempDir((dir) => {
      const logFile = path.join(dir, 'dev.log');
      writeFileSync(logFile, 'x'.repeat(10));
      assert.equal(rotateLog(logFile), false);
      assert.equal(shouldRotate(10), false);
      assert.equal(shouldRotate(LOG_MAX_BYTES), true);

      writeFileSync(logFile, 'y'.repeat(LOG_MAX_BYTES));
      assert.equal(rotateLog(logFile), true);
      // 轮转是"改名"，不是"复制"：备份拿到全部内容，当前文件让子进程重新写
      assert.equal(readFileSync(`${logFile}.1`, 'utf8').length, LOG_MAX_BYTES);
      assert.equal(existsSync(logFile), false);
    });
  });

  it('sessionText 只取本次会话，上一次的「启动完成」不会让这次失败判成成功', () => {
    withTempDir((dir) => {
      const logFile = path.join(dir, 'dev.log');
      const first = sessionHeader({ pid: 1, now: new Date('2026-01-01T00:00:00Z') });
      const second = sessionHeader({ pid: 2, now: new Date('2026-01-02T00:00:00Z') });
      writeFileSync(logFile, `${first}\n[info] 启动完成 {"windowId":1}\n${second}\nboom\n`);
      const text = sessionText(logFile, second);
      assert.ok(!text.includes('启动完成'), '上一次会话的就绪日志泄漏进了本次判定');
      assert.match(text, /boom/);
      // 会话头自己写坏了（例如日志被清空）时也不能误判
      assert.equal(sessionText(logFile, '不存在的会话头'), '');
    });
  });

  it('tailChars 去掉 ANSI 颜色并截断到尾部', () => {
    const text = `\u001b[31m${'a'.repeat(100)}\u001b[0m`;
    const tail = tailChars(text, 10);
    assert.equal(tail.length, 10);
    assert.equal(tail.includes('\u001b'), false);
  });

  it('失败说明必须给出原因、日志路径与日志尾部', () => {
    const report = buildFailureReport({
      reason: 'Electron 没有打印「启动完成」就退出了（退出码 1）',
      logFile: 'logs/dev.log',
      logTail: 'Error: spawn EPERM',
      hint: '先看日志尾部',
    });
    for (const needle of ['Cottage 启动失败', '原因：', 'logs/dev.log', '建议：', '--- 日志尾部 ---', 'spawn EPERM']) {
      assert.ok(report.includes(needle), `失败说明缺少「${needle}」`);
    }
  });
});

describe('退出码：决定快捷方式会不会弹失败提示', () => {
  it('见过就绪 → 退出码 0（用户关窗口、被强杀都不算启动失败）', () => {
    const verdict = classifyLauncherExit({ ready: true, duplicateInstance: false, code: 0, signal: null });
    assert.equal(verdict.exitCode, 0);
    assert.equal(verdict.failureReason, null);
    assert.match(verdict.note, /应用已退出/);
  });

  it('已有实例在运行 → 退出码 0（双击第二次不是错误）', () => {
    const verdict = classifyLauncherExit({ ready: false, duplicateInstance: true, code: 0, signal: null });
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.note, /已有实例/);
  });

  it('没见过就绪 → 退出码 1', () => {
    const verdict = classifyLauncherExit({ ready: false, duplicateInstance: false, code: 1, signal: null });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.failureReason, /退出码 1/);
  });
});

describe('与仓库其它部分的一致性', () => {
  it('"已有实例在运行"的特征与主进程的日志对得上', () => {
    const mainSource = readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');
    const logLine = mainSource.match(/log\.warn\(\s*'([^']+)',\s*'([^']+)'/);
    assert.ok(logLine, '主进程里找不到单实例锁的告警日志');
    const sample = `${logLine[1]} ${logLine[2]}`;
    assert.ok(
      isDuplicateInstanceOutput(sample) || isDuplicateInstanceOutput(`${sample}\nsecond-instance`),
      '主进程要么改了口径、要么这段日志没了，启动器就分不清"已有实例"和"真失败"了',
    );
  });

  it('启动器跑的确实等价于 pnpm dev', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(
      pkg.scripts.dev,
      'electron-vite dev',
      'package.json 的 dev 脚本变了，启动器（直接跑 electron-vite 的 CLI）需要跟着改',
    );
  });

  it('runtimePaths / resolveRuntimeDir：默认落在仓库 logs/，可被环境变量改掉', () => {
    const custom = path.join(os.tmpdir(), 'cottage-runtime');
    const dir = resolveRuntimeDir({ env: { COTTAGE_LAUNCH_DIR: custom }, repoRoot });
    assert.equal(dir, path.resolve(custom));
    assert.equal(resolveRuntimeDir({ env: {}, repoRoot }), path.join(repoRoot, 'logs'));
    const paths = runtimePaths(dir);
    assert.equal(paths.logFile, path.join(dir, 'dev.log'));
    assert.equal(paths.lockFile, path.join(dir, 'dev-launcher.lock'));
    assert.equal(paths.failureFile, path.join(dir, 'dev-failure.txt'));
  });

  it('VBS 垫片是 ASCII：wscript 按系统代码页读它，非 ASCII 注释会变乱码', () => {
    const vbs = readFileSync(path.join(repoRoot, 'scripts/launch-dev.vbs'));
    const nonAscii = [...vbs.toString('latin1')].filter((ch) => ch.charCodeAt(0) > 127);
    assert.equal(nonAscii.length, 0, 'launch-dev.vbs 里出现了非 ASCII 字符');
    const text = vbs.toString('utf8');
    assert.match(text, /launch-dev\.mjs/, 'VBS 必须调到真正的启动器');
    assert.match(text, /notepad\.exe/, 'VBS 必须把失败说明摊开给人看，否则失败是静默的');
    assert.match(text, /dev-failure\.txt/);
    assert.match(text, /", 0, True\)/, 'VBS 必须以"隐藏窗口 + 等待"的方式起启动器');
  });

  it('桌面快捷方式指向 wscript（不是 node / pnpm —— 那两个都会留黑框）', async () => {
    const { buildShortcutSpec } = await import('../scripts/create-desktop-shortcut.mjs');
    const spec = buildShortcutSpec({ repoRoot, desktopDir: 'C:\\Desktop' });
    assert.match(spec.targetPath, /wscript\.exe$/i);
    assert.match(spec.arguments, /launch-dev\.vbs"$/);
    assert.equal(spec.workingDirectory, repoRoot);
    assert.match(spec.linkPath, /Cottage\.lnk$/);
  });
});

describe('启动器自己的默认值', () => {
  it('默认仓库根就是本仓库', () => {
    assert.equal(defaultRepoRoot(), repoRoot);
  });
});
