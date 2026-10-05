# Cottage 技术方案（MVP）

> 版本：v1.0（MVP）
> 上游基线：`docs/product-design.md` v1.0（尤其第 6 节"技术约束"）、`docs/ui-design-sidebar-chat.md` v1.0、`docs/ui-design-conversation.md` v1.0
> 本文回答一个问题：**这套东西用什么写、怎么分层、哪一层负责什么、用什么证明它没写坏。**
> 一句话结论：**Electron + TypeScript 单语言全栈；业务逻辑集中到零 Electron 依赖的 `src/core`；DB 与网络只在主进程；界面用 React 从零实现，`demo/index.html` 只作布局与交互参考、不参与构建。**

---

## 1. 已定决策与不变量

### 1.1 决策表

| 编号 | 决策 | 依据 | 可变性 |
|---|---|---|---|
| D1 | 桌面外壳用 Electron | 产品文档第 6 节 + 本方案第 3 节 | 冻结 |
| D2 | 全栈 TypeScript，不引入第二语言 | 单一语言是本方案最大的成本优势 | 冻结 |
| D3 | 业务纯逻辑放 `src/core`，零 Electron / 零 Node 内置依赖 | 让"组装是纯函数"成为结构约束，见第 4 节 | 冻结 |
| D4 | 数据层用 `better-sqlite3` + 自管顺序迁移 | 同步 API 让多步写入天然成事务；迁移可控 | 冻结 |
| D5 | api_key 只以 safeStorage 密文落库（字段 `api_key_enc`），明文不出主进程 | 产品文档 3.1 | 冻结 |
| D6 | 界面用 React 从零实现 | 用户已确认；见第 9 节 | 冻结 |
| D7 | `demo/index.html` 只作布局与交互参考，不参与构建 | 用户已确认；见 9.2 | 冻结 |
| D8 | Provider 适配层手写，不使用官方 SDK | 见 7.1 | 冻结 |
| D9 | 文档校验脚本与自动化测试同仓、同一次提交 | 仓库 `AGENTS.md` | 冻结 |

### 1.2 不变量（违反即为架构错误，需在评审中拦下）

| 编号 | 不变量 | 如何被强制 |
|---|---|---|
| I1 | 依赖方向单向：`renderer → preload → shared`，`main → core/shared`；`core` 不依赖任何上层 | 第 4 节分层 + 第 15 节验收项 1/2 |
| I2 | api_key 明文与密文都不进入 renderer | IPC 契约层只回 `hasKey` 布尔量，见第 6 节 |
| I3 | Prompt 组装是纯函数：同输入同输出，无时间/网络/DB 读取 | `src/core/prompt` 只接受显式入参（含"当前时间"也由调用方传入） |
| I4 | 迁移从第一天存在且幂等 | 第 5.2 节 + 第 15 节验收项 5 |
| I5 | 摘要写入与消息归档标记在同一事务内 | 第 5.1 节 |

---

## 2. 技术栈总表

| 层 | 选择 | 版本策略 | 关键理由 |
|---|---|---|---|
| 桌面外壳 | Electron | **精确锁定**（写死版本号，不用 `^`） | `safeStorage` 原生语义、单一 Chromium 渲染引擎 |
| 语言 | TypeScript（`strict: true`） | 跟随最新稳定 | 类型 + 运行时校验双保险 |
| 构建（开发） | `electron-vite` | 跟随次版本 | main / preload / renderer 三份构建一次配好，renderer 有 HMR |
| 构建（打包） | `electron-builder` | 跟随次版本 | 三平台安装包 + `install-app-deps` 自动重编原生模块 |
| 数据库 | `better-sqlite3` | 跟随次版本 | 同步 API、进程内、无 IPC 开销 |
| 迁移 | 自写顺序迁移器（`user_version` + 编号脚本） | 自有代码 | 不引 ORM 代管迁移，见 14 节 |
| 查询 | 手写 DAO + `zod` 校验 JSON 列 | 自有代码 | JSON 列必须有 schema，见 5.3 |
| 校验 | `zod` | 跟随次版本 | 同时用于 IPC 入参、角色卡导入、`app_settings` |
| IPC | `contextBridge` + typed preload + zod 双向校验 | 自有代码 | 通道白名单 + 类型端到端 |
| 网络 | 主进程原生 `fetch`（undici） | 随 Electron | 不用 SDK，见 7.1 |
| SSE 解析 | `eventsource-parser`（或等价的小型手写解析） | 跟随次版本 | 处理跨 chunk 截断的 `event:`/`data:` 帧 |
| Token 计数 | `gpt-tokenizer` + 自写加权估算 | 跟随次版本 | 见第 8 节 |
| 界面框架 | React + TypeScript | 跟随最新稳定 | 生态覆盖虚拟滚动、浮层、无障碍原语 |
| 界面状态 | Zustand（按 UI 文档的 5 个 store 切片） | 跟随次版本 | 状态量小，无需 Redux 那套 |
| 虚拟滚动 | `@tanstack/react-virtual` | 跟随次版本 | 会话列表定高、消息流变高都能覆盖 |
| 浮层定位 | `@floating-ui/react` | 跟随次版本 | 菜单翻转/边界吸附，见 9.4 |
| 样式 | `src/renderer/styles/tokens.css` 声明 CSS 自定义属性 + 手写组件样式表 | 自有代码 | token 单一来源，见 9.7 与本节下方的勘误 |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-sanitize` | 跟随次版本 | 模型输出必须消毒 |
| 测试 | `vitest` + `@testing-library/react` + `playwright` | 跟随次版本 | 三层分工见第 11 节 |
| 包管理 | pnpm | 跟随最新稳定 | 原生模块 + workspace 友好 |

**依赖预算原则**：任何新增依赖必须在提交说明里写清"它替我们省了什么、它坏了我们怎么办"。尤其是渲染层组件库——引入第二套样式体系会立刻让设计 token 变成双轨（见 14 节）。

---

## 3. 桌面外壳：为什么是 Electron

### 3.1 备选方案裁决

| 方案 | 体积/内存 | 对本产品的成本 | 结论 |
|---|---|---|---|
| **Electron（采用）** | 安装包约 90–150MB；常驻约 150–250MB | 最低：产品文档第 6 节的所有约束都是它的原生能力 | **采用** |
| Tauri v2 | 约 8–15MB；常驻约 60–120MB | 主进程逻辑（DB、SSE、prompt 组装、token 计数）要么用 Rust 重写、要么挂 Node 边车，等于放弃单语言；`safeStorage` 无等价物，产品文档 3.1 整节（含 Linux `basic_text` 降级警告）需重新设计；macOS 用 WKWebView、Linux 用 WebKitGTK，与 Windows 的 WebView2 存在渲染差异，而两份 UI 文档的验收清单里大量是像素级、焦点态、对比度条目 | 否决 |
| 纯 Web + 本地服务 | 无安装包 | "本地优先、可离线、Key 存本机"变成"跑个服务"，与产品定位冲突；文件系统与密钥保护都失去落点 | 否决 |

**裁决理由收敛成一句**：这个产品的技术难点不在"外壳有多轻"，而在"上下文怎么花、密钥怎么守、交互状态有多密"。Electron 把这三件事的成本压到最低，代价是体积和内存——对本地优先的桌面聊天应用，这是可接受的交换。

### 3.2 顺带被固定的 Electron 原生语义

以下能力**直接决定实现形态**，因此不可替换外壳：

| 能力 | 用途 | 约束 |
|---|---|---|
| `safeStorage.encryptStringAsync` / `decryptStringAsync` | api_key 落库前加密 | 只用异步 API，且必须在 `app` ready 之后调用（产品文档 3.1） |
| 解密返回 `shouldReEncrypt` | 系统密钥轮换后自动回写 | 主进程内处理，UI 无感 |
| `safeStorage.getSelectedStorageBackend()` | 检测 Linux 无可用密钥环 | 返回 `basic_text` 时 UI 必须显示"Key 实际未受保护" |
| `app.getPath('userData')` | 数据库与自定义头像的落点 | `cottage.db` 与 `avatars/` 都在其下，DB 内存相对路径 |
| `utilityProcess` | 把 token 计数等重计算移出主进程事件循环 | 仅在实测有卡顿时启用（第 8 节） |

**另加两条主进程纪律**（不来自产品文档，但属于工程必需）：

1. `app.requestSingleInstanceLock()` + 单窗口：SQLite 单写者假设下，避免两个实例同时写库。
2. 主进程不得吞异常：未捕获异常必须落日志（脱敏）并让 UI 可见，否则"数据库写入失败要回滚并报错"（产品文档 3.7）无从兑现。

---

## 4. 进程模型与代码分层

### 4.1 分层与依赖方向

```
                       ┌─────────────────────────────────────────┐
                       │  src/core   纯 TypeScript · 零平台依赖   │
                       │  变量替换 · PromptSpec 组装 · token 计数 │
                       │  provider 序列化 · 摘要模板              │
                       └─────────────────────────────────────────┘
                            ▲                            ▲
                  只读引用   │                  只读引用   │
        ┌───────────────────┴──────┐        ┌────────────┴──────────────┐
        │  src/main                │        │  src/renderer             │
        │  窗口 · DAO · 迁移 ·      │        │  React 界面 · 交互状态     │
        │  密钥 · fetch+SSE · IPC   │        │  （无 Node 能力）          │
        └──────────────────────────┘        └───────────────────────────┘
                 ▲        │                              ▲
                 │        └── IPC 事件（stream:chunk）───┘
                 │ invoke（zod 校验入参/出参）
        ┌────────┴──────────────────────────────────────────────────┐
        │  src/shared   IPC 通道常量 · zod schema · 共享类型 · 错误码 │
        └───────────────────────────────────────────────────────────┘
                 ▲
                 │  唯一跨边界通道（contextBridge 白名单）
        ┌────────┴───────────┐
        │  src/preload       │
        └────────────────────┘
```

### 4.2 各层职责与允许的 import

| 层 | 职责 | 允许依赖 | 禁止 |
|---|---|---|---|
| `src/core` | 纯计算：变量替换、PromptSpec 组装、token 计数、IR→请求体序列化、摘要模板与解析 | `zod`、`gpt-tokenizer` | `electron`、`node:fs`、`node:net`、任何 IO、任何时间读取（时间由入参传入） |
| `src/shared` | IPC 通道常量、请求/响应 zod schema、跨进程共享类型、错误码枚举 | `zod`、`core` 的类型 | `electron`、IO |
| `src/main` | 窗口生命周期、DAO/迁移、safeStorage、fetch + SSE、IPC handler、数据落库 | `electron`、`node:*`、`core`、`shared` | `renderer` |
| `src/preload` | 用 `contextBridge` 暴露白名单方法，转发 IPC | `electron` | 业务逻辑、IO、状态缓存 |
| `src/renderer` | 界面、交互状态、渲染 | React、`shared` 的类型、`core` 的只读计算（仅用于预览） | `electron`、`node:*`、`main`、任何网络请求 |

### 4.3 为什么 `core` 这一刀是整份方案的关键

产品文档 3.3 要求"组装是纯函数：相同输入必须得到相同输出，这样 Prompt 预览才能可信"。把组装放进 `core` 并禁止它触碰 IO 与时间，这条承诺就从"团队自觉"变成**编译期与测试期都无法绕过的结构**：想在组装里读一次系统时间，就必须改 `core` 的公开签名，评审一眼可见。副产品是产品文档第 7 节的验收项 1–11 全部可以在纯 Node 下测试，不需要起 Electron（第 11 节）。

---

## 5. 数据层

### 5.1 `better-sqlite3` 与连接策略

| 项 | 决定 | 理由 |
|---|---|---|
| 位置 | `app.getPath('userData')/cottage.db` | 与产品文档"数据都在本机"一致；头像在 `avatars/` |
| 打开时机 | 主进程 ready 后、注册 IPC 之前 | 早于 IPC 注册可避免"窗口已经能发消息但库还没开" |
| `journal_mode` | `WAL` | 读写不互相阻塞，流式期间高频落库不卡 UI |
| `foreign_keys` | `ON` | 删除会话要级联带走 messages / summaries |
| `synchronous` | `NORMAL` | WAL 下的常规选择，崩溃不损坏库 |
| 事务 | 一律走一个 `withTransaction(fn)` 包装 | 压缩写入、删除会话、截断+级联失效都必须是"全成或全不成"（产品文档 3.7 / 3.4） |
| 并发 | 单实例单连接，主进程内串行访问 | SQLite 单写者；配合单实例锁 |

**必须用事务包裹的三处**（验收项 6 会覆盖）：压缩（写 `summaries` + 标记 `archived`）、恢复（删摘要 + 取消归档）、删除会话（`conversations` + `messages` + `summaries`）。

### 5.2 迁移机制

- 实现：`PRAGMA user_version` + `src/main/db/migrations/NNN_*.ts` 顺序执行，每个迁移在**一个事务内**执行并递增 `user_version`。
- 规则：一次启动把空库推到最新；重复启动幂等（验收项 5）。
- 迁移清单（MVP）：

| 编号 | 内容 | 来源 |
|---|---|---|
| 001 | 初始 schema：`providers` / `characters` / `personas` / `conversations` / `messages` / `summaries` / `app_settings` + 第 4 节要求的索引 | 产品文档第 4 节 |
| 002 | `ALTER TABLE conversations ADD COLUMN pinned_at INTEGER` + `conversations(pinned_at DESC)` 索引 | UI 文档 9.1 |
| 003 | `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done'` + `messages(status)` 索引 | 本方案 7.6（崩溃恢复需要能定位残留的"生成中"行） |

> 001–003 的完整 DDL 需落地到产品文档第 4 节承诺的 `docs/data-model.md`（该文档尚未创建，创建时以本表为准）。

### 5.3 DAO 边界

- 每个实体一个 DAO 模块，**只导出窄接口**（`listConversations`、`insertSummary`、…），不导出原始 `Database` 实例。这样将来若要换 `node:sqlite` 等实现，改动面被限制在 DAO 内部。
- **DAO 与迁移不得 `import electron`**：数据库路径由调用方以参数传入。这是让第 11 节的"纯 Node 单测"成立的前提。
- JSON 列（`params_json` / `metadata_json` / `models_json` / `tags_json` / `app_settings.value`）读写都必须过 zod schema，禁止裸字符串读取（产品文档第 4 节约束）。
- 字段命名与产品文档一致（snake_case 落库，camelCase 出 DAO），转换在 DAO 内一次性完成，避免 UI 层出现两种命名。
- `pinned_at` 写入**不得触碰 `updated_at`**：这一条要作为 DAO 的显式测试用例（UI 文档 9.1 与验收项 22）。

### 5.4 原生模块的 ABI 风险与对冲

`better-sqlite3` 是原生模块，Electron 每次大版本升级都可能因 Node ABI 变化需要重编译。这是这类项目最典型的"昨天还好好的"来源。

| 对冲手段 | 具体做法 |
|---|---|
| 锁版本 | `electron` 写精确版本号；只在专门的升级提交里动它 |
| 自动重编 | `postinstall` 跑 `electron-builder install-app-deps`，一步到位重建到 Electron ABI |
| 依赖位置 | `better-sqlite3` 放 `dependencies`，不放 `devDependencies`，否则打包时不会被收进去 |
| 打包 | `asarUnpack` 必须包含 `**/*.node`（或 `node_modules/better-sqlite3/**`），否则安装后启动即报"找不到模块" |
| 隔离 | DAO 不依赖 Electron，使绝大多数测试在本地 Node 下运行，不依赖重编译成功 |

> **勘误（v1.0 修订）：升级 Electron 大版本会立刻撞上"没有预编译产物"这堵墙**
>
> 实测 `better-sqlite3@11.10.0` 发布到 GitHub Releases 的预编译产物只到 **`electron-v132`**
> （= Electron 34，本仓当前 ABI），**没有 `v133`**（= Electron 35）。而本机没有
> Visual Studio C++ 工具链，于是「把 electron 升到 35.x，再跑 `pnpm rebuild:native`」
> 这条路是走不通的：`install-app-deps` 找不到匹配 ABI 的预编译包，会退回 node-gyp
> 源码编译并失败——也就是上表"自动重编"那一行的前提并不总成立。
>
> 所以升 Electron 大版本必须**同时**满足下面任一条，否则应用启动即报
> `NODE_MODULE_VERSION` 不匹配：
>
> 1. 把 `better-sqlite3` 升到有对应 Electron ABI 预编译产物的版本；或
> 2. 在构建机上安装 Visual Studio「使用 C++ 的桌面开发」工作负载。
>
> 这也说明 `electron` 写精确版本号不是洁癖，而是硬依赖。

---

## 6. IPC 契约与密钥边界

### 6.1 一次"发消息"的完整时序

```
 renderer                  preload               main                        远端 API
    │                         │                    │                             │
    │ invoke('messages:send') │                    │                             │
    │ {conversationId, text}  ├───────────────────►│                             │
    │                         │  zod 校验入参       │                             │
    │                         │                    │ 1. 读会话 / 角色 / persona    │
    │                         │                    │ 2. core：组装 PromptSpec      │
    │                         │                    │ 3. core：计数 + 超限判断       │
    │                         │                    │ 4. 必要时先压缩（事务）        │
    │                         │                    │ 5. safeStorage 解密 Key       │
    │                         │                    │ 6. 适配器 → 请求体             │
    │                         │                    ├──────── fetch(SSE) ─────────►│
    │ ◄─ event 'stream:chunk' ◄────────────────────┤ ◄────── data: {...} ────────┤
    │   （主进程节流合批推送）  │                    │ 7. 节流落库（防崩溃丢内容）    │
    │ ◄─ event 'stream:end'   ◄────────────────────┤                             │
    │ invoke('messages:abort')────────────────────►│ AbortController.abort()     │
```

### 6.2 通道清单（示意，实现以 `src/shared/ipc.ts` 为准）

| 方向 | 通道 | 说明 |
|---|---|---|
| invoke | `providers:*` | 增删改查、`providers:test`（三态结果 + HTTP 状态 + 原始错误摘要） |
| invoke | `characters:*` | 导入（v2/v3）、导出、列表、搜索、编辑、头像写入 |
| invoke | `personas:*` | 增删改查、设为默认 |
| invoke | `conversations:*` | 列表、创建、重命名、置顶/取消置顶、删除 |
| invoke | `messages:*` | 列表、发送、编辑、删除、重新生成、中断 |
| invoke | `summaries:*` | 列表、手动压缩、恢复区间 |
| invoke | `settings:*` | 全局默认 Provider/模型、压缩默认、UI 布尔量 |
| invoke | `export:*` | 导出会话（Markdown / JSON）、导出明文配置包（需二次确认） |
| invoke | `tokens:preview` | 只读的 token 明细预览（不落库、不联网） |
| event | `stream:chunk` / `stream:end` / `stream:error` | 主进程 → renderer 流式事件 |
| event | `conversations:changed` / `messages:changed` | 增量通知，列表不做整表重取（UI 文档 5.6） |

> **勘误（v1.0 修订）：可选入参的空值约定必须在两侧显式对齐**
>
> preload 转发可选参数时写的是 `invoke(INVOKE.x, arg ?? null)`——也就是说"没传"到主进程
> 时是 **`null`** 而不是 `undefined`。但 zod 的 `.optional()` 只接受 `undefined`，
> 于是 `characters.list()` 被判成入参校验失败，**角色库永远显示"还没有角色卡"**；
> 更隐蔽的是 `characters` store 一直为空，所以聊天里消息的角色名只能退化成"角色"二字。
> 而同一个页面的标签筛选是好的（`characters:tags` 不经过那个 schema），看起来很像渲染 bug。
>
> 结论与约定：
>
> 1. 可选参数要么在 preload 里省略（不传 `undefined`），要么在主进程 schema 里用
>    `.nullish()`——**两者必须选一个并对齐**；
> 2. `characters:list` 采用后者：`{}`、`undefined`、`null` 都表示"不筛选"；
> 3. 由 `test/ipc-registration.test.ts` 的「IPC 可选入参的空值约定」守住：
>    它逐一断言 preload 里每个 `?? null` 都在主进程有对应 handler，
>    并断言 schema 既接受三种空写法、又仍然拒绝真正非法的查询。

### 6.3 硬性安全约束

| 项 | 取值 | 理由 |
|---|---|---|
| `contextIsolation` | `true` | 渲染进程不可触达 preload 作用域 |
| `nodeIntegration` | `false` | 渲染进程无 Node 能力 |
| `sandbox` | `true` | 渲染进程按不可信内容对待（模型输出是外部输入） |
| preload 暴露面 | 逐个方法显式暴露，不暴露 `ipcRenderer` 本身 | 通道白名单，未知通道由主进程拒绝 |
| 入参校验 | 每个 handler 用 `shared` 的 zod schema 校验 | 渲染进程被 XSS 时也不能构造越权调用 |
| CSP | `default-src 'self'`；`img-src 'self' data:`；禁止 `unsafe-eval` | 阻断模型输出里的外链图片与脚本 |
| 外链 | `setWindowOpenHandler` 一律 `deny`；正文里的链接交给 `shell.openExternal`，仅允许 http/https | 防止在应用窗口内打开任意页面 |
| 导航 | 拦截 `will-navigate`，只允许应用自身 | 同上 |
| 错误结构 | 统一 `{ code, message, retryable, httpStatus? }`，message 经脱敏 | UI 要分三态展示（产品文档 3.1 / 3.7） |

### 6.4 密钥边界规则

1. renderer 侧只拿到 `hasKey: boolean` 与 `providerId`，**不返回掩码片段**（少一个泄露面，UI 也无此需求）。
2. api_key 明文只存在于主进程内存中的一次调用栈内；用完即释放引用，不缓存到长期变量。
3. 日志、错误信息、异常堆栈、导出文件默认范围**均不含 Key**；日志脱敏在写日志的函数里统一做，而不是靠调用方自觉（验收项 3）。
4. 连接测试失败时只回传 HTTP 状态与上游错误摘要，且摘要需过一遍 Key 脱敏（上游有时会把 Key 回显在错误里）。
5. 导出明文配置包必须走二次确认 + 强提示，并在 UI 说明"safeStorage 密文绑定本机凭据，直接拷库到另一台机器无法解密"（产品文档 3.1）。

---

## 7. Provider 适配与流式生成

### 7.1 为什么不用官方 SDK

| 理由 | 展开 |
|---|---|
| 必须精确控制 wire 格式 | 产品文档 3.3 要求"统一组装 + 分派序列化"，Anthropic 不得出现 system 角色、`post_history` 要合并进顶层 `system`。SDK 会接管请求体组装，与"我们能对最终请求体做断言"冲突 |
| base_url 是用户任意填的兼容端点 | BYOK 场景下大量第三方兼容端点与官方 SDK 的假设不符，裸 `fetch` 兼容性反而更好 |
| 重试/遥测/日志策略要自己说了算 | SDK 的默认重试与错误上报与"不自动重试（429 除外）"以及"Key 永不进日志"两条约束冲突 |
| 依赖体积与审计面 | 少一个大依赖，就少一处可能把 Key 打进日志的地方 |

代价是 SSE 解析、重试、超时要自己写——这三块加起来约三五百行，可控，且正是本产品的核心逻辑所在。

### 7.2 适配器接口

```ts
// 概念形态（实际以 src/core/providers 为准）
interface ProviderAdapter {
  buildRequest(spec: PromptSpec, cfg: ProviderConfig): RequestInit & { url: string };
  parseStream(chunk: string, state: StreamState): StreamEvent[];   // 增量、可跨 chunk 调用
  parseError(res: Response, body: string): NormalizedError;
  countTokens(spec: PromptSpec): TokenCount;                        // 精确或估算
}
```

`PromptSpec` 是 provider 无关的 IR；适配器**只做序列化与解析**，不做组装、不做摘要、不碰 DB。

### 7.3 两个适配器的关键差异

| 差异点 | OpenAI 兼容 | Anthropic |
|---|---|---|
| system | `messages[0].role = 'system'` | 顶层 `system` 参数，`messages` 内禁止 system 角色 |
| `post_history_instructions` | 作为一条 system 或 user 注入 | 合并进顶层 `system`，或转成最后一条 user 的后缀 |
| 消息交替 | 不强制 | 要求 user / assistant 交替，连续同角色必须合并 |
| 流式协议 | `data: {...}` + `data: [DONE]` | `event:` + `data:` 成对，含 `message_start` / `content_block_delta` / `message_delta` / `message_stop` / `error` |
| 用量 | 末帧或需 `stream_options` 才带 usage | `message_start` 与 `message_delta` 分别带输入/输出用量 |
| 超长 | 报错 | 报错 |

适配器的测试方式是**对 IR → 请求体做快照断言**（验收项 7），而不是发真实请求。

### 7.4 流式解析的工程细节

- 按 `\n\n` 切帧并保留未完成尾巴（跨 chunk 截断是常态，必须缓冲）。
- 忽略心跳/注释行，容忍上游多发空行。
- 远端在流中途返回错误事件时，要能转成 `NormalizedError`，而不是当成正常结束。
- 已产出内容之后**不再重试**（重试会导致内容重复或回退）。
- 结束时机判定：收到 `[DONE]` / `message_stop` / `response.body` 关闭，三者取先到者。

### 7.5 中断、超时与重试状态机

```
  发起请求
     │
     ▼
 ┌───────────┐   用户停止 / 窗口关闭 / 超时        ┌─────────────┐
 │ streaming ├───────────────────────────────────►│ interrupted │  保留已收到的部分内容
 └─────┬─────┘                                    └─────────────┘
       │ 正常结束
       ▼
 ┌───────────┐
 │   done    │  写入用量元数据（tokens / 时长 / TTFT）
 └───────────┘

  失败分支（只有"尚未产出任何内容"才允许自动重试）
     │
     ├── 429 ─────────► 指数退避重试（最多 2 次）──► 仍失败 ──┐
     │                                                        │
     ├── 401 / 403 / 不可达 / 上下文超长 ─────────────────────┤
     │                                                        ▼
     │                                                  ┌───────────┐
     └─────────────────────────────────────────────────►│   error   │ 提示 + 手动重试按钮
                                                        └───────────┘
```

- 超时用 `AbortSignal.timeout(ms)` 与用户中断信号合并（`AbortSignal.any`），保证两条路径都收敛到同一个中断处理。
- 429 退避重试 2 次（产品文档 3.7），每次重试前检查"是否已产出内容"。
- 中断后保留已收到内容并写 `metadata.interrupted = true`（验收项 10）。

### 7.6 流式落库与崩溃恢复

产品文档要求"应用在流式中被关闭时，该消息标记为中断并保留已收到的部分"（验收项 11），因此：

1. 发起请求前先插入一条助手消息行，`status = 'streaming'`。
2. 收到 chunk 时**节流落库**（约每 500ms 或每累计 N 字符一次），避免每帧一次写盘。
3. 正常结束 → `status = 'done'` + 写入用量元数据；中断 → `status = 'interrupted'`。
4. 启动时执行一次清扫：把所有残留 `streaming` 行改为 `interrupted`，并补一份 `metadata.interrupted = true`。
5. 这条清扫必须在注册 IPC 之前完成，否则窗口可能先读到"生成中"的旧状态。

### 7.7 IPC 推送节流

模型每秒可产出几十个 chunk，逐帧 `webContents.send` 会把 IPC 变成瓶颈。做法：主进程侧按约 16–32ms 合并增量后批量推送；renderer 侧只做追加与重排。验收项 9 用"推送次数显著小于 chunk 数"来断言这条节流确实生效。

---

## 8. Token 计数策略

| Provider | 方式 | 精度标注 | 备注 |
|---|---|---|---|
| OpenAI 系（`cl100k_base` / `o200k_base`） | `gpt-tokenizer`，按模型选编码 | 精确 | 只用纯 JS 编码入口，避免打进全套编码表 |
| Anthropic / Gemini / DeepSeek 等 | 字符数加权估算（英文约 3.5–4.0 字符/token，CJK 另计） | 估算 | 必须按 provider 可覆盖 |

- 返回结构固定为 `{ tokens, exact: boolean, method: string }`，UI 侧禁止把 `exact: false` 渲染成精确值（产品文档 3.3；UI 文档验收项 9）。
- 计数对象是**组装结果的分段**（system / few-shot / 摘要 / 历史 / 本次输入），逐段累加必须等于合计（验收项 8）。
- 触发时机：组装后计一次、输入变化时对"本次输入"增量计一次。renderer 不得自行计数作为权威值；`tokens:preview` 只是主进程算完后的只读投影。
- 性能路径：先按主进程内同步计数实现（万级 token 在毫秒量级）；若实测输入卡顿，再按 3.2 节把计数移到 `utilityProcess`，接口形状不变（`core` 的纯函数可原样搬过去）。

---

## 9. 渲染层

### 9.1 选择与理由

| 需求（来自 UI 文档） | 选择 | 理由 |
|---|---|---|
| 上千条会话的虚拟滚动、固定 36px 行高 | `@tanstack/react-virtual` | 定高与动态高度两种模式都支持，无样式侵入 |
| 消息流变高内容（无气泡的全宽文本 + 气泡混排） | 同上，动态测量模式 | 消息高度不可预知，必须动态测量 |
| 菜单右/下溢出自动翻转、不被侧栏裁切 | `@floating-ui/react` | 边界检测与翻转是它的核心能力 |
| 菜单语义（`role="menu"`、`Shift+F10`、焦点回收、180ms 宽限期、锚点切换） | **自研薄封装**（floating-ui 只负责定位） | 现有组件库的开关与关闭时序与 UI 文档的时序要求冲突，越用越拧 |
| 对话框（删除确认）、下拉、Tooltip | Radix 原语（仅这几个） | 无障碍与焦点陷阱是已解决问题，不必自研 |
| 状态 | Zustand 切片 | UI 文档已给出 5 个 store 的划分 |

**明确不引入**：Ant Design / MUI / Chakra 等成品组件库——它们自带一套颜色与间距体系，会与设计 token 形成双轨（见 14 节）。

### 9.2 与 `demo/` 的边界

`demo/index.html` 是**已验证过的交互样本**，它的价值是"照着点一遍就知道对不对"，不是"改改就能用"。

| demo 提供什么 | 实现侧怎么用 |
|---|---|
| 布局比例（260 / flex / 320）、间距与圆角的具体数值 | 作为 Tailwind token 的取值来源 |
| 悬停、菜单时序、压缩状态机、占用条阈值的可视化效果 | 作为人工对照：实现完一个组件就照 demo 点一遍 |
| 那份 `verify-demo.mjs` 里的关键交互断言清单 | 作为组件测试用例来源（把正则断言升级为行为断言） |

| 明确不做 | 原因 |
|---|---|
| 不 import / 复制 demo 的脚本或样式 | demo 是命令式 DOM 操作，与 React 状态模型不同构，搬过来会变成两套真相 |
| 不把 demo 编进产物 | 构建配置不引用 `demo/`（验收项 15/16） |
| 不为了"和 demo 一样"而在 React 里模拟 DOM diff | 行为一致即可，实现方式无关 |

### 9.3 状态归属

沿用 UI 文档给出的划分，落在 Zustand：

| store | 内容 |
|---|---|
| `useChatStore` | 当前会话、消息列表、流式状态、`AbortController` |
| `useComposerStore` | 草稿、模型 chip、参数 chip、persona chip |
| `usePanelStore` | 右栏开关、当前标签（落 `app_settings`，宽度不落库——只有两态） |
| `useCompressStore` | 压缩状态机：`idle / running / error` + 进度 + 上次结果 |
| `useMenuStore` | 唯一的菜单实例：锚点、目标、菜单项（左栏与消息共用） |

**规则**：会话与消息的权威数据在主进程 DB，renderer 的 store 是投影；所有写操作先走 IPC 成功后再更新本地投影，或者由 `*:changed` 事件驱动刷新——两条路径选一条并保持一贯，避免出现"UI 已改、库没改"的假成功。

### 9.4 浮层与菜单（最容易被低估的部分）

UI 文档对菜单提了明确时序（180ms 宽限期、锚点切换不闪断、`Esc` 焦点回到触发按钮、`⋯` 不进 Tab 序列、触屏长按等效）。这些要求指向一个结论：**菜单的开关状态必须由 Shell 层的单一 store 持有，而不是每个行组件各自持有 `open`**。实现上：

- 定位交给 floating-ui；开关时序、宽限期定时器、锚点切换、焦点回收自己写。
- 左栏会话菜单与消息菜单是**同一个组件**（UI 文档验收项 12），只是菜单项不同。
- Portal 挂在 `body`，不受侧栏 `overflow` 裁切。

### 9.5 消息流渲染

- Markdown 走 `react-markdown` + `remark-gfm` + `rehype-sanitize`；消毒是必须项，不是可选项（模型输出可能含脚本或外链图片，配合 6.3 的 CSP 双保险）。
- 流式渲染：对已稳定的段落做 memo，只重渲染最后一段，避免每个 chunk 触发整篇 Markdown 重解析。
- 代码高亮、数学公式属于二期（体积与复杂度都不值），MVP 只保证代码块可读。

### 9.6 样式与 token 单一来源

- 设计 token（UI 文档第 8 节与 11 节）落在一个 `src/renderer/styles/tokens.css`，
  以 CSS 自定义属性声明深浅两套（`html[data-theme="dark"]` 覆盖同名变量）。
- 组件样式表（`base / layout / sidebar / chat / panel / pages / overlays.css`）**只允许引用变量**，
  禁止出现硬编码颜色；动效 120 / 180 / 200 / 160ms 也来自 token（`--motion-*`）。
- 归档消息的"仅靠降透明度区分"也走 token（UI 文档验收项 26），不写成一次性样式。

> **勘误（v1.0 修订）：本方案原定用 Tailwind v4 的 `@theme` 映射 token，实现时改为
> 手写 CSS 自定义属性 + 手写组件样式表。** 理由与代价都写在这里，便于将来重新评估：
>
> - 原目标只有一条：**token 单一来源**。而 Tailwind v4 的 `@theme` 本身就是
>   "把 CSS 自定义属性声明一遍再映射"——对本案的设计 token 集合来说，
>   它是在同一件事上多加一层构建期转换，没有增加新的表达能力。
> - 本案 UI 是"三栏固定宽度 + 少量阈值状态（75% / 80%）+ 两个主题"，没有响应式栅格、
>   没有设计系统规模的工具类复用需求；tokens.css 直接声明变量已经满足单一来源。
> - 代价（必须承认）：失去了原子类的书写便利，组件样式表比 Tailwind 写法更长。
>   如果后续 UI 规模明显变大、出现大量重复的间距/颜色组合，重新引入 Tailwind
>   并让 `@theme` 指向同一份 token 变量即可，**token 文件不需要改**。
> - 这条例外只针对 Tailwind。`@tanstack/react-virtual`、`@floating-ui/react`、`Zustand`
>   三项按原方案执行（它们在 9.1 / 9.4 里各自解决了具体问题，不是样式体系重复）。

---

## 10. 构建、打包与发布

| 项 | 决定 | 理由 |
|---|---|---|
| 开发构建 | `electron-vite`（main / preload / renderer 三段） | 三段配置一次配好，renderer HMR |
| 主进程模块格式 | **CJS**，由产物目录内的 `{"type":"commonjs"}` 标识保证（不是靠扩展名） | 见下方勘误：文件名受 electron-vite 约束，CJS 这条要求改用目录级标识落实 |
| 打包 | `electron-builder`：Windows NSIS、macOS DMG、Linux AppImage | 三平台一套配置 |
| 原生模块 | 安装后 `electron-builder install-app-deps`；`asarUnpack` 含 `**/*.node` | 见 5.4 |
| 版本锁定 | `electron` 精确版本；提交 `pnpm-lock.yaml` | 防"本地能跑、装的包跑不起来" |
| 平台优先级 | Windows 为主开发与验收平台；macOS / Linux 保证可构建可启动 | 与团队主要使用场景一致；Linux 需额外验证 `safeStorage` 降级路径 |
| 签名与公证 | MVP 外，但目录结构预留（`build/` 下放图标与配置） | 不阻塞 MVP；一旦要分发就得补 |
| 自动更新 | MVP 不做 | 与"本地优先、不上传"的立场一致，也少一个网络入口 |

---

## 11. 测试策略

> **勘误（v1.0 修订）：主进程产物的文件名与格式控制**
>
> 本节原写"主进程输出 CJS（`.cjs` 或独立 `package.json` 控制）"。实现时发现
> electron-vite 有两条硬约定，两者叠加后与"用 `.cjs` 扩展名"冲突：
>
> 1. 它用 `build.rollupOptions.input` 的**键名**决定产物文件名，
>    `output.entryFileNames` 对入口 chunk 不生效；
> 2. 启动 Electron 前会调 `ensureElectronEntryFile()` 校验 `package.json` 的 `main`
>    字段所指文件**确实存在**，否则直接抛 `No electron app entry file found` 退出。
>
> 于是"产物叫 `out/main/index.cjs`、`main` 指向 `out/main/index.js`"这组配置会让
> **`pnpm build` 全绿而 `pnpm dev` 直接起不来**——属于最难发现的一类问题。
>
> 最终方案：产物就用 `out/main/index.js` 与 `out/preload/index.js`（顺带满足
> electron-vite 与文档的文件名约定），CJS 这条要求改由**产物目录内的
> `{"type":"commonjs"}`** 落实（构建时由 `emitCommonJsMarker` 插件写入）。
> 这样"仓库根是 `type: module`、而这两个目录里的 `.js` 是 CJS"就成立了，
> 且不依赖扩展名。
>
> 相应地，验证里增加了 `pnpm smoke:dev`：**`pnpm build` 通过不代表 `pnpm dev` 能用**，
> 这两条路径必须各自验证（见第 11 节的表格）。

### 11.1 三层分工

```
        ┌──────────────────────────────────────────────┐
        │  冒烟（脚本，不打框架）                          │
        │  smoke:dev  dev server + renderer 入口 + HMR   │
        │  smoke       Electron 拉起主进程启动链路         │
        ├──────────────────────────────────────────────┤
        │  E2E：Playwright Electron（少量，慢而可信）    │
        │  强杀重启 · 流式中断 · 真实布局与自适应         │
        ├──────────────────────────────────────────────┤
        │  组件测试：Vitest + RTL + jsdom（中量）        │
        │  菜单语义 · 键盘导航 · 确认框 · 占用阈值文案     │
        ├──────────────────────────────────────────────┤
        │  单元测试：Vitest（大量，纯 Node，毫秒级）      │
        │  core 纯函数 · 适配器序列化 · DAO/迁移/事务     │
        └──────────────────────────────────────────────┘
```

> 冒烟与 E2E 的分工：冒烟脚本只回答"**它能不能起来**"，不模拟用户操作；
> 需要真实排版与进程生死的断言（悬停位移、菜单翻转、强杀重启）仍归 E2E。

> **勘误（v1.0 修订）：冒烟的就绪判据必须是"启动链跑完"，且它在受限目录下需要关沙箱**
>
> 两条都是实现期踩到的，且都是"显示为绿、实际什么都没验证"的类型：
>
> 1. **判据过早**。`smoke` 原本拿主进程的「数据库已打开」当真，而那条日志在**迁移之前**。
>    于是"开库 → 迁移 → IPC 注册抛错"会被判为通过——实际发生过一次（`INVOKE` 里多了一个
>    没有 handler 的通道），应用根本起不来，冒烟却是绿的。现在主进程在**建窗口之后**补打一条
>    「启动完成」，冒烟只认它。这条约定横跨两个文件，因此由
>    `test/smoke-electron.test.mjs` 把它钉住（含"不许再拿过早的日志当判据"的反向断言）。
> 2. **Chromium 进程沙箱在受限目录下无法初始化**。同一个 `electron.exe`，放在受限工作区内会以
>    `0x80000003`（Windows 断点异常）**立即退出且没有任何输出**，复制到工作区外则完全正常——
>    **与 Electron 版本无关**，所以别据此升级 Electron。更麻烦的是每次崩溃 Windows 错误报告
>    都会弹一个对话框。因此 `smoke` 默认加 `--no-sandbox`（它要验的是主进程启动链，不是
>    Chromium 沙箱）；要验带沙箱的真实配置用 `COTTAGE_SMOKE_SANDBOXED=1`。
>    若 userData 落在建不了 Chromium 单实例锁的目录，主进程会按"已有实例在运行"正常退出
>    （表象是秒退、退出码 0、不建库、无输出），冒烟会**明确报告"未能完成校验"**而不是打印
>    "通过"，并自动换一个 userData 目录重试一次；CI 上要求严格可设 `COTTAGE_SMOKE_STRICT=1`。

### 11.2 各层覆盖什么

| 层 | 运行环境 | 覆盖 | 对应验收 |
|---|---|---|---|
| 单元 | 纯 Node（不需要 Electron、不需要重编原生模块） | PromptSpec 幂等、变量替换、token 求和与精确/估算标记、OpenAI/Anthropic 请求体快照、摘要模板解析、角色卡 v2/v3 round-trip 保留 `raw_json`、迁移幂等、压缩事务原子性、截断级联失效、`pinned_at` 不改 `updated_at`、**IPC 通道声明与 handler 注册的完整性（静态比对，见下方勘误）** | 产品文档 7 的 1–8、11 |
| 组件 | jsdom | 行内重命名（提交/Esc/空值）、删除确认（默认焦点在取消、展示消息数与摘要段数）、搜索过滤态、`⋯` 菜单键盘与焦点回收、占用条 75%/80% 阈值、估算"约"前缀、无头像断言 | 两份 UI 文档的绝大多数条目 |
| E2E | Playwright 拉起 Electron | 流式停止保留部分内容、强杀后重启状态一致且无残留"生成中"、虚拟滚动、窗口宽度自适应与右栏抽屉、真实布局类断言（悬停无位移、菜单翻转不被裁切） | 产品文档 7 的 9/10、UI 文档的布局类条目 |
| 文档 | 纯 Node | 设计文档与技术方案的结构完整性（本仓 `scripts/verify-*.mjs`） | 仓库 `AGENTS.md` |

**必须诚实标注的边界**：jsdom 没有排版引擎，"悬停前后 `getBoundingClientRect()` 不变""菜单在视口边缘自动翻转"这类断言**只能在 E2E 里做**。把它们写在组件测试里只会得到永远为真的假通过。

### 11.3 测试纪律

1. 单测**永不发真实网络请求**：适配器用固定输入断言请求体，流式解析用录制好的 SSE 字节序列。
2. 仓库里不得出现真实密钥；`scripts/verify-*.mjs` 里保留密钥形态的正则检查。
3. 时间相关断言（TTFT、总时长）用假时钟，不用 `sleep`。
4. `core` 的任何一次改动都必须能让单元测试在**不启动 Electron** 的情况下跑完；跑不起来说明 I1 被破坏了。
5. 每项功能改动与它的测试在同一次提交里（仓库 `AGENTS.md`）。

---

## 12. 目录结构

```
src/
  core/                    纯逻辑，零平台依赖
    prompt/                变量替换 · PromptSpec 组装 · 分段
    tokens/                精确计数与估算
    providers/             适配器与序列化
    summary/               摘要模板与解析
  shared/                  IPC 通道 · zod schema · 类型 · 错误码
  main/
    index.ts               应用生命周期 · 单实例锁 · 崩溃清扫
    window.ts              窗口与安全策略（CSP / 导航 / 外链）
    ipc/                   每个域一个 handler 模块
    db/                    connection · migrations/ · dao/
    secrets/               safeStorage 封装与脱敏
    providers/             fetch + SSE 运行时（重试/超时/中断）
  preload/index.ts         contextBridge 白名单
  renderer/
    app/                   壳层与路由（对话 / 角色库 / 人设 / 设置）
    features/chat|sidebar|panel|characters|personas|settings
    components/            通用组件（菜单 / 对话框 / 虚拟列表）
    stores/                5 个 Zustand 切片
    styles/tokens.css      设计 token 单一来源
scripts/                   verify-design-doc.mjs · verify-demo.mjs · verify-tech-stack.mjs
test/                      单元与组件测试
docs/                      产品 / UI / 技术方案
demo/index.html            交互参考样本，不参与构建
```

---

## 13. 风险清单与对冲

| 风险 | 影响 | 对冲 |
|---|---|---|
| `better-sqlite3` ABI 与 Electron 升级冲突 | 启动即失败 | 精确锁 Electron 版本；`install-app-deps`；DAO 不依赖 Electron 使测试不阻塞 |
| `safeStorage` 在 Linux 退化为 `basic_text` | Key 实际未加密而用户以为安全 | 检测 `getSelectedStorageBackend()` 并在设置页显著警告（产品文档 3.1） |
| 流式 chunk 灌满 IPC | UI 卡顿、掉帧 | 主进程节流合批推送（7.7），并以测试断言推送次数 |
| 流式中崩溃丢内容 | 违反产品承诺 | 500ms 节流落库 + 启动清扫（7.6） |
| 长对话下 Markdown 重渲染成为瓶颈 | 输入卡顿 | 段落级 memo，只重渲染最后一段（9.5） |
| 虚拟滚动与变高消息相互干扰 | 滚动跳动、位置错乱 | 消息流用动态测量模式；摘要分割条与消息共用一个测量器 |
| 引入第二套样式体系 | 设计 token 失效、颜色失控 | 禁止成品 UI 组件库（9.1 / 14 节）；只引无样式原语 |
| Tailwind v4 与 floating-ui 迭代较快 | 依赖升级引入行为变化 | 两者版本锁定，升级走独立提交并跑 E2E |
| `utilityProcess` / 原生模块在 CI 上不便运行 | E2E 覆盖面缩水 | CI 分两档：单元+组件必跑；E2E 在主平台（Windows）跑 |

---

## 14. 明确不做（技术层面）

- **不采用 Tauri 或任何需要第二语言的外壳**（理由见 3.1）。
- 不引入 ORM 代管迁移（Prisma / TypeORM）：迁移的幂等与顺序是本产品的显式验收项，必须自己掌握。
- 不引入 Redux Toolkit / React Query：没有服务端缓存语义，数据流是"IPC 调用 + 变更事件"，上一套通用缓存层只会增加间接层。
- 不做 i18n 框架：中文优先，但所有文案集中在一处，保留将来提取的可能。
- 不引入 CSS-in-JS 运行时（styled-components / emotion）：与 Tailwind token 体系重复。
- 不引入成品 UI 组件库（Ant Design / MUI / Chakra）：会造成设计 token 双轨。
- 不做崩溃上报与遥测：任何自动外发都与"本地优先、不上传"的立场冲突。
- 不做自动更新：MVP 不引入这条网络通道。
- 不引入富文本编辑器或代码编辑器（Monaco）：角色卡编辑用纯文本域即可。
- 不做消息级代码高亮与数学公式渲染：二期。
- 不做多窗口 / 分屏 / 后台常驻任务：MVP 单窗口单实例。
- 不把 `demo/` 的任何代码编进产物：它只是参考。

---

## 15. 验收清单（技术选型的落地检查）

1. `src/core` 全目录不含 `electron` 与 `node:` 前缀 import；在纯 Node 下能跑完它的全部单元测试。
2. 依赖方向单向：`renderer` 不 import `main`，`main` 不 import `renderer`；`core` 不 import 任何上层；越界由 lint 规则拦截。
3. 用假 Key 跑完整链路后，日志文件、错误信息、默认导出内容中三处均检索不到该 Key 明文。
4. 每个 IPC handler 的入参都过了一遍 zod；未登记的通道名调用会被拒绝而不是静默通过。
5. 迁移：空库一次启动推到最新版本；连续启动三次后 `user_version` 与表结构不变（幂等）。
6. 压缩在某一步失败时，`summaries` 无新行且 `archived` 标记未变（同一事务内回滚）。
7. 同一 `PromptSpec` 分别序列化为 OpenAI 与 Anthropic 请求体，两者格式合法且 Anthropic 的 `messages` 中不含 `system` 角色。
8. Token 明细各项之和等于合计；估算来源的项带 `exact: false`，UI 渲染时带"约"前缀。
9. 流式过程中主进程推送给 renderer 的事件次数显著小于收到的 chunk 数（节流生效）。
10. 流式中点击停止：已收到内容被保留并落库，`status` 为中断且 UI 显示"已中断"。
11. 流式中强杀应用后重启：无任何残留的"生成中"状态，部分内容仍在且标记为中断。
12. 429 场景下最多自动重试 2 次且间隔递增；已产出内容的请求不再重试。
13. 打包产物中 `better-sqlite3` 原生模块位于 `asarUnpack` 范围，安装后首次启动能正常建库。
14. `electron` 在 `package.json` 中为精确版本号（不含 `^` / `~`），锁文件已提交。
15. 构建配置不引用 `demo/`；产物中不含 `demo/index.html`。
16. `renderer` 源码中不出现对 `demo/` 的任何引用（import、路径字符串、资源拷贝）；界面为 React 从零实现，`demo/` 只被人工对照使用。
17. 三层测试齐备并可运行：`core`/DAO 单元测试、组件测试、Playwright Electron 端到端测试。
