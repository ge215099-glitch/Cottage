import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * 三段构建：main / preload / renderer。
 *
 * ## 为什么 main 输出 `.js` 而不是 `.cjs`
 *
 * `docs/tech-stack.md` 第 10 节要求"主进程输出 CJS，避免仓库根 `type: module`
 * 带来的加载方式混用"，同时又要求"构建用 electron-vite"。这两条在文件名上会打架，
 * 原因是 electron-vite 的硬约定：
 *
 *   - 它用 `build.rollupOptions.input` 的**键名**决定产物文件名，
 *     `output.entryFileNames` 对入口 chunk 不起作用；
 *   - 启动 Electron 之前，`ensureElectronEntryFile()` 会检查 `package.json` 的
 *     `main` 字段所指文件**确实存在**，否则直接抛错退出。
 *
 * 所以只要 `main` 指向 `out/main/index.js` 而实际产物是 `index.cjs`，
 * `pnpm dev` 就会以 "No electron app entry file found" 失败——`pnpm build`
 * 却是好的，属于最难发现的那类问题（构建绿、开发起不来）。
 *
 * 解决办法：产物就叫 `out/main/index.js`（顺带满足 electron-vite 与文档的文件名约定），
 * 再由下面的 `emitCommonJsMarker` 在 `out/main/` 与 `out/preload/` 里各写一个
 * `{"type":"commonjs"}` 的 package.json，让 Node 把这两个目录下的 `.js` 当 CJS 解析。
 * 这样 CJS 这条要求由**目录级标识**保证，而不是靠扩展名。
 */

/**
 * 在产物目录里写 `{"type":"commonjs"}`。
 *
 * 必要性：仓库根 `package.json` 是 `"type": "module"`，而这两个目录里的产物是 CJS。
 * 没有这个标记，Node 会按 ESM 解析 `.js`，启动时报
 * "Cannot use import statement outside a module" 之类让人摸不着头脑的错误。
 */
function emitCommonJsMarker(outDir: string): Plugin {
  return {
    name: 'cottage:emit-commonjs-marker',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'package.json',
        source: `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
      });
    },
    // 顺手打个日志，方便构建时确认标记确实写进去了
    writeBundle(options) {
      const dir = options.dir ?? outDir;
      this.info(`已写入 CJS 标记：${dir}/package.json`);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), emitCommonJsMarker(resolve('out/main'))],
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
        // 只有 format（没有 entryFileNames）：文件名由 input 的键决定，
        // 写 entryFileNames 会给人"我在控制文件名"的错觉，实际不生效。
        output: { format: 'cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), emitCommonJsMarker(resolve('out/preload'))],
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
        output: { format: 'cjs' },
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
      // 构建配置**不引用 demo/**（技术方案验收项 15）
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
