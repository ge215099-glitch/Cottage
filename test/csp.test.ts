/**
 * CSP 与导航判定测试（技术方案 6.3）。
 *
 * 为什么必须直接测：这是安全边界。「生产环境 renderer 不许发网络请求」和
 * 「开发环境 HMR 能连上」是两条互相拉扯的要求，写错了不会有任何报错——
 * 要么 HMR 静默失效（改了代码页面不刷新），要么生产环境悄悄放行了网络。
 * 两者都属于"跑起来看着没事"的缺陷，只能靠对策略文本的断言拦住。
 */
import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  buildDevelopmentCsp,
  buildProductionCsp,
  devServerOrigins,
  isInternalNavigation,
} from '../src/main/csp.js';

/** 把 `a=b; c=d` 形式的策略解析成便于断言的对象。 */
function parsePolicy(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const directive of policy.split(';')) {
    const trimmed = directive.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    map.set(name!, values.join(' '));
  }
  return map;
}

describe('生产策略', () => {
  const map = parsePolicy(buildProductionCsp());

  it("connect-src 是 'none'：renderer 一发起请求就失败（DB 与 API 只在主进程）", () => {
    expect(map.get('connect-src')).toBe("'none'");
  });

  it("script-src 只有 'self'，且不含 unsafe-eval / unsafe-inline", () => {
    const scriptSrc = map.get('script-src')!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain('unsafe-eval');
    // 生产下不允许内联脚本：模型输出里的脚本没有任何理由被执行
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('img-src 只允许 self、data: 与自有头像协议（阻断模型输出里的外链图片）', () => {
    // `cottage-avatar:` 是角色卡图片的通道；主进程 handler 会把 URL 限制在
    // userData/avatars/ 之内，所以放宽的是协议而不是 file:
    expect(map.get('img-src')).toBe("'self' data: cottage-avatar:");
  });

  it('锁掉 object / frame / media / base-uri / form-action', () => {
    expect(map.get('object-src')).toBe("'none'");
    expect(map.get('frame-src')).toBe("'none'");
    expect(map.get('media-src')).toBe("'none'");
    expect(map.get('base-uri')).toBe("'none'");
    expect(map.get('form-action')).toBe("'none'");
  });

  it('style-src 允许内联（React 的 style 属性与主题变量需要）', () => {
    expect(map.get('style-src')).toBe("'self' 'unsafe-inline'");
  });

  it("default-src 是 'self'", () => {
    expect(map.get('default-src')).toBe("'self'");
  });
});

describe('开发策略：必须放行 HMR，且只放行 dev server', () => {
  const url = 'http://localhost:5173';
  const map = parsePolicy(buildDevelopmentCsp(url));

  it('connect-src 放行 dev server 的 HTTP 与 WebSocket（否则 HMR 直接不工作）', () => {
    const connectSrc = map.get('connect-src')!;
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain('http://localhost:5173');
    // Vite 的热更新推送走 ws://，漏了它就会出现"改了代码页面不刷新"
    expect(connectSrc).toContain('ws://localhost:5173');
  });

  it('https 的 dev server 推导出 wss（而不是错误的 ws）', () => {
    const secure = parsePolicy(buildDevelopmentCsp('https://localhost:5173'));
    expect(secure.get('connect-src')).toContain('wss://localhost:5173');
    expect(secure.get('connect-src')).not.toContain(' ws://localhost:5173');
  });

  it('script-src 放行 dev server 与内联脚本（Vite 会注入启动脚本）', () => {
    const scriptSrc = map.get('script-src')!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain('http://localhost:5173');
    expect(scriptSrc).toContain("'unsafe-inline'");
    // 但绝不放开 eval
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('即使宽松模式也保留那些安全指令', () => {
    expect(map.get('object-src')).toBe("'none'");
    expect(map.get('img-src')).toBe("'self' data: cottage-avatar:");
    expect(map.get('base-uri')).toBe("'none'");
    expect(map.get('form-action')).toBe("'none'");
  });

  it('不同端口不会被误放行（只放行实际 dev server 源）', () => {
    const connectSrc = map.get('connect-src')!;
    expect(connectSrc).not.toContain('5174');
  });
});

describe('devServerOrigins', () => {
  it('解析 http / https 并推导对应的 ws / wss', () => {
    expect(devServerOrigins('http://localhost:5173')).toEqual({
      http: 'http://localhost:5173',
      ws: 'ws://localhost:5173',
    });
    expect(devServerOrigins('https://127.0.0.1:8443')).toEqual({
      http: 'https://127.0.0.1:8443',
      ws: 'wss://127.0.0.1:8443',
    });
  });

  it('带路径的地址只取源（不把路径带进 CSP）', () => {
    expect(devServerOrigins('http://localhost:5173/some/path')?.http).toBe('http://localhost:5173');
  });

  it('非法地址返回 null', () => {
    expect(devServerOrigins('不是一个 URL')).toBeNull();
    expect(devServerOrigins('')).toBeNull();
  });
});

describe('模式选择', () => {
  it('没有 dev server 地址时一律用生产策略（不会因忘设环境变量而放松）', () => {
    expect(buildContentSecurityPolicy(null)).toBe(buildProductionCsp());
    expect(buildContentSecurityPolicy(undefined)).toBe(buildProductionCsp());
    expect(buildContentSecurityPolicy('')).toBe(buildProductionCsp());
  });

  it('有地址时用开发策略', () => {
    expect(buildContentSecurityPolicy('http://localhost:5173')).toBe(
      buildDevelopmentCsp('http://localhost:5173'),
    );
  });

  it('地址畸形时回退生产策略（宁可 HMR 不工作，也不放松安全）', () => {
    expect(buildContentSecurityPolicy('不是地址')).toBe(buildProductionCsp());
  });

  it('两种策略都不是空串且指令数一致（避免漏拼某一条）', () => {
    const prod = parsePolicy(buildProductionCsp());
    const dev = parsePolicy(buildDevelopmentCsp('http://localhost:5173'));
    expect(prod.size).toBeGreaterThan(8);
    expect([...dev.keys()].sort()).toEqual([...prod.keys()].sort());
  });
});

describe('导航判定（isInternalNavigation）', () => {
  it('file:// 视为应用自身（生产加载 index.html）', () => {
    expect(isInternalNavigation('file:///D:/app/out/renderer/index.html')).toBe(true);
  });

  it('开发模式下 dev server 源内的地址视为自身（HMR 会整页刷新）', () => {
    expect(isInternalNavigation('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isInternalNavigation('http://localhost:5173/index.html', 'http://localhost:5173')).toBe(true);
  });

  it('没有 dev server 时 http 地址不算自身', () => {
    expect(isInternalNavigation('http://localhost:5173/', null)).toBe(false);
  });

  it('外站一律不算自身', () => {
    expect(isInternalNavigation('https://evil.example.com/', 'http://localhost:5173')).toBe(false);
  });

  it('用"源相等"而不是前缀匹配：同前缀的恶意域名不算自身', () => {
    // 前缀匹配会把这个当成 localhost:5173 放行——这正是要避免的
    expect(isInternalNavigation('http://localhost:5173.evil.com/', 'http://localhost:5173')).toBe(false);
  });

  it('不同端口不算自身', () => {
    expect(isInternalNavigation('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
  });

  it('畸形地址不算自身（不抛异常）', () => {
    expect(isInternalNavigation('not a url', 'http://localhost:5173')).toBe(false);
    expect(isInternalNavigation('', null)).toBe(false);
  });
});
