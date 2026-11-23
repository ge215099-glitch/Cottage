# 架构与维护地图

更新日期：2026-11-23。用于下一轮开发快速定位，不替代源码契约。

## 技术结构

Electron 34 / React 19 / TypeScript 5.7 / Zustand / SQLite（better-sqlite3）/ zod。角色卡语言转换使用 LangGraph.js 1.7.5。为兼容该依赖，zod 继续使用 3.x 并升至 3.25.76。

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
| `src/main/db/migrations/` | 001–006 顺序迁移，仅可追加 |
| `src/main/db/dao/` | 角色、会话、消息、摘要、设置、用量 |
| `src/main/services/generate.ts` | 组装、预算判断、自动整理、流式生成、终态落库 |
| `src/main/services/compress.ts` | 摘要请求、进度终态、摘要与原文归档事务 |
| `src/main/services/character-translation.ts` | LangGraph 语言判断、翻译、校验和预览生命周期；确认后生成新角色 |
| `src/main/services/chub.ts` | Chub 搜索、封面和 PNG 下载经主进程独立会话使用系统代理，导入复用本地解析并按来源去重 |
| `src/core/character-translation.ts` | 本地语言判断、分句、专名锁定和格式校验 |
| `src/core/prompt/assemble.ts` | 角色、人设、摘要、历史与输入的 Prompt 组装 |
| `src/renderer/App.tsx` | 页面组合与操作接线 |
| `src/renderer/app/useCottageController.ts` | 启动加载、全局事件、会话操作与业务状态协调 |
| `src/renderer/components/Sidebar.tsx` | 会话切换、重命名、置顶、删除入口（无对话搜索） |
| `ChatView.tsx`、`MessageItem.tsx` | 消息流、输入、模型选择、消息操作 |
| `src/renderer/components/useStreamingText.ts` | 仅平滑流式文字展示，不修改原始内容；终态立即显示全部文本，支持减少动态效果 |
| `NewConversationWizard.tsx` | 名称沿用历史，实际是单窗口角色与连接选择 |
| `DetailPanel.tsx` | 默认展开的右侧详情栏；角色、对话、记忆、导出直接切换 |
| `Pages.tsx`、`ApiKeysPage.tsx`、`UsagePage.tsx` | 角色库、人设、设置、连接、用量 |
| `SettingsDialog.tsx`、`SettingsNavigation.tsx` | 居中设置面板、纵向分类、关闭与焦点恢复 |
| `Overlays.tsx` | 菜单、确认、焦点约束与提示 |
| `src/renderer/styles/next.css` | 新版布局及视觉；旧 layout/sidebar/panel 样式不再导入 |

## 状态与异步约定

- 主进程数据库是权威状态，写操作成功后再更新投影。
- `app.view` 只表示聊天或角色库，`app.settingsView` 独立表示当前设置分类（null 为关闭）。打开设置不卸载原页面，背景 shell 使用 inert，避免焦点进入背后内容；连接、人设编辑仍复用既有嵌套弹窗。
- 全局订阅集中于 controller，卸载时逐项取消。后续不要在面板里重复订阅流。
- 消息加载同时检查会话与请求序号；过期加载不能覆盖当前会话。
- `chat.activeStreams` 按会话记录生成；结束事件按 streamId 匹配。保留有限终态记录，兼容极快响应早于发送结果的顺序。
- 草稿和发送前错误按会话保存，仅清除实际成功发送且未被继续编辑的草稿。草稿在进程内存中，退出应用不保留。
- `compress.tasks` 按会话保存状态。主进程进度事件包含 summarizing / writing / complete / error；关闭面板不等于停止任务。目前不提供压缩取消。
- 角色卡转换复用现有模型连接和流式请求。开场白首行的单词式地名可依据卡内用法自动保护。转换一次提交整卡待译内容，模型报告达到输出上限时直接提示并结束。DeepSeek 官方 384K 模型请求其最大输出量，并为翻译关闭默认思考模式。其他 OpenAI 兼容连接沿用服务端默认输出量，Anthropic 协议要求传入输出量，未知上限时使用 8,192 token。长文本翻译请求允许至少等待 5 分钟，用户仍可取消。校验失败的片段合并重译一次，仍失败则结束转换。确认后的副本继承原名、头像、标签和原卡附加字段。翻译预览暂存在主进程内存中，有效期 30 分钟，退出、取消或开始新任务时清除。模式随卡保存在 `extensions.cottage.languageMode`，可随 JSON/PNG 导出及重新导入。聊天生成依照卡片模式添加回复指令。
- 滚动位置在进程内按会话记忆；加载完再恢复位置或定位最新。设置页切回聊天不主动丢阅读位置。
- 每次启动默认展开右侧详情栏并显示角色资料；不恢复旧版弹层偏好。侧栏通过宽度与内部位移过渡收放；收起时使用 inert 与 aria-hidden 移除交互和辅助技术入口，内容保持挂载，切换分类不卸载设置表单。减少动态效果时跳过过渡。
- 详情开关使用同一个 DOM 按钮，始终固定在窗口右上角；收起时若焦点在栏内，返回该按钮。流式展示缓冲独立于 store，ResizeObserver 在跟随最新时处理正文增高，上翻阅读时取消跟随。
- 应用顶栏固定 40px。Electron 隐藏默认标题并保留系统窗口按钮，按钮颜色跟随应用主题。顶栏空白处可拖动窗口，左栏开关和「Cottage」文字可点击。
- 导航开关由 App 保持挂载，位于顶栏左侧，用 aria-expanded 与 aria-controls 关联主导航。导航外层只负责收放宽度和裁切，内层采用同一宽度并包含留白；窄窗口改为整栏位移。导航收起后保留内容挂载，通过 inert 与 aria-hidden 移出交互；会话列表独立滚动，设置不随列表移动。
- 最大输出 token 的编辑草稿以字符串保留，空值不转为 0；仅在保存合法整数（1–1,000,000）时转为数字。新会话默认 8,192，已有会话的已保存参数不迁移；实际模型支持的上限由供应商决定。

## 验证入口

`pnpm typecheck`、`pnpm test`、`pnpm build`；`pnpm verify` 串行执行三者。`pnpm smoke:dev` 单独验证 Vite 的开发入口，哑进程不代表真实 Electron；`pnpm smoke` 在临时数据目录启动真实 Electron。`pnpm smoke:launcher` 验证隐藏启动器的正常与失败路径。

服务测试使用内存 SQLite 和替换的网络响应。真实模型测试必须另行明确启用；不允许为了检查界面调用用户密钥。

`pnpm package:win` 生成 Windows x64 NSIS 安装包，产物位于 `dist/`。`pnpm smoke:packaged:launch` 使用临时数据目录验证打包后的程序可以首次启动并建库。新版 appId、程序和快捷方式名均独立。

## 后续重点

1. 用户评审新版布局，尤其是功能入口和对话记忆窗口。
2. 补完窄窗口人工验收、真实服务连通与长时间对话检查。
3. 按模型配置上下文预算；现有 20,000 token 只是兜底预算。
4. 在数据副本上完成旧会话与头像迁移演练后，再考虑正式迁移。
5. 摘要目前没有完整的取消信号和并发编辑锁；不应宣称支持整理中取消。后续强化整理期间的并发写入保护。
