import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyTechStack,
  DOC_PATH_DEFAULT,
  SECTIONS,
  PATTERNS,
  NON_GOALS,
  FORBIDDEN,
  MIN_DIAGRAMS,
  MIN_CHECKLIST_ITEMS,
  REQUIRED_LINKS,
} from '../scripts/verify-tech-stack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realText = readFileSync(path.join(repoRoot, DOC_PATH_DEFAULT), 'utf8');

const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-techstack-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/**
 * 把文档副本写到 <case>/docs/tech-stack.md，并以 <case> 为 cwd 校验，
 * 保证相对路径与真实仓库一致。
 */
function patch(transform) {
  seq += 1;
  const caseRoot = path.join(tmp, `case-${seq}`);
  mkdirSync(path.join(caseRoot, 'docs'), { recursive: true });
  writeFileSync(path.join(caseRoot, DOC_PATH_DEFAULT), transform(realText), 'utf8');
  return verifyTechStack(DOC_PATH_DEFAULT, caseRoot);
}

/** 断言某条 issue 命中。 */
function expectIssue(result, needle, label) {
  assert.equal(result.ok, false, `${label}：本应校验失败`);
  assert.ok(
    result.issues.some((i) => i.includes(needle)),
    `${label}：未出现「${needle}」相关报错，实际报错：\n${result.issues.join('\n')}`,
  );
}

/* ---------------- 真实文档 ---------------- */

test('技术方案文档通过结构校验', () => {
  const result = verifyTechStack(path.join(repoRoot, DOC_PATH_DEFAULT));
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.ok(result.stats.sections >= SECTIONS.length);
  assert.ok(result.stats.diagrams >= MIN_DIAGRAMS);
  assert.ok(result.stats.checklistItems >= MIN_CHECKLIST_ITEMS);
});

test('文档不存在时返回可读错误而不是抛异常', () => {
  const result = verifyTechStack(path.join(tmp, 'nope.md'));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /无法读取技术方案文档/);
});

/* ---------------- 章节结构 ---------------- */

test('缺少必需章节会被检出', () => {
  const result = patch((t) => t.replace(/^## 5\. 数据层$/m, '## 数据那一层'));
  expectIssue(result, '缺少必需章节', '删掉数据层章节');
});

test('章节编号断裂会被检出', () => {
  const result = patch((t) => t.replace(/^## 12\. /m, '## 120. '));
  expectIssue(result, '编号不连续', '打乱章节编号');
});

/* ---------------- 关键技术决定 ---------------- */

test('桌面外壳选型缺失会被检出', () => {
  const result = patch((t) => t.replaceAll('Electron', '某外壳'));
  expectIssue(result, '桌面外壳选型', '抹掉 Electron');
});

test('密钥必须密文落库：删掉这条要点会被检出', () => {
  assert.match(realText, /密文落库/);
  const result = patch((t) => t.replaceAll('密文落库', '存起来').replaceAll('api_key_enc', 'k'));
  expectIssue(result, '以密文落库', '抹掉密文落库要求');
});

test('依赖方向与核心层划分缺失会被检出', () => {
  const result = patch((t) => t.replaceAll('src/core', 'src/stuff'));
  expectIssue(result, '零平台依赖的核心层', '抹掉 src/core');
});

test('迁移机制与事务边界缺失会被检出', () => {
  const noMigration = patch((t) => t.replaceAll('user_version', 'version'));
  expectIssue(noMigration, '迁移机制', '抹掉 user_version');

  const noTxn = patch((t) => t.replaceAll('withTransaction', '写一批').replaceAll('事务', '步骤'));
  expectIssue(noTxn, '事务边界', '抹掉事务');
});

test('流式与 token 计数要点缺失会被检出', () => {
  const noAbort = patch((t) => t.replaceAll('AbortController', '停止件').replaceAll('AbortSignal', '停止信号'));
  expectIssue(noAbort, '中断机制', '抹掉中断机制');

  const noTokenizer = patch((t) => t.replaceAll('gpt-tokenizer', '某分词器'));
  expectIssue(noTokenizer, '精确 token 计数', '抹掉 gpt-tokenizer');

  const noExact = patch((t) => t.replaceAll('exact', 'flag'));
  expectIssue(noExact, '精确与估算', '抹掉精确/估算标记');
});

test('打包与原生模块要点缺失会被检出', () => {
  const result = patch((t) => t.replaceAll('asarUnpack', '打包配置').replaceAll('install-app-deps', '装依赖'));
  expectIssue(result, '原生模块', '抹掉原生模块打包与重编');
});

/* ---------------- 禁用表述 ---------------- */

test('开启 nodeIntegration 会被判定为禁用表述', () => {
  const result = patch((t) => t.replace(/\| `nodeIntegration` \| `false` \|/, '| `nodeIntegration` | `true` |'));
  expectIssue(result, '禁止开启 nodeIntegration', '把 nodeIntegration 改成 true');
});

test('关闭 contextIsolation 会被判定为禁用表述', () => {
  const result = patch((t) => t.replace(/\| `contextIsolation` \| `true` \|/, '| `contextIsolation` | `false` |'));
  expectIssue(result, '禁止关闭 contextIsolation', '把 contextIsolation 改成 false');
});

test('明文存储密钥会被判定为禁用表述', () => {
  const result = patch((t) => `${t}\n\n补充：api_key 明文存储即可。\n`);
  expectIssue(result, '禁止明文存储密钥', '写入明文存储');
});

test('renderer 直连数据库会被判定为禁用表述', () => {
  const result = patch((t) => `${t}\n\n补充：renderer 直接访问 SQLite 更省事。\n`);
  expectIssue(result, '禁止 renderer 直连数据库', '写入 renderer 直连库');
});

test('Tauri 只在被选为正解时才报错，否定表述不误报', () => {
  const tauriRule = FORBIDDEN.find(([re]) => String(re).includes('Tauri'))?.[0];
  assert.ok(tauriRule, '必须登记 Tauri 的禁用规则');
  assert.equal(tauriRule.test('不采用 Tauri 或任何需要第二语言的外壳'), false, '否定表述不应命中');
  assert.equal(tauriRule.test('否决 Tauri v2'), false, '否决表述不应命中');
  assert.equal(tauriRule.test('推荐 Tauri 作为外壳'), true, '正选 Tauri 必须命中');
  assert.equal(tauriRule.test('采用 Tauri'), true, '采用 Tauri 必须命中');

  const result = patch((t) => `${t}\n\n结论修正：采用 Tauri。\n`);
  expectIssue(result, '不得把 Tauri 作为选型', '把 Tauri 写成正解');
});

test('真实密钥样例会被判定为禁用表述', () => {
  const result = patch((t) => `${t}\n\n示例：sk-abcdefghijklmnopqrstuvwxyz\n`);
  expectIssue(result, '不得出现真实密钥样例', '写入疑似真实密钥');
});

/* ---------------- 明确不做 ---------------- */

test('"明确不做"章节缺条目会被检出', () => {
  const dropTauri = patch((t) => t.replace(/^- \*\*不采用 Tauri.*$/m, '- 外壳选择已定。'));
  expectIssue(dropTauri, '不采用 Tauri', '删掉 Tauri 边界');

  const dropUpdate = patch((t) => t.replace(/^- 不做自动更新.*$/m, '- 更新相关后议。'));
  expectIssue(dropUpdate, '不做自动更新', '删掉自动更新边界');

  assert.equal(NON_GOALS.length > 0, true);
});

/* ---------------- 结构图 / 占位 / 清单 / 回链 ---------------- */

test('缺少结构图会被检出', () => {
  const result = patch((t) => t.replace(/[┌┐└┘│─├┤┬┴┼]/g, '+'));
  expectIssue(result, '结构图', '抹掉所有框线');
});

test('占位内容会被检出', () => {
  const result = patch((t) => `${t}\n\n## 附：以后再说\n\nTODO: 补充细节\n`);
  expectIssue(result, '占位内容', '写入 TODO');
});

test('验收清单规模不足会被检出', () => {
  const result = patch((t) => `${t.split('## 15. 验收清单')[0]}## 15. 验收清单（技术选型的落地检查）\n\n1. 先这样。\n2. 再那样。\n`);
  expectIssue(result, '验收清单只有', '把验收项砍到 2 条');
});

test('缺少上游基线引用会被检出', () => {
  const result = patch((t) => t.replaceAll('docs/ui-design-conversation.md', '某界面文档'));
  expectIssue(result, 'ui-design-conversation.md', '删掉姐妹文档回链');
});

/* ---------------- 关键栈点名 ---------------- */

test('关键选型必须逐个点到名', () => {
  const must = [
    'better-sqlite3',
    'safeStorage',
    'contextBridge',
    'zod',
    'PromptSpec',
    'gpt-tokenizer',
    'utilityProcess',
    'asarUnpack',
    'Zustand',
    'Tailwind',
    'floating-ui',
    'Playwright',
    'vitest',
    'electron-vite',
    'electron-builder',
    'pnpm',
  ];
  for (const name of must) {
    assert.ok(realText.includes(name), `技术方案必须点名 ${name}`);
  }
  assert.ok(PATTERNS.length >= 20, '校验器登记的关键决定不应过少');
  assert.ok(REQUIRED_LINKS.every((l) => realText.includes(l)), '必须回链全部上游基线');
});

test('demo 的定位必须写清楚：只作参考、不参与构建', () => {
  assert.match(realText, /demo\/index\.html` 只作布局与交互参考、不参与构建|只作布局与交互参考/);
  assert.match(realText, /不把 `demo\/` 的任何代码编进产物|构建配置不引用 `demo\/`/);
});
