#!/usr/bin/env node
/**
 * 校验打包配置（electron-builder.yml、package.json、build/icon.ico）。
 *
 * 存在的理由：打包配置的错误**不会在单测或 typecheck 里暴露**，而且大多只在
 * 用户装完之后才现形，属于最贵的一类 bug。docs/tech-stack.md 第 10 节与验收清单
 * 第 13 条把下面这些定为硬约束，这里把它们固化成可执行断言：
 *
 *   - asarUnpack 必须覆盖 **\/*.node（原生模块在 asar 里无法 dlopen，
 *     漏了它 → 装完首次启动报"找不到模块"）；
 *   - better-sqlite3 必须是 runtime dependency（放 devDependencies 就不会被打进包）；
 *   - Windows 目标必须是 nsis，且产物名与 scripts/package-win.mjs 的查找规则一致；
 *   - 图标必须存在且含 256×256 档（electron-builder 的硬性下限）。
 *
 * 为什么用文本匹配而不是解析 YAML：仓库里没有直接的 YAML 解析依赖
 * （js-yaml 只在 pnpm store 里，非直接依赖 import 不到）。配置结构固定，
 * 匹配关键行足够，也避免为一份校验器引入新依赖。
 *
 * 用法：node scripts/verify-packaging.mjs
 * 退出码：0 = 通过，1 = 有问题
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_PATH_DEFAULT = 'electron-builder.yml';
export const ICON_PATH_DEFAULT = 'build/icon.ico';

/** electron-builder 对 Windows 图标的最低要求。 */
export const REQUIRED_ICON_SIZE = 256;

/**
 * 解析 .ico 目录，返回其中包含的所有尺寸（宽, 高）。
 *
 * ICO 头部：Reserved(2, 必须为 0) Type(2, 必须为 1) Count(2)，随后是每条
 * 16 字节的目录项，第 1 字节宽、第 2 字节高（0 表示 256）。
 *
 * 先校验头部：只看 Count 的话，随便一个非 ICO 文件（前几字节恰好是较大整数）
 * 会被读出一堆假尺寸，于是"图标是坏的"变成"图标尺寸不够"，报错指向错误的方向。
 * 这个漏洞是 test/verify-packaging.test.mjs 的"非法 .ico"用例抓出来的。
 */
export function parseIcoSizes(buffer) {
  if (buffer.length < 6) return [];
  if (buffer.readUInt16LE(0) !== 0) return []; // reserved 必须为 0
  if (buffer.readUInt16LE(2) !== 1) return []; // type 必须为 1（图标）
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    if (offset + 2 > buffer.length) break;
    const w = buffer[offset] === 0 ? 256 : buffer[offset];
    const h = buffer[offset + 1] === 0 ? 256 : buffer[offset + 1];
    sizes.push([w, h]);
  }
  return sizes;
}

/** 取 `key:` 开头的块（含其缩进子项），用于把某个顶层键的正文切出来。 */
export function yamlBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start === -1) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    // 顶格的非注释行表示这一块结束
    if (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/**
 * @param {{ cwd?: string, configPath?: string, iconPath?: string }} [options]
 * @returns {{ ok: boolean, issues: string[], stats: Record<string, unknown> }}
 */
export function verifyPackaging({ cwd = repoRoot, configPath = CONFIG_PATH_DEFAULT, iconPath = ICON_PATH_DEFAULT } = {}) {
  const issues = [];
  const absConfig = path.resolve(cwd, configPath);
  const absIcon = path.resolve(cwd, iconPath);
  const pkgPath = path.join(cwd, 'package.json');

  let config = '';
  try {
    config = readFileSync(absConfig, 'utf8');
  } catch (err) {
    return {
      ok: false,
      issues: [`无法读取打包配置：${absConfig}（${err.code ?? err.message}）`],
      stats: {},
    };
  }

  // ---- 1. 基本标识 ----
  for (const [key, label] of [
    ['appId', '必须固定 appId（安装标识与卸载登记都依赖它）'],
    ['productName', '必须固定 productName（决定安装目录与快捷方式名）'],
  ]) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(config)) issues.push(`缺少 ${key}：${label}`);
  }

  // ---- 2. files 必须把运行期产物与原生模块收进去 ----
  const filesBlock = yamlBlock(config, 'files');
  if (!filesBlock) {
    issues.push('缺少 files 配置：不显式声明会漏收 out/ 或 node_modules');
  } else {
    if (!/out\/\*\*/.test(filesBlock)) {
      issues.push('files 未包含 out/**/*：主进程与 renderer 产物不会进包');
    }
    if (!/node_modules\/\*\*/.test(filesBlock)) {
      issues.push('files 未包含 node_modules/**/*：better-sqlite3 不会被收进包');
    }
    if (!/package\.json/.test(filesBlock)) {
      issues.push('files 未包含 package.json：主进程入口字段 main 会丢失，应用无法启动');
    }
  }

  // ---- 3. asarUnpack 必须覆盖原生模块（验收项 13 的核心） ----
  const asarBlock = yamlBlock(config, 'asarUnpack');
  if (!asarBlock) {
    issues.push('缺少 asarUnpack：原生模块留在 asar 内会导致启动时报找不到模块');
  } else {
    if (!/\*\*\/\*\.node/.test(asarBlock)) {
      issues.push('asarUnpack 未包含 **/*.node：原生模块无法从 asar 内加载');
    }
    if (!/better-sqlite3/.test(asarBlock)) {
      issues.push('asarUnpack 未覆盖 better-sqlite3（其 .node 与配套文件都必须解包）');
    }
  }

  // ---- 4. Windows 目标与产物名 ----
  const winBlock = yamlBlock(config, 'win');
  if (!winBlock) {
    issues.push('缺少 win 配置：不会产出 Windows 安装包');
  } else {
    if (!/nsis/.test(winBlock)) issues.push('win.target 未包含 nsis：产不出安装包');
    if (!/icon:\s*build\/icon\.ico/.test(winBlock)) {
      issues.push('win.icon 未指向 build/icon.ico');
    }
  }
  if (!/^artifactName:\s*Cottage-Setup-\$\{version\}\.\$\{ext\}/m.test(config)) {
    issues.push('artifactName 必须形如 Cottage-Setup-${version}.${ext}（package-win.mjs 按此查找产物）');
  }

  // ---- 5. package.json：runtime 依赖与打包脚本 ----
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    issues.push(`无法读取 package.json：${err.code ?? err.message}`);
  }
  if (pkg) {
    if (!pkg.dependencies?.['better-sqlite3']) {
      issues.push('better-sqlite3 必须在 dependencies 里：放 devDependencies 不会被收进安装包');
    }
    if (!pkg.scripts?.['package:win']) {
      issues.push('缺少 package:win 脚本');
    }
    if (!pkg.main) issues.push('package.json 缺少 main 字段');
  }

  // ---- 6. 图标存在且含 256×256 档 ----
  let iconSizes = [];
  let iconBytes = 0;
  if (!existsSync(absIcon)) {
    issues.push(`图标不存在：${absIcon}（electron-builder 需要 build/icon.ico）`);
  } else {
    const buf = readFileSync(absIcon);
    iconBytes = statSync(absIcon).size;
    iconSizes = parseIcoSizes(buf);
    if (!iconSizes.length) {
      issues.push(`${iconPath} 不是合法的 .ico（读不到目录项）`);
    } else {
      const max = Math.max(...iconSizes.map(([w]) => w));
      if (max < REQUIRED_ICON_SIZE) {
        issues.push(
          `${iconPath} 最大只有 ${max}×${max}，electron-builder 要求至少 ${REQUIRED_ICON_SIZE}×${REQUIRED_ICON_SIZE}`,
        );
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      configLines: config.split(/\r?\n/).length,
      filesEntries: filesBlock ? (filesBlock.match(/^\s*-\s/gm) ?? []).length : 0,
      asarEntries: asarBlock ? (asarBlock.match(/^\s*-\s/gm) ?? []).length : 0,
      iconSizes: iconSizes.map(([w]) => w).sort((a, b) => a - b),
      iconBytes,
      version: pkg?.version ?? null,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPackaging();
  if (result.ok) {
    const s = result.stats;
    console.log(`✓ ${CONFIG_PATH_DEFAULT}`);
    console.log(`  ${s.configLines} 行 / files ${s.filesEntries} 条 / asarUnpack ${s.asarEntries} 条`);
    console.log(`✓ ${ICON_PATH_DEFAULT}`);
    console.log(`  ${s.iconSizes.join(' / ')} 共 ${s.iconSizes.length} 档 / ${(s.iconBytes / 1024).toFixed(1)} KB`);
    process.exit(0);
  }
  console.error(`✗ 打包配置有问题：`);
  for (const issue of result.issues) console.error(`  - ${issue}`);
  process.exit(1);
}
