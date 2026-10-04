#!/usr/bin/env node
/**
 * 校验 demo/index.html 的结构与脚本语法。
 *
 * 存在的理由：Demo 是单文件、无构建、无类型检查，一个漏掉的 </div> 或脚本里的
 * 语法错误只有在浏览器里才会暴露。这里用零依赖的方式把它变成可执行断言：
 *   1. 内联 <script> 必须能通过 vm 编译（等价于语法检查，不执行）
 *   2. 必须不依赖任何外部资源（离线可打开）
 *   3. 设计稿要求的关键元素与交互必须存在
 *   4. 静态 HTML 与其内联生成的 HTML 片段，标签必须配平
 *
 * 用法：node scripts/verify-demo.mjs [demoPath]
 * 退出码：0 = 通过，1 = 有问题
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

export const DEMO_PATH_DEFAULT = 'demo/index.html';

/** 必须存在的元素 id（对应设计稿中的区块）。 */
export const REQUIRED_IDS = [
  'shell', 'sidebar', 'conv-list', 'new-chat', 'list-new',
  'search-input', 'nav', 'persona-foot', 'main', 'topbar', 'chat-title', 'pin-btn',
  'panel-btn', 'scroll', 'thread', 'to-latest', 'composer', 'model-chip', 'meter',
  'meter-bar', 'meter-text', 'send-btn', 'panel', 'panel-body',
  'overlay-root', 'toast-root', 'theme-btn',
];

/** [正则, 缺失说明]：设计稿中的关键交互与规格。 */
export const REQUIRED_PATTERNS = [
  [/class="conv-row/, '会话行必须有 .conv-row（左栏文档 4.1）'],
  [/row-menu-btn/, '会话行必须有悬停出现的 ⋯ 按钮'],
  [/\.conv-row:hover \.row-menu-btn[^}]*opacity:1/, '⋯ 必须悬停/聚焦才出现'],
  [/opacity:0;color:var\(--text-secondary\);transition:opacity/, '⋯ 必须有常驻占位（防标题位移）'],
  [/width:26px;height:26px/, '⋯ 命中区必须固定尺寸'],
  [/group-title/, '必须有分组标题（仅「已置顶」段）'],
  [/已置顶/, '必须有已置顶段'],
  [/pinnedAt/, '置顶必须记录 pinnedAt'],
  [/不修改 updated|注意：不修改/, '置顶不得改写 updated（防污染"今天"分组）'],
  [/删除对话？/, '必须有删除确认对话框'],
  [/此操作不可撤销/, '删除确认必须说明不可撤销'],
  [/新建一个/, '列表为空时必须有空态引导'],
  [/没有匹配的对话/, '搜索无结果必须有提示'],
  [/data-tab="context"/, '右栏必须有「上下文」标签'],
  [/data-tab="conversation"/, '右栏必须有「对话」标签'],
  [/data-tab="character"/, '右栏必须有「角色」标签'],
  [/data-tab="data"/, '右栏必须有「数据」标签'],
  [/class="meter"/, '输入区必须有常驻占用条'],
  [/class="usage/, '右栏必须有上下文占用分段条'],
  [/压缩最老的/, '必须有压缩按钮'],
  [/压缩中 /, '压缩必须有进行中状态'],
  [/取消压缩/, '压缩必须可取消'],
  [/已将第 \$\{from\}–\$\{to\} 条压缩/, '压缩完成必须播报具体条数与 token 变化'],
  [/恢复这段原文，摘要将失效/, '摘要必须可恢复'],
  [/已中断/, '必须处理流式中断'],
  [/重新生成/, '必须有重新生成'],
  [/回到最新/, '必须有回到最新按钮'],
  [/msg\.archived \.body\{opacity/, '归档消息必须只靠降透明度区分'],
];

export const FORBIDDEN_PATTERNS = [
  [/<script[^>]+src=/i, '禁止外部脚本（必须离线可打开）'],
  [/<link[^>]+href=/i, '禁止外部样式表'],
  [/https?:\/\/(?!www\.w3\.org)/i, '禁止外部资源 URL'],
  [/\bfetch\s*\(/, '禁止网络请求'],
  [/XMLHttpRequest/, '禁止网络请求'],
  [/sk-[A-Za-z0-9]{16,}/, '不得出现真实密钥'],
  [/api[_-]?key\s*[:=]\s*["'][^"']{12,}/i, '不得出现真实密钥'],
  [/resizer/i, '侧栏不做拖拽调宽（只保留拉出/收起）'],
  [/cursor:col-resize/i, '不得出现调宽光标'],
  [/已归档/, '消息上不得出现"已归档"提示'],
  [/\bdayKey\b/, '列表不按时间分组（不得再有时间分组逻辑）'],
  [/["'](今天|昨天|前 7 天|更早)["']/, '列表不得出现时间分组标题'],
  [/\bavatar\b|avatarHTML|class="big-avatar"/i, '界面不使用头像（消息、对话列表、空态、右栏均无）'],
];

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'circle', 'path', 'rect', 'line', 'polyline', 'polygon', 'use', 'ellipse', 'stop', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
const BALANCED_TAGS = ['div', 'button', 'aside', 'main', 'nav', 'textarea', 'select', 'span'];

/** 逐行正则提取模板串不够健壮（嵌套引号/行内闭合/续行都会出错），改用字符级扫描。 */
export function lineOf(src, index) {
  return src.slice(0, index).split(/\r?\n/).length;
}

function readString(src, i, q) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q) return j + 1;
    if (src[j] === '\n') return j;
    j += 1;
  }
  return j;
}

const TAG_START = /<([a-zA-Z][a-zA-Z0-9]*)/g;

/** 把模板串文本里的 ${...} 挖空（按 JS 的嵌套引号/模板规则跳过）。 */
function blankInterpolations(text, src, base) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
        else if (c === '`') {
          const inner = scanTemplate(text, j, src, base);
          if (inner === null) return { html: null, error: `模板串未闭合（第 ${lineOf(src, base + j)} 行）` };
          j = inner.end - 1;
        } else if (c === '"' || c === "'") j = readString(text, j, c) - 1;
      }
      out += ' ';
      i = j - 1;
      continue;
    }
    out += text[i];
  }
  return { html: out, error: null };
}

/** 从 src[pos] 的起引号开始扫描一个模板串，返回其内容与结束位置。 */
function scanTemplate(src, pos, full, base) {
  let i = pos + 1;
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { text += src[i + 1] ?? ''; i += 2; continue; }
    if (c === '`') return { text, end: i + 1 };
    if (c === '$' && src[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j += 1) {
        const d = src[j];
        if (d === '{') depth += 1;
        else if (d === '}') { depth -= 1; if (depth === 0) break; }
        else if (d === '`') {
          const inner = scanTemplate(src, j, full, base);
          if (!inner) return null;
          j = inner.end - 1;
        } else if (d === '"' || d === "'") j = readString(src, j, d) - 1;
      }
      text += ' ';
      i = j + 1;
      continue;
    }
    text += c;
    i += 1;
  }
  return null;
}

/**
 * 扫描整段脚本，取出所有"真正含 HTML 标签"的模板串，并逐串做标签配平。
 * @param {string} script
 * @returns {string[]} 问题列表
 */
export function collectHtmlTemplates(script, issues, label = '脚本内联 HTML') {
  const out = [];
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (c === '/' && script[i + 1] === '/') { i = script.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && script[i + 1] === '*') { i = script.indexOf('*/', i); if (i === -1) break; i += 2; continue; }
    if (c === '"' || c === "'") { i = readString(script, i, c); continue; }
    if (c === '`') {
      const res = scanTemplate(script, i, script, i);
      if (!res) { issues.push(`${label}：模板串未闭合（第 ${lineOf(script, i)} 行）`); return out; }
      i = res.end;
      if (!/<[a-zA-Z][a-zA-Z0-9]*[\s/>]/.test(res.text)) continue;
      const cleared = blankInterpolations(res.text, script, i);
      if (cleared.error) { issues.push(`${label}：${cleared.error}`); continue; }
      out.push({ html: cleared.html, line: lineOf(script, i), tags: (cleared.html.match(TAG_START) || []).length });
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 取静态 HTML：去掉 script/style 内容，保留结构。
 * @param {string} html
 */
export function staticMarkup(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

/**
 * 检查一批 HTML 文本的标签配平。
 * @param {string} markup
 * @param {string} label
 * @param {string[]} issues
 */
export function checkTagBalance(markup, label, issues) {
  const stack = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (VOID_TAGS.has(tag) || attrs.trim().endsWith('/')) continue;
    if (!BALANCED_TAGS.includes(tag)) continue;
    if (!closing) stack.push(tag);
    else {
      const top = stack.pop();
      if (top !== tag) {
        issues.push(`${label}：标签配平失败，遇到 </${tag}> 但栈顶是 ${top ? `<${top}>` : '空'}`);
        return;
      }
    }
  }
  if (stack.length) issues.push(`${label}：有 ${stack.length} 个未闭合标签（${stack.join(', ')}）`);
}

/**
 * @param {string} demoPath
 * @param {string} [cwd]
 */
export function verifyDemo(demoPath = DEMO_PATH_DEFAULT, cwd = process.cwd()) {
  const abs = path.isAbsolute(demoPath) ? demoPath : path.resolve(cwd, demoPath);
  const issues = [];
  let html;
  try {
    html = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, issues: [`无法读取 Demo：${abs}（${err.code ?? err.message}）`], stats: {} };
  }

  // 1. 内联脚本必须能编译（语法检查，不执行）
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (!scripts.length) issues.push('必须包含内联 <script>');
  let scriptBytes = 0;
  scripts.forEach((src, i) => {
    scriptBytes += src.length;
    try {
      new vm.Script(src, { filename: `demo-inline-${i + 1}.js` });
    } catch (err) {
      issues.push(`内联脚本 ${i + 1} 语法错误：${err.message}`);
    }
  });

  // 2. 必须离线可用
  for (const [re, why] of FORBIDDEN_PATTERNS) {
    if (re.test(html)) issues.push(why);
  }

  // 3. 关键元素与交互
  for (const id of REQUIRED_IDS) {
    if (!new RegExp(`id="${id}"`).test(html)) issues.push(`缺少元素 id="${id}"`);
  }
  for (const [re, why] of REQUIRED_PATTERNS) {
    if (!re.test(html)) issues.push(`缺少要点：${why}`);
  }

  // 4. 标签配平：静态骨架 + 脚本里生成出的 HTML 模板串
  checkTagBalance(staticMarkup(html), '静态 HTML', issues);
  const tpls = collectHtmlTemplates(scripts.join('\n'), issues);
  tpls.forEach((t) => checkTagBalance(t.html, `脚本内联 HTML（第 ${t.line} 行起）`, issues));
  checkTagBalance(tpls.map((t) => t.html).join('\n'), '脚本内联 HTML 汇总', issues);

  // 5. 脚本里的字面选择器必须真实存在（id / data-* 属性）
  //    注意：不能只扫已挖空 ${} 的模板文本——id 与 data-* 常常就写在插值里，
  //    所以这里额外扫一遍原始脚本里的属性字面量。
  const scriptText = scripts.join('\n');
  const source = staticMarkup(html) + '\n' + scriptText;
  const knownIds = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const knownData = new Set([...source.matchAll(/\b(data-[a-z0-9-]+)(?=[\s=>/`]|$)/gi)].map((m) => m[1].toLowerCase()));
  let selectorRefs = 0;
  for (const m of html.matchAll(/\$\$?\(\s*["']([^"']+)["']\s*\)/g)) {
    const sel = m[1];
    for (const idm of sel.matchAll(/#([a-zA-Z][\w-]*)/g)) {
      selectorRefs += 1;
      if (!knownIds.has(idm[1])) {
        issues.push(`选择器引用了不存在的 id：#${idm[1]}（第 ${lineOf(html, m.index)} 行附近）`);
      }
    }
    for (const dm of sel.matchAll(/\[(data-[a-z0-9-]+)/gi)) {
      selectorRefs += 1;
      if (!knownData.has(dm[1].toLowerCase())) {
        issues.push(`选择器引用了不存在的属性：[${dm[1]}]（第 ${lineOf(html, m.index)} 行附近）`);
      }
    }
  }

  // 6. 中文界面文案
  if (!/[\u4e00-\u9fff]/.test(html)) issues.push('界面文案应为中文');

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      lines: html.split(/\r?\n/).length,
      kb: Math.round(html.length / 1024),
      scripts: scripts.length,
      scriptBytes,
      htmlTemplates: tpls.length,
      htmlTemplateTags: tpls.reduce((a, t) => a + t.tags, 0),
      selectorRefs,
      ids: REQUIRED_IDS.length,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? DEMO_PATH_DEFAULT;
  const { ok, issues, stats } = verifyDemo(target);
  if (ok) {
    console.log(`✓ Demo 校验通过：${target}`);
    console.log(`  ${stats.lines} 行 / ${stats.kb} KB / 内联脚本 ${stats.scripts} 段（${stats.scriptBytes} 字符）/ 关键 id ${stats.ids} 个`);
    process.exit(0);
  }
  console.error(`✗ Demo 校验失败：${target}`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
