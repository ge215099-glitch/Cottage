import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 三层测试共用一份配置（docs/tech-stack.md 第 11 节）：
 *   - 单元测试：纯 Node，跑 core / DAO / 迁移 / 事务
 *   - 组件测试：jsdom + RTL
 * 单测永不发真实网络请求（第 11.3 节纪律 1）。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    globals: true,
    // 默认纯 Node；组件测试文件用 `// @vitest-environment jsdom` 单独切换。
    environment: 'node',
    // 只收 .ts/.tsx：仓库里既有的 `verify-*.test.mjs` 是零依赖校验器测试，
    // 由 `node --test` 驱动（见 package.json 的 test 脚本），不重复纳入 vitest。
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/**/*.e2e.ts', 'node_modules/**'],
    restoreMocks: true,
  },
});
