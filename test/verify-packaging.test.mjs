import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyPackaging,
  parseIcoSizes,
  yamlBlock,
  REQUIRED_ICON_SIZE,
  CONFIG_PATH_DEFAULT,
  ICON_PATH_DEFAULT,
} from '../scripts/verify-packaging.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-packaging-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/* ---------------- 造一份最小合法的打包配置 ---------------- */

/** 与真实 electron-builder.yml 同构的最小配置；改哪一条就传哪一条。 */
function validConfig({
  files = [
    'package.json',
    'out/**/*',
    'node_modules/**/*',
  ],
  asarUnpack = ['**/*.node', 'node_modules/better-sqlite3/**'],
  win = ['target:', '  - target: nsis', '    arch:', '      - x64', 'icon: build/icon.ico'],
  artifactName = 'Cottage-Setup-${version}.${ext}',
} = {}) {
  return [
    'appId: com.cottage.app',
    'productName: Cottage',
    '',
    'directories:',
    '  buildResources: build',
    '  output: dist',
    '',
    'files:',
    ...files.map((f) => `  - ${f}`),
    '',
    'asarUnpack:',
    ...asarUnpack.map((a) => `  - ${a}`),
    '',
    'win:',
    ...win.map((l) => `  ${l}`),
    '',
    `artifactName: ${artifactName}`,
    '',
  ].join('\n');
}

/** 造一个含指定尺寸档位的 .ico（只需头部正确即可被解析）。 */
function makeIco(sizes = [[16, 16], [32, 32], [256, 256]]) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(sizes.length * 16);
  sizes.forEach(([w, h], i) => {
    entries.writeUInt8(w === 256 ? 0 : w, i * 16);
    entries.writeUInt8(h === 256 ? 0 : h, i * 16 + 1);
  });
  return Buffer.concat([header, entries]);
}

/**
 * 造一个完整的仓库骨架（配置 + package.json + 图标），返回 cwd。
 * @returns {string} caseRoot
 */
function makeRepo({
  config = validConfig(),
  pkg = { name: 'cottage', version: '0.1.0', main: 'out/main/index.js', dependencies: { 'better-sqlite3': '11.10.0' }, scripts: { 'package:win': 'node scripts/package-win.mjs' } },
  ico = makeIco(),
} = {}) {
  const root = mkdtempSync(path.join(tmp, 'repo-'));
  mkdirSync(path.join(root, 'build'), { recursive: true });
  if (config !== null) writeFileSync(path.join(root, CONFIG_PATH_DEFAULT), config, 'utf8');
  if (pkg !== null) writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  if (ico !== null) writeFileSync(path.join(root, ICON_PATH_DEFAULT), ico);
  return root;
}

function expectIssue(result, needle, label) {
  assert.equal(result.ok, false, `${label}：本应校验失败`);
  assert.ok(
    result.issues.some((i) => i.includes(needle)),
    `${label}：未出现「${needle}」相关报错，实际：\n${result.issues.join('\n')}`,
  );
}

/* ---------------- 真实配置 ---------------- */

test('真实打包配置通过校验', () => {
  const result = verifyPackaging({ cwd: repoRoot });
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.ok(result.stats.asarEntries >= 2);
  assert.ok(
    Math.max(...result.stats.iconSizes) >= REQUIRED_ICON_SIZE,
    `图标最大档应 ≥ ${REQUIRED_ICON_SIZE}`,
  );
});

test('配置或图标不存在时返回可读错误而不是抛异常', () => {
  const empty = mkdtempSync(path.join(tmp, 'empty-'));
  const result = verifyPackaging({ cwd: empty });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /无法读取打包配置/);
});

/* ---------------- asarUnpack（验收项 13 的核心） ---------------- */

test('asarUnpack 缺 **/*.node 会被检出', () => {
  const root = makeRepo({ config: validConfig({ asarUnpack: ['node_modules/better-sqlite3/**'] }) });
  expectIssue(verifyPackaging({ cwd: root }), '**/*.node', '缺 .node 通配');
});

test('asarUnpack 缺 better-sqlite3 会被检出', () => {
  const root = makeRepo({ config: validConfig({ asarUnpack: ['**/*.node'] }) });
  expectIssue(verifyPackaging({ cwd: root }), 'better-sqlite3', '缺 better-sqlite3');
});

test('整个 asarUnpack 缺失会被检出', () => {
  const config = validConfig().replace(/asarUnpack:\n(  - .*\n)+/, '');
  const root = makeRepo({ config });
  expectIssue(verifyPackaging({ cwd: root }), '缺少 asarUnpack', '无 asarUnpack');
});

/* ---------------- files 必须收齐运行期产物 ---------------- */

test('files 漏掉 node_modules 会被检出', () => {
  const root = makeRepo({ config: validConfig({ files: ['package.json', 'out/**/*'] }) });
  expectIssue(verifyPackaging({ cwd: root }), 'node_modules', '缺 node_modules');
});

test('files 漏掉 out/** 会被检出（产物不会进包）', () => {
  const root = makeRepo({ config: validConfig({ files: ['package.json', 'node_modules/**/*'] }) });
  expectIssue(verifyPackaging({ cwd: root }), 'out/**', '缺 out');
});

test('files 漏掉 package.json 会被检出（main 字段丢失则应用起不来）', () => {
  const root = makeRepo({ config: validConfig({ files: ['out/**/*', 'node_modules/**/*'] }) });
  expectIssue(verifyPackaging({ cwd: root }), 'package.json', '缺 package.json');
});

/* ---------------- Windows 目标与产物名 ---------------- */

test('win 目标不是 nsis 会被检出', () => {
  const root = makeRepo({ config: validConfig({ win: ['target: portable', 'icon: build/icon.ico'] }) });
  expectIssue(verifyPackaging({ cwd: root }), 'nsis', '非 nsis');
});

test('win.icon 未指向 build/icon.ico 会被检出', () => {
  const root = makeRepo({
    config: validConfig({ win: ['target:', '  - target: nsis', 'icon: assets/app.ico'] }),
  });
  expectIssue(verifyPackaging({ cwd: root }), 'win.icon', 'icon 路径不对');
});

test('artifactName 与 package-win.mjs 的查找规则不一致会被检出', () => {
  const root = makeRepo({ config: validConfig({ artifactName: 'Cottage-${version}.${ext}' }) });
  expectIssue(verifyPackaging({ cwd: root }), 'artifactName', 'artifactName 不符');
});

/* ---------------- package.json 的两条硬约束 ---------------- */

test('better-sqlite3 放进 devDependencies 会被检出', () => {
  const root = makeRepo({
    pkg: {
      name: 'cottage',
      version: '0.1.0',
      main: 'out/main/index.js',
      dependencies: {},
      devDependencies: { 'better-sqlite3': '11.10.0' },
      scripts: { 'package:win': 'node scripts/package-win.mjs' },
    },
  });
  expectIssue(verifyPackaging({ cwd: root }), 'dependencies', '原生模块放错位置');
});

test('缺少 package:win 脚本会被检出', () => {
  const root = makeRepo({
    pkg: {
      name: 'cottage',
      version: '0.1.0',
      main: 'out/main/index.js',
      dependencies: { 'better-sqlite3': '11.10.0' },
      scripts: {},
    },
  });
  expectIssue(verifyPackaging({ cwd: root }), 'package:win', '缺打包脚本');
});

/* ---------------- 图标 ---------------- */

test('图标缺失会被检出', () => {
  const root = makeRepo({ ico: null });
  expectIssue(verifyPackaging({ cwd: root }), '图标不存在', '无图标');
});

test('图标最大档不足 256 会被检出（electron-builder 的硬性下限）', () => {
  const root = makeRepo({ ico: makeIco([[16, 16], [64, 64]]) });
  expectIssue(verifyPackaging({ cwd: root }), String(REQUIRED_ICON_SIZE), '图标过小');
});

test('非法 .ico 会被检出', () => {
  const root = makeRepo({ ico: Buffer.from('not an ico at all') });
  expectIssue(verifyPackaging({ cwd: root }), '合法的 .ico', '坏图标');
});

/* ---------------- 纯函数 ---------------- */

test('parseIcoSizes 把 0 读成 256（ICO 的尺寸字段约定）', () => {
  assert.deepEqual(parseIcoSizes(makeIco([[16, 16], [256, 256]])), [
    [16, 16],
    [256, 256],
  ]);
});

test('parseIcoSizes 对截断/空输入返回空数组而不是抛异常', () => {
  assert.deepEqual(parseIcoSizes(Buffer.alloc(0)), []);
  assert.deepEqual(parseIcoSizes(Buffer.from([0, 0, 1])), []);
  // 头部声明 2 档但目录项被截断：只返回能读到的
  const truncated = Buffer.concat([makeIco([[16, 16], [32, 32]]), Buffer.alloc(0)]).subarray(0, 22);
  assert.deepEqual(parseIcoSizes(truncated), [[16, 16]]);
});

test('yamlBlock 取到子项，遇到下一个顶格键就停', () => {
  const text = ['files:', '  - a', '  - b', 'asarUnpack:', '  - c', ''].join('\n');
  const files = yamlBlock(text, 'files');
  assert.ok(files.includes('- a'));
  assert.ok(!files.includes('- c'), 'files 块不应把 asarUnpack 的子项吃进来');
  assert.equal(yamlBlock(text, 'nope'), null);
});

test('yamlBlock 跳过块内注释行（注释不能让块提前结束）', () => {
  const text = ['files:', '  ## 说明', '  - a', 'win:', '  target: nsis'].join('\n');
  const files = yamlBlock(text, 'files');
  assert.ok(files.includes('- a'), '注释行之后仍应属于同一个块');
});
