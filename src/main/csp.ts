/**
 * 内容安全策略的构造（技术方案 6.3）。
 *
 * **刻意独立成文件、且不 import electron**：CSP 是安全边界，必须能被单元测试
 * 直接断言（哪些指令允许什么），而不是只能靠"跑起来看看"来验证。
 *
 * 两种模式的区别很关键：
 *
 * | | 生产（`file://`） | 开发（Vite dev server） |
 * |---|---|---|
 * | `connect-src` | `'none'` —— renderer 不许发任何网络请求 | 必须放行 dev server 与它的 WebSocket，否则 **HMR 直接不工作** |
 * | `script-src` | `'self'` | 还要放行 dev server 源（Vite 注入客户端脚本） |
 *
 * 生产侧的 `connect-src 'none'` 是本产品的硬要求：DB 与 API 调用只在主进程
 * （技术方案 4.2 的 renderer 禁止项）。这条比"靠 code review 拦住"可靠得多。
 *
 * 注意：宽松只发生在**显式传入了 dev server 地址**时。没有这个地址就一律按
 * 生产策略下发，不会因为"忘了设环境变量"而静默放松安全策略。
 */

/** 那些在两种模式下都一样的严格指令。 */
const BASE_DIRECTIVES = {
  // 模型输出里的外链图片一律阻断（只允许自站与 data:）
  imgSrc: "img-src 'self' data:",
  fontSrc: "font-src 'self' data:",
  objectSrc: "object-src 'none'",
  frameSrc: "frame-src 'none'",
  mediaSrc: "media-src 'none'",
  baseUri: "base-uri 'none'",
  formAction: "form-action 'none'",
  // 样式需要允许内联：React 的 style 属性与主题变量都靠它
  styleSrc: "style-src 'self' 'unsafe-inline'",
} as const;

function join(...parts: string[]): string {
  return parts.join('; ');
}

/**
 * 生产策略。
 *
 * `connect-src 'none'` 是刻意的：renderer 一发起请求就失败，而不是"悄悄地成功"。
 * 这条也顺手挡住了模型输出里可能夹带的 `fetch`。
 */
export function buildProductionCsp(): string {
  return join(
    "default-src 'self'",
    "script-src 'self'",
    BASE_DIRECTIVES.styleSrc,
    BASE_DIRECTIVES.imgSrc,
    BASE_DIRECTIVES.fontSrc,
    "connect-src 'none'",
    BASE_DIRECTIVES.objectSrc,
    BASE_DIRECTIVES.frameSrc,
    BASE_DIRECTIVES.mediaSrc,
    BASE_DIRECTIVES.baseUri,
    BASE_DIRECTIVES.formAction,
  );
}

/** 从 dev server 地址推导出需要放行的源（含 WebSocket 源）。 */
export function devServerOrigins(devServerUrl: string): { http: string; ws: string } | null {
  try {
    const url = new URL(devServerUrl);
    const origin = url.origin;
    const ws = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
    return { http: origin, ws };
  } catch {
    return null;
  }
}

/**
 * 开发策略：在生产策略的基础上，只把 dev server 的 HTTP 与 WebSocket 源加进去。
 *
 * Vite 的 HMR 客户端要连 `ws://host:port`，而 `connect-src 'none'` 会把这条
 * WebSocket 一起掐掉——表现就是"代码改了页面不刷新，控制台报 CSP 违规"。
 * 所以这里必须显式放行，而不是留个 `'unsafe-inline'` 之类的口子。
 *
 * 传进来的地址解析失败时**回退到生产策略**：宁可 HMR 不工作，
 * 也不能因为一个畸形环境变量把安全策略放松。
 */
export function buildDevelopmentCsp(devServerUrl: string): string {
  const origins = devServerOrigins(devServerUrl);
  if (!origins) return buildProductionCsp();

  return join(
    `default-src 'self' ${origins.http}`,
    // Vite 会注入内联的启动脚本，dev 下必须允许
    `script-src 'self' 'unsafe-inline' ${origins.http}`,
    BASE_DIRECTIVES.styleSrc,
    BASE_DIRECTIVES.imgSrc,
    BASE_DIRECTIVES.fontSrc,
    // HMR：HTTP 用于模块热替换请求，ws 用于热更新推送
    `connect-src 'self' ${origins.http} ${origins.ws}`,
    BASE_DIRECTIVES.objectSrc,
    BASE_DIRECTIVES.frameSrc,
    BASE_DIRECTIVES.mediaSrc,
    BASE_DIRECTIVES.baseUri,
    BASE_DIRECTIVES.formAction,
  );
}

/** 按模式选择策略。`devServerUrl` 为空即视为生产。 */
export function buildContentSecurityPolicy(devServerUrl?: string | null): string {
  return devServerUrl ? buildDevelopmentCsp(devServerUrl) : buildProductionCsp();
}

/**
 * 判断一次导航是否属于"应用自身"，从而决定放行还是交给系统浏览器。
 *
 * 两种合法情形：
 *   - 生产：`file://`（我们自己的 `index.html`）
 *   - 开发：dev server 源下的地址（HMR 会做整页刷新）
 *
 * 其余一律拦截。这里刻意用"源相等"而不是"前缀匹配"——前缀匹配会让
 * `http://localhost:5173.evil.com` 这类地址蒙混过关。
 */
export function isInternalNavigation(targetUrl: string, devServerUrl?: string | null): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  if (url.protocol === 'file:') return true;

  if (!devServerUrl) return false;
  const origins = devServerOrigins(devServerUrl);
  return origins !== null && url.origin === origins.http;
}
