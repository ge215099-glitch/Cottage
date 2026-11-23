# Cottage Next

本地优先的 AI 角色聊天桌面应用。新版沿用旧项目的角色卡、模型协议和数据能力，按 `FrontendDemo` 的简约风格重建界面。

## Windows 安装

Windows x64 安装包为 `Cottage-Next-Setup-0.2.0.exe`。在本仓库执行 `pnpm package:win` 可重新生成，产物位于 `dist/`。安装包未做代码签名，Windows 可能显示未知发布者提示。

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

- 左栏只保留新对话、角色库、会话列表与设置；不提供对话搜索。
- 聊天默认显示右侧详情栏，直接切换角色、对话、记忆和导出；同一个右上角按钮固定位置，侧栏平滑收放。模型在顶栏选择。
- 新会话在一个窗口选择角色、模型连接与人设。
- 支持浅色、深色与跟随系统；输入法确认不误发送，发送失败保留草稿。
- 角色库默认打开「我的卡片」。「Chub 搜索」跟随系统代理，默认按热度浏览公开角色卡，支持关键词、翻页、预览和导入。
- 模型连接、人设和用量集中在设置中；原有角色卡导入导出、流式生成、停止、重生成、摘要与恢复能力保留。
- 在角色库打开英文角色卡，点击「转换语言」，选择中文版或中英双语版。可以锁定人名、地名等专有名词，预览后保存为新卡。双语开场白和对话示例逐句对照。双语聊天回复按段对照，每组先英文、紧接中文，组间空一行。已经是中文的卡会直接提示。
- 设置在居中独立面板中打开，左侧切换分类；关闭后回到原页面并保留聊天草稿。

## 数据与边界

新版默认数据目录为 `%APPDATA%\CottageNext`，旧版 `%APPDATA%\Cottage` 不参与开发和测试。命令行 `--user-data-dir=<绝对路径>` 可指定隔离目录。

旧项目 `D:\Work\AI\DeepSeek_Harness\Cottage` 只作参考；`FrontendDemo` 保持原样。没有自动迁移旧会话或密钥。真正迁移前应关闭应用并备份数据库、WAL/SHM 和 avatars；系统加密密钥不能假定跨机器可用。

当前版本有 493 项自动测试通过、8 项跳过。Windows x64 安装包已验证安装、首次启动建库和卸载。角色卡转换已在隔离的 Electron 窗口使用本地测试模型响应验证。真实模型连通、现存数据迁移和 200 轮长对话尚未验收。上下文预算目前采用 20,000 token 兜底，不表示供应商真实模型上限。

## 开发文档

1. [实现记录与验证](docs/implementation-status.md)
2. [架构与维护地图](docs/architecture.md)
3. [前端方向](docs/frontend-direction.md)
4. [实施计划](docs/implementation-plan.md)
5. [旧项目调研（历史快照）](docs/project-audit.md)
6. [协作约定](AGENTS.md)
