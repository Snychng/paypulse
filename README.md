<p align="center">
  <img src="./docs/logo-generated/paypulse-logo-gpt-image-2-4.png" alt="PayPulse 薪跳 Logo" width="160" />
</p>

# PayPulse 薪跳

PayPulse 薪跳是一款跨平台桌面「实时薪资计数器」。它把月薪、工作天数、每日工时和加班倍率换算为每秒收入，并通过托盘、菜单栏、主仪表盘和置顶小窗持续展示今天已经赚到的金额。

项目使用 Tauri v2 构建桌面端：Rust 负责计时、金额计算、SQLite 持久化和系统能力，React 负责像素风 UI 展示。核心原则是「金额真相只在 Rust 后端」，前端只订阅每秒 tick 并做动画插值，避免浏览器计时漂移带来的误差。

## 功能特性

- 实时每秒薪资计数：支持上班、摸鱼暂停、恢复、下班状态切换。
- Rust 权威计费引擎：使用整数分/毫分计算金额，降低浮点误差。
- 睡眠感知计时：合盖、休眠、唤醒后尽量避免把睡眠时间误算为工作时长。
- 托盘/菜单栏常驻：macOS 菜单栏显示实时金额，Windows 托盘提供状态提示。
- 置顶小窗：适合放在屏幕角落持续查看，当日金额会以像素风动效跳动。
- SQLite 本地数据：保存会话、每日汇总、设置和历史统计。
- 统计视图：展示今日、本周、本月和最近趋势。
- 设置中心：薪资模型、加班倍率、里程碑、主题、语言、透明度、开机自启等。
- 中英双语：界面语言可在运行时切换。

## 技术栈

- 桌面框架：Tauri v2
- 后端：Rust、Tokio、SQLite/sqlx
- 前端：React 19、TypeScript、Vite、Tailwind CSS v4、Motion
- 包管理：pnpm
- 测试：Vitest、Cargo Test
- CI/CD：GitHub Actions

## 项目结构

```text
PayPulse/
├── src/                    # React 多窗口前端
│   ├── main/               # 主仪表盘窗口
│   ├── mini/               # 置顶小窗
│   ├── popover/            # 托盘弹窗
│   ├── settings/           # 设置窗口
│   ├── hooks/              # 前端状态、tick、统计、主题等 Hooks
│   ├── shared/             # IPC 类型、格式化工具
│   └── pixel/              # 像素风设计系统与动效
├── src-tauri/              # Tauri/Rust 后端
│   ├── src/engine/         # 薪资计时和金额计算引擎
│   ├── src/persistence/    # SQLite 持久化和检查点
│   ├── src/commands.rs     # JS 调 Rust 的 IPC 命令
│   ├── src/tray.rs         # 托盘和菜单栏逻辑
│   ├── capabilities/       # Tauri 权限配置
│   └── tauri.conf.json     # 应用与打包配置
├── design/                 # 高保真 HTML 原型
├── docs/PLAN.md            # 架构与实施计划
├── .github/workflows/ci.yml
└── .github/workflows/release.yml
```

## 本地开发

### 环境要求

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Rust stable，项目当前要求 `rust-version = "1.82"`
- macOS 或 Windows 桌面环境

首次安装依赖：

```bash
pnpm install
```

启动 Tauri 开发环境：

```bash
pnpm tauri dev
```

仅启动前端预览：

```bash
pnpm dev
```

## 常用命令

```bash
# TypeScript 类型检查
pnpm typecheck

# 前端生产构建
pnpm build

# 前端测试
pnpm test

# Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml

# 本机打包当前平台
pnpm tauri build
```

## 发版与自动打包

项目已配置 GitHub Actions 发版流程：[.github/workflows/release.yml](.github/workflows/release.yml)。

当推送形如 `v0.1.0`、`v1.2.3`、`v1.2.3-beta.1` 的 Git 标签时，GitHub Actions 会自动：

1. 校验标签版本与 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 中的版本一致。
2. 在 `macos-latest` Runner 上构建 macOS Universal 应用，覆盖 Apple Silicon 和 Intel Mac。
3. 在 `windows-latest` Runner 上构建 Windows 安装包。
4. 创建 GitHub Draft Release，并上传 `.dmg`、`.app`、`.msi`、`.exe` 等构建产物。
5. 同时把产物上传为本次工作流的 Artifacts，便于在 Actions 页面直接下载。

推荐发版步骤：

```bash
# 1. 确认三个版本号一致
# package.json
# src-tauri/tauri.conf.json
# src-tauri/Cargo.toml

# 2. 本地跑一遍质量门禁
pnpm typecheck
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml

# 3. 创建并推送版本标签
git tag v0.1.0
git push origin v0.1.0
```

macOS 签名和公证是可选项。若需要让用户打开时不出现 Gatekeeper 警告，请在 GitHub 仓库 Secrets 中配置以下变量：

| Secret | 说明 |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 编码后的 Developer ID Application `.p12` 证书 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 证书密码 |
| `APPLE_SIGNING_IDENTITY` | 例如 `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Windows 代码签名暂未内置证书配置。没有签名时仍会产出安装包，但 Windows SmartScreen 可能提示未知发布者。

## 版本号约定

发版标签统一使用：

```text
v主版本.次版本.修订版本
```

示例：

```text
v0.1.0
v1.0.0
v1.2.3-beta.1
```

如果标签版本和项目配置中的版本不一致，Release 工作流会直接失败。这样可以避免安装包内部版本号和 GitHub Release 版本号对不上。

## 数据与隐私

PayPulse 的收入、设置和历史统计默认只保存在本机应用配置目录中的 SQLite 数据库里，不依赖云服务。发版构建流程不会上传用户运行时数据。

## 更多文档

- 架构与实施计划：[docs/PLAN.md](docs/PLAN.md)
- Tauri 配置：[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)
- Rust 后端入口：[src-tauri/src/lib.rs](src-tauri/src/lib.rs)
