/**
 * 角色库卡片的样式契约（组件测试补不上的一块）。
 *
 * 存在的理由：`test/renderer/character-library.test.tsx` 跑在 jsdom 里，而 jsdom
 * **不加载外部样式表、也没有排版引擎**——"名字超长会不会糊到右边那张卡上"在那里
 * 既看不见也断言不了（`overflow: hidden` 写没写，用例都是绿的）。写进组件测试
 * 只会得到永远为真的假通过。
 *
 * 这里钉的是一个**真实报上来的 bug**：卡片下面的名字过长时，直接盖住了右边那张卡
 * 的名字。根因不是"忘了写省略号"——`overflow: hidden` / `text-overflow: ellipsis` /
 * `white-space: nowrap` 三行一直都在，而是 flex 项的**尺寸**把它们架空了：
 *
 *   1. `button` 的 UA 样式表带 `align-items: flex-start`。作者覆盖了同一规则里的
 *      `text-align` / `padding` / `border`，唯独漏了这一条，于是 flex 项的宽度退化成
 *      fit-content，而不是撑满卡片。
 *   2. flex 项默认 `min-width: auto`，取值是内容的 min-content 尺寸；而 nowrap 文本的
 *      min-content **就等于整串名字**。不显式压到 0，最小尺寸会把框顶回"整串名字那么宽"。
 *
 * 两条叠加的结果是"框比卡片还宽"：文字在自己的框里放得下，`overflow: hidden`
 * 没有东西可裁，于是整串名字画到了卡片外面。少任何一条，这个 bug 都会回来。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const PAGES_CSS = 'src/renderer/styles/pages.css';
const DESIGN_DOC = 'docs/ui-design-sidebar-chat.md';

const css = readFileSync(path.join(repoRoot, PAGES_CSS), 'utf8');
const doc = readFileSync(path.join(repoRoot, DESIGN_DOC), 'utf8');

/** 去掉 CSS 块注释：注释里也会提到这些属性名，不能当成规则命中。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某个选择器在样式表里的声明块文本。找不到返回 null。 */
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

function propsOf(selector: string): Map<string, string> {
  const body = ruleBody(css, selector);
  expect(body, `样式表里找不到 ${selector}`).not.toBeNull();
  return declarations(body!);
}

describe('卡片名字超长只省略，不糊到邻卡上', () => {
  it('.char-card 显式写 align-items: stretch（不能靠默认值）', () => {
    // 默认值来自 UA 的 `button { align-items: flex-start }`，
    // 显式写死才不会因为浏览器/框架的默认值变化而回退成 fit-content。
    expect(propsOf('.char-card').get('align-items')).toBe('stretch');
  });

  it('.char-card-name 同时具备"单行省略"的三件套', () => {
    const props = propsOf('.char-card-name');
    expect(props.get('overflow')).toBe('hidden');
    expect(props.get('text-overflow')).toBe('ellipsis');
    expect(props.get('white-space')).toBe('nowrap');
  });

  it('.char-card-name 把 min-width 压到 0，否则最小尺寸会顶掉省略号', () => {
    // 这一条是 bug 的真正开关：nowrap 文本的 min-content = 整串名字，
    // 而 flex 项默认 min-width: auto 就是取 min-content。
    expect(propsOf('.char-card-name').get('min-width')).toBe('0');
  });

  it('.char-card-name 不得超出卡片宽度', () => {
    expect(propsOf('.char-card-name').get('max-width')).toBe('100%');
  });

  it('.char-card 自己是网格项，仍需 min-width: 0（网格轨道同理）', () => {
    expect(propsOf('.char-card').get('min-width')).toBe('0');
  });
});

describe('设计文档与实现同源', () => {
  it('文档写明卡片名字是单行省略', () => {
    expect(doc).toMatch(/名字[^\n]{0,20}单行省略/);
  });
});
