/**
 * 冒烟测试脚本自身的测试（`node --test` 驱动，与 verify-*.test.mjs 同层）。
 *
 * 为什么值得给一个"测试脚本"写测试：
 *   1. 它的判定逻辑一旦写错，会**安静地骗人**——比如把"环境起不来"报成通过，
 *      或者拿一条过早的日志当成就绪标志。实测两种都发生过。
 *   2. 那条"就绪标志必须晚于整条启动链"的约定横跨两个文件
 *      （src/main/index.ts 打日志、scripts/smoke-electron.mjs 认日志），
 *      单看任何一边都看不出问题，所以在这里把它钉在一起。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  FATAL_PATTERNS,
  READY_PATTERNS,
  buildLaunchArgs,
  classifyRun,
  parseExitCode,
  planUserDataRoots,
  shouldDisableSandbox,
} from '../scripts/smoke-electron.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');
const mainIpcSource = readFileSync(path.join(repoRoot, 'src/main/ipc/index.ts'), 'utf8');

describe('就绪标志与主进程日志是一份契约', () => {
  it('READY_PATTERNS 匹配主进程打出的就绪日志', () => {
    for (const pattern of READY_PATTERNS) {
      assert.ok(
        pattern.test(" [info] 启动完成 {\"windowId\":1}"),
        `就绪标志 ${pattern} 匹配不上主进程的『启动完成』日志，冒烟测试会永远失败`,
      );
    }
  });

  it('主进程确实会打『启动完成』，且晚于建窗口', () => {
    const logAt = mainSource.indexOf("log.info('启动完成'");
    const windowAt = mainSource.indexOf('createMainWindow()');
    assert.ok(logAt > -1, '主进程不再打印『启动完成』，冒烟测试的就绪标志失效');
    assert.ok(windowAt > -1, '主进程里找不到 createMainWindow()');
    assert.ok(
      logAt > windowAt,
      '『启动完成』必须打在创建窗口之后，否则又会出现"IPC 注册失败却判为通过"',
    );
  });

  it('不再拿过早的『数据库已打开』当就绪标志', () => {
    // 这条日志在迁移之前，拿它当成功判据会漏掉后续的 IPC 注册失败
    for (const pattern of READY_PATTERNS) {
      assert.equal(
        pattern.test(' [info] 数据库已打开 {"dbPath":"x"}'),
        false,
        `就绪标志 ${pattern} 会匹配过早的『数据库已打开』，这正是曾经漏掉 IPC 缺陷的原因`,
      );
    }
  });

  it('致命模式能识别 IPC 通道不齐的启动失败', () => {
    const real = 'Error: 以下 IPC 通道已登记在 INVOKE 里但没有 handler：export:character-card';
    assert.ok(
      FATAL_PATTERNS.some((re) => re.test(real)),
      '主进程的 IPC 通道断言报错必须被当成致命特征，否则冒烟测试会把它当普通输出忽略',
    );
    assert.ok(
      /以下 IPC 通道已登记在 INVOKE 里但没有 handler/.test(mainIpcSource),
      'src/main/ipc/index.ts 里的报错文案变了，请同步 FATAL_PATTERNS',
    );
  });
});

describe('classifyRun 归类启动结果', () => {
  it('看到就绪标志就是 ready，优先于其它信号', () => {
    const r = classifyRun({ output: '启动完成', ready: true, finished: 'ready' });
    assert.equal(r.verdict, 'ready');
  });

  it('命中致命模式就是 fatal（真实失败，不是环境问题）', () => {
    const r = classifyRun({
      output: 'Error: 以下 IPC 通道已登记在 INVOKE 里但没有 handler：x',
      fatal: true,
      finished: 'fatal',
    });
    assert.equal(r.verdict, 'fatal');
    assert.equal(r.verdict === 'fatal' && r.detail.includes('致命'), true);
  });

  it('0x80000003 且无输出 → 判为沙箱初始化失败，不是应用失败', () => {
    // Node 里是 2147483651，PowerShell 里是 -2147483645，两个都必须认得
    for (const code of [2147483651, -2147483645]) {
      const r = classifyRun({ output: '', finished: `exit:${code}` });
      assert.equal(r.verdict, 'sandbox-init', `退出码 ${code} 应判为沙箱初始化失败`);
    }
  });

  it('输出里出现 0x80000003 也算沙箱初始化失败', () => {
    const r = classifyRun({ output: 'crash 0x80000003', finished: 'exit:1' });
    assert.equal(r.verdict, 'sandbox-init');
  });

  it('单实例锁建不了 → 单独归类（可换目录重试）', () => {
    const r = classifyRun({
      output: '[ERROR:process_singleton_win.cc(468)] Lock file can not be created! Error code: 5',
      finished: 'exit:0',
    });
    assert.equal(r.verdict, 'singleton-lock');
  });

  it('致命模式优先于单实例锁（有硬证据就不是环境问题）', () => {
    const r = classifyRun({
      output: 'Lock file can not be created',
      fatal: true,
      finished: 'fatal',
    });
    assert.equal(r.verdict, 'fatal');
  });

  it('超时与意外退出各自归类，都不会被当成通过', () => {
    assert.equal(classifyRun({ finished: 'timeout' }).verdict, 'timeout');
    assert.equal(classifyRun({ output: 'something', finished: 'exit:1' }).verdict, 'unknown-exit');
    assert.equal(classifyRun({ finished: 'exit:0' }).verdict, 'unknown-exit');
  });
});

describe('启动参数', () => {
  it('总是带入口与独立 userData', () => {
    const args = buildLaunchArgs({ main: 'out/main/index.js', userDataDir: 'D:\\ud', disableSandbox: false });
    assert.deepEqual(args, ['out/main/index.js', '--user-data-dir=D:\\ud']);
  });

  it('禁用沙箱时追加 --no-sandbox', () => {
    const args = buildLaunchArgs({ main: 'm.js', userDataDir: 'D:\\ud', disableSandbox: true });
    assert.deepEqual(args, ['m.js', '--user-data-dir=D:\\ud', '--no-sandbox']);
  });

  it('默认禁用沙箱（避免崩溃弹窗），显式设 COTTAGE_SMOKE_SANDBOXED=1 才启用', () => {
    assert.equal(shouldDisableSandbox({}), true);
    assert.equal(shouldDisableSandbox({ COTTAGE_SMOKE_SANDBOXED: '0' }), true);
    assert.equal(shouldDisableSandbox({ COTTAGE_SMOKE_SANDBOXED: '1' }), false);
  });
});

describe('userData 候选目录', () => {
  it('默认先试系统临时目录，再回退到用户目录', () => {
    const roots = planUserDataRoots({ env: {}, tempDir: 'D:\\tmp', homeDir: 'C:\\Users\\u' });
    assert.deepEqual(roots, ['D:\\tmp', 'C:\\Users\\u']);
  });

  it('临时目录与用户目录相同时不重复尝试', () => {
    const roots = planUserDataRoots({ env: {}, tempDir: 'X:\\same', homeDir: 'X:\\same' });
    assert.deepEqual(roots, ['X:\\same']);
  });

  it('COTTAGE_SMOKE_USER_DATA 显式指定时不自动回退', () => {
    const roots = planUserDataRoots({
      env: { COTTAGE_SMOKE_USER_DATA: 'D:\\chosen' },
      tempDir: 'D:\\tmp',
      homeDir: 'C:\\Users\\u',
    });
    assert.deepEqual(roots, ['D:\\chosen']);
  });
});

describe('parseExitCode', () => {
  it('解析退出码，非退出态返回 null', () => {
    assert.equal(parseExitCode('exit:0'), 0);
    assert.equal(parseExitCode('exit:2147483651'), 2147483651);
    assert.equal(parseExitCode('exit:-2147483645'), -2147483645);
    assert.equal(parseExitCode('timeout'), null);
    assert.equal(parseExitCode('fatal'), null);
  });
});
