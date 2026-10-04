import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDesignDoc, DOC_PATH_DEFAULT } from '../scripts/verify-design-doc.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realDoc = path.join(repoRoot, DOC_PATH_DEFAULT);
const realText = readFileSync(realDoc, 'utf8');

const tmp = mkdtempSync(path.join(tmpdir(), 'cottage-designdoc-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** 在临时目录写一份文档副本并校验。 */
function verifyWith(transform) {
  seq += 1;
  const file = path.join(tmp, `doc-${seq}.md`);
  writeFileSync(file, transform(realText), 'utf8');
  return verifyDesignDoc(file);
}

test('真实设计文档通过全部结构校验', () => {
  const result = verifyDesignDoc(realDoc);
  assert.deepEqual(result.issues, [], `校验问题：\n${result.issues.join('\n')}`);
  assert.equal(result.ok, true);
  assert.ok(result.stats.sections >= 14, '章节数应 >= 14');
  assert.ok(result.stats.diagrams >= 4, '布局图应 >= 4');
  assert.ok(result.stats.checklistItems >= 20, '验收项应 >= 20');
});

test('文档必须定义悬停出现 ⋯ 与防位移', () => {
  assert.match(realText, /悬停[\s\S]{0,120}⋯|⋯[\s\S]{0,120}悬停/);
  assert.match(realText, /占位(恒在|保留)/, '必须说明 ⋯ 占位避免标题位移');
  const result = verifyWith((t) => t.replace(/悬停/g, '鼠标移上去'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('悬停')), '删掉「悬停」应被判定为缺要点');
});

test('文档必须包含删除的二次确认与摘要级联说明', () => {
  assert.match(realText, /删除对话？/);
  assert.match(realText, /此操作不可撤销/);
  assert.match(realText, /摘要[\s\S]{0,60}(一并删除|级联)/);
  const result = verifyWith((t) => t.replace(/删除对话？/g, '确定吗'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('删除确认文案')));
});

test('章节缺失或编号断裂会被检出', () => {
  const dropped = verifyWith((t) => t.replace(/^## 5\. 核心交互二：列表本身$/m, '## 列表本身'));
  assert.equal(dropped.ok, false);
  assert.ok(dropped.issues.some((i) => i.includes('缺少必需章节')), '应报告缺少章节');

  const renumbered = verifyWith((t) => t.replace(/^## 6\. /m, '## 66. '));
  assert.equal(renumbered.ok, false);
  assert.ok(renumbered.issues.some((i) => i.includes('编号不连续')));
});

test('占位内容会被检出', () => {
  const result = verifyWith((t) => `${t}\n\n## 附：待补\n\nTODO: 补充动效细节\n`);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('占位内容')));
});

test('验收清单条目不足会被检出', () => {
  const result = verifyWith((t) => t.split('\n').filter((l) => !/^\d+\.\s/.test(l)).join('\n'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('验收清单')));
});

test('缺少布局图或上游基线引用会被检出', () => {
  const noDiagram = verifyWith((t) => t.replace(/[┌┐└┘│─├┤]/g, '+'));
  assert.equal(noDiagram.ok, false);
  assert.ok(noDiagram.issues.some((i) => i.includes('布局图')));

  const noBaseline = verifyWith((t) => t.replace(/product-design\.md/g, '某文档'));
  assert.equal(noBaseline.ok, false);
  assert.ok(noBaseline.issues.some((i) => i.includes('上游基线')));
});

test('文档不存在时返回可读错误而不是抛异常', () => {
  const result = verifyDesignDoc(path.join(tmp, 'nope.md'));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /无法读取设计文档/);
});
