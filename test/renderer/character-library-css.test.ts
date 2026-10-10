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
const OVERLAYS_CSS = 'src/renderer/styles/overlays.css';
const TOKENS_CSS = 'src/renderer/styles/tokens.css';
const DESIGN_DOC = 'docs/ui-design-sidebar-chat.md';

const css = readFileSync(path.join(repoRoot, PAGES_CSS), 'utf8');
const overlays = readFileSync(path.join(repoRoot, OVERLAYS_CSS), 'utf8');
const tokens = readFileSync(path.join(repoRoot, TOKENS_CSS), 'utf8');
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
  return propsIn(css, selector);
}

/** 从任意样式表里取某个选择器的属性表。 */
function propsIn(text: string, selector: string): Map<string, string> {
  const body = ruleBody(text, selector);
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

  it('文档写明收藏角标是深色胶囊 + 实心 SVG 星', () => {
    expect(doc).toMatch(/角标[^\n]{0,40}(胶囊|`--badge-scrim`)[^\n]{0,20}(实心|svg)/i);
  });
});

/* ------------------------------------------------------------------ */
/* 收藏角标：深色胶囊 + 实心 SVG 星（不是压在卡面图上的文本 ★）            */
/* ------------------------------------------------------------------ */

/**
 * 角标此前是**文本字符** `★`（12px / `--warn` 橙 / 只有 text-shadow）：
 * 字形来自系统字体、与全应用的内联 SVG 图标不是一套；没有底盘，卡面一花就被吃掉；
 * 而且 `--warn` 在本项目里是警告色，拿它表达收藏是语义串台。
 *
 * 组件测试只能验到"里面是个 svg、文本为空"（见 character-library.test.tsx），
 * "有没有底盘、什么颜色" 只能在样式文本上验——所以这一组留在这里。
 */
describe('收藏角标是"胶囊 + 实心 SVG 星"', () => {
  it('.char-card-fav 是绝对定位的深色胶囊 + 专供深色底的星色', () => {
    const props = propsOf('.char-card-fav');
    expect(props.get('position')).toBe('absolute');
    expect(props.get('background')).toBe('var(--badge-scrim)');
    expect(props.get('color')).toBe('var(--favorite-on-badge)');
  });

  it('角标不再借用语义为"警告"的 --warn', () => {
    const props = propsOf('.char-card-fav');
    expect(props.get('color')).not.toContain('--warn');
    // text-shadow 是"没有底色时硬撑可读性"的补丁，有了胶囊就不该再留着
    expect(props.has('text-shadow')).toBe(false);
  });

  it('详情弹窗的星按钮用 --favorite，而不是 --warn', () => {
    expect(propsIn(overlays, '.icon-btn.fav-on').get('color')).toBe('var(--favorite)');
  });

  it('收藏 token 在浅色与深色两套主题里都有取值', () => {
    const light = declarations(ruleBody(tokens, ':root')!);
    const dark = declarations(ruleBody(tokens, "html[data-theme='dark']")!);
    for (const name of ['--favorite', '--favorite-on-badge', '--badge-scrim']) {
      expect(light.get(name), `:root 缺少 ${name}（浅色主题会取不到值）`).toBeDefined();
      expect(dark.get(name), `深色主题缺少 ${name}`).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 两个对话框的布局：表单能滚、底部动作不跟着滚                           */
/* ------------------------------------------------------------------ */

/**
 * 编辑弹窗与向导都是"很高的表单 + 固定在底部的动作区"。
 * jsdom 没有排版引擎，只能读样式文本：
 *   - 对话框宽度必须比 `.dialog` 默认的 400px 宽（否则编辑 system_prompt 只能看两三行）；
 *   - 高度必须封顶（`max-height`）且**只有表单那一段滚动**，否则「保存 / 取消」
 *     会被一起滚出视口——这一点在真机上用 CDP 量过：677px 高、视口 757px、
 *     表单 `scrollHeight > clientHeight`。
 */
describe('编辑弹窗与向导的布局', () => {
  it('编辑弹窗是"大对话框"：够宽、高度封顶、表单区自己滚', () => {
    const dialog = propsIn(overlays, '.dialog.char-editor');
    const width = Number.parseInt(dialog.get('width') ?? '0', 10);
    expect(width).toBeGreaterThanOrEqual(600);
    expect(dialog.get('max-height')).toContain('100vh');
    expect(dialog.get('display')).toBe('flex');
    expect(propsIn(overlays, '.dialog.char-editor .char-editor-body').get('overflow-y')).toBe('auto');
  });

  it('向导宽度按最宽的那一步定（要放得下完整表单，且不随步骤变）', () => {
    const width = Number.parseInt(propsIn(overlays, '.dialog.wizard').get('width') ?? '0', 10);
    expect(width).toBeGreaterThanOrEqual(600);
  });

  it('向导第 2 步的提示文案样式能盖过 .dialog p 的默认段落样式', () => {
    // `!important` 与更高特指度二选一，这里用的是后者（`.dialog p.wizard-hint`）
    expect(ruleBody(overlays, '.dialog p.wizard-hint')).not.toBeNull();
  });
});
