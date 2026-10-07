# Cottage MVP 需求整理(精简版)

> 这是一个AI聊天软件



## 一、BYOK / Provider

- Provider 增删改查:名称、类型(OpenAI 兼容 / Anthropic)、base_url、api_key、模型列表、默认模型
- api_key 用 Electron `safeStorage` 加密存储
- 连接测试(可达性 + 真实请求验证)
- **全局默认配置(设置页)**:
  - 聊天默认 Provider / Key
  - 压缩默认 Provider / Key
- 每个会话可覆盖默认聊天 Key
- 压缩时也可临时从已配置的 Key 里选

---

## 二、角色卡(v2 / v3)

- 导入 / 导出 JSON,兼容 v2 / v3,保留 `raw_json` 无损还原
- 编辑字段:名称、描述、性格、场景、开场白、备用开场白、示例对话、tags 等
- 角色库:列表、搜索、标签、收藏
- **自定义头像**:文件存 `userData/avatars/`,DB 存路径,导入导出走 `extensions.cottage.avatar`
- 用户 persona(名称 + 头像),供 `{{user}}` 使用

---

## 三、Prompt 组装

- 顺序:system(角色卡 system_prompt 或拼接字段) → few-shot(mes_example 解析)→ 历史(含摘要区)→ post_history_instructions → 用户新消息
- 变量替换:`{{char}}` `{{user}}` `{{time}}` 等
- Token 计数(用 `gpt-tokenizer` 近似,UI 标注"约")
- 超限处理:**保最近 N 轮,老历史自动压缩成摘要**
- Prompt 预览(原样展示 messages 数组)

---

## 四、上下文压缩

- **自动触发**:超过阈值(如模型上限 80%)时压缩最老历史
- **手动触发**:侧栏按钮,弹范围选择 → 预览摘要 → 确认
- 压缩用的 Key:设置里的压缩默认 Key,手动时可临时换
- 摘要独立存 `summaries` 表,记录覆盖的 message 范围、层级
- 原始消息标记 `archived`,**可查看 / 可恢复**
- UI 提示具体,如:"已将第 3–15 条压缩(1200 → 180 tokens)"
- 压缩 Prompt 要求结构化输出(人物关系、关键事件、当前场景、情绪、伏笔)
- 摘要与"当前状态"保持一致性(为未来系统角色预留)

---

## 五、对话

- 会话:创建 / 删除 / 重命名,绑定角色卡 + Provider + Key + 模型
- 多轮对话、流式输出(SSE)、停止生成、重新生成
- 编辑 / 删除消息(编辑用户消息时询问是否截断后续)
- 开场白选择(含备用开场白)
- 消息级 metadata:model、provider、prompt/completion tokens、TTFT、总时长、是否中断
- 消息气泡显示用时与消耗

---

## 六、右侧详情侧栏(可伸缩)

- 上下文占用进度条 + Token 明细(system / few-shot / 摘要 / 历史 / 输入)
- 本次对话消耗(用时、tokens、可选费用)
- 压缩按钮 + 压缩历史查看 / 恢复
- 角色卡信息预览 + 编辑入口(弹面板)
- 切换 Provider / Key / 模型
- 生成参数调节(temperature / top_p / max_tokens,会话级覆盖)
- 开场白切换器
- 导出当前会话(Markdown / JSON)
- 手动删除某几条历史

---

## 七、数据模型(要点)

```
providers(id, name, type, base_url, api_key_enc, models_json, default_model, compression_model, enabled, sort_order)
characters(id, name, raw_json, tags_json, favorite, avatar_path)
personas(id, name, avatar_path)
conversations(id, title, character_id, provider_id, model, params_json)
messages(id, conversation_id, role, content, metadata_json, archived, sort_order)
summaries(id, conversation_id, content, covers_from, covers_to, token_count, level)
app_settings(key, value)
```

---

## 八、明确不做(MVP 外)

- 角色卡 PNG 解析
- 世界书 / Lorebook
- 群聊、多角色
- 长期记忆 / 向量检索
- TTS / STT、图片生成
- 云端同步、插件、角色卡市场、账号体系
- **系统角色**(后续做,方向为**消息级注入**)

---

## 九、技术栈

- Electron,DB 与 API 调用在 main 进程,renderer 只做 UI
- `better-sqlite3`(配 `@electron/rebuild`)
- IPC 流式:main → renderer 逐 chunk 推送,`AbortController` 支持停止
- 类型共享放 `src/shared/`
- 迁移机制从第一天就有