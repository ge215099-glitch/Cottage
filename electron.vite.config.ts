import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * 三段构建：main / preload / renderer。
 *
 * - main 与 preload 输出 CommonJS（`.cjs`），这样原生模块 better-sqlite3 的加载与
 *   Electron 主进程的组合最稳，也避开仓库根 `type: module` 带来的格式混用
 *   （docs/tech-stack.md 第 10 节）。
 * - renderer 构建配置**不引用 demo/**（同上第 15 节验收项 15）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
