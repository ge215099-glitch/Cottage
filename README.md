# Cottage Next

本地优先的 AI 角色聊天桌面应用。新版沿用旧项目的角色卡、模型协议和数据能力，按 `FrontendDemo` 的简约风格重建界面。

## 启动

本机依赖已经安装。在此目录双击 **`启动 Cottage.cmd`** 即可打开开发版，启动日志在 `logs/dev.log`；启动失败会显示说明。

也可以在终端运行：

```powershell
pnpm dev
```

首次使用：进入「角色库」导入 JSON/PNG 角色卡，在「设置 → 模型连接」添加自己的服务地址、密钥和模型，再点击「新对话」。本应用不会预置真实密钥，也不会生成模拟聊天回复。

重新安装依赖与检查：

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm smoke:dev
pnpm smoke
```

验证环境：Windows、Node 24.18.0、pnpm 11.21.0。`pnpm start` 预览已有构建，代码修改后先运行 `pnpm build`。

## 界面

- 左栏只保留新对话、搜索、角色库、会话列表与设置。
- 默认没有右侧栏。模型在顶栏选择；对话设置、角色资料、记忆整理和导出按需打开。
- 新会话在一个窗口选择角色、模型连接与人设。
- 支持浅色、深色与跟随系统；输入法确认不误发送，发送失败保留草稿。
- 模型连接、人设和用量集中在设置中；原有角色卡导入导出、流式生成、停止、重生成、摘要与恢复能力保留。

## 数据与边界

新版默认数据目录为 `%APPDATA%\CottageNext`，旧版 `%APPDATA%\Cottage` 不参与开发和测试。命令行 `--user-data-dir=<绝对路径>` 可指定隔离目录。

旧项目 `D:\Work\AI\DeepSeek_Harness\Cottage` 只作参考；`FrontendDemo` 保持原样。没有自动迁移旧会话或密钥。真正迁移前应关闭应用并备份数据库、WAL/SHM 和 avatars；系统加密密钥不能假定跨机器可用。

当前交付为可运行的源码开发版，465 项自动测试通过、8 项跳过；类型检查、构建和两种启动冒烟通过。真实模型连通、现存数据迁移、安装包和 200 轮长对话尚未验收。上下文预算目前采用 20,000 token 兜底，不表示供应商真实模型上限。

## 开发文档

1. [实现记录与验证](docs/implementation-status.md)
2. [架构与维护地图](docs/architecture.md)
3. [前端方向](docs/frontend-direction.md)
4. [实施计划](docs/implementation-plan.md)
5. [旧项目调研（历史快照）](docs/project-audit.md)
6. [协作约定](AGENTS.md)
