import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyDemo, DEMO_PATH_DEFAULT, REQUIRED_IDS,
  staticMarkup, checkTagBalance, collectHtmlTemplates, lineOf,
} from '../scripts/verify-demo.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realPath = path.join(repoRoot, DEMO_PATH_DEFAULT);
const realHtml = readFileSync(realPath, 'utf8');

const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-demo-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function verifyWith(transform) {
  seq += 1;
  const file = path.join(tmp, `demo-${seq}.html`);
  writeFileSync(file, transform(realHtml), 'utf8');
  return verifyDemo(file);
}

/* ---------------- 真实 Demo ---------------- */

test('demo/index.html 通过结构、语法与离线校验', () => {
  const result = verifyDemo(realPath);
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.equal(result.ok, true);
  assert.ok(result.stats.kb > 40, 'Demo 应是一个完整单文件');
  assert.ok(result.stats.htmlTemplates >= 8, '应有多个运行时生成的 HTML 模板');
  assert.ok(result.stats.htmlTemplateTags >= 100, '模板里的标签数量应可观');
});

test('Demo 覆盖设计稿的关键交互', () => {
  const need = [
    ['悬停出现 ⋯', /\.conv-row:hover \.row-menu-btn[^}]*opacity:1/],
    ['⋯ 常驻占位', /opacity:0;color:var\(--text-secondary\);transition:opacity/],
    ['删除二次确认', /删除对话？/],
    ['不可撤销提示', /此操作不可撤销/],
    ['已置顶段', /已置顶/],
    ['不按时间分组', /不按时间分组|只有「已置顶」/],
    ['置顶落字段', /pinnedAt/],
    ['右栏四标签', /data-tab="data"/],
    ['常驻占用条', /id="meter"/],
    ['压缩可取消', /取消压缩/],
    ['压缩完成播报', /已将第 \$\{from\}–\$\{to\} 条压缩/],
    ['摘要可恢复', /恢复这段原文，摘要将失效/],
    ['流式中断', /已中断/],
    ['回到最新', /回到最新/],
    ['归档只降透明度', /msg\.archived \.body\{opacity/],
    ['侧栏折叠', /#sidebar\.collapsed\{width:56px\}/],
    ['右栏可收起', /#panel\.hidden\{display:none\}/],
  ];
  for (const [why, re] of need) {
    assert.match(realHtml, re, `缺少：${why}`);
  }
});

test('侧栏只拉出/收起，不做拖拽调宽', () => {
  assert.doesNotMatch(realHtml, /resizer/i);
  assert.doesNotMatch(realHtml, /col-resize/i);
  assert.doesNotMatch(realHtml, /makeResizer/);
});

test('界面不出现任何头像，也没有"已归档"提示', () => {
  assert.doesNotMatch(realHtml, /avatar/i);
  assert.doesNotMatch(realHtml, /已归档/);
});

test('对话列表不按时间分组，只保留「已置顶」段', () => {
  assert.doesNotMatch(realHtml, /dayKey/, '时间分组函数应已删除');
  for (const label of ['今天', '昨天', '前 7 天', '更早']) {
    assert.doesNotMatch(realHtml, new RegExp(`"${label}"`), `列表不应再有「${label}」段`);
  }
  assert.match(realHtml, /showHead\("已置顶"\)/);
});

test('Demo 的关键元素 id 一个都不能少', () => {
  for (const id of REQUIRED_IDS) {
    assert.match(realHtml, new RegExp(`id="${id}"`), `缺少 id="${id}"`);
  }
});

/* ---------------- 校验器自身的有效性 ---------------- */

test('脚本语法错误会被检出', () => {
  const result = verifyWith((h) => h.replace('function closeMenu(){', 'function closeMenu({'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('语法错误')), result.issues.join('\n'));
});

test('静态骨架标签不配平会被检出', () => {
  const result = verifyWith((h) => h.replace('aria-label="对话列表"></div>', 'aria-label="对话列表">'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('静态 HTML') && /未闭合|配平失败/.test(i)), result.issues.join('\n'));
});

test('运行时模板串标签不配平会被检出（含行号定位）', () => {
  const result = verifyWith((h) => h.replace('  function closeMenu(){', '  const broken = `<div><span>x</div>`;\n  function closeMenu(){'));
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.includes('未闭合') || i.includes('配平失败'));
  assert.ok(issue, result.issues.join('\n'));
  assert.match(issue, /第 \d+ 行/, '应给出行号便于定位');
});

test('外部资源或网络调用会被拒绝', () => {
  const ext = verifyWith((h) => h.replace('<title>', '<script src="https://cdn.example.com/x.js"></script><title>'));
  assert.equal(ext.ok, false);
  assert.ok(ext.issues.some((i) => i.includes('外部脚本')));

  const net = verifyWith((h) => h.replace('function boot(){', 'function boot(){ fetch("/api");'));
  assert.equal(net.ok, false);
  assert.ok(net.issues.some((i) => i.includes('网络请求')));

  const key = verifyWith((h) => h.replace('const MODEL_LIMIT', 'const api_key = "sk-abcdefghijklmnopqrstuvwx";\n  const MODEL_LIMIT'));
  assert.equal(key.ok, false);
  assert.ok(key.issues.some((i) => i.includes('密钥')));
});

test('缺少关键元素会被检出', () => {
  const result = verifyWith((h) => h.replace('id="to-latest"', 'id="to-latest-x"'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('to-latest')));
});

test('脚本引用了不存在的选择器会被检出', () => {
  const gone = verifyWith((h) => h.replace('id="panel-body"', 'id="panel-body-x"'));
  assert.equal(gone.ok, false);
  assert.ok(gone.issues.some((i) => i.includes('不存在的 id：#panel-body')), gone.issues.join('\n'));
  const attr = verifyWith((h) => h.replaceAll('data-restore=', 'data-restore-x='));
  assert.equal(attr.ok, false);
  assert.ok(attr.issues.some((i) => i.includes('data-restore')), attr.issues.join('\n'));
});

test('文档不存在时返回可读错误而不是抛异常', () => {
  const result = verifyDemo(path.join(tmp, 'missing.html'));
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /无法读取 Demo/);
});

/* ---------------- 扫描器单元测试 ---------------- */

test('staticMarkup 会剥离 script 与 style', () => {
  const out = staticMarkup('<style>a{}</style><div><script>let a="<div>";</script></div>');
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('<style'), false);
  assert.match(out, /<div><\/div>/);
});

test('checkTagBalance 能识别嵌套与自闭合标签', () => {
  const ok = [];
  checkTagBalance('<div><span><br><input></span></div>', 'x', ok);
  assert.deepEqual(ok, []);

  const bad = [];
  checkTagBalance('<div><span></div></span>', 'x', bad);
  assert.equal(bad.length, 1);
});

test('collectHtmlTemplates 能处理嵌套引号与嵌套模板串', () => {
  const src = [
    'const a = `<div>${x ? "user" : \'bot\'}</div>`;',
    'const b = `<ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>`;',
    'const c = `<div><span>未闭合</div>`;',
    'const d = "没有 html";',
  ].join('\n');
  const issues = [];
  const tpls = collectHtmlTemplates(src, issues);
  assert.equal(issues.length, 0);
  assert.equal(tpls.length, 3, '三个模板串都含 HTML');
  const bad = [];
  checkTagBalance(tpls[2].html, 'c', bad);
  assert.equal(bad.length, 1, '第三个模板串应被发现未配平');
});

test('lineOf 给出正确的行号', () => {
  assert.equal(lineOf('a\nb\nc', 4), 3);
});
