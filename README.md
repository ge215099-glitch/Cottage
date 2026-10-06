# Cottage

本地优先（**BYOK**）的 AI 角色扮演聊天桌面应用。

三条核心主张：

1. **BYOK**——用户自带 API Key，应用不代理、不上传、不收费。
2. **本地优先**——所有会话、角色卡、Key 都存在本机，可离线查看与导出。
3. **长对话可用**——通过上下文压缩，让几百轮的对话依然能继续；压缩过程对用户透明、可回滚。

---

## 界面模块

左侧固定导航五项：**角色库 / 人设 / 用量 / API Key / 设置**（没有「对话」——
正下方就是会话列表，再放一个等于同一个动作两个入口）。

| 模块 | 管什么 |
|---|---|
| 角色库 | 角色卡的导入 / 编辑 / 收藏 / 导出（JSON 或 PNG 卡），卡片网格 + 详情弹窗 |
| 人设 | `{{user}}` 的替换来源；可建多个，会话各绑一个 |
| 用量 | 本机发出的请求数、token 走势与按模型的明细。**只报 token 与请求次数**，不报金额与余额 |
| API Key | Provider 与密钥的增删改（列表 + 弹窗）、连接测试。「最新使用日期」由消息元数据派生 |
| 设置 | 全局默认 Provider、生成与行为、诊断 |

---

## 文档

| 文档 | 管什么 |
|---|---|
| [`docs/product-design.md`](docs/product-design.md) | 产品定位、功能模块、数据模型、验收要点 |
| [`docs/ui-design-sidebar-chat.md`](docs/ui-design-sidebar-chat.md) | 应用外壳 + 左侧栏 + 对话列表的布局与交互 |
| [`docs/ui-design-conversation.md`](docs/ui-design-conversation.md) | 对话主区 + 右侧详情栏的布局与交互 |
| [`docs/tech-stack.md`](docs/tech-stack.md) | 技术选型、分层、不变量、测试策略 |

三份文档各自配有零依赖的校验脚本（见下文「验证」），把「文档必须长什么样」
固化成可执行断言——章节被误删、关键交互要点消失、不变量被改写都会让校验失败。

> 早期那份 `demo/index.html`（单文件交互样本）已经删除：它与实现分叉之后就不再是
> 参考，而是第二份规格。判定口径与替代手段记在 `docs/tech-stack.md` 9.2。

---

## 快速开始

前置：Node ≥ 20、pnpm ≥ 11。

```bash
pnpm install        # 安装依赖；postinstall 会按 Electron ABI 重建 better-sqlite3
pnpm dev            # 开发模式（renderer 有 HMR）；终端里能看到全部日志
pnpm build          # 三段构建：main / preload / renderer
pnpm start          # 预览构建产物
```

### 不想每次敲 `pnpm dev`：桌面快捷方式

```bash
pnpm shortcut       # 在桌面创建一个 Cottage 快捷方式（双击即启动）
pnpm launch         # 与 pnpm dev 等价，只是把输出写进 logs/dev.log
```

双击快捷方式启动时**不会出现控制台窗口**——那个黑框是 `pnpm dev` 的终端，不是应用的窗口：

- 它承担的是「Vite dev server（renderer 的 HMR 靠它）+ 源码监听重建 + 主进程日志」；
- 这些事**依然要做**，只是输出被写进 `logs/dev.log`（超过 2 MB 轮转到 `logs/dev.log.1`）；
- 起不来的时候，启动器退出码非 0，并写下 `logs/dev-failure.txt`（原因 + 日志尾部），
  快捷方式会把它用记事本摊开——黑框可以没有，"为什么没起来"不能没有。

想看实时日志就 `Get-Content -Wait logs/dev.log`，或者继续用 `pnpm dev`（终端模式一直保留）。
启动器自身的验证见下文 `pnpm smoke:launcher`；它由 `scripts/launch-dev.mjs`（逻辑）、
`scripts/launch-dev.vbs`（零窗口垫片）、`scripts/create-desktop-shortcut.mjs`（建 .lnk）三部分组成。

> **跑验证前先关掉正在运行的应用**：快捷方式启动的应用会一直占着 5173 端口，
> 而 `pnpm smoke:dev` 靠这个端口判定"自己的 dev server 起来了"。端口被占时它会明确
> 打印"**未能完成校验**：5173 已被占用（很可能 Cottage 正在运行）"并让人先关掉应用——
> 以前这种情况会伪装成"没有观察到主进程构建成功的标志"，把排查引到构建配置上。

另外两点与"后台运行"有关的实际影响：主进程代码改动**不会**自动热重启
（`electron-vite dev` 不带 `--watch`，热更新只覆盖 renderer），改了 main / preload 要重新
双击一次快捷方式；同一个仓库里同时跑 `pnpm dev` 与快捷方式启动的应用没有意义，
启动器会用锁文件挡住第二次启动。

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
pnpm verify         # 三份校验：设计文档 / 技术方案 / 编码与依赖边界
pnpm test           # 单元 + 组件测试（vitest），再加校验器自身的测试（node --test）
pnpm smoke:dev      # 开发模式：dev server 起来并正确提供 renderer 入口（含 HMR 客户端）
pnpm smoke          # 生产模式：真的把 Electron 拉起来，确认能开库、迁移、注册 IPC、建窗口
pnpm smoke:launcher # 快捷方式那条链路：隐藏启动、日志落盘、就绪判定、锁、失败说明
pnpm verify:all     # 上面全部串起来跑一遍
```

### 测试分工

| 层 | 环境 | 覆盖什么 |
|---|---|---|
| 单元 | 纯 Node | core 纯函数（组装幂等、变量替换、token 求和、适配器序列化、SSE 折叠、用量按本地日分桶）、PNG 角色卡的读写（合成 PNG 覆盖多文本块/坏 base64/长度写坏/截断/压缩块）、迁移幂等、压缩事务原子性、截断级联失效、`pinned_at` 不改 `updated_at`、密钥边界、CSP 与导航判定、用量取数（`json_extract` 过滤 / 坏 JSON 兜底 / 最新使用日期）、IPC 通道声明与 handler 注册的完整性（静态比对） |
| 组件 | jsdom + RTL | 侧栏悬停与菜单时序、行内重命名、列表两段分组、搜索过滤、键盘导航、占用条阈值、「约」前缀、角色库卡片网格与详情弹窗、导出格式菜单、无头像断言、API Key 列表与弹窗（密钥只渲染固定掩码）、用量页筛选与图表占位 |
| 真卡（live，默认跳过） | 纯 Node | `COTTAGE_REAL_CARD=<路径>` 才跑：真 PNG 卡的解析、「导入 → 导出 PNG → 再导入」闭环、导出的卡面图与源文件逐字节一致 |
| 真上游（live，默认跳过） | 纯 Node + 真实 API | `COTTAGE_LIVE_KEY=<key>` 才跑：思考型模型（`deepseek-flash` 这类）的思考与正文分开统计；输出上限被思考吃满时正文为空，且被判成"额度被思考吃满"的失败 |
| 冒烟（开发） | node + Vite | `pnpm dev` 三段构建、dev server 端口、renderer 入口与 HMR 客户端 |
| 冒烟（生产） | Electron | 主进程启动链路（开库 → 迁移 → 清扫 → 注册 IPC → 建窗口） |
| 冒烟（启动器） | node + 哑 Electron | 快捷方式那条链路：隐藏启动、输出落进 `logs/dev.log`、就绪判定、重复双击被挡、退出后锁与 dev server 都收干净、失败时留下 `logs/dev-failure.txt` 并退出非 0 |

**必须诚实标注的边界**：jsdom 没有排版引擎，「悬停前后 `getBoundingClientRect()`
不变」「菜单在视口边缘自动翻转」「侧栏真实宽度只有 260 / 56 两态」这类断言
**只能在 E2E 里做**。把它们写在组件测试里只会得到永远为真的假通过，
所以它们既没写、也不假装覆盖。

三个冒烟脚本各管一段，谁都不假装覆盖别的：`smoke:dev` 用哑进程替换 Electron，
只验证 Vite dev server 这条链路；`smoke` 真的拉起 Electron，验证主进程启动链，
但它不验证界面渲染；`smoke:launcher` 换掉 Electron 来验**启动器**这条链路
（同样的哑进程套路），它不验证真实 Electron 能否起来，也不验证界面。

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
> `smoke:launcher` 同理：环境若不允许创建子进程（`spawn EPERM`，esbuild / Vite
> 起不来），它报告的是"未能完成校验"，而不是把环境问题算成启动器的缺陷。
> `smoke:dev` 也如此：5173 被占用（最常见的原因就是应用正在运行）时它明确报"未能完成校验"，
> 而不是伪装成"主进程没构建成功"。

> **`pnpm dev` 与 `pnpm build` 是两条独立路径**，构建通过不代表开发能起来。
> 实测踩过一次：产物名与 `package.json` 的 `main` 不一致时，`pnpm build` 全绿，
> 而 `electron-vite dev` 会在启动前校验 `main` 所指文件存在并直接退出。
> 这也是为什么 `smoke:dev` 单独存在。

> **上游"正常收流但没有正文"一律按失败处理**，并说清原因（思考吃满额度 / 内容过滤 /
> 触发输出上限 / 空流）。这条曾经是静默的：`deepseek-flash` 这类思考型模型先思考、
> 后正文，思考 token 与正文共用「上限」，上限被思考吃满时正文为空而上游仍是 200 正常收流；
> 当时应用把它当成了成功，于是"发消息没反应"既没有报错也没有日志。
> 口径与文案在 `src/core/providers/errors.ts` 的 `emptyCompletionError()`，
> 判据与理由见 `docs/tech-stack.md` 7.8。

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
    usage/              用量按本地自然日分桶、补齐空日、按模型分组（纯函数）
    character-card.ts   角色卡 v2/v3 无损导入导出
  shared/               IPC 通道常量 · zod schema · 共享类型 · 错误码
  main/
    index.ts            生命周期 · 单实例锁 · 启动清扫 · 未捕获异常可见化
    window.ts           窗口与安全策略（CSP / 导航 / 外链）
    ipc/                全部 IPC handler（先登记再注册，启动断言之）
    db/                 驱动接口 · 迁移 · DAO · better-sqlite3 / node:sqlite 适配
    secrets/            safeStorage 封装
    providers/          fetch + SSE 运行时（超时 / 重试 / 中断）
    services/           组装取数 · 生成编排 · 压缩 · 连接测试 · 用量聚合 · 导出
  preload/index.ts      contextBridge 白名单（只转发，不含业务逻辑）
  renderer/
    app/                壳层编排（IPC 与事件的唯一订阅点）
    components/         侧栏 · 消息流 · 输入区 · 右栏 · 浮层 · 虚拟列表 · 角色库 / 人设 / 用量 / API Key 四个页面
    stores/             5 个 Zustand 切片 + 菜单 + toast
    styles/tokens.css   设计 token 单一来源（深浅两套）
scripts/                校验脚本 + 原生模块重建 + Electron 冒烟
  launch-dev.mjs        开发启动器（隐藏黑框，日志落进 logs/dev.log）
  launch-dev.vbs        零窗口垫片：wscript 起启动器，失败时把说明摊开
  create-desktop-shortcut.mjs  生成桌面快捷方式（pnpm shortcut）
  smoke-launcher.mjs    启动器冒烟（哑 Electron 替换真 Electron）
test/                   单元与组件测试
docs/                   产品 / UI / 技术方案
```

---

## 界面约定（几条容易被改坏的）

- **左右栏只有「拉出 / 收起」两态**，没有中间宽度，页面里不存在调宽手柄。
- **用量统计只报 token 与请求次数**，不报消费金额与账户余额：前者要维护一张会过期的
  单价表，后者是 DeepSeek 专有接口。分桶按**本地自然日**（SQLite 没有时区概念，写进 SQL 会按 UTC 切天）。
- **应用里不存在写出明文 Key 的出口**：会话导出与角色卡导出都不含密钥字段。
- **头像只出现在角色库**（卡片与它的详情弹窗）：消息、会话列表、空态、右栏一律没有，
  身份靠名字文本表达。没有卡面图的角色用**纯灰色色块**占位，不放图标
  （图标等于偷偷引入"默认头像"）。卡面图按 `cover` 填满 2:3 的卡片框，允许裁掉一点。
- **角色卡可以导出成 JSON 或 PNG 卡**：PNG 卡是"原卡面图 + 新数据"，写回时只动
  PNG 的文本块，图片像素一个字节都不改；旧的 `chara`/`ccv3` 块会被替换掉，
  否则"改完导出、再导入又变回去"。角色没有卡面图就明确报错，不造占位图。
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
- **应用里不存在任何写出明文 Key 的出口**：会话导出（Markdown / JSON）与角色卡导出
  （JSON / PNG）都不含密钥字段。代价是换机不能靠一个文件搬过去——
  `safeStorage` 的密文绑定本机用户凭据，直接拷贝 `cottage.db` 到另一台机器也解不开，
  需要在新机器上重新填一次 Key。

---

## 数据位置

- 数据库：`app.getPath('userData')/cottage.db`（设置页「诊断」里有完整路径）
- 迁移：`user_version` + 编号脚本，启动时自动执行且幂等；重复启动不会重复执行
- 崩溃恢复：启动时把所有残留的 `streaming` 消息标记为 `interrupted` 并保留已收到内容
