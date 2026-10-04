/**
 * renderer 入口。
 *
 * 这里只做三件事：加载样式、挂载 React、把主进程推来的致命错误兜住。
 * 任何业务逻辑都不应该出现在这个文件里。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
