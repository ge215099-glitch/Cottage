# Cottage 产品设计文档

> 版本：v1.0（MVP）
> 定位：本地优先（BYOK）的 AI 角色扮演聊天桌面应用
> 替代关系：本文档是需求基线的正式版本，细化并修正了《Cottage MVP 需求整理(精简版)》

---

## 1. 产品定位

一个跑在桌面上的 AI 聊天软件，面向角色扮演场景。核心主张三条：

1. **BYOK**——用户自带 API Key，应用不代理、不上传、不收费。
2. **本地优先**——所有会话、角色卡、Key 都存在本机，可离线查看与导出。
3. **长对话可用**——通过上下文压缩，让几百轮的对话依然能继续，且压缩过程对用户透明、可回滚。

**成功判据（MVP）**：用户导入一张 v2/v3 角色卡 → 配好 Key → 连续聊满 200 轮不炸上下文 → 中途能看清 token 花在哪、能手动压缩并恢复。

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Provider** | 一个 API 端点配置：类型（OpenAI 兼容 / Anthropic）、base_url、api_key、可选模型列表 |
| **Character** | 角色卡，兼容 SillyTavern v2/v3，保留 `raw_json` 无损还原 |
| **Persona** | 用户自身的人设（名称 + 头像），供 `{{user}}` 替换 |
| **Conversation** | 一次会话，绑定 1 个角色 + 1 套默认生成配置 |
| **Message** | 会话内的一条消息，有 `sort_order`、`archived` 标记、`metadata` |
| **Summary** | 一段被压缩历史的摘要，记录它覆盖了哪个消息区间 |
| **PromptSpec** | 统一的中间表示（IR）：组装结果的抽象形态，与 Provider 无关 |

**术语约定**：下文"压缩"指把老消息转成摘要的动作，"摘要"指产物，"归档"指原消息被标记为不参与后续请求但**不删除**。

---

## 3. 功能模块梳理

### 3.1 Provider 与密钥管理

**配置项**：名称、类型、base_url、api_key、模型列表（手动填 + 从端点拉取）、默认模型、启用开关、排序。

**密钥安全**
- api_key 用 Electron `safeStorage` 加密后存库（字段 `api_key_enc`），明文只存在于 main 进程内存。
- **只用 `safeStorage` 自身的 API，且必须在 `app` ready 之后调用。**
  > 实现勘误（v1.0 修订）：本节原写"只用异步 API（`encryptStringAsync` /
  > `decryptStringAsync`）"。核实结论是 **Electron 并不存在这两个 API**：
  > `safeStorage` 只提供同步的 `encryptString` / `decryptString`，
  > 也没有 `shouldReEncrypt` 返回值（已逐一检查 electron 34/35/36/37/38/39 的
  > 类型定义）。因此实现改为：用同步原语，但**对外仍暴露 Promise**，
  > 以便将来补上异步 API 时调用方零改动；"密钥轮换后回写"改由密文的
  > **版本前缀**实现（读到无前缀的历史值即按旧格式解密并标记回写）。
- 解密失败（系统密钥环变更）必须给出可读提示并要求重新填写，**不得**把底层异常原文抛出。
- Linux 降级路径：`getSelectedStorageBackend()` 返回 `basic_text` 时说明本机无可用密钥环、Key 实际未受保护，**UI 必须显示警告**。
- Key 永不进入日志、错误信息、导出文件的默认范围。

**连接测试**：分派策略，不假设所有端点都有 `/v1/models`。

| 类型 | 测试方式 |
|---|---|
| OpenAI 兼容 | 优先 `GET /models`；失败则降级为一次 1-token 的 `chat/completions` 探针 |
| Anthropic | `POST /messages` 最小请求 |

测试结果分三态：**可达 + 鉴权通过** / **可达 + 鉴权失败** / **不可达**，并显示 HTTP 状态与原始错误摘要。

**全局默认（设置页）**
- 聊天默认 Provider / Key / 模型
- 压缩默认 Provider / Key / 模型
- 会话级可覆盖聊天 Key；手动压缩时可临时指定 Key

**导出与迁移**（原需求缺失，必须补）
- 支持导出明文配置包（用户显式二次确认 + 强提示），用于换机。
- 因为 `safeStorage` 密文绑定本机用户凭据，**直接拷库到另一台机器无法解密**，这一点要在 UI 说明。

### 3.2 角色卡与人设

**导入导出**
- 兼容 v2 / v3；`raw_json` 原样保存，导出时以 `raw_json` 为基底，只覆盖 Cottage 自己管理的字段 → 保证不丢第三方字段。
- 自定义头像：文件存 `userData/avatars/`，库内存相对路径；导出时内联到 `extensions.cottage.avatar`。

**可编辑字段**：名称、描述、性格、场景、开场白（first_mes）、备用开场白（alternate_greetings）、示例对话（mes_example）、system_prompt、post_history_instructions、tags。

**角色库**：**卡片网格**（2:3 竖版，上面图片、下面名字）+ 搜索（名称/描述/标签）+ 标签筛选 + 收藏。

- 卡片**不显示描述**：描述与性格/场景/开场白都放到「详情弹窗」里，卡片上只留图片与名字，网格才整齐；描述同时挂在该卡片的悬停提示上，信息不丢。
- **没有图片的角色卡用灰色色块占位**，不留空洞，也不放"默认头像"。
- **点卡片打开详情弹窗**，全部动作（新对话 / 编辑 / 收藏 / 导出 / 删除）都在弹窗里。原因是这些动作里含删除这种危险动作，摊在卡片上会让网格变成按钮墙，收进卡片 `⋯` 又要用户先猜哪张卡有菜单。
- 图片只在这一处出现：消息流、会话列表、空态、右栏继续**不使用头像**（详见 `ui-design-sidebar-chat.md` 的勘误与 P9）。

**会话命名**：新建会话默认用**角色名**作标题；若该标题已被占用，则依次尝试 `<名> 2`、`<名> 3`…… 重名判断是**全库**的（标题只出现在一个列表里），并且只作用于自动命名——用户手动改过的标题一律不干预。上限 80 字符，超长角色名会被截断以容纳后缀。

**Persona**（原需求的关系未落库，这里定清楚）
- Persona 是**全局资源**，可建多个。
- 每个会话绑定一个 persona；未绑定时使用全局默认 persona。
- 关系落在 `conversations.persona_id`，不放在 `personas` 表里。

### 3.3 Prompt 组装（系统核心）

组装是一个**纯函数**：输入会话状态 + 角色卡 + persona + 参数，输出 `PromptSpec`。相同输入必须得到相同输出，这样 Prompt 预览才能可信。

**组装顺序（逻辑顺序，非最终 wire 格式）**

```
1. system        角色卡 system_prompt，为空则用 描述/性格/场景 拼接
2. few-shot      mes_example 解析成成对的 user/assistant 示例
3. summaries     已归档历史对应的摘要，按覆盖区间时间升序拼接
4. history       未归档的历史消息
5. post_history  post_history_instructions（若配置）
6. user          用户新消息
```

**变量替换**：`{{char}}`、`{{user}}`、`{{time}}`、`{{date}}` 等，在**组装阶段**对全部文本统一替换。

**Provider 适配层**（原需求的关键缺口）
`PromptSpec` 是 provider 无关的 IR，各适配器负责序列化：

| 目标 | 差异点 |
|---|---|
| OpenAI 兼容 | system 作为 `messages[0]` 的 system 角色；`post_history` 作为一条 system 或 user 注入 |
| Anthropic | system 是**顶层 `system` 参数**，`messages` 里禁止 system 角色；`post_history` 需合并进顶层 system 或转成 user 后缀；且要求 user/assistant 交替 |

→ 因此"统一组装 + 分派序列化"是架构约束，不能直接把 IR 当请求体发出去。

**Token 计数与精度**（原需求缺口）

| Provider | 方式 | UI 标注 |
|---|---|---|
| OpenAI | `gpt-tokenizer`，按模型选 `cl100k_base` / `o200k_base` | 精确 |
| Anthropic / Gemini / DeepSeek 等 | 字符数估算（英文约 3.8 / 4.0 / 3.5 字符每 token），CJK 另行加权 | 约 |

估算值必须把"精确/估算"作为字段一并返回给 UI，**不允许把估算当精确展示**。

**超限处理**：超过模型上限时先按 3.5 节压缩最老历史；仍超限则继续压缩，直到放得下或无可压缩内容，此时明确报错而非静默截断。

### 3.4 上下文压缩

**触发方式**
- **自动**：占用超过阈值（默认模型上限 80%）时，从最老的未归档段开始压缩。
- **手动**：右侧栏按钮 → 选范围 → 预览摘要 → 确认写入。

**压缩算法（MVP 定死为单层，避免嵌套歧义）**
1. 取一段**连续的、未被归档的**最老消息区间 `[from, to]`。
2. 用压缩 Key 调模型，按结构化模板生成摘要。
3. 写入 `summaries` 一行，记录 `covers_from` / `covers_to` / `token_count` / `level=1` / `provider_id` / `model`。
4. 该区间消息标记 `archived=1`。

**明确不做的**：摘要不可再被压缩（即不产生 `level=2`）。`level` 字段保留仅为将来演进。这样装配时摘要区永远是**一组互不重叠、按时间升序的 level-1 摘要**，语义无歧义。

**摘要 Prompt 的结构化输出**：人物关系 / 关键事件 / 当前场景 / 情绪与态度 / 未回收伏笔 / 事实状态（时间、地点、持有物）。

**一致性**：摘要必须记录生成它的 provider 与 model，换模型后摘要风格可能断裂，此信息用于排查与将来重算。

**可见性与可逆**
- 归档消息**可查看**（折叠区）与**可恢复**（恢复后摘要需一并失效，见下）。
- 恢复语义：恢复某区间 → 删除覆盖它的摘要 → 该摘要的 token 占用释放。
- 压缩失败或中断 → 不写摘要、不改归档标记，保持原子性。

**UI 反馈必须具体**：如 `已将第 3–15 条压缩(1200 → 180 tokens)`。

### 3.5 对话与消息

**会话生命周期**：创建（选角色卡、开场白）→ 重命名 / 删除 → 绑定 Provider / Key / 模型 / persona → 生成参数覆盖。

**消息流**
- 流式输出：main 进程 SSE 解析 → IPC 逐 chunk 推送 renderer → `AbortController` 停止。
- 停止生成：保留已生成的部分内容，`metadata.interrupted=true`，UI 显示"已中断"。
- 重新生成：默认**就地替换**该助手消息（MVP 不做多候选分支）；`parent_id` 字段不引入。
- 编辑消息：编辑用户消息时询问"是否截断后续"。选择截断则连带处理压缩冲突。

**改消息与压缩的冲突规则**（原需求缺口）
> 若被截断 / 编辑的区间落在某个摘要覆盖范围内，则该摘要**级联失效并被删除**，受影响消息取消归档回到历史中。避免出现"摘要里写着已经删掉的剧情"。

**消息 metadata**：model、provider、prompt/completion tokens、TTFT、总时长、是否中断。气泡上展示用时与消耗。

**崩溃恢复**：应用在流式中被关闭时，该消息标记为中断并保留已收到的部分。

### 3.6 右侧详情侧栏

可伸缩。承担"让用户看清上下文怎么花的"这一职责：

1. 上下文占用进度条 + Token 明细（system / few-shot / 摘要 / 历史 / 输入），并标注精确或估算
2. 本次对话消耗：用时、tokens、可选费用
3. 压缩按钮 + 压缩历史查看 / 恢复
4. 角色卡信息预览 + 编辑入口（弹面板）
5. 切换 Provider / Key / 模型
6. 生成参数调节（temperature / top_p / max_tokens，会话级覆盖）
7. 开场白切换器
8. 导出当前会话（Markdown / JSON）
9. 手动删除某几条历史

### 3.7 失败与错误处理（原需求缺口）

| 场景 | 行为 |
|---|---|
| 网络不可达 | 明确提示 + 重试按钮，不自动重试 |
| 401 / 403 | 提示 Key 无效或权限不足，附跳转到设置 |
| 429 限流 | 指数退避自动重试 2 次，仍失败则提示并保留已生成内容 |
| 请求超时 | 可配置超时，超时后按中断处理 |
| 上下文超长 | 自动压缩；压缩后仍超长则明确报错 |
| 流式中断 | 保留部分内容并标记 `interrupted` |
| 数据库写入失败 | 事务回滚，UI 报错，不留半截状态 |

---

## 4. 数据模型（要点）

> 完整 DDL 见后续 `docs/data-model.md`。此处只固定实体与关键字段。

```
providers(id, name, type, base_url, api_key_enc, models_json, default_model,
          compression_model, enabled, sort_order, created_at, updated_at)

characters(id, name, description, personality, scenario, first_mes,
           alternate_greetings_json, mes_example, system_prompt,
           post_history_instructions, tags_json, favorite, avatar_path,
           raw_json, created_at, updated_at)

personas(id, name, avatar_path, is_default, created_at, updated_at)

conversations(id, title, character_id, persona_id, provider_id, model,
              params_json, created_at, updated_at)

messages(id, conversation_id, role, content, metadata_json,
         archived, sort_order, created_at, updated_at)

summaries(id, conversation_id, content, covers_from, covers_to,
          token_count, level, provider_id, model, created_at)

app_settings(key, value, updated_at)
```

**约束（相对原需求新增）**
- 所有表带 `created_at` / `updated_at`。
- `conversations.persona_id` 承载 persona 关系。
- `summaries` 记录生成它的 provider 与 model。
- 索引至少覆盖：`messages(conversation_id, sort_order)`、`messages(conversation_id, archived)`、`summaries(conversation_id, covers_from)`、`conversations(updated_at DESC)`。
- `app_settings.value` 的类型由代码侧 schema 校验，不做裸字符串读取。
- 迁移机制从第一天存在：`user_version` + 顺序迁移脚本，启动时自动执行。

---

## 5. MVP 边界

**不做**：角色卡 PNG 解析、世界书 / Lorebook、群聊与多角色、长期记忆 / 向量检索、TTS / STT、图片生成、云端同步、插件、角色卡市场、账号体系、多候选分支重新生成。

**系统角色**：MVP 外。方向为**消息级注入**（不占 system 位），因此装配时预留注入点即可，不在本期实现。

---

## 6. 技术约束

- Electron；DB 与 API 调用仅在 main 进程，renderer 只做 UI。
- `better-sqlite3` + `@electron/rebuild`。
- IPC 流式：main → renderer 逐 chunk 推送，`AbortController` 停止。
- 共享类型放 `src/shared/`；`PromptSpec` IR 与 provider 适配器分离。
- 迁移机制从第一天就有。

---

## 7. 验收要点

按 `AGENTS.md`，每项改动需配套测试。以下为 MVP 的关键验收路径，实现时逐条转为自动化测试用例：

1. 一张 v3 角色卡导入后导出，除 Cottage 管理的字段外，其他字段与 `raw_json` 完全一致。
2. `api_key` 落库为密文；日志与错误信息中不出现明文。
3. 同一会话状态两次组装的 `PromptSpec` 完全一致（纯函数性）。
4. 同一 IR 分别序列化为 OpenAI 与 Anthropic 请求体，格式均合法（Anthropic 无 system 角色）。
5. Token 明细各项之和等于总量；估算项被标记为估算。
6. 触发自动压缩后：摘要入库、原消息归档、占用下降，且 UI 文案含具体条数与 token 变化。
7. 恢复归档消息后，覆盖它的摘要被删除，占用回升。
8. 编辑并截断落在摘要区间内的消息后，该摘要已级联失效。
9. 流式生成中点击停止，部分内容被保留且标记为中断。
10. 应用在流式中被强杀后重启，消息状态一致，无残留"生成中"。
11. 迁移机制：从空库启动到最新版本可一次性完成，重复启动幂等。
