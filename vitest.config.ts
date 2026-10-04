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
    include: ['test/**/*.test.{ts,tsx,mjs}'],
    exclude: ['test/**/*.e2e.ts', 'node_modules/**'],
    restoreMocks: true,
  },
});
