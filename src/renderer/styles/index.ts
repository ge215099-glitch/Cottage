/**
 * 样式入口：设计 token 的单一来源（技术方案 9.6）。
 *
 * 顺序有讲究：tokens 必须最先加载，后续样式表只允许引用它声明的 CSS 变量。
 * 组件里**禁止硬编码颜色/时长**；动效 120 / 180 / 200ms 也来自 token。
 *
 * 注意 CSS 导入**不带 `.js` 后缀**：这里是交给 Vite 解析的资源，
 * 不是 Node ESM 的模块说明符（带后缀会让 rollup 找不到文件）。
 */
import './tokens.css';
import './base.css';
import './layout.css';
import './sidebar.css';
import './chat.css';
import './panel.css';
import './pages.css';
import './overlays.css';
