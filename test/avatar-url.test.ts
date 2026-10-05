/**
 * 头像通道测试。
 *
 * 分两半：
 *   - `buildAvatarUrl`（shared，renderer 也用）：相对路径 → URL；
 *   - `resolveAvatarRequest`（main）：URL → 磁盘文件。
 *
 * 后者是**安全边界**，所以重点全在"必须拒绝什么"上：renderer 里任何东西
 * （包括模型输出渲染出的内容）都能构造 `cottage-avatar://` URL，而 CSP 恰好放行了
 * 这个协议。只要路径校验漏一处，它就变成了读任意本地文件的能力。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAvatarUrl } from '../src/shared/avatar-url.js';
import { resolveAvatarRequest } from '../src/main/avatars.js';

/* --------------------------------- 构造 URL --------------------------------- */

describe('buildAvatarUrl', () => {
  it('普通相对路径 → 自有协议 URL', () => {
    expect(buildAvatarUrl('avatars/lin-wan.png')).toBe(
      'cottage-avatar://local/avatars/lin-wan.png',
    );
  });

  it('没有图片时返回 null（调用方回退到灰色占位块）', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(buildAvatarUrl(value)).toBeNull();
    }
  });

  it('反斜杠与多余的前导斜杠会被规范化', () => {
    expect(buildAvatarUrl('avatars\\lin.png')).toBe('cottage-avatar://local/avatars/lin.png');
    expect(buildAvatarUrl('/avatars/lin.png')).toBe('cottage-avatar://local/avatars/lin.png');
  });

  it('含 .. 的路径直接拒绝，不生成 URL', () => {
    expect(buildAvatarUrl('../secret.png')).toBeNull();
    expect(buildAvatarUrl('avatars/../../secret.png')).toBeNull();
  });

  it('空格与中文会被逐段编码，保证 URL 合法', () => {
    expect(buildAvatarUrl('avatars/林 晚.png')).toBe(
      `cottage-avatar://local/avatars/${encodeURIComponent('林 晚.png')}`,
    );
  });
});

/* -------------------------------- 解析与校验 -------------------------------- */

describe('resolveAvatarRequest（安全边界）', () => {
  let userData: string;
  let avatarDir: string;

  beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'cottage-avatar-test-'));
    avatarDir = path.join(userData, 'avatars');
    mkdirSync(avatarDir, { recursive: true });
    mkdirSync(path.join(userData, 'avatars-evil'), { recursive: true });
    // 一个 1×1 的合法 PNG（只要扩展名与存在性，内容不参与判断）
    writeFileSync(
      path.join(avatarDir, 'ok.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9v3lAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    writeFileSync(path.join(avatarDir, 'secret.txt'), 'not an image');
    writeFileSync(path.join(userData, 'cottage.db'), 'db');
    writeFileSync(path.join(userData, 'avatars-evil', 'x.png'), 'x');
  });

  afterAll(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('avatars/ 下的图片正常解析，并带上正确的 Content-Type', () => {
    const resolved = resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/ok.png');
    expect(resolved).not.toBeNull();
    expect(resolved!.filePath).toBe(path.join(avatarDir, 'ok.png'));
    expect(resolved!.contentType).toBe('image/png');
  });

  it('拒绝别的协议与别的 host', () => {
    expect(resolveAvatarRequest(userData, 'file:///etc/passwd')).toBeNull();
    expect(resolveAvatarRequest(userData, 'http://local/avatars/ok.png')).toBeNull();
    expect(resolveAvatarRequest(userData, 'cottage-avatar://evil/avatars/ok.png')).toBeNull();
    expect(resolveAvatarRequest(userData, '不是一个 URL')).toBeNull();
  });

  it('拒绝目录穿越（明文与百分号编码两种写法）', () => {
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/../cottage.db')).toBeNull();
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/../../cottage.db')).toBeNull();
    expect(
      resolveAvatarRequest(userData, 'cottage-avatar://local/%2e%2e%2fcottage.db'),
    ).toBeNull();
    expect(
      resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/%2e%2e/%2e%2e/cottage.db'),
    ).toBeNull();
  });

  it('拒绝同前缀的兄弟目录（startsWith 写法会漏掉这个）', () => {
    // <userData>/avatars-evil 与 <userData>/avatars 是同前缀，必须靠 path.relative 判断
    expect(
      resolveAvatarRequest(userData, 'cottage-avatar://local/../avatars-evil/x.png'),
    ).toBeNull();
  });

  it('拒绝不在白名单里的扩展名，哪怕文件真的存在', () => {
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/secret.txt')).toBeNull();
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/ok.png.exe')).toBeNull();
  });

  it('拒绝含有 NUL 字节的路径', () => {
    expect(
      resolveAvatarRequest(userData, `cottage-avatar://local/avatars/ok.png%00.txt`),
    ).toBeNull();
  });

  it('拒绝畸形百分号编码，而不是抛异常', () => {
    expect(() =>
      resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/%zz.png'),
    ).not.toThrow();
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/%zz.png')).toBeNull();
  });

  it('文件不存在时返回 null（handler 会回 404）', () => {
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/avatars/missing.png')).toBeNull();
  });

  it('空路径返回 null', () => {
    expect(resolveAvatarRequest(userData, 'cottage-avatar://local/')).toBeNull();
  });
});
