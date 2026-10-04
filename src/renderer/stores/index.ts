/**
 * 界面状态（技术方案 9.3 / UI 文档第 7 节）。
 *
 * 划分沿用文档给出的 5 个切片：
 *   useChatStore      当前会话、消息列表、流式状态
 *   useComposerStore  草稿与输入区 chip
 *   usePanelStore     右栏开关与当前标签
 *   useCompressStore  压缩状态机 idle / running / error
 *   useMenuStore      唯一的菜单实例（左栏与消息共用）
 *
 * **规则（技术方案 9.3）**：会话与消息的权威数据在主进程 DB，这里只是投影；
 * 所有写操作先走 IPC，成功后再更新投影，或由 `*:changed` 事件驱动刷新。
 * 两条路径选一条并保持一贯，避免"UI 已改、库没改"的假成功。
 */
export { useChatStore } from './chat.js';
export { useComposerStore } from './composer.js';
export { usePanelStore } from './panel.js';
export { useCompressStore } from './compress.js';
export { useMenuStore, type MenuItem } from './menu.js';
export { useAppStore } from './app.js';
export { useToastStore } from './toast.js';
