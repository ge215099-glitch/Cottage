#!/usr/bin/env node
/**
 * 校验 UI 设计文档（docs/ui-design-sidebar-chat.md）的结构完整性。
 *
 * 存在的理由：本文档是后续界面实现的唯一交互基线，一旦章节、交互要点或验收清单
 * 被误删，实现阶段会静默丢失约束。这里把"文档必须长什么样"固化成可执行断言。
 *
 * 用法：node scripts/verify-design-doc.mjs [docPath]
 * 退出码：0 = 通过，1 = 有问题
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DOC_PATH_DEFAULT = 'docs/ui-design-sidebar-chat.md';

/** 必须出现的二级标题（顺序一致、编号连续）。 */
export const REQUIRED_SECTIONS = [
  '设计原则',
  '整体布局骨架',
  '左侧栏 ①–⑥ 逐块规格',
  '核心交互一：会话行与 `⋯` 菜单（重点）',
  '核心交互二：列表本身',
  '主区与详情栏（仅定入口，细则另文）',
  '交互状态与文案清单',
  '视觉规格（设计 token，深浅双主题）',
  '自适应规则',
  '无障碍与输入方式',
  '与参考图的一致 / 有意偏离',
  '组件结构（实现时按此拆分）',
  '验收清单（可直接转成 UI 测试用例）',
  '明确不做（避免界面膨胀）',
];

/** 必须出现的关键词：[正则, 人类可读说明]。 */
export const REQUIRED_PATTERNS = [
  [/悬停/, '必须说明悬停交互'],
  [/⋯/, '必须出现 ⋯ 菜单按钮'],
  [/重命名/, '必须有重命名'],
  [/删除/, '必须有删除'],
  [/置顶/, '必须有置顶/取消置顶'],
  [/删除对话？/, '必须有删除确认文案'],
  [/不可撤销/, '删除确认必须说明不可撤销'],
  [/Esc/, '必须定义 Esc 行为'],
  [/F2/, '必须定义 F2 重命名'],
  [/Shift\+F10/, '必须定义键盘等效菜单入口'],
  [/aria-live/, '必须有无障碍播报'],
  [/aria-label/, '必须有 aria-label'],
  [/aria-current/, '必须标记当前会话'],
  [/focus-visible/, '必须有焦点可见策略'],
  [/pointer: coarse/, '必须有触屏适配'],
  [/虚拟滚动/, '必须说明大列表性能方案'],
  [/56px/, '必须说明折叠态宽度'],
  [/720px/, '必须说明窄屏阈值/内容宽'],
  [/180ms/, '必须有菜单关闭宽限期'],
  [/summaries|摘要/, '必须说明删除时摘要级联'],
  [/事务/, '必须说明删除的事务性'],
  [/AbortController/, '必须说明生成中删除先中断'],
  [/compact|压缩/, '必须保留压缩相关反馈'],
];

/** 必须明确不做的项（防止界面膨胀）。 */
export const REQUIRED_NON_GOALS = [/批量删除/, /文件夹/];

const MIN_SECTION_COUNT = 14;
const MIN_CHECKLIST_ITEMS = 20;
const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|XXX|待补|待定|占位符)\b/i;

/** 编号连续的二级标题：形如 `## 3. 标题`（支持重复 `：` 后的括号说明）。 */
function parseSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (m) {
      sections.push({ number: Number(m[1]), title: m[2].trim(), line: i + 1 });
    }
  }
  return sections;
}

function checklistItems(lines) {
  const start = lines.findIndex((l) => /^##\s+\d+\.\s+验收清单/.test(l));
  if (start === -1) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    if (/^\d+\.\s+\S/.test(lines[i])) items.push(lines[i]);
  }
  return items;
}

/**
 * @param {string} docPath 相对/绝对路径
 * @param {string} [cwd] 解析相对路径的基准
 * @returns {{ ok: boolean, issues: string[], stats: Record<string, number> }}
 */
export function verifyDesignDoc(docPath = DOC_PATH_DEFAULT, cwd = process.cwd()) {
  const abs = path.isAbsolute(docPath) ? docPath : path.resolve(cwd, docPath);
  const issues = [];
  let text;

  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, issues: [`无法读取设计文档：${abs}（${err.code ?? err.message}）`], stats: {} };
  }

  const lines = text.split(/\r?\n/);
  const sections = parseSections(lines);

  // 1. 必须是一级文档
  if (!/^#\s+\S/.test(lines[0] ?? '')) issues.push('文档必须以一级标题开头');

  // 2. 章节齐全、编号连续、顺序一致
  if (sections.length < MIN_SECTION_COUNT) {
    issues.push(`二级标题数量 ${sections.length} 少于要求的 ${MIN_SECTION_COUNT}`);
  }
  const missing = REQUIRED_SECTIONS.filter(
    (title) => !sections.some((s) => s.title.includes(title.replace(/（.*?）/, '').trim())),
  );
  if (missing.length) issues.push(`缺少必需章节：${missing.join('、')}`);

  sections.forEach((s, idx) => {
    if (s.number !== idx + 1) {
      issues.push(`章节编号不连续：第 ${idx + 1} 个二级标题是「${s.number}. ${s.title}」（第 ${s.line} 行）`);
    }
  });
  if (REQUIRED_SECTIONS.length && sections.length >= MIN_SECTION_COUNT) {
    const actualOrder = sections.map((s) => s.title);
    REQUIRED_SECTIONS.forEach((expected, idx) => {
      const found = actualOrder.findIndex((t) => t.includes(expected.replace(/（.*?）/, '').trim()));
      if (found !== -1 && found !== idx) {
        issues.push(`章节顺序不符：期望第 ${idx + 1} 节为「${expected}」，实际在位置 ${found + 1}`);
      }
    });
  }

  // 3. 关键交互要点不得丢失
  for (const [re, why] of REQUIRED_PATTERNS) {
    if (!re.test(text)) issues.push(`缺少交互要点：${why}（未匹配 ${re}）`);
  }
  for (const re of REQUIRED_NON_GOALS) {
    if (!re.test(text)) issues.push(`第 14 节缺少"明确不做"项：${re}`);
  }

  // 4. 必须含 ASCII 布局图（用框线字符写在代码块内）
  const fenceBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const diagramBlocks = fenceBlocks.filter((b) => /[┌┐└┘│─├┤┬┴┼]/.test(b));
  if (diagramBlocks.length < 4) {
    issues.push(`含框线的布局图只有 ${diagramBlocks.length} 处，少于要求的 4 处`);
  }
  if (!diagramBlocks.some((b) => /ConversationRow|会话行/.test(b)) &&
      !diagramBlocks.some((b) => /⋯/.test(b))) {
    issues.push('布局图必须画出会话行与 ⋯ 按钮');
  }

  // 5. 不得留占位内容
  if (PLACEHOLDER_PATTERN.test(text)) {
    const hit = text.split(/\r?\n/).findIndex((l) => PLACEHOLDER_PATTERN.test(l)) + 1;
    issues.push(`文档存在未完成占位内容（第 ${hit} 行）`);
  }

  // 6. 验收清单规模
  const items = checklistItems(lines);
  if (items.length < MIN_CHECKLIST_ITEMS) {
    issues.push(`验收清单只有 ${items.length} 条，少于要求的 ${MIN_CHECKLIST_ITEMS} 条`);
  }

  // 7. 必须回链上游基线
  if (!/product-design\.md/.test(text)) issues.push('必须引用上游基线 docs/product-design.md');

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      lines: lines.length,
      sections: sections.length,
      diagrams: diagramBlocks.length,
      checklistItems: items.length,
      chars: text.length,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? DOC_PATH_DEFAULT;
  const { ok, issues, stats } = verifyDesignDoc(target);
  if (ok) {
    console.log(`✓ 设计文档校验通过：${target}`);
    console.log(`  ${stats.lines} 行 / ${stats.sections} 节 / ${stats.diagrams} 张布局图 / ${stats.checklistItems} 条验收项`);
    process.exit(0);
  }
  console.error(`✗ 设计文档校验失败：${target}`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
