/**
 * `scripts/verify-dev-server.mjs`（开发模式冒烟）自身的测试。
 *
 * 这里只钉一件事：**端口被占用时不许伪装成构建失败**。
 *
 * 为什么值得单独写：这个脚本的就绪判据是"5173 上有人在提供 renderer 入口"，
 * 它分不清那个 server 是自己起的还是别人起的。桌面快捷方式启动的 Cottage 会一直占着
 * 5173，于是 `pnpm verify:all` 会报出"没有观察到主进程构建成功的标志"——真实原因
 * （端口被占）被藏起来，指向的却是构建配置。这类"失败信息与原因无关"的问题
 * 只能靠断言把它钉住。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DEV_PORT, preflightVerdict } from '../scripts/verify-dev-server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('dev server 端口被占用：按"环境受限"报告，不伪装成失败', () => {
  it('端口空闲时不做任何判断（照常往下走）', () => {
    assert.equal(preflightVerdict({ portBusy: false }), null);
  });

  it('端口被占 + 默认宽松 → 退出 0，但明确说"未能完成校验"并给出最可能的原因', () => {
    const verdict = preflightVerdict({ portBusy: true, port: DEV_PORT });
    assert.equal(verdict.exitCode, 0);
    const text = verdict.lines.join('\n');
    assert.match(text, /未能完成校验/);
    assert.match(text, new RegExp(String(DEV_PORT)));
    assert.match(text, /Cottage 正在运行/);
    assert.match(text, /先关掉正在运行的应用/);
    // 关键：不能把"环境受限"说成"通过了"
    assert.doesNotMatch(text, /通过/);
  });

  it('端口被占 + COTTAGE_SMOKE_STRICT=1 → 退出非 0（CI 上要严格）', () => {
    const verdict = preflightVerdict({ portBusy: true, port: DEV_PORT, strict: true });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.lines.join('\n'), /COTTAGE_SMOKE_STRICT=1：按失败处理/);
  });

  it('预检确实接在 main() 的启动路径上（否则这条判断永远不会生效）', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/verify-dev-server.mjs'), 'utf8');
    const preflightAt = source.indexOf('const preflight = preflightVerdict(');
    const spawnAt = source.indexOf("spawn(process.execPath, [cli, 'dev']");
    assert.ok(preflightAt > -1, '预检调用被删掉了');
    assert.ok(spawnAt > -1, '找不到启动 electron-vite 的位置');
    assert.ok(preflightAt < spawnAt, '预检必须在起 dev server 之前，否则端口已被自己的进程占上');
  });
});
