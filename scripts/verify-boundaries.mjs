#!/usr/bin/env node
/**
 * 校验源码与文档的编码与依赖边界。
 *
 * 存在的理由（两条都是真实踩过的坑）：
 *
 * 1. **编码**：仓库以 UTF-8 存中文注释与文案。用 PowerShell 的
 *    `Get-Content -Raw | Set-Content` 改写文件时，如果没指定编码，中文会被写坏成
 *    乱码（`瑙勮寖鍖`这种）。这种损坏**不会**让测试失败——只会让注释变成天书，
 *    而且 diff 巨大。所以这里把它变成可执行断言：源码里不允许出现典型的
 *    UTF-8 误码特征，也不允许出现替换字符 `U+FFFD`。
 *
 * 2. **依赖方向**（技术方案 1.2 不变量 I1 与 4.2 的允许依赖表）：
 *      renderer → preload → shared，main → core/shared；core 不依赖任何上层。
 *    `src/core` 一旦 import 了 `electron` 或 `node:`，那条"组装是纯函数、可以在
 *    纯 Node 下测"的承诺就悄悄破了。这里在 CI 阶段直接拦住。
 *
 * 用法：node scripts/verify-boundaries.mjs [repoRoot]
 * 退出码：0 = 通过，1 = 有问题
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 本文件自身需要豁免编码检查：它必须保留真实的误码样例，否则测不出校验器有没有用。
// verify-boundaries:allow-mojibake

/** 需要扫描的源码目录。 */
export const SOURCE_DIRS = ['src', 'scripts', 'test'];

/** 只扫这些扩展名。 */
export const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.html', '.css', '.md'];

/** 替换字符：任何一种编码转换出错都会留下它。 */
export const REPLACEMENT_CHAR = '\uFFFD';

/**
 * UTF-8 被按 GBK/Latin-1 解读后的典型特征串。
 * 这些组合在正常中文里几乎不可能出现，出现即说明编码被写坏。
 */
export const MOJIBAKE_MARKERS = ['瑙勮寖', '鎻愮ず', '涓嶅彲', '娴佸紡', '鏂囨。', '鍑芥暟', '璁℃暟'];

/**
 * 逐文件的编码检查豁免标记。
 *
 * 只有"测试本校验器自身"的文件才需要它——那些文件必须内含真实的误码样例，
 * 否则测不出校验器有没有用。用显式标记而不是路径白名单，是为了让豁免在 diff 里
 * 一眼可见：谁加了、为什么加，都写在那一行上。
 */
export const ENCODING_OPT_OUT = 'verify-boundaries:allow-mojibake';

/** `src/core` 里禁止出现的 import（不变量 I1 / I3）。 */
export const CORE_FORBIDDEN_IMPORTS = [
  { re: /from\s+['"]electron['"]/, why: 'core 不得依赖 electron' },
  { re: /from\s+['"]node:/, why: 'core 不得依赖 node: 内置模块' },
  { re: /from\s+['"]\.\.\/main\//, why: 'core 不得依赖 main' },
  { re: /from\s+['"]\.\.\/renderer\//, why: 'core 不得依赖 renderer' },
  { re: /from\s+['"]@main\//, why: 'core 不得依赖 main' },
  { re: /from\s+['"]@renderer\//, why: 'core 不得依赖 renderer' },
];

/** `src/renderer` 里禁止出现的 import。 */
export const RENDERER_FORBIDDEN_IMPORTS = [
  { re: /from\s+['"]electron['"]/, why: 'renderer 不得直接触达 electron' },
  { re: /from\s+['"]node:/, why: 'renderer 不得使用 node 内置模块' },
  { re: /from\s+['"]@main\//, why: 'renderer 不得 import main（数据库与网络只在主进程）' },
  { re: /from\s+['"]\.\.\/main\//, why: 'renderer 不得 import main' },
];

/** `src/shared` 里禁止 IO。 */
export const SHARED_FORBIDDEN_IMPORTS = [
  { re: /from\s+['"]electron['"]/, why: 'shared 不得依赖 electron' },
  { re: /from\s+['"]node:fs['"]/, why: 'shared 不得做 IO' },
];

/** 递归收集文件（跳过 node_modules / out / .git / demo）。 */
export function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'out' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, acc);
      continue;
    }
    if (SCANNED_EXTENSIONS.includes(path.extname(entry))) acc.push(full);
  }
  return acc;
}

/** 检查一个文件的编码是否可信。 */
export function checkEncoding(text, rel) {
  const issues = [];
  if (text.includes(REPLACEMENT_CHAR)) {
    issues.push(`${rel}：出现替换字符 U+FFFD，文件编码已损坏`);
  }
  for (const marker of MOJIBAKE_MARKERS) {
    if (text.includes(marker)) {
      issues.push(`${rel}：出现 UTF-8 误码特征「${marker}」，文件中文已被写坏`);
    }
  }
  return issues;
}

/** 检查 import 边界。 */
export function checkImports(text, rel) {
  const issues = [];
  const rules = rel.startsWith('src/core/')
    ? CORE_FORBIDDEN_IMPORTS
    : rel.startsWith('src/renderer/')
      ? RENDERER_FORBIDDEN_IMPORTS
      : rel.startsWith('src/shared/')
        ? SHARED_FORBIDDEN_IMPORTS
        : [];
  for (const { re, why } of rules) {
    if (re.test(text)) issues.push(`${rel}：${why}（匹配 ${re}）`);
  }
  return issues;
}

export function verifyBoundaries(root = repoRoot) {
  const issues = [];
  const files = [];
  for (const dir of SOURCE_DIRS) files.push(...collectFiles(path.join(root, dir)));

  let scanned = 0;
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    scanned += 1;
    // 逐文件豁免：只有校验器自身的测试需要（它必须内含真实误码样例）。
    if (!text.includes(ENCODING_OPT_OUT)) {
      issues.push(...checkEncoding(text, rel));
    }
    issues.push(...checkImports(text, rel));
  }

  return { ok: issues.length === 0, issues, stats: { files: scanned } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? repoRoot;
  const { ok, issues, stats } = verifyBoundaries(target);
  if (ok) {
    console.log(`✓ 编码与依赖边界校验通过：${path.relative(repoRoot, target) || '.'}`);
    console.log(`  扫描 ${stats.files} 个文件（src / scripts / test）`);
    process.exit(0);
  }
  console.error(`✗ 编码与依赖边界校验失败：${target}`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
