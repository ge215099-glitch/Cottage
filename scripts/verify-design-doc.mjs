#!/usr/bin/env node
/**
 * 校验 UI 设计文档的结构完整性。
 *
 * 存在的理由：这些文档是后续界面实现的唯一交互基线，一旦章节、交互要点或验收清单
 * 被误删，实现阶段会静默丢失约束。这里把"文档必须长什么样"固化成可执行断言。
 *
 * 用法：node scripts/verify-design-doc.mjs [docPath ...]
 *      不带参数 = 校验全部已登记文档
 * 退出码：0 = 通过，1 = 有问题
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIN_CHECKLIST_ITEMS = 20;
const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|XXX|待补|待定|占位符)\b/i;

/**
 * 已登记的设计文档规格。
 * id          唯一标识
 * path        相对仓库根
 * sections    必须出现且编号连续、顺序一致的二级标题
 * patterns    [正则, 缺失说明]
 * nonGoals    必须出现在"明确不做"章节的词
 * minDiagrams 至少几张 ASCII 图
 * minItems    验收清单最少条数
 * links       必须引用的其他文档
 */
export const DOC_SPECS = [
  {
    id: 'sidebar',
    path: 'docs/ui-design-sidebar-chat.md',
    sections: [
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
    ],
    patterns: [
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
      [/pinned_at/, '置顶必须落库字段名明确'],
      [/置顶不(修改|改变)|不修改 `updated_at`|不改变 `updated_at`/, '必须说明置顶不改 updated_at'],
    ],
    nonGoals: [/批量删除/, /文件夹/],
    minDiagrams: 4,
    minItems: MIN_CHECKLIST_ITEMS,
    links: ['docs/product-design.md', 'docs/ui-design-conversation.md'],
  },
  {
    id: 'conversation',
    path: 'docs/ui-design-conversation.md',
    sections: [
      '为什么右栏该存在（先定职责，再画图）',
      '对比过的三种布局方案',
      '对话界面整体骨架',
      '消息流规格（3.5 的界面落地）',
      '输入区规格',
      '功能入口总表（"哪个功能放哪里"的唯一答案）',
      '组件结构',
      '自适应与快捷布局',
      '会话置顶的数据与行为约定',
      '状态与文案清单',
      '视觉规格（补充，与左栏文档第 8 节同一套 token）',
      '验收清单（可直接转成 UI 测试用例）',
      '明确不做（避免界面膨胀）',
    ],
    patterns: [
      [/DetailPanel/, '右栏必须有组件定义'],
      [/PanelTabs/, '右栏必须有标签页结构'],
      [/上下文占用/, '必须有上下文占用展示'],
      [/压缩历史/, '必须有压缩历史与恢复入口'],
      [/已中断/, '必须处理流式中断'],
      [/重新生成/, '必须有重新生成'],
      [/回到最新/, '必须有粘底/回到最新行为'],
      [/已压缩 第 3–15 条|已压缩/, '必须有摘要分割条'],
      [/pinned_at/, '置顶必须落库字段名明确'],
      [/ALTER TABLE conversations ADD COLUMN pinned_at/, '必须有置顶字段迁移语句'],
      [/pinned_at IS NOT NULL DESC/, '必须有置顶排序 SQL'],
      [/不(修改|改变) `updated_at`/, '必须说明置顶不改 updated_at'],
      [/⌘\/Ctrl \+ I|⌘I/, '必须有右栏快捷键'],
      [/pointer: coarse|触屏/, '必须说明触屏菜单入口'],
      [/估算/, '必须标注估算 token'],
      [/原子性/, '压缩失败必须保持原子性'],
      [/精确/, '必须区分精确/估算'],
    ],
    nonGoals: [/统计图/, /消息分支/],
    minDiagrams: 4,
    minItems: MIN_CHECKLIST_ITEMS,
    links: ['docs/product-design.md', 'docs/ui-design-sidebar-chat.md'],
  },
];

export const DOC_PATH_DEFAULT = DOC_SPECS[0].path;

/** 编号连续的二级标题：形如 `## 3. 标题`。 */
function parseSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (m) sections.push({ number: Number(m[1]), title: m[2].trim(), line: i + 1 });
  }
  return sections;
}

/** 取"验收清单"章节下的编号条目。 */
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

/** 去掉标题里的括号补充说明，便于宽松匹配。 */
function normalizeTitle(title) {
  return title.replace(/（[^）]*）/g, '').trim();
}

/**
 * @param {string} docPath 相对/绝对路径
 * @param {string} [cwd] 解析相对路径的基准
 * @returns {{ ok: boolean, issues: string[], stats: Record<string, number>, id?: string }}
 */
export function verifyDesignDoc(docPath = DOC_PATH_DEFAULT, cwd = process.cwd()) {
  const abs = path.isAbsolute(docPath) ? docPath : path.resolve(cwd, docPath);
  const rel = path.relative(cwd, abs).split(path.sep).join('/');
  const spec = DOC_SPECS.find((s) => s.path === rel || s.path === docPath) ?? null;
  const issues = [];
  let text;

  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, issues: [`无法读取设计文档：${abs}（${err.code ?? err.message}）`], stats: {} };
  }

  if (!spec) {
    return {
      ok: false,
      issues: [`文档未在设计文档规格中登记：${rel}（请在 scripts/verify-design-doc.mjs 的 DOC_SPECS 添加）`],
      stats: {},
    };
  }

  const lines = text.split(/\r?\n/);
  const sections = parseSections(lines);

  // 1. 必须是一级文档
  if (!/^#\s+\S/.test(lines[0] ?? '')) issues.push('文档必须以一级标题开头');

  // 2. 章节齐全、编号连续、顺序一致
  if (sections.length < spec.sections.length) {
    issues.push(`二级标题数量 ${sections.length} 少于要求的 ${spec.sections.length}`);
  }
  const missing = spec.sections.filter(
    (title) => !sections.some((s) => s.title.includes(normalizeTitle(title))),
  );
  if (missing.length) issues.push(`缺少必需章节：${missing.join('、')}`);

  sections.forEach((s, idx) => {
    if (s.number !== idx + 1) {
      issues.push(`章节编号不连续：第 ${idx + 1} 个二级标题是「${s.number}. ${s.title}」（第 ${s.line} 行）`);
    }
  });
  spec.sections.forEach((expected, idx) => {
    const found = sections.findIndex((s) => s.title.includes(normalizeTitle(expected)));
    if (found !== -1 && found !== idx) {
      issues.push(`章节顺序不符：期望第 ${idx + 1} 节为「${expected}」，实际在位置 ${found + 1}`);
    }
  });

  // 3. 关键交互要点不得丢失
  for (const [re, why] of spec.patterns) {
    if (!re.test(text)) issues.push(`缺少要点：${why}（未匹配 ${re}）`);
  }
  for (const re of spec.nonGoals) {
    if (!re.test(text)) issues.push(`"明确不做"章节缺少条目：${re}`);
  }
  for (const re of spec.forbidWords ?? []) {
    if (re.test(text)) issues.push(`出现禁用表述：${re}`);
  }

  // 4. 必须含 ASCII 布局图
  const fenceBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const diagramBlocks = fenceBlocks.filter((b) => /[┌┐└┘│─├┤┬┴┼]/.test(b));
  if (diagramBlocks.length < spec.minDiagrams) {
    issues.push(`含框线的布局图只有 ${diagramBlocks.length} 处，少于要求的 ${spec.minDiagrams} 处`);
  }

  // 5. 不得留占位内容
  if (PLACEHOLDER_PATTERN.test(text)) {
    const hit = text.split(/\r?\n/).findIndex((l) => PLACEHOLDER_PATTERN.test(l)) + 1;
    issues.push(`文档存在未完成占位内容（第 ${hit} 行）`);
  }

  // 6. 验收清单规模
  const items = checklistItems(lines);
  if (items.length < spec.minItems) {
    issues.push(`验收清单只有 ${items.length} 条，少于要求的 ${spec.minItems} 条`);
  }

  // 7. 必须回链上游基线与姊妹文档
  for (const link of spec.links) {
    if (!text.includes(link)) issues.push(`必须引用 ${link}`);
  }

  return {
    ok: issues.length === 0,
    id: spec.id,
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

/** 校验所有已登记文档。 */
export function verifyAll(cwd = process.cwd()) {
  return DOC_SPECS.map((spec) => ({ spec, result: verifyDesignDoc(spec.path, cwd) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  const runs = targets.length
    ? targets.map((t) => ({ spec: DOC_SPECS.find((s) => s.path === t) ?? { id: t, path: t }, result: verifyDesignDoc(t) }))
    : verifyAll();

  let failed = 0;
  for (const { spec, result } of runs) {
    if (result.ok) {
      const s = result.stats;
      console.log(`✓ ${spec.path}`);
      console.log(`  ${s.lines} 行 / ${s.sections} 节 / ${s.diagrams} 张布局图 / ${s.checklistItems} 条验收项`);
    } else {
      failed += 1;
      console.error(`✗ ${spec.path}`);
      for (const issue of result.issues) console.error(`  - ${issue}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} 份文档未通过校验。`);
    process.exit(1);
  }
  console.log(`\n${runs.length} 份设计文档全部通过校验。`);
  process.exit(0);
}
