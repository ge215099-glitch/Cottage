import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDesignDoc, verifyAll, DOC_SPECS, DOC_PATH_DEFAULT } from '../scripts/verify-design-doc.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realDoc = path.join(repoRoot, DOC_PATH_DEFAULT);
const realText = readFileSync(realDoc, 'utf8');

const CONV_PATH = 'docs/ui-design-conversation.md';
const convDoc = path.join(repoRoot, CONV_PATH);
const convText = readFileSync(convDoc, 'utf8');

const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-designdoc-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/**
 * 把文档副本写到 <case>/docs/<name>，并以 <case> 为 cwd 校验，
 * 这样副本相对路径与登记规格一致。
 */
function verifyWith(relPath, sourceText, transform) {
  seq += 1;
  const caseRoot = path.join(tmp, `case-${seq}`);
  mkdirSync(path.join(caseRoot, 'docs'), { recursive: true });
  writeFileSync(path.join(caseRoot, relPath), transform(sourceText), 'utf8');
  return verifyDesignDoc(relPath, caseRoot);
}

const patchSidebar = (transform) => verifyWith(DOC_PATH_DEFAULT, realText, transform);
const patchConv = (transform) => verifyWith(CONV_PATH, convText, transform);

/* ---------------- 规格登记 ---------------- */

test('全部已登记设计文档通过结构校验', () => {
  const runs = verifyAll(repoRoot);
  assert.equal(runs.length, DOC_SPECS.length);
  for (const { spec, result } of runs) {
    assert.deepEqual(result.issues, [], `${spec.path} 校验问题：\n${result.issues.join('\n')}`);
    assert.ok(result.stats.sections >= spec.sections.length);
    assert.ok(result.stats.diagrams >= spec.minDiagrams);
    assert.ok(result.stats.checklistItems >= spec.minItems);
  }
});

test('未登记的文档会被拒绝校验', () => {
  const file = path.join(tmp, 'unknown.md');
  writeFileSync(file, '# x\n', 'utf8');
  const result = verifyDesignDoc(file);
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /未在设计文档规格中登记/);
});

/* ---------------- 左栏 / 列表 ---------------- */

test('左栏文档必须定义悬停出现 ⋯ 与防位移', () => {
  assert.match(realText, /悬停[\s\S]{0,120}⋯|⋯[\s\S]{0,120}悬停/);
  assert.match(realText, /占位(恒在|保留)/, '必须说明 ⋯ 占位避免标题位移');
  assert.match(realText, /不是产品功能/, '必须澄清"时间线"只是交互时序');
  const result = patchSidebar((t) => t.replaceAll('悬停', '鼠标移上去'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('悬停')), '删掉「悬停」应被判定为缺要点');
});

test('左栏文档必须包含删除的二次确认与摘要级联说明', () => {
  assert.match(realText, /删除对话？/);
  assert.match(realText, /此操作不可撤销/);
  assert.match(realText, /摘要[\s\S]{0,60}(一并删除|级联)/);
  const result = patchSidebar((t) => t.replaceAll('删除对话？', '确定吗'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('删除确认文案')));
});

test('置顶必须落库且不得污染 updated_at', () => {
  assert.match(realText, /pinned_at/);
  const result = patchSidebar((t) => t.replaceAll('pinned_at', 'sort_flag'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('pinned_at')));
});

test('章节缺失或编号断裂会被检出', () => {
  const dropped = patchSidebar((t) => t.replace(/^## 5\. 核心交互二：列表本身$/m, '## 列表本身'));
  assert.equal(dropped.ok, false);
  assert.ok(dropped.issues.some((i) => i.includes('缺少必需章节')), '应报告缺少章节');

  const renumbered = patchSidebar((t) => t.replace(/^## 6\. /m, '## 66. '));
  assert.equal(renumbered.ok, false);
  assert.ok(renumbered.issues.some((i) => i.includes('编号不连续')));
});

test('列表不按时间分组的约定必须写在文档里', () => {
  assert.match(realText, /不按时间分组/);
  assert.match(realText, /只有两段/);
  const result = patchSidebar((t) => t.replaceAll('不按时间分组', '按时间走').replaceAll('只有两段', '分成若干段'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('不按时间分组')), result.issues.join('\n'));
});

test('占位内容会被检出', () => {
  const result = patchSidebar((t) => `${t}\n\n## 附：待补\n\nTODO: 补充动效细节\n`);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('占位内容')));
});

test('缺少布局图或上游基线引用会被检出', () => {
  const noDiagram = patchSidebar((t) => t.replace(/[┌┐└┘│─├┤]/g, '+'));
  assert.equal(noDiagram.ok, false);
  assert.ok(noDiagram.issues.some((i) => i.includes('布局图')));

  const noBaseline = patchSidebar((t) => t.replaceAll('docs/product-design.md', '某文档'));
  assert.equal(noBaseline.ok, false);
  assert.ok(noBaseline.issues.some((i) => i.includes('product-design.md')));
});

test('文档不存在时返回可读错误而不是抛异常', () => {
  const result = verifyDesignDoc(path.join(tmp, 'nope.md'));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /无法读取设计文档/);
});

/* ---------------- 对话界面 + 右栏 ---------------- */

test('对话界面文档通过校验并规划了右栏标签与常驻占用', () => {
  const result = verifyDesignDoc(convDoc);
  assert.deepEqual(result.issues, [], result.issues.join('\n'));
  assert.match(convText, /PanelTabs/);
  assert.match(convText, /上下文 \/ 对话 \/ 角色 \/ 数据|上下文 \/ 对话 \/ 数据/);
  assert.match(convText, /占用条下沉到输入框角落|占用数字/, '必须说明占用信息常驻位置');
});

test('对话界面文档必须给出置顶的 SQL 与迁移', () => {
  assert.match(convText, /ALTER TABLE conversations ADD COLUMN pinned_at/);
  assert.match(convText, /pinned_at IS NOT NULL DESC/);
  const result = patchConv((t) => t.replaceAll('ALTER TABLE conversations ADD COLUMN pinned_at', '-- nada'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('迁移语句')));
});

test('对话界面文档必须保留"明确不做"清单，否则报缺章节', () => {
  const result = patchConv((t) => t.replace(/^## 13\. 明确不做（避免界面膨胀）$/m, '## 13. 补充说明'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('明确不做') || i.includes('缺少必需章节')));
});

test('删掉非目标条目（统计图/消息分支）会被检出', () => {
  const result = patchConv((t) => t.replace(/^- 右栏放统计图.*$/m, '- 右栏保持轻量。'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('统计图')), '需要保留"不做统计图"的边界');
});
