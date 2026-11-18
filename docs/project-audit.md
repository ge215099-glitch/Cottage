# 旧项目调研记录

本文是迁入前的历史快照；新版当前状态见 [实现记录](implementation-status.md)。文中“当前”“本轮”均指调研阶段。

调研日期：2026-11-18。来源：`D:\Work\AI\DeepSeek_Harness\Cottage`。

## 1. 结论与证据范围

旧版是已有业务实现与大量测试的 Windows 桌面应用，适合保留业务基础、重做前端。代码、旧设计文档、依赖配置和 demo 均已查阅；本轮没有启动旧 Electron 窗口，也没有调用真实模型。对布局的判断来自组件与 CSS，不是运行截图。

旧项目包版本为 `0.1.1`，调研时 HEAD 为 `456420b`。工作区已有两项删除：

- `docs/ui-design-conversation.md`
- `docs/ui-design-sidebar-chat.md`

没有恢复或修改这些文件。旧 README、技术文档、源码注释与测试仍引用它们，所以旧文档不能完整照搬。

当前新工作区只有 `FrontendDemo`，没有应用源码、package.json 或 Git 仓库。

## 2. 产品与现有能力

定位：本地优先、用户自带 API Key 的 AI 角色扮演聊天软件。

| 模块 | 已有实现 | 主要证据 |
|---|---|---|
| 模型连接 | OpenAI 兼容协议、Anthropic 协议；连接测试、获取模型列表 | `src/core/providers/`、`src/main/providers/runtime.ts`、`src/main/services/provider-test.ts` |
| 密钥 | safeStorage 加密存储；列表返回 hasKey，不返回保存过的密钥 | `src/main/secrets/`、`src/shared/api.ts`、`src/main/db/dao/providers.ts` |
| 角色卡 | v2/v3、JSON/PNG 导入导出、原始 JSON 保留、收藏、标签、卡面 | `src/core/character-card.ts`、`src/core/png-card.ts`、`src/main/services/character-import.ts` |
| 用户人设 | 多个人设、默认人设、会话绑定 | `src/main/db/dao/personas.ts`、`src/renderer/components/Pages.tsx` |
| 会话 | 创建、重命名、置顶、重开、删除、Markdown/JSON 导出 | `src/shared/api.ts`、`src/main/ipc/index.ts` |
| 消息 | 流式生成、停止、编辑、删除、重新生成、崩溃后保留已生成部分 | `src/main/services/generate.ts`、`src/main/db/dao/messages.ts` |
| 长对话 | 自动/手动摘要压缩、归档原文、恢复摘要覆盖区间 | `src/main/services/compress.ts`、`src/main/db/dao/summaries.ts` |
| Token 与用量 | 主进程预览分段占用、本地请求与 token 统计 | `src/core/tokens/`、`src/main/services/usage.ts` |
| 桌面交付 | Electron 构建、Windows NSIS 打包、开发快捷方式 | `electron-builder.yml`、`scripts/package-win.mjs` |

“已有实现”不等于本轮已验证全部可用。尤其 200 轮连续对话、真实接口、原生模块打包，本轮均未实测。

## 3. 技术结构

| 层 | 技术与职责 |
|---|---|
| 桌面 | Electron 34.3.3，单实例、单窗口 |
| UI | React 19、TypeScript 5.7.3、Zustand、手写 CSS tokens |
| 构建 | electron-vite 3、Vite 6、electron-builder 25 |
| 持久化 | better-sqlite3 11.10、手写 DAO、4 次顺序迁移 |
| 校验 | zod 3.24；IPC 白名单与共享类型 |
| 文本 | react-markdown、remark-gfm、rehype-sanitize |
| 列表/浮层 | TanStack Virtual、Floating UI |
| 测试 | Vitest 3、Testing Library、jsdom；`.mjs` 脚本由 Node test 驱动 |

职责与边界：

```text
renderer（React 页面、临时状态）
    → preload（window.cottage 白名单）
    → main（IPC、数据库、请求、密钥、文件）
    → core（纯函数：角色卡、Prompt、token、协议、摘要格式）

shared 提供跨层类型、schema 与通道名。
```

重要入口：`src/renderer/App.tsx` 同时负责编排数据载入、事件订阅、页面、弹窗和业务动作，约千行，是重做时应拆分的耦合点。`src/shared/api.ts` 是新旧前端衔接的主要契约。

## 4. 数据与请求链路

主要表：`providers`、`characters`、`personas`、`conversations`、`messages`、`summaries`、`app_settings`。

- 会话绑定角色，可覆盖 Provider、模型、人设和生成参数。
- 消息有排序、归档标记、状态和 metadata；状态包括 streaming、done、interrupted、error。
- 摘要保存覆盖区间，原文只归档不删除；恢复会撤销对应摘要。
- 角色卡保留 raw_json，卡面图片在 userData 下独立保存。
- 真实数据库路径由 Electron `app.getPath('userData')` 决定；旧 README 给出的常见位置是 `%APPDATA%\Cottage\cottage.db`。本轮未读取实际用户库。
- 迁移通过 `PRAGMA user_version` 记录，001–004 涵盖初始表、置顶时间、消息状态与索引。

发送链路：取会话与角色 → 解析人设/Provider → 组装 Prompt → 计数与必要的压缩 → 写用户消息和助手占位 → 主进程解密密钥请求上游 → SSE 增量事件 → UI 更新 → 最终消息落库。

Prompt 当前顺序：角色系统文本 → 示例对话 → 摘要 → 未归档历史 → post-history instructions → 本次输入。变量替换在 core 完成，支持 char/user/time/date 等；未知变量保留。

用量来自本地消息 metadata，只显示 token 和请求次数，不表示账号余额或供应商账单。

## 5. 右栏为什么显得复杂

证据：`src/renderer/components/DetailPanel.tsx`、`src/renderer/stores/panel.ts`、`src/main/db/dao/settings.ts`。

- 状态与默认设置都令右栏默认打开。
- 四标签：上下文、对话、角色、数据。
- 上下文标签同时有自动压缩状态、总占用、分段明细、压缩、历史、消息数和更新时间。
- 对话标签放 Provider、模型、人设、temperature、top_p、max_tokens 和清空历史重开。
- 角色标签重复展示角色描述与系统提示；数据标签放统计、导出、复制与删除。

问题是信息层级：日常聊天、少用的配置、诊断信息和破坏性操作聚集于同一常驻区域。仅缩小宽度或换颜色无法解决，需重新分配入口。

## 6. demo 提供了什么

位置：新工作区 `FrontendDemo/`，三个文件，无框架依赖。

- `index.html`：左栏、顶栏、空态、消息区、输入区与 SVG 图标。
- `styles.css`：浅/深主题、260px 左栏、800px 消息容器、768px 输入区上限、低对比边界、圆角输入框、900px 窄屏抽屉规则。
- `app.js`：预置聊天、搜索、菜单、主题、本地 localStorage、模拟逐字回复。

没有真实请求；模型名称是写死的，附件、工具、语音、资料库、分享等入口部分仅显示演示提示。不能因此推导出新版需要账户、订阅、多模态或云端分享。

本轮尝试打开浏览器预览时，工具返回本聊天不支持本地浏览器访问，故这里只记录源码结论，不宣称完成视觉验收。

## 7. 迁入前要处理的实现问题

以下来自静态代码追踪，与本轮自动测试结果分开记录。应先补能复现行为的回归用例，再修复。

| 优先级 | 问题与证据 | 迁入要求 |
|---|---|---|
| 高 | `generate.ts` 自动压缩后使用 `reassembled.spec` 重算 token，但传给 `runStream` 的仍是最初的 `spec` | 验证压缩后的实际请求确实替换了归档历史，而非仅占用数字下降 |
| 高 | `App.tsx` 的 onCancelCompress 仅调用 UI store.cancel；共享 API 无压缩取消接口，压缩请求未收到取消信号 | 在实现端到端取消前，不展示会让人误以为已取消请求的按钮 |
| 中 | `DetailPanel.tsx` 写死“自动压缩（80%）”“已开启”，按钮只切到对话标签 | 从真实设置读取状态，打开正确的设置入口 |
| 中 | `assemblePrompt` 虽接收 persona.description，却未把描述加入分段 | 明确人设描述的生效方式，补实际请求内容测试；不能只验证名字替换 |
| 中 | `assemble.ts` 用 20,000 作上下文兜底；调用处未见按模型配置的真实窗口上限 | 估算/兜底明确标注，不能宣称等于供应商真实上限 |
| 中 | 旧设计文档缺失，部分 CSS 测试在收集阶段直接读文档失败 | 新版测试按新交互重整，不伪造旧文档来掩盖失败 |

这些是本轮识别到的问题，不代表完成了全项目缺陷审计。

## 8. 本轮验证

环境：Node `v24.18.0`，使用旧项目已有依赖；没有安装或升级它的依赖。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run verify` | 失败：两份 UI 文档不存在；后续串行校验未执行 |
| `npm run test:unit -- --reporter=dot` | 整体失败：34 个测试文件通过、2 个文件跳过、2 个文件收集失败；已执行用例 588 通过、8 跳过。两个失败文件均因缺失 `docs/ui-design-sidebar-chat.md`，不是用例断言失败 |
| Electron 实际窗口、真实模型、构建与打包 | 本轮未执行 |

失败文件为 `test/renderer/sidebar-css.test.ts` 和 `test/renderer/character-library-css.test.ts`。用例执行时另出现人设测试的 React 重复 key 警告；本轮没有进一步定位该警告，也不将其算作测试失败。

新工作区只增加调研文档，不修复旧版业务问题，不迁入源码。检查结束后旧仓库 Git 状态仍只有开始时的两项文档删除。全局 frontend-design 已从用户指定目录完整复制，SKILL.md 与 LICENSE.txt 的 SHA-256 均与来源一致。
