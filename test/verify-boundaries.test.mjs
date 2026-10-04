/**
 * 编码与依赖边界校验器的测试。
 *
 * 这个校验器存在的理由见它自己的注释：中文被写坏与 core 层越界 import 这两件事
 * 都不会让功能测试失败，所以必须单独守住。这里验证它真的能拦住——
 * 一个永远返回 ok 的校验器比没有校验器更危险。
 *
 * 本文件需要豁免编码检查：它必须内含真实的误码样例（"瑙勮寖"这类），
 * 否则根本测不出 checkEncoding 有没有生效。
 * verify-boundaries:allow-mojibake
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyBoundaries,
  checkEncoding,
  checkImports,
  collectFiles,
  SOURCE_DIRS,
  REPLACEMENT_CHAR,
} from '../scripts/verify-boundaries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-boundaries-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** 造一个最小仓库：写入 `files`（相对路径 → 内容），然后校验。 */
function fixture(files) {
  seq += 1;
  const root = path.join(tmp, `case-${seq}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return verifyBoundaries(root);
}

/* ---------------- 真实仓库 ---------------- */

test('真实仓库通过编码与依赖边界校验', () => {
  const result = verifyBoundaries(repoRoot);
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.equal(result.ok, true);
  assert.ok(result.stats.files >= 20, '应扫描到全部源码文件');
});

test('扫描范围覆盖 src / scripts / test 与仓库根当前层级', () => {
  // '.' 是有意加进来的：它让 .gitignore 这类根配置文件也进入编码检查
  assert.deepEqual(SOURCE_DIRS, ['src', 'scripts', 'test', '.']);
  const files = collectFiles(path.join(repoRoot, 'src'));
  assert.ok(files.length >= 10, `src 下应有多个文件，实际 ${files.length}`);
  assert.ok(
    files.every((f) => !f.includes('node_modules')),
    '不应把 node_modules 纳进来',
  );
});

/* ---------------- 编码检查 ---------------- */

test('U+FFFD 替换字符会被检出', () => {
  const issues = checkEncoding(`const a = "${REPLACEMENT_CHAR}";`, 'src/x.ts');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /U\+FFFD/);
});

test('UTF-8 被写坏的中文会被检出', () => {
  // "不规范" 被按 GBK 解读后的样子；正常中文里不会出现这种组合
  const issues = checkEncoding('// 瑙勮寖鍖?baseUrl', 'src/x.ts');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /误码特征/);
});

test('正常中文与英文注释不会被误报', () => {
  const ok = '// 这是正常的中文注释：变量替换与 token 计数\nconst a = 1;\n';
  assert.deepEqual(checkEncoding(ok, 'src/x.ts'), []);
});

/* ---------------- 编码：非法字节与 BOM ---------------- */

test('非法 UTF-8 字节会被检出（此前只有 U+FFFD 检查，漏掉了这类）', () => {
  // 构造一段非法 UTF-8 字节：这正是用 PowerShell 的 Add-Content 追加内容时
  // 会产生的损坏形态（中文被按本地代码页写出去，高字节单独出现）。
  const invalid = Buffer.from([0x2f, 0x2f, 0x20, 0xb4, 0xe4, 0xca, 0xb1, 0x0a]);
  const asText = invalid.toString('utf8');

  // 前提校验：这段字节确实不是合法 UTF-8（否则用例本身没有意义）
  assert.equal(
    Buffer.from(asText, 'utf8').equals(invalid),
    false,
    '构造的样本应当不是合法 UTF-8',
  );

  const issues = checkEncoding(asText, '.gitignore', invalid);
  assert.ok(
    issues.some((i) => i.includes('不是合法的 UTF-8')),
    `应报非法 UTF-8，实际：${issues.join('；')}`,
  );
  // 有损解码本身也会留下替换字符，两条都该报出来
  assert.ok(issues.some((i) => i.includes('U+FFFD')), issues.join('；'));
});

test('合法 UTF-8 的原始字节不会被误报为非法', () => {
  const bytes = Buffer.from('# ---- 临时草稿 ----\nCOMMIT_MSG*\n', 'utf8');
  assert.deepEqual(checkEncoding(bytes.toString('utf8'), '.gitignore', bytes), []);
});

test('UTF-8 BOM 会被检出（它会让首行规则悄悄失效）', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n', 'utf8')]);
  const issues = checkEncoding(bytes.toString('utf8'), '.gitignore', bytes);
  assert.ok(issues.some((i) => i.includes('BOM')), issues.join('；'));
});

test('不传 bytes 时只做文本级检查（向后兼容）', () => {
  assert.deepEqual(checkEncoding('普通内容', 'x.ts'), []);
});

/* ---------------- 扫描范围：根目录配置文件 ---------------- */

test('.gitignore 在扫描范围内（这正是漏掉过一次的地方）', () => {
  const rootFiles = collectFiles(repoRoot, [], { rootOnly: true }).map((f) =>
    path.relative(repoRoot, f).split(path.sep).join('/'),
  );
  assert.ok(rootFiles.includes('.gitignore'), `根扫描应包含 .gitignore，实际：${rootFiles.join(',')}`);
  // 根扫描必须只扫当前层级，不能递归进 src
  assert.ok(
    !rootFiles.some((f) => f.startsWith('src/')),
    '根扫描不应递归进 src',
  );
});

test('根目录扫描跳过了 node_modules / out / .git', () => {
  const rootFiles = collectFiles(repoRoot, [], { rootOnly: true }).map((f) =>
    path.relative(repoRoot, f).split(path.sep).join('/'),
  );
  for (const bad of ['node_modules', 'out', '.git']) {
    assert.ok(!rootFiles.some((f) => f.startsWith(`${bad}/`)), `根扫描不应包含 ${bad}/`);
  }
});

/* ---------------- 依赖边界 ---------------- */

test('core 里出现 electron / node: 会被检出', () => {
  const electron = checkImports("import { app } from 'electron';", 'src/core/a.ts');
  assert.equal(electron.length, 1);
  assert.match(electron[0], /不得依赖 electron/);

  const nodeBuiltin = checkImports("import { readFileSync } from 'node:fs';", 'src/core/b.ts');
  assert.equal(nodeBuiltin.length, 1);
  assert.match(nodeBuiltin[0], /node: 内置模块/);
});

test('core 里 import main / renderer 会被检出', () => {
  assert.match(checkImports("import x from '../main/x.js';", 'src/core/a.ts')[0], /不得依赖 main/);
  assert.match(checkImports("import x from '@main/x.js';", 'src/core/a.ts')[0], /不得依赖 main/);
  assert.match(checkImports("import x from '@renderer/x.js';", 'src/core/a.ts')[0], /不得依赖 renderer/);
});

test('core 只依赖 zod 与自身是允许的（这正是它的设计）', () => {
  const ok = "import { z } from 'zod';\nimport { assemblePrompt } from './prompt/assemble.js';\n";
  assert.deepEqual(checkImports(ok, 'src/core/a.ts'), []);
});

test('renderer 里出现 electron / node: / main 会被检出', () => {
  assert.match(checkImports("import { ipcRenderer } from 'electron';", 'src/renderer/a.ts')[0], /electron/);
  assert.match(checkImports("import fs from 'node:fs';", 'src/renderer/a.ts')[0], /node 内置模块/);
  assert.match(checkImports("import x from '@main/db.js';", 'src/renderer/a.ts')[0], /不得 import main/);
});

test('renderer 依赖 shared 与 core 的类型是允许的', () => {
  const ok = "import { IPC } from '@shared/ipc.js';\nimport { formatTokenCount } from '@core/tokens/index.js';\n";
  assert.deepEqual(checkImports(ok, 'src/renderer/a.ts'), []);
});

test('shared 里出现 electron 或 node:fs 会被检出', () => {
  assert.match(checkImports("import { app } from 'electron';", 'src/shared/a.ts')[0], /shared 不得依赖 electron/);
  assert.match(checkImports("import fs from 'node:fs';", 'src/shared/a.ts')[0], /shared 不得做 IO/);
});

test('main 允许依赖 electron / node: / core / shared（不误报）', () => {
  const ok = [
    "import { app } from 'electron';",
    "import path from 'node:path';",
    "import { assemblePrompt } from '@core/prompt/assemble.js';",
    "import { IPC } from '@shared/ipc.js';",
  ].join('\n');
  assert.deepEqual(checkImports(ok, 'src/main/a.ts'), []);
});

test('src 下引用 demo/ 会被检出（验收项 16）', () => {
  const rel = checkImports("import { x } from '../../demo/foo.js';", 'src/renderer/a.ts');
  assert.equal(rel.length, 1);
  assert.match(rel[0], /不得引用 demo\//);

  const literal = checkImports("const demoPath = 'demo/index.html';", 'src/main/a.ts');
  assert.equal(literal.length, 1);
  assert.match(literal[0], /路径字符串/);
});

test('main / preload 里提到 demo 只是注释时不误报（只在 import 与路径串上判）', () => {
  // 校验器只看 import 与引号包起来的路径，不拦普通注释
  const ok = '// 这里的实现方式参考了 demo/index.html 的交互，但没有引用它的代码\nconst a = 1;\n';
  assert.deepEqual(checkImports(ok, 'src/renderer/a.ts'), []);
});

/* ---------------- 端到端 ---------------- */

test('整体校验能同时报出编码与边界两类问题', () => {
  const result = fixture({
    'src/core/bad.ts': "import { app } from 'electron';\n// 瑙勮寖鍖?\n",
    'src/renderer/ok.tsx': 'export const A = () => null;\n',
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('electron')));
  assert.ok(result.issues.some((i) => i.includes('误码')));
});

test('干净的最小仓库通过', () => {
  const result = fixture({
    'src/core/pure.ts': '// 纯逻辑，零平台依赖\nexport const a = 1;\n',
    'src/main/wire.ts': "import { app } from 'electron';\n",
    'src/shared/types.ts': 'export interface A { x: number }\n',
  });
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.equal(result.ok, true);
});

test('目录不存在时返回可读结果而不是抛异常', () => {
  const result = verifyBoundaries(path.join(tmp, 'nope'));
  assert.equal(result.ok, true);
  assert.equal(result.stats.files, 0);
});
