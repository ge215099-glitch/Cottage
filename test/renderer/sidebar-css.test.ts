/**
 * 左栏样式契约（组件测试补不上的一块）。
 *
 * 存在的理由：`test/renderer/sidebar.test.tsx` 跑在 jsdom 里，而 jsdom **不加载
 * 外部样式表、也没有排版引擎**——"选中项前面有没有那条蓝色竖线""两块之间有没有
 * 间距"这两件事在那里既看得见 DOM 也断言不了。写进组件测试只会得到永远为真的假通过。
 *
 * 所以这里改读真实样式表文本 + 设计文档文本，把两处视觉约定钉成可执行断言：
 *
 *   1. **选中态只用填充表达**：`.nav-item.active` / `.conv-row.active` 里不得出现
 *      `::before`、`border-left`、`box-shadow: inset` 之类的"左侧竖条"写法（P4）。
 *   2. **相邻两项之间留缝**：`.nav` 与 `.conv-list` 都要有 gap；
 *      虚拟滚动态的行不在 flex 流里（绝对定位），必须由 `[data-index]` 补同一个缝，
 *      否则列表一过阈值行距就塌成 0。
 *
 * 这是真实踩过的坑：早期项间距只有 1px，选中项的填充块和邻居糊在一起，
 * 才不得不再画一条左侧 2px 强调条来指认当前项。反过来做——留缝 + 加深填充——
 * 那条竖线就是多余的。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const SIDEBAR_CSS = 'src/renderer/styles/sidebar.css';
const DESIGN_DOC = 'docs/ui-design-sidebar-chat.md';

const css = readFileSync(path.join(repoRoot, SIDEBAR_CSS), 'utf8');
const doc = readFileSync(path.join(repoRoot, DESIGN_DOC), 'utf8');

/** 去掉 CSS 块注释：注释里也会提到"2px 强调条"，不能当成规则命中。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某个选择器（逗号分隔的整体）在样式表里的声明块文本。找不到返回 null。 */
function ruleBody(text: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(stripComments(text));
  return match ? match[1]! : null;
}

/** 解析声明块为属性表。 */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 选中态：只有填充，没有左侧竖线                                        */
/* ------------------------------------------------------------------ */

describe('选中态不画左侧竖线（P4：状态靠填充，不靠描边）', () => {
  it.each(['.nav-item.active', '.conv-row.active'])('%s 的规则里没有 ::before / 左侧竖条', (selector) => {
    const body = ruleBody(css, selector);
    expect(body, `样式表里找不到 ${selector}`).not.toBeNull();

    // ① 该选择器本身不得带伪元素
    expect(stripComments(css)).not.toContain(`${selector}::before`);
    expect(stripComments(css)).not.toContain(`${selector}::after`);

    // ② 也不得改用 border-left / inset 阴影这些等价写法来凑一条竖线
    const props = declarations(body!);
    expect(props.has('border-left')).toBe(false);
    expect(props.has('border-inline-start')).toBe(false);
    expect(props.has('box-shadow')).toBe(false);

    // ③ 选中态仍然是"一层更深的填充"
    expect(props.get('background')).toBe('var(--surface-active)');
  });

  it('整个样式表里不再有靠 ::before 画的 2px 强调条', () => {
    const plain = stripComments(css);
    // 强调条当年的写法就是伪元素 + width: 2px + --accent-soft 背景
    const accentBars = plain.match(/::before\s*\{[^}]*--accent-soft[^}]*\}/g) ?? [];
    expect(accentBars).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 项间距：两块之间要有缝                                                */
/* ------------------------------------------------------------------ */

/** 取 `gap` 或 `row-gap` 的像素值。 */
function rowGapPx(text: string, selector: string): number {
  const body = ruleBody(text, selector);
  expect(body, `样式表里找不到 ${selector}`).not.toBeNull();
  const props = declarations(body!);
  const raw = props.get('row-gap') ?? props.get('gap');
  expect(raw, `${selector} 必须显式写出项间距`).toBeDefined();
  const match = /^(\d+)px$/.exec(raw!);
  expect(match, `只接受 px 取值，实际是 ${raw}`).not.toBeNull();
  return Number(match![1]);
}

describe('相邻项之间留缝（导航与对话列表同一套口径）', () => {
  it('③ 固定导航项之间有可见间距，且落在 2–8px 之间', () => {
    const gap = rowGapPx(css, '.nav');
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(8);
  });

  it('⑤ 对话行之间同样有间距', () => {
    const gap = rowGapPx(css, '.conv-list');
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(8);
  });

  it('列表必须是 flex 列布局，gap 才生效', () => {
    const listProps = declarations(ruleBody(css, '.conv-list')!);
    expect(listProps.get('display')).toBe('flex');
    expect(listProps.get('flex-direction')).toBe('column');
  });

  it('虚拟滚动态补回同一段行距（绝对定位的行不参与父级 gap）', () => {
    const virtualRow = ruleBody(css, '.conv-list [data-index]');
    expect(virtualRow, '虚拟行必须自带行距，否则过阈值后行距塌成 0').not.toBeNull();
    const margin = declarations(virtualRow!).get('margin-bottom');
    expect(margin).toBe(`${rowGapPx(css, '.conv-list')}px`);
  });

  it('虚拟行选择器与 VirtualRowList 真正写出的属性一致', () => {
    // 样式与组件之间的这层耦合是隐式的：组件撤销 data-index 时这里必须报警。
    const virtualList = readFileSync(
      path.join(repoRoot, 'src/renderer/components/VirtualRowList.tsx'),
      'utf8',
    );
    expect(virtualList).toContain('data-index={virtualRow.index}');
  });
});

/* ------------------------------------------------------------------ */
/* 文档同源：设计文档必须跟着改                                          */
/* ------------------------------------------------------------------ */

describe('设计文档与实现同源（避免文档变成第二份规格）', () => {
  it('文档写明选中项不画左侧强调条', () => {
    expect(doc).toMatch(/不画左侧 2px 强调条|没有左侧强调条|不要左侧 2px 强调条|不再有强调条/);
  });

  it('文档写明导航与列表项之间留 4px 间距', () => {
    expect(doc).toMatch(/项间[^\n]{0,12}4px|间距 4px|gap: 4px/);
    expect(doc).toMatch(/行距[^\n]{0,12}(4px|间距)|4px 行距/);
  });

  it('文档写明虚拟滚动态要补回同一段行距', () => {
    expect(doc).toMatch(/data-index/);
  });
});
