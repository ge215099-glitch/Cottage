# Cottage

本地优先（**BYOK**）的 AI 角色扮演聊天桌面应用。

三条核心主张：

1. **BYOK**——用户自带 API Key，应用不代理、不上传、不收费。
2. **本地优先**——所有会话、角色卡、Key 都存在本机，可离线查看与导出。
3. **长对话可用**——通过上下文压缩，让几百轮的对话依然能继续；压缩过程对用户透明、可回滚。

---

## 文档

| 文档 | 管什么 |
|---|---|
| [`docs/product-design.md`](docs/product-design.md) | 产品定位、功能模块、数据模型、验收要点 |
| [`docs/ui-design-sidebar-chat.md`](docs/ui-design-sidebar-chat.md) | 应用外壳 + 左侧栏 + 对话列表的布局与交互 |
| [`docs/ui-design-conversation.md`](docs/ui-design-conversation.md) | 对话主区 + 右侧详情栏的布局与交互 |
| [`docs/tech-stack.md`](docs/tech-stack.md) | 技术选型、分层、不变量、测试策略 |
| [`demo/index.html`](demo/index.html) | **交互参考样本**（单文件、纯前端、模拟数据），只作人工对照，**不参与构建** |

三份文档各自配有零依赖的校验脚本（见下文「验证」），把「文档必须长什么样」
固化成可执行断言——章节被误删、关键交互要点消失、不变量被改写都会让校验失败。

---

## 快速开始

前置：Node ≥ 20、pnpm ≥ 11。

```bash
pnpm install        # 安装依赖；postinstall 会按 Electron ABI 重建 better-sqlite3
pnpm dev            # 开发模式（renderer 有 HMR）
pnpm build          # 三段构建：main / preload / renderer
pnpm start          # 预览构建产物
```

`pnpm install` 之后如果提示原生模块未就绪，执行：

```bash
pnpm rebuild:native
```

> **为什么需要这个命令**：`better-sqlite3` 的原生模块必须按 Electron 的 ABI 编译。
> 它自带的 `postinstall` 走 node-gyp，在没有 Visual Studio C++ 工具链的机器上会失败，
> 并且**失败时会删掉已有的 `.node` 文件**。因此项目在 `pnpm-workspace.yaml` 里
> 禁用了它的构建脚本，改由 `@electron/rebuild` 取官方预编译产物（不需要本地编译器）。

---

## 验证

```bash
pnpm typecheck      # tsc 严格模式，main/preload/shared/core 与 renderer 两套配置
pnpm verify         # 四份校验：设计文档 / demo / 技术方案 / 编码与依赖边界
pnpm test           # 单元 + 组件测试（vitest），再加校验器自身的测试（node --test）
pnpm smoke:dev      # 开发模式：dev server 起来并正确提供 renderer 入口（含 HMR 客户端）
pnpm smoke          # 生产模式：真的把 Electron 拉起来，确认能开库、迁移、注册 IPC、建窗口
pnpm verify:all     # 上面全部串起来跑一遍
```

### 测试分工

| 层 | 环境 | 覆盖什么 |
|---|---|---|
| 单元 | 纯 Node | core 纯函数（组装幂等、变量替换、token 求和、适配器序列化、SSE 折叠）、迁移幂等、压缩事务原子性、截断级联失效、`pinned_at` 不改 `updated_at`、密钥边界、CSP 与导航判定、IPC 通道声明与 handler 注册的完整性（静态比对） |
| 组件 | jsdom + RTL | 侧栏悬停与菜单时序、行内重命名、列表两段分组、搜索过滤、键盘导航、占用条阈值、「约」前缀、无头像断言 |
| 冒烟（开发） | node + Vite | `pnpm dev` 三段构建、dev server 端口、renderer 入口与 HMR 客户端 |
| 冒烟（生产） | Electron | 主进程启动链路（开库 → 迁移 → 清扫 → 注册 IPC → 建窗口） |

**必须诚实标注的边界**：jsdom 没有排版引擎，「悬停前后 `getBoundingClientRect()`
不变」「菜单在视口边缘自动翻转」「侧栏真实宽度只有 260 / 56 两态」这类断言
**只能在 E2E 里做**。把它们写在组件测试里只会得到永远为真的假通过，
所以它们既没写、也不假装覆盖。

两个冒烟脚本各管一半，谁都不假装覆盖另一半：`smoke:dev` 用哑进程替换 Electron，
只验证 Vite dev server 这条链路；`smoke` 真的拉起 Electron，验证主进程启动链，
但它不验证界面渲染。

`smoke` 的就绪判据是主进程在**建窗口之后**打印的「启动完成」，而不是更早的
「数据库已打开」——后者发生在迁移之前，拿它当判据会让"迁移之后就抛错"的启动失败
显示为通过（实测踩过一次：一个 `INVOKE` 通道漏了 handler，应用根本起不来，冒烟却是绿的）。

> **受限环境下的两点说明。** Chromium 的进程沙箱在受限目录里无法初始化，进程会以
> `0x80000003` 立即退出且没有任何输出；同一个二进制放到别处就完全正常，所以**这与
> Electron 版本无关**，别据此升级 Electron。`smoke` 默认加 `--no-sandbox`（它要验的是
> 主进程启动链，不是 Chromium 沙箱），要验带沙箱的真实配置用
> `COTTAGE_SMOKE_SANDBOXED=1 pnpm smoke`。
> 若环境受限导致无法校验，`smoke` 会明确打印"**未能完成校验**"并说明原因，绝不打印
> "通过"；CI 上要求严格可设 `COTTAGE_SMOKE_STRICT=1`，此时环境受限按失败处理。

> **`pnpm dev` 与 `pnpm build` 是两条独立路径**，构建通过不代表开发能起来。
> 实测踩过一次：产物名与 `package.json` 的 `main` 不一致时，`pnpm build` 全绿，
> 而 `electron-vite dev` 会在启动前校验 `main` 所指文件存在并直接退出。
> 这也是为什么 `smoke:dev` 单独存在。

### 为什么 DAO 测试不需要原生模块

`src/main/db` 只依赖一个窄接口 `DatabaseDriver`，生产注入 `better-sqlite3`，
测试注入基于 Node 内建 `node:sqlite` 的实现。两者都是**真实 SQLite**，
所以测的是真行为，而不是自己糊的 SQL 解释器；同时 DAO 测试不再被
「原生模块有没有重编译成功」阻塞（`docs/tech-stack.md` 5.4 的对冲目标）。

---

## 目录结构

```
src/
  core/                 纯 TypeScript，零平台依赖（不变量 I1/I3 的结构保证）
    prompt/             变量替换 · PromptSpec 组装 · 分段
    tokens/             精确计数（gpt-tokenizer）与字符加权估算
    providers/          适配器（IR → 请求体）· SSE 增量解析 · 错误规范化
    summary/            六段结构化摘要模板与容错解析
    character-card.ts   角色卡 v2/v3 无损导入导出
  shared/               IPC 通道常量 · zod schema · 共享类型 · 错误码
  main/
    index.ts            生命周期 · 单实例锁 · 启动清扫 · 未捕获异常可见化
    window.ts           窗口与安全策略（CSP / 导航 / 外链）
    ipc/                全部 IPC handler（先登记再注册，启动断言之）
    db/                 驱动接口 · 迁移 · DAO · better-sqlite3 / node:sqlite 适配
    secrets/            safeStorage 封装
    providers/          fetch + SSE 运行时（超时 / 重试 / 中断）
    services/           组装取数 · 生成编排 · 压缩 · 连接测试 · 导出
  preload/index.ts      contextBridge 白名单（只转发，不含业务逻辑）
  renderer/
    app/                壳层编排（IPC 与事件的唯一订阅点）
    components/         侧栏 · 消息流 · 输入区 · 右栏 · 浮层 · 虚拟列表
    stores/             5 个 Zustand 切片 + 菜单 + toast
    styles/tokens.css   设计 token 单一来源（深浅两套）
scripts/                校验脚本 + 原生模块重建 + Electron 冒烟
test/                   单元与组件测试
docs/                   产品 / UI / 技术方案
demo/index.html         交互参考样本，不参与构建
```

---

## 界面约定（几条容易被改坏的）

- **左右栏只有「拉出 / 收起」两态**，没有中间宽度，页面里不存在调宽手柄。
- **界面不使用任何头像**：消息、会话列表、空态、右栏一律没有；身份靠名字文本表达。
- **会话列表只有两段**：`已置顶` 与其余全部，**不按今天/昨天分组**。
- **置顶不改 `updated_at`**：否则取消置顶后老会话会跳到列表最前面。
- **归档消息只用降低透明度区分**，不出现「已归档」标签。
- **估算的 token 必须带「约」**，不允许当精确值展示。
- 主进程日志只有一个出口（`safeLog`），脱敏在出口统一做，不靠调用方自觉。

---

## 密钥安全

- API Key 用 Electron `safeStorage` 加密后落库（字段 `api_key_enc`）；明文只存在于
  主进程内存中的一次调用栈内，**不进入 renderer**（IPC 只回 `hasKey` 布尔量）。
- Linux 上若 `getSelectedStorageBackend()` 返回 `basic_text`，说明本机没有可用密钥环、
  Key **实际未受保护**，设置页会显示显著警告。
- 导出**默认不含 Key**；只有「导出明文配置包」会带，且必须二次确认。
  该文件里也写明了：`safeStorage` 的密文绑定本机用户凭据，
  因此直接拷贝 `cottage.db` 到另一台机器无法解密，换机要用这个文件。

---

## 数据位置

- 数据库：`app.getPath('userData')/cottage.db`（设置页「诊断」里有完整路径）
- 迁移：`user_version` + 编号脚本，启动时自动执行且幂等；重复启动不会重复执行
- 崩溃恢复：启动时把所有残留的 `streaming` 消息标记为 `interrupted` 并保留已收到内容
