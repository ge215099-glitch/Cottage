#!/usr/bin/env node
/**
 * 校验技术方案文档（docs/tech-stack.md）的结构完整性。
 *
 * 存在的理由：技术方案是编码阶段的约束来源。一旦"依赖方向""密钥边界""迁移机制"
 * 这类不变量被误删，实现会在没人察觉的情况下漂移（例如 renderer 直连数据库、
 * api_key 明文落库、迁移改成 ORM 代管）。这里把这些约束固化成可执行断言。
 *
 * 与 verify-design-doc.mjs 的分工：那份管"界面必须长什么样"，这份管"代码必须怎么摆"。
 *
 * 用法：node scripts/verify-tech-stack.mjs [docPath]
 * 退出码：0 = 通过，1 = 有问题
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DOC_PATH_DEFAULT = 'docs/tech-stack.md';

/** 必须出现且编号连续、顺序一致的二级标题。 */
export const SECTIONS = [
  '已定决策与不变量',
  '技术栈总表',
  '桌面外壳：为什么是 Electron',
  '进程模型与代码分层',
  '数据层',
  'IPC 契约与密钥边界',
  'Provider 适配与流式生成',
  'Token 计数策略',
  '渲染层',
  '构建、打包与发布',
  '测试策略',
  '目录结构',
  '风险清单与对冲',
  '明确不做（技术层面）',
  '验收清单（技术选型的落地检查）',
];

/** [正则, 缺失说明]：方案里不得丢失的关键决定。 */
export const PATTERNS = [
  [/Electron/, '必须明确桌面外壳选型'],
  [/src\/core/, '必须划分出零平台依赖的核心层'],
  [/safeStorage/, '必须固定密钥加密方案'],
  [/api_key_enc|密文落库/, '必须说明 api_key 以密文落库'],
  [/better-sqlite3/, '必须固定数据库实现'],
  [/WAL/, '必须说明 SQLite 日志模式'],
  [/user_version/, '必须说明迁移机制'],
  [/withTransaction|事务/, '必须说明多步写入的事务边界'],
  [/contextIsolation/, '必须固定渲染进程隔离策略'],
  [/nodeIntegration/, '必须说明 nodeIntegration 取值'],
  [/contextBridge/, '必须由 preload 暴露白名单通道'],
  [/zod/, '必须有运行时 schema 校验'],
  [/PromptSpec/, '必须保留 IR 与 provider 适配分离'],
  [/Anthropic/, '必须覆盖 Anthropic 的序列化差异'],
  [/SSE|eventsource/, '必须说明流式解析方案'],
  [/AbortController|AbortSignal/, '必须说明中断机制'],
  [/gpt-tokenizer/, '必须固定精确 token 计数方案'],
  [/exact/, 'token 必须区分精确与估算'],
  [/utilityProcess/, '重计算必须有移出主进程的路径'],
  [/asarUnpack/, '必须说明原生模块的打包处理'],
  [/install-app-deps/, '必须说明原生模块重编'],
  [/单实例|requestSingleInstanceLock/, '必须说明单实例约束'],
  [/脱敏/, '必须说明日志脱敏'],
  [/虚拟滚动|react-virtual/, '必须固定虚拟滚动方案'],
  [/floating-ui/, '必须固定浮层定位方案'],
  [/Tailwind/, '必须固定样式方案与 token 来源'],
  [/Zustand/, '必须固定界面状态方案'],
  [/react-markdown|Markdown/, '必须固定消息渲染与消毒方案'],
  [/vitest/i, '必须说明单元与组件测试'],
  [/Playwright/i, '必须说明端到端测试'],
];

/** [正则, 缺失说明]：必须出现在"明确不做"章节里的技术边界。 */
export const NON_GOALS = [
  [/Tauri/, '必须写明不采用 Tauri'],
  [/ORM/, '必须写明不引入 ORM 代管迁移'],
  [/React Query/, '必须写明不引入通用服务端缓存层'],
  [/i18n/, '必须写明不做 i18n 框架'],
  [/CSS-in-JS/, '必须写明不引入 CSS-in-JS 运行时'],
  [/Ant Design/, '必须写明不引入成品 UI 组件库'],
  [/崩溃上报/, '必须写明不做崩溃上报与遥测'],
  [/自动更新/, '必须写明 MVP 不做自动更新'],
  [/Monaco/, '必须写明不引入富文本/代码编辑器'],
  [/代码高亮/, '必须写明代码高亮属二期'],
  [/多窗口/, '必须写明不做多窗口'],
];

/** [正则, 问题说明]：出现即视为方案被写坏。 */
export const FORBIDDEN = [
  [/(?<![不否未])(采用|选用|推荐)\s*Tauri/, '不得把 Tauri 作为选型'],
  [/nodeIntegration[^\n]{0,16}true/, '禁止开启 nodeIntegration'],
  [/contextIsolation[^\n]{0,16}false/, '禁止关闭 contextIsolation'],
  [/明文存储|明文落库|明文保存/, '禁止明文存储密钥'],
  [/sk-[A-Za-z0-9]{16,}/, '不得出现真实密钥样例'],
  [/renderer[^\n]{0,24}(直连|直接访问|直接读写)[^\n]{0,12}(数据库|SQLite|DB)/, '禁止 renderer 直连数据库'],
];

export const MIN_DIAGRAMS = 3;
export const MIN_CHECKLIST_ITEMS = 15;

/** 必须回链的上游基线。 */
export const REQUIRED_LINKS = [
  'docs/product-design.md',
  'docs/ui-design-sidebar-chat.md',
  'docs/ui-design-conversation.md',
];

const PLACEHOLDER_PATTERN = /(TODO|TBD|FIXME|XXX|待补|待定|占位符|以后再说)/i;

/** 编号连续的二级标题：形如 `## 3. 标题`。 */
function parseSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (m) sections.push({ number: Number(m[1]), title: m[2].trim(), line: i + 1 });
  }
  return sections;
}

/** 取某个二级章节的正文（不含标题行，遇到下一个二级标题结束）。 */
function sectionBody(lines, titlePattern) {
  const start = lines.findIndex((l) => /^##\s+\d+\.\s+/.test(l) && titlePattern.test(l));
  if (start === -1) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
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
 * @returns {{ ok: boolean, issues: string[], stats: Record<string, number> }}
 */
export function verifyTechStack(docPath = DOC_PATH_DEFAULT, cwd = process.cwd()) {
  const abs = path.isAbsolute(docPath) ? docPath : path.resolve(cwd, docPath);
  const issues = [];
  let text;

  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, issues: [`无法读取技术方案文档：${abs}（${err.code ?? err.message}）`], stats: {} };
  }

  const lines = text.split(/\r?\n/);
  const sections = parseSections(lines);

  // 1. 必须是一级文档
  if (!/^#\s+\S/.test(lines[0] ?? '')) issues.push('文档必须以一级标题开头');

  // 2. 章节齐全、编号连续、顺序一致
  if (sections.length < SECTIONS.length) {
    issues.push(`二级标题数量 ${sections.length} 少于要求的 ${SECTIONS.length}`);
  }
  const missing = SECTIONS.filter((title) => !sections.some((s) => s.title.includes(normalizeTitle(title))));
  if (missing.length) issues.push(`缺少必需章节：${missing.join('、')}`);

  sections.forEach((s, idx) => {
    if (s.number !== idx + 1) {
      issues.push(`章节编号不连续：第 ${idx + 1} 个二级标题是「${s.number}. ${s.title}」（第 ${s.line} 行）`);
    }
  });
  SECTIONS.forEach((expected, idx) => {
    const found = sections.findIndex((s) => s.title.includes(normalizeTitle(expected)));
    if (found !== -1 && found !== idx) {
      issues.push(`章节顺序不符：期望第 ${idx + 1} 节为「${expected}」，实际在位置 ${found + 1}`);
    }
  });

  // 3. 关键技术决定不得丢失
  for (const [re, why] of PATTERNS) {
    if (!re.test(text)) issues.push(`缺少要点：${why}（未匹配 ${re}）`);
  }

  // 4. "明确不做"章节必须保留技术边界（只在该章节内检查）
  const nonGoalBody = sectionBody(lines, /明确不做/);
  if (!nonGoalBody) {
    issues.push('缺少"明确不做"章节正文');
  } else {
    for (const [re, why] of NON_GOALS) {
      if (!re.test(nonGoalBody)) issues.push(`"明确不做"章节缺少条目：${why}（未匹配 ${re}）`);
    }
  }

  // 5. 禁用表述
  for (const [re, why] of FORBIDDEN) {
    if (re.test(text)) issues.push(`出现禁用表述：${why}（匹配 ${re}）`);
  }

  // 6. 必须含 ASCII 结构图（分层 / 时序 / 状态机 / 测试金字塔）
  const fenceBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const diagramBlocks = fenceBlocks.filter((b) => /[┌┐└┘│─├┤┬┴┼]/.test(b));
  if (diagramBlocks.length < MIN_DIAGRAMS) {
    issues.push(`含框线的结构图只有 ${diagramBlocks.length} 处，少于要求的 ${MIN_DIAGRAMS} 处`);
  }

  // 7. 不得留占位内容
  if (PLACEHOLDER_PATTERN.test(text)) {
    const hit = lines.findIndex((l) => PLACEHOLDER_PATTERN.test(l)) + 1;
    issues.push(`文档存在未完成占位内容（第 ${hit} 行）`);
  }

  // 8. 验收清单规模
  const items = checklistItems(lines);
  if (items.length < MIN_CHECKLIST_ITEMS) {
    issues.push(`验收清单只有 ${items.length} 条，少于要求的 ${MIN_CHECKLIST_ITEMS} 条`);
  }

  // 9. 必须回链上游基线
  for (const link of REQUIRED_LINKS) {
    if (!text.includes(link)) issues.push(`必须引用 ${link}`);
  }

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
  const result = verifyTechStack(target);

  if (result.ok) {
    const s = result.stats;
    console.log(`✓ ${target}`);
    console.log(`  ${s.lines} 行 / ${s.sections} 节 / ${s.diagrams} 张结构图 / ${s.checklistItems} 条验收项`);
    process.exit(0);
  }

  console.error(`✗ ${target}`);
  for (const issue of result.issues) console.error(`  - ${issue}`);
  process.exit(1);
}
