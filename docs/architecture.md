# 架构与维护地图

更新日期：2026-11-18。用于下一轮开发快速定位，不替代源码契约。

## 技术结构

Electron 34 / React 19 / TypeScript 5.7 / Zustand / SQLite（better-sqlite3）/ zod。沿用原依赖版本，未伴随界面重做升级依赖。

```text
renderer（界面与临时状态）
  → window.cottage（preload 白名单）
  → main IPC（输入校验、数据库、网络、文件与密钥）
  → core（角色卡、Prompt、协议、摘要、token 纯逻辑）
```

renderer 不直接访问网络或数据库。模型输出与角色卡文本经 Markdown 清理；窗口保持 contextIsolation、禁用 Node、启用 sandbox。密钥用主进程 safeStorage 保存，已有密钥不回传 renderer。

## 入口与文件地图

| 位置 | 职责 |
| --- | --- |
| `src/main/index.ts` | 应用身份、独立数据目录、单实例、迁移、IPC、窗口生命周期 |
| `src/main/window.ts`、`csp.ts` | 窗口和网页安全边界 |
| `src/shared/api.ts`、`ipc.ts`、`types.ts` | 跨层方法与事件契约 |
| `src/preload/index.ts` | 受控桥接与订阅清理 |
| `src/main/db/migrations/` | 001–004 顺序迁移，仅可追加 |
| `src/main/db/dao/` | 角色、会话、消息、摘要、设置、用量 |
| `src/main/services/generate.ts` | 组装、预算判断、自动整理、流式生成、终态落库 |
| `src/main/services/compress.ts` | 摘要请求、进度终态、摘要与原文归档事务 |
| `src/core/prompt/assemble.ts` | 角色、人设、摘要、历史与输入的 Prompt 组装 |
| `src/renderer/App.tsx` | 页面组合与操作接线 |
| `src/renderer/app/useCottageController.ts` | 启动加载、全局事件、会话操作与业务状态协调 |
| `src/renderer/components/Sidebar.tsx` | 会话搜索、切换、重命名、置顶、删除入口 |
| `ChatView.tsx`、`MessageItem.tsx` | 消息流、输入、模型选择、消息操作 |
| `NewConversationWizard.tsx` | 名称沿用历史，实际是单窗口角色与连接选择 |
| `DetailPanel.tsx` | 按需弹层；默认不渲染，不是常驻右栏 |
| `Pages.tsx`、`ApiKeysPage.tsx`、`UsagePage.tsx` | 角色库、人设、设置、连接、用量 |
| `Overlays.tsx` | 菜单、确认、焦点约束与提示 |
| `src/renderer/styles/next.css` | 新版布局及视觉；旧 layout/sidebar/panel 样式不再导入 |

## 状态与异步约定

- 主进程数据库是权威状态，写操作成功后再更新投影。
- 全局订阅集中于 controller，卸载时逐项取消。后续不要在面板里重复订阅流。
- 消息加载同时检查会话与请求序号；过期加载不能覆盖当前会话。
- `chat.activeStreams` 按会话记录生成；结束事件按 streamId 匹配。保留有限终态记录，兼容极快响应早于发送结果的顺序。
- 草稿和发送前错误按会话保存，仅清除实际成功发送且未被继续编辑的草稿。草稿在进程内存中，退出应用不保留。
- `compress.tasks` 按会话保存状态。主进程进度事件包含 summarizing / writing / complete / error；关闭面板不等于停止任务。目前不提供压缩取消。
- 滚动位置在进程内按会话记忆；加载完再恢复位置或定位最新。设置页切回聊天不主动丢阅读位置。
- UI 偏好忽略旧 `panelOpen=true`，每次启动默认没有右栏。

## 验证入口

`pnpm typecheck`、`pnpm test`、`pnpm build`；`pnpm verify` 串行执行三者。`pnpm smoke:dev` 单独验证 Vite 的开发入口，哑进程不代表真实 Electron；`pnpm smoke` 在临时数据目录启动真实 Electron。`pnpm smoke:launcher` 验证隐藏启动器的正常与失败路径。

服务测试使用内存 SQLite 和替换的网络响应。真实模型测试必须另行明确启用；不允许为了检查界面调用用户密钥。

打包命令保留为 `pnpm package:win`，新版 appId、程序和快捷方式名均独立；本轮没有构建或安装发布包。

## 后续重点

1. 用户评审新版布局，尤其是功能入口和对话记忆窗口。
2. 补完窄窗口人工验收、真实服务连通与长时间对话检查。
3. 按模型配置上下文预算；现有 20,000 token 只是兜底预算。
4. 在数据副本上完成旧会话与头像迁移演练后，再考虑正式迁移。
5. 摘要目前没有完整的取消信号和并发编辑锁；不应宣称支持整理中取消。后续强化整理期间的并发写入保护。
6. 打包验收需重新检查原生模块、安装、启动及卸载。本轮仅验证开发与构建入口。
