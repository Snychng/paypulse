# PayPulse 薪跳 · 实施计划（Living Plan）

> 跨平台（Windows + macOS）桌面「每秒薪资」计数器。
> **架构一句话**：Rust 独占「金钱/时间引擎」作为唯一真相源（单个 tokio 1Hz 任务 + `Arc<Mutex<EngineState>>`），React 19 是纯展示层，其 Framer-Motion 弹簧目标**每秒被重锚定到 Rust 的整数分真值**——下一拍永远覆盖上一拍，漂移不可能发生。
>
> 本文件是**活文档**，开发全程实时勾选更新。最后更新：2026-06-27 · 当前阶段：**M0–M9 全部完成** ✅（33 Rust 测试全过 · tsc/cargo 全绿 · 4 窗口 Chrome 实测 · 实机零 panic 启动 · `pnpm tauri build` 产出 .app/.dmg；仅余签名待用户证书）

---

## 0. 需求确认（已对齐）

| 维度 | 决策 |
|------|------|
| 技术栈 | **Tauri v2**（Rust 后端 + 系统 WebView） |
| 前端 | **React 19 + TypeScript + Vite + Tailwind v4 + Motion (framer-motion v12)** |
| 薪资模型 | **月薪 ÷ 月工作天数 ÷ 日工时 ÷ 3600 → 每秒费率**；加班倍率可配 |
| 核心形态 | **托盘/菜单栏常驻 ＋ 极简置顶小窗（两者都要）** |
| 工作判定 | **手动 上班 / 摸鱼(暂停) / 下班** |
| 视觉风格 | **复古像素风（8-bit/16-bit）· Arcade Treasury Meter**；每秒跳动 + 脉搏波纹 + **状态栏钱币飘入** |
| 透明度 | 置顶小窗**可调透明度**（用户需求，详见 §10 待确认决策 D5） |
| 数据 | **完整历史 + 统计**（SQLite，今日/本周/本月 + 趋势），离线 |
| 附加功能 | 里程碑通知、开机自启、加班倍率、深/浅色主题 —— **均在设置中可配** |
| 语言/货币 | **中英双语**，运行时切换 |

---

## 1. 最终架构（评审合成结果）

> 来源：3 套架构方案竞标 → 评审合成。胜出 = **Hybrid 真相+插值**（嫁接 Backend-Authoritative 的运维细节）。
> 淘汰 Frontend-Authoritative：其前提「`performance.now()` 睡眠时不走」**事实相反**——Windows 浏览器睡眠时仍计时，会为合盖时间**超额发钱**（金钱应用最严重的 bug）。

### 1.1 计算引擎（Rust，唯一真相）
- **位置**：`engine` 模块，`tokio::sync::Mutex<EngineState>` 置于 Tauri managed state，由 `.setup()` 中**单个** `tokio::time::interval(1s)` 任务驱动。
- **🔑 睡眠正确性**：活跃时长**只用 `suspend_time::SuspendUnawareInstant` 测量**，**绝不用 `std::time::Instant`**。
  - 已核实：原始 `Instant` 在 Windows 上**计入睡眠**（`QueryPerformanceCounter`），合盖会超额发钱；在 macOS 上不计。`SuspendUnawareInstant`（Win=`QueryUnbiasedInterruptTimePrecise`，mac=`CLOCK_UPTIME_RAW`）让**两个系统一致地忽略睡眠**，且饱和归零而非 panic。
  - 纵深防御：`wall_delta − mono_delta > 5s` 视为睡眠，只计 monotonic 增量。
- **墙钟**（`chrono::Local`）**只用于**时间戳与按本地日历日归账，**绝不用于计费时长**。
- **精度**：费率存 **millicents（毫分）**：`rate_millicents = monthly_salary_cents*1000 / workdays / daily_hours / 3600`；仅在展示/落库边界四舍五入到整数分。
- **加班**：`earnings = min(t,T)*rate + max(0,t−T)*rate*mult`，`T = daily_hours*3600`，整数分、跨阈值连续。
- React **持有零金钱权威**。

### 1.2 持久化（双写，全程整数分）
> **M5 落地修订**：改用 **`sqlx` 直连**（Rust 侧读写 SQLite），而非 tauri-plugin-sql 的命令式 JS 写入。理由：引擎是唯一真相源，**必须由 Rust 从 tokio 循环写耐久数据**；tauri-plugin-sql 是 JS 命令导向（迁移在首次 `Database.load` 才跑），不适合 Rust 权威写。schema 由 sqlx 幂等执行 `migrations/*.sql`（`IF NOT EXISTS`）；tauri-plugin-sql 仍注册以备前端只读。`RunEvent::Exit` 最终 flush 暂缓（15s 检查点已兜底 ≤15s 损失），列为后续。
- **SQLite**（`sqlx`，AppConfig/`paypulse.db`）= **耐久真相源**：`sessions` / `day_totals` / `settings`。
- **Store**（`tauri-plugin-store`，`counter.json`，autoSave）= **15s 活检查点**用于崩溃恢复。
- **分级 flush**（杜绝每秒写放大）：检查点每 15s + 在 暂停/停止/跨午夜/睡眠检测 时写 SQLite + `RunEvent::Exit` 最终 flush。
- **绝不持久化 `Instant`**（跨进程无意义）→ 持久化 `accumulated_active_secs:f64`，启动时重开锚点。
- **保守恢复**：崩溃后只补到最后检查点，**丢弃未 flush 的尾巴**（应用已宕、用户未必在工作），最大损失 ~15s。

### 1.3 窗口（3 个，按 label 钉死）
> 能力（capabilities）按 **label** 匹配而非 title，**改名会静默撤销授权，有时仅在 release 构建暴露**。
- `popover`：无边框托盘下拉，点击前隐藏，positioner `TrayCenter` 定位。
- `mini`：无边框、`always_on_top(true)`、`skip_taskbar(true)`（仅 Win 有效）、`resizable(false)`、`shadow(true)`、`inner_size ~220×120`、初始 `visible(false)`；拖拽区 `data-tauri-drag-region` **只包数字不包按钮**。
- `settings`：常规带边框，按需创建。
- 每个窗口拦截 `WindowEvent::CloseRequested → api.prevent_close() + hide()`，「X」永不退出常驻应用。
- macOS：`ActivationPolicy::Accessory`（仅菜单栏，无 Dock）；打开设置时临时切 `Regular`，关闭时复位。

### 1.4 托盘 · 按 OS 分策略（已解决 Windows 限制）
> 已核实：**Windows 托盘无标题文字**（docs.rs `Windows: Unsupported` + JS `setTitle` 不支持）。
- **(A) macOS** = `tray.set_title(Some("💰 ¥42.50"))`，按整数分变化门控（菜单栏专为「频繁更新数字」设计，1Hz 很轻）。
- **(B) Windows 主方案（也是跨平台一致面）** = **置顶小窗的大数字**（两端 UX 完全一致，这是对 Windows 缺口的**正解而非降级**）+ 每拍 `set_tooltip` 供 hover。
- **(C) Windows 可选（默认关）** = `set_icon` 整元 PNG 重绘（需 `image-png/image-ico`），仅整元变化时节流。
- 托盘构建：`TrayIconBuilder::with_id("main")`，feature `tray-icon`，`show_menu_on_left_click(false)` → 左键开 popover、右键开菜单；`icon_as_template(true)` 适配 mac 明暗。

### 1.5 状态机
`EngineState`（单个 `Arc<Mutex<>>`，唯一权威）：`status:Idle|Working|Paused`、`per_second_rate_millicents`、`daily_threshold_secs`、`overtime_mult_x100`、`current_local_date:NaiveDate`、`accumulated_active_secs:f64`（**仅当前本地日**，午夜重置，因加班按日算）、`today_total_cents_before_session`、`current_stretch_anchor:Option<SuspendUnawareInstant>`（仅 Working 时 Some）…

**每拍算法**（纯 Rust 可测，无 webview 依赖）：
`lock → mono_delta / wall_delta → 睡眠检查(差>5s 只计 mono, reason=sleep-resume) → 跨日检查(本地日变化则拆分、重置 T、锚点结转, reason=rollover) → 累加(若 Working) → 算 today_cents → emit tick → 托盘更新(门控)`。

**前端**：`listen('paypulse://tick')` 把 `todayCents` 写入 `MotionValue`（**非 useState**）→ `useSpring` 60/120fps 插值 → `useTransform` 写 `<motion.span>` 的 textContent，**整棵树不随帧重渲染**；跳动 + 波纹在同一 handler 触发。任何分歧被下一拍覆盖——一次性 UI，漂移不可能。

---

## 2. 像素设计系统 · "Arcade Treasury Meter"

> 已产出并浏览器实测通过，原型在 `design/`（5 个高保真页 + 共享设计系统）。生产 React 组件以此为视觉基准实现。

- **概念**：深夜街机/JRPG 金库的进账脉搏；记忆点 = **像素硬币成股飘入**。
- **App 图标**：像素**金币**（`SPRITE.coin`）—— 用于首屏左上角 logo、托盘/菜单栏图标、最小化后图标，全局统一。
- **调色板**：Sweetie-16（16 色），映射到 money(gold)/gain(lime)/accent(cyan)/danger(rose)/ink 等角色；深色「Vault at Night」+ 浅色「Parchment Ledger」双主题。
- **字体**：
  - **金额数字（hero 大数 + 统计卡）= `DSEG7-Classic`（7 段数码管/计算器 LCD）** —— 每位由独立段构成，0/6/8/9 绝不混淆，辨识度最高，契合「计量器」概念；hero 含未点亮「8.8.8」底影层（`.seg-off`）。¥ 符号用 `Pixelify Sans`（hero 标绿）以区分。注意数码管不含字母，缩写如「58k」需写成完整数字。
  - `Pixelify Sans`（标题/品牌）· `DotGothic16`（中日文点阵，保证双语像素化）· `VT323`（次级读数/计时）· `Silkscreen`（标签）。
  - ⚠️ 生产环境：**DSEG7 需本地打包**（原型用 jsDelivr CDN）；中文像素字体需换更全的简体像素字体（如 Fusion Pixel / Zpix），DotGothic16 为日文集、部分简体字形不全。
- **特效**：CRT 扫描线、抖动点阵、粗描边 + 硬投影、`image-rendering: pixelated`、金币吉祥物（眨眼/弹跳）。
- **CoinFlow 引擎**：边缘生成像素硬币/钞票，抛物线飞向目标并吸收 + 脉冲环。托盘收起态与小窗共用，是「钱不断飘入」的核心。
- **原型清单**（`design/`）：
  - `index.html` — 设计系统门户（调色板/字体/组件/精灵/画廊）
  - `mini-window.html` — 置顶小窗（数码管金额·**默认 3 位小数** + 跳动/波纹 + 拖拽 + 落日壁纸衬透明；左上角 app 图标=金币；**右上角仅「设置 + 最小化」两个按钮**（hover 提示）；**无吉祥物**、**透明度滑块已移至设置页**；**peek 模式：idle 仅显示 ¥+数字+动效，hover 才展开完整 UI**）
  - `tray.html` — 状态栏钱币飘入（mac 菜单栏 / Win 托盘双形态 + popover）
  - `main.html` — 仪表盘（趋势柱状图 + 四宫格 + 连续打卡）
  - `settings.html` — 设置（薪资模型 + 实时费率预览 + **小数位数 0–4** + 透明度 + 主题/语言）
- **UX 约定**（M3/M4 实现时遵循）：小窗只保留金额+控制+目标，配置（透明度/小数位数/主题/语言…）全部在设置窗口；**小窗右上角仅「设置 + 最小化」两个按钮**（均有 hover 提示），最小化=收起到托盘；app 图标统一为金币。
- **「下班」= 长按确认**（防误触）：所有下班/Stop 按钮需长按 ~0.8s 才触发，按住时有斜纹充能条扫过 + 轻微抖动，松手即取消，单击无效（复用 `holdToConfirm` 助手 + `.btn.hold`）。
  - `pixel.css` / `sprites.js` — 共享 tokens、组件、精灵渲染器、i18n、CoinFlow

---

## 3. 技术栈与依赖

### Rust（`src-tauri/Cargo.toml`）
```
tauri = { version = "2", features = ["tray-icon", "image-png", "image-ico"] }
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-store = "2"
tauri-plugin-notification = "2"
tauri-plugin-autostart = "2"          # init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"]))
tauri-plugin-positioner = "2"          # 需 on_tray_event 转发 + tray-icon feature
tauri-plugin-window-state = "2"
tauri-plugin-os = "2"
suspend-time = "*"                     # 🔑 SuspendUnawareInstant，最高价值正确性依赖
chrono = "0.4"                          # SystemTime → Local NaiveDate（本地时区，绝不 UTC）
tokio = { version = "1", features = ["time","sync","rt-multi-thread","macros"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
[dev-dependencies] proptest = "1"
```

### npm（pnpm）
```
react@^19  react-dom@^19  @tauri-apps/api@^2
@tauri-apps/plugin-{sql,store,notification,positioner,window-state,os,autostart}@^2
motion@^12              # 改名后的 framer-motion；从 'motion/react' 引入（v11 与 React19 冲突）
react-i18next@^15  i18next@^24  zod@^3  recharts@^2（趋势图，可手写 SVG 替代）
-D: tailwindcss@^4  @tailwindcss/vite@^4  @vitejs/plugin-react  vite@^6  typescript@^5
    @tauri-apps/cli@^2  @types/react@^19  @types/react-dom@^19  vitest@^2
```
> 本机已就绪：rustc 1.89 / cargo 1.89 / node 26.3 / pnpm 10.28 / bun 1.3。`cargo-tauri` 非全局，用 `pnpm tauri`。

---

## 4. 文件结构

```
PayPulse/
├── docs/PLAN.md                 # 本活文档
├── design/                      # 像素设计原型（已完成，视觉基准）
├── index.html  mini.html  settings.html   # 3 个 webview 入口
├── vite.config.ts               # react() + tailwindcss(); rollupOptions.input: {index, mini, settings}
├── src/
│   ├── shared/{ipc,events,types,format,zod}.ts
│   ├── hooks/{useEngineTick,useStateChanged,useMilestone}.ts
│   ├── components/{EarningsCounter,TransportControls,ThemeProvider,MilestoneBurst}.tsx
│   │   └── stats/{StatsPanel,TrendChart}.tsx
│   ├── pixel/                   # 移植 design/ 的 tokens/sprites/CoinFlow 为 React 组件
│   ├── i18n/{index.ts, locales/{zh,en}.json}
│   ├── popover/main.tsx  mini/main.tsx  settings/main.tsx
│   └── styles/app.css           # @import "tailwindcss"; @theme {...}
└── src-tauri/
    ├── Cargo.toml  tauri.conf.json  build.rs
    ├── capabilities/{main,popover,mini,settings}.json   # 按 label 最小权限，core: 前缀
    ├── migrations/{0001_init.sql,0002_indexes.sql}
    └── src/
        ├── main.rs  lib.rs       # setup(): 插件/3窗口/托盘/tokio 1Hz/ActivationPolicy/Exit flush
        ├── commands.rs  tray.rs  windows.rs
        ├── persistence/{mod,checkpoint,sqlite}.rs
        └── engine/{mod,rate,state,tick,rollover}.rs + tests/
```

---

## 5. 数据模型（SQLite DDL · 全整数分/整数秒）

```sql
-- 0001_init.sql  —— local_date 一律本地日历日（chrono::Local），ISO 'YYYY-MM-DD'
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, start_wall TEXT NOT NULL, end_wall TEXT,
  local_date TEXT NOT NULL,           -- 跨午夜会话拆成多行（每日一段）
  active_secs INTEGER NOT NULL DEFAULT 0, regular_secs INTEGER NOT NULL DEFAULT 0,
  overtime_secs INTEGER NOT NULL DEFAULT 0, earnings_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_local_date ON sessions(local_date);

CREATE TABLE IF NOT EXISTS day_totals (
  local_date TEXT PRIMARY KEY, total_cents INTEGER NOT NULL DEFAULT 0,
  active_secs INTEGER NOT NULL DEFAULT 0, overtime_secs INTEGER NOT NULL DEFAULT 0,
  updated_wall TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_salary_cents INTEGER NOT NULL DEFAULT 0,
  daily_hours REAL NOT NULL DEFAULT 8.0,
  workdays_per_month INTEGER NOT NULL DEFAULT 22,
  overtime_multiplier_x100 INTEGER NOT NULL DEFAULT 150,   -- 1.5x
  milestones_cents TEXT NOT NULL DEFAULT '[]',
  theme TEXT NOT NULL DEFAULT 'system', language TEXT NOT NULL DEFAULT 'system',
  currency TEXT NOT NULL DEFAULT 'auto',   -- 'auto'=跟随语言(zh→CNY/en→USD) | 'CNY' | 'USD'…
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  autostart_enabled INTEGER NOT NULL DEFAULT 0,
  windows_icon_number INTEGER NOT NULL DEFAULT 0,
  transparency_enabled INTEGER NOT NULL DEFAULT 1,         -- ✅ 默认开（自分发）
  mini_opacity_x100 INTEGER NOT NULL DEFAULT 92,           -- 小窗透明度 0.35–1.0（存 ×100，在设置页调节）
  display_decimals INTEGER NOT NULL DEFAULT 3              -- ✅ 首屏金额小数位数 0–4（默认 3）
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

-- 0002_indexes.sql
CREATE INDEX IF NOT EXISTS idx_sessions_date_earn ON sessions(local_date, earnings_cents);
```

---

## 6. IPC 契约

**Rust → JS（emit/listen）**
- `paypulse://tick`（每墙钟秒，所有窗口）：`{todayCents, sessionCents, perSecondCents, state, isOvertime, localDate, sessionId, milestoneHit}` —— 整数分 = 无漂移弹簧锚点。
- `paypulse://state-changed`（start/pause/stop/settings/rollover/sleep）：`{state, sessionId, reason:'user'|'rollover'|'sleep-resume'|'settings', todayCents, localDate}`。
- `paypulse://milestone`：`{kind, amountCents, label}` —— 跨越时恰好触发一次。

**JS → Rust（invoke）**
`engine_start` · `engine_pause` · `engine_resume` · `engine_stop` · `get_snapshot`（挂载时种子，避免白帧）· `update_settings`（Rust 重算费率+阈值并持久化）· `get_settings` · `set_autostart` · `get_stats{range}` · `toggle_mini` · `open_settings_window`。

---

## 7. 里程碑（M0–M9 · 严格自上而下执行）

### ✅ M0 — 脚手架（Tauri v2 + React 19 + Vite + Tailwind v4 + Motion）— 已完成
**验证**：`tsc --noEmit`（app+node 双配置）✅ · `vite build`（index/mini/settings/popover 四入口多页 + Tailwind v4）✅ · `cargo check`（591 依赖 + paypulse crate，含 suspend-time 0.1.2 / sqlx / chrono / 8 插件，macos-private-api 已对齐）✅ · build script 校验 tauri.conf ↔ Cargo features 一致 ✅。托盘归 M2。
**目标**：`pnpm tauri dev` 起 3 窗口空壳，6 插件 + suspend-time/chrono/tokio 全部编译，4 个按 label 的能力文件就位，「X」不退出。
- [ ] `pnpm create vite . --template react-ts`（确认 react@^19）
- [ ] `pnpm add -D @tauri-apps/cli@^2 && pnpm tauri init`（appName PayPulse, id com.paypulse.app, devUrl :1420, dist ../dist）
- [ ] `pnpm add @tauri-apps/api@^2`
- [ ] Tailwind v4：`pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4`；vite 插件 `tailwindcss()` 放在 `react()` **之后**；CSS 单行 `@import "tailwindcss"`，主题用 `@theme`
- [ ] `pnpm add motion@^12` 并验证从 `motion/react` 引入
- [ ] `pnpm add react-i18next i18next`（M7 接线）
- [ ] CLI 加插件：`pnpm tauri add sql/store/notification/positioner/window-state/os/autostart`
- [ ] 手动加 Cargo：suspend-time、chrono=0.4、tokio(time,sync,rt-multi-thread,macros)、serde/serde_json、uuid
- [ ] tauri features = [tray-icon, image-png, image-ico]
- [ ] 3 个 HTML 入口 + vite `rollupOptions.input` 多页
- [ ] `lib.rs .setup()`：注册插件；`WebviewWindowBuilder` 按 label 建 popover/mini/settings；macOS `set_activation_policy(Accessory)`
- [ ] 4 个能力文件（main/popover/mini/settings，`core:` 前缀，按 label 限权）
- [ ] 每窗口 `CloseRequested → prevent_close() + hide()`
- [ ] `.gitignore`（dist/node_modules/target/*.db）；`pnpm tauri dev` 干净起 3 label + 托盘
- **测试**：mac+Win CI 零错；`tsc --noEmit` + `cargo check` 干净；各窗口 `core:event` 无 ACL 拒绝。

### ☐ M1 — 核心计算引擎 + 状态机（TDD，纯 Rust，≥80% 覆盖）
- [ ] `engine/` 模块：mod/rate/state/tick/rollover
- [ ] `EngineState`（单 `Arc<Mutex<>>`）字段齐全（见 §1.5）
- [ ] `rate_millicents`（u128 运算存 u64，边界才舍入到分）
- [ ] `earnings_cents(t,T,rate_mc,mult_x100)`，t==T 连续
- [ ] 跨阈值边际积分（阈下/阈上/跨阈）；`earnings_cents` 重算 = 对账真相
- [ ] 状态迁移 Idle→Working→Paused→…→Idle
- [ ] 每拍算法：睡眠检查 / 跨日检查 / 累加 / 算 today_cents
- [ ] 午夜拆分：pre/post 午夜单调增量归 D/D+1，重置 D+1 的 T 窗
- **测试**：费率精度；加班 t<T/t==T/t>T/跨阈；暂停只累加 monotonic；睡眠 2h→计 0；跨日拆分 + T 重置 + 锚点结转；proptest 单调性 & 边际累加和==总额(±1 分)；饱和减不 panic；`cargo llvm-cov ≥ 80%`。

### ☐ M2 — 托盘/菜单栏实时金额 + 按 OS 策略 + popover
- [ ] `.setup()` 单 `tokio interval(1s)`：lock→apply_tick→emit tick→托盘更新(门控)
- [ ] `TrayIconBuilder::with_id("main")`，左键 popover/右键菜单，菜单 上班/摸鱼/下班/打开小窗/设置/退出
- [ ] `on_tray_icon_event`：先转发 `positioner::on_tray_event`，再 `Click{Left,Up}` 开 popover
- [ ] macOS `set_title` 整数分门控；Windows `set_tooltip` 每拍 + 可选 `set_icon` 整元节流
- [ ] `tauri_plugin_os::platform()` 分支策略
- [ ] popover 窗口接 `engine_*` 命令 + `get_snapshot` 种子
- [ ] `paypulse://state-changed` 带 reason
- **测试**：start→1s 内托盘更新；门控跳过未变；mac 菜单栏爬升/左键/右键；Win tooltip/不 panic；positioner 吸附。

### ☐ M3 — 无边框置顶可拖拽小窗
- [ ] mini：decorations(false)/always_on_top/skip_taskbar/resizable(false)/shadow/220×120/visible(false)
- [ ] 拖拽区只包数字（`data-tauri-drag-region`），Win 触控加 `app-region:drag`
- [ ] `mini.json` 能力：`core:window:allow-start-dragging` + positioner + window-state + `core:event`；**无** sql/autostart/notification
- [ ] `toggle_mini` 命令
- [ ] React：`useEngineTick`→MotionValue→useSpring→useTransform；跳动+波纹
- [ ] **peek 模式**：idle 仅渲染 ¥+数字+动效（标题栏/状态/控制收起），hover 展开完整 UI（CSS `:hover` + max-height/opacity 过渡）；窗口随之收缩/展开
- [ ] **可拖拽缩放 + 尺寸自适应**：窗口可调宽（`resizable(true)` / 角部手柄），数字字号随窗宽缩放（`clamp(..,14cqw,..)`，`.mini` 设 `container-type: inline-size`）；**窗宽 < ~250px 切「精简模式」**（CSS `@container`）——hover 仅显示 标题栏(PayPulse+设置/最小化) + 跳动数字 + 纯进度条(无数值) + 暂停/结束，其余（状态/¥每秒/本次时长/目标文字与百分比）隐藏
- [ ] `window-state` 自动持久化几何
- [ ] **透明度（✅ 默认开启）**：`tauri.conf.json` `app.macOSPrivateApi=true`，mini `WebviewWindowBuilder::transparent(true)`，CSS 背景用 rgba/可调 alpha；设置里透明度滑块写 `transparency_*`，实时作用于小窗
- **测试**：只数字可拖、按钮可点、置顶、重启复位；10min 漂移 ±1 帧；隐藏 5min 再显跳到真值；e2e WebDriver。

### ☐ M4 — 主窗口 + 设置窗口 UI
- [ ] `update_settings`（zod+serde 校验，重算费率+阈值，持久化，emit reason=settings）
- [ ] `get_settings → SettingsDto`
- [ ] 设置表单：月薪(→分)/日工时/月工作天数/加班倍率(x100)/里程碑/主题/语言/通知/自启/Win图标数字开关
- [ ] zod：salary>0、0<dailyHours≤24、0<workdays≤31、multiplier≥1
- [ ] `open_settings_window`：macOS 切 Regular，关闭复位 Accessory
- [ ] `set_autostart → autolaunch().enable()/disable()`
- [ ] 主仪表盘 + 共享 `useEngineTick`/`EarningsCounter`（React19 双 effect 安全清理）
- **测试**：zod 拒非法；update_settings 下一拍生效；mac Dock 切换；自启开关生效。

### ☐ M5 — SQLite 持久化 + 会话 + 日/周/月统计 + 趋势图 + 崩溃恢复
- [ ] `add_migrations` 建表 + 索引；`db_url` 三处一致；路径 `BaseDirectory::AppConfig`
- [ ] 双写：SQLite 真相 + store 15s 检查点
- [ ] 分级 flush：15s + 暂停/停止/跨午夜/睡眠 + `RunEvent::Exit`；**绝不每秒写 SQLite**
- [ ] 不持久化 Instant；持久化 `accumulated_active_secs`
- [ ] 启动恢复：今日 = SQLite SUM + 检查点尾；只补到检查点、丢弃未 flush 尾
- [ ] `get_stats{today|week|month}` GROUP BY local_date
- [ ] 统计 UI + 趋势柱图（Recharts/SVG）
- **测试**：工作 30s 停 → 一行 session 正确；崩溃恢复不超额；普通拍不写 SQLite；多日聚合;午夜两行；db_url 不一致测试报错。

### ☐ M6 — 里程碑通知 + 自启 + 加班 + 深/浅主题
- [ ] `paypulse://milestone`（独立于 tick）跨越拍触发，来自 `milestonesCents[]`
- [ ] JS：权限请求 + sendNotification + 庆祝，受 `notificationsEnabled` 门控
- [ ] 加班 `isOvertime` 驱动 UI 强调 + 可选 overtime-start 里程碑
- [ ] 主题 dark/light/system → Tailwind dark class + CSS vars，持久化、可实时切
- [ ] 自启 `--minimized` 端到端：登录后隐藏到托盘
- **测试**：跨里程碑恰好一次通知不复发；关通知则无；跨 T 翻转倍率；主题实时+持久；自启最小化进托盘。

### ☐ M7 — i18n（zh/en 运行时切换）
- [ ] react-i18next + `locales/{zh,en}.json` 覆盖全部 UI
- [ ] 默认语言取 `tauri_plugin_os::locale()`（zh*→zh 否则 en），可在设置覆盖
- [ ] 语言变更经 `update_settings` 持久化并广播，所有窗口重渲
- [ ] 货币**跟随语言**（✅ D2）：zh→`Intl.NumberFormat('zh-CN',{currency:'CNY'})`、en→`('en-US',{currency:'USD'})`，按 locale 缓存两套，仅换符号不转汇率
- **测试**：key 对等（双文件每 key 都在）；切换无需重启；locale 默认正确。

### ☐ M8 — 打磨 + 游戏化动画（像素风落地）
- [ ] 每秒跳动 `animate(scale,[1,1.15,1])`；波纹独立元素
- [ ] `useSpring(target,{stiffness:300,damping:30})`，值在 MotionValue 不在 useState
- [ ] `useTransform(spring, v=>cachedIntlFmt.format(v/100))` → motion.span textContent
- [ ] **移植 `design/` 像素系统**：Sweetie-16 tokens、像素字体、CoinFlow、吉祥物、CRT 扫描线
- [ ] **状态栏/popover 钱币飘入** 动画接真实 tick
- [ ] `prefers-reduced-motion` 关动画；隐藏窗暂停 rAF
- **测试**：Profiler 证明计数器不随帧重渲；每拍一次跳动+波纹；减少动效生效；隐藏小窗停 rAF。

### ☐ M9 — 构建/打包/签名（Win + mac）
- [ ] `pnpm tauri build` → mac .app/.dmg + Win .msi/.exe
- [ ] macOS：**Developer ID 自分发**签名 + notarytool 公证（✅ 不上架 App Store）；确认 release 仍 Accessory；确认 `macOSPrivateApi=true` 透明生效
- [ ] Windows：Authenticode 签名；干净 VM 验托盘/tooltip/小窗/自启
- [ ] **release 能力审计**：4 个 capability label 与窗口 label 全匹配（改名仅 release 暴露）
- [ ] 图标/元数据/版本；干净机安装冒烟
- [ ] CI GitHub Actions：mac+Win 矩阵，build + cargo test + pnpm test
- **测试**：干净 VM e2e；release 无 ACL 拒绝；签名校验通过。

---

## 8. 风险与缓解（精选）

| 风险 | 缓解 |
|------|------|
| 🔑 原始 `Instant` 在 Win 计睡眠 → 合盖超额发钱 | 全程 `SuspendUnawareInstant` + wall-vs-mono>5s 纵深检查；M1 注入 2h 睡眠断言计 0 |
| Windows 托盘无文字 | mac `set_title` / Win 置顶小窗(一致)+tooltip / 可选 icon 重绘 |
| capability 按 label 匹配，改名静默撤权（仅 release） | 早钉死 label；M9 release 审计 |
| 每秒写 SQLite 放大 / 持久化 Instant 无意义 | 分级 flush + 持久化秒数而非 Instant；M5 断言普通拍不写 |
| 崩溃尾部超额发钱 | 保守恢复只补到检查点、丢尾，损失 ≤15s |
| 每帧 React 重渲/每帧建 Intl 卡顿耗电 | MotionValue + 缓存 Intl + 隐藏暂停；M8 Profiler 断言 |
| React19 Strict 双 effect 重复 listen | async-store-and-unlisten 安全清理；motion@^12 |
| 跨午夜/DST 加班误归 | 按本地日 accumulator 每拍重算，午夜拆分重置 T |
| mac 透明度需 macos-private-api（阻 App Store） | 见 §10 D5 由分发目标决定 |
| positioner 无转发静默失效 | 先转发 `on_tray_event` + tray-icon feature；M2 测试 |
| db_url 三处漂移 → 表缺失 | 单常量 + M5 一致性守卫测试 |

---

## 9. 验证与质量门槛
- **覆盖率 ≥ 80%**（引擎单元/属性测试为重）；类型零错（`tsc`/`cargo check`）。
- 每里程碑完成后跑 `code-reviewer`，修复 CRITICAL/HIGH。
- 关键正确性（睡眠/午夜/加班/崩溃恢复）必须有针对性测试。

---

## 10. 待确认决策（含建议默认值）

> ✅ = 用户已确认；⬜ = 采用建议默认值（如需调整随时提）。

- ✅ **D2 货币 vs 语言**：**跟随 UI 语言**——zh 显示 `¥(CNY)`、en 显示 `$(USD)`，**仅换符号不做汇率转换**（数值不变）。`Intl.NumberFormat` 按 locale 缓存两套。
- ✅ **D3 里程碑**：「按日绝对值数组 `milestonesCents[]`，本地午夜重置」。
- ✅ **🔑 D5 macOS 分发 / 透明度**：**自分发 Developer ID + 启用透明度**（`tauri.conf.json` `app.macOSPrivateApi=true`，小窗 `transparent(true)`，`transparency_enabled` 默认开）。**不上架 Mac App Store。**
- ✅ **D6 睡眠后**：保持 `Working` 且睡眠期计 0（emit `reason=sleep-resume`），不自动暂停。
- ⬜ **D1 加班语义**：仅按「日工时阈值 T = daily_hours×3600」，无周/月封顶。
- ⬜ **D4 工作日模型**：`workdays_per_month` 为纯除数；手动 Start 任意一天（含周末）都累加，无星期门控。
- ⬜ **D7 趋势范围**：周=近 7 本地日、月=近 30 本地日（滚动窗，非自然月）。
- ⬜ **D8 未配置时**：未填薪资则禁用「上班」并提示去设置，不用示例薪资。
- ⬜ **D9 空闲自动停**：v1 不做（仅手动），留作未来设置项。
- ⬜ **D10 小窗离屏恢复**：恢复时做边界 clamp，离屏则重新居中。

---

## 11. 进度追踪

| 阶段 | 状态 | 说明 |
|------|------|------|
| 需求对齐 | ✅ 完成 | 11 项决策已定 |
| 架构设计 | ✅ 完成 | 工作流产出，3 方案竞标→评审合成 |
| 像素设计系统 | ✅ 完成 | `design/` 5 页 + 设计系统，浏览器实测通过 |
| PLAN.md | ⏳ 待批准 | 本文档 |
| M0 脚手架 | ✅ 完成 | tsc + vite build + cargo check 全绿；3 辅助窗 + 4 能力文件 + 共享 TS 契约层 |
| M1 计算引擎 | ✅ 完成 | engine 模块 5 文件 + 31 测试全过（睡眠/跨日/加班/单调性/饱和）|
| M2 托盘/popover | ✅ 完成 | tokio 1Hz 循环 + 托盘(menu/左键 popover/positioner) + 按 OS 策略 + 9 命令；cargo check 零警告 |
| M3 置顶小窗 | ✅ 完成 | React 小窗(peek/compact/透明/拖拽缩放/长按下班) + useEngineTick；Chrome 实测 peek+展开通过 |
| M4 主/设置窗口 | ✅ 完成 | 仪表盘 + 设置表单(实时费率/zod/update_settings) + popover；4 窗口 Chrome 视觉实测通过（macOS Dock 切换并入 M6 微调）|
| M5 持久化/统计 | ✅ 完成 | sqlx 直连(设置落库/day_total 分级 flush/15s 检查点/启动恢复/get_stats) + 33 测试全过；useStats 接仪表盘/popover(本周/本月/趋势) |
| M6 通知/自启/加班/主题 | ✅ 完成 | 里程碑(Rust 单源通知+前端庆祝) + 自启(--minimized) + macOS Dock 切换 + useTheme 全窗主题；加班视觉强调并入 M8 |
| M7 i18n | ✅ 完成 | 4 窗口 ns 化(zh/en key 平价 29/13/45/16) + useI18n + 货币随语言(¥/$)；Chrome 英文模式实测通过 |
| M8 打磨/像素动画 | ✅ 完成 | 像素系统全集成(CoinFlow/CRT/DSEG7/numJump/波纹/长按/里程碑庆祝) + reduced-motion + 隐藏窗降权；计数器 MotionValue→textContent 不逐帧重渲。加班强调/正式 Profiler 为次要补充 |
| M9 打包/签名 | ✅ 基本完成 | `pnpm tauri build` 产出 PayPulse.app + .dmg(3.0M) 实测通过；CI/release 工作流就位；cargo fmt 干净；identifier 修正。**签名需用户证书**(已在 §12 文档化) |

---

## 12. 构建 / 运行 / 签名指南（M9）

### 本地开发与构建
```bash
pnpm install                 # 安装前端依赖
pnpm tauri dev               # 起开发版（3 窗口 + 托盘 + 1Hz 循环）
pnpm typecheck               # tsc 类型检查（app + node 双配置）
pnpm build                   # 前端多页构建到 dist/
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单元 + 属性测试
pnpm tauri build             # 出包：mac .app/.dmg + win .msi/.exe（未配证书时为未签名）
```

### CI（`.github/workflows/ci.yml`）
- mac + win 矩阵：`pnpm typecheck` + `pnpm build` + `cargo test`（硬门禁）；`cargo fmt --check` / `clippy`（信息性，后续转硬门禁）。

### 发布与签名（`.github/workflows/release.yml`，打 `v*` tag 触发）
> **签名需要你的证书，我无法代为完成**。未配置 secrets 时仍会出包，但**未签名**（首次启动 Gatekeeper/SmartScreen 会告警）。
- **macOS（Developer ID 自分发，D5）**：在仓库 Secrets 配置 `APPLE_CERTIFICATE`(base64 的 .p12)、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`(App 专用密码)、`APPLE_TEAM_ID` → tauri-action 自动签名 + notarytool 公证。已确认 `tauri.conf.json` `app.macOSPrivateApi=true`（透明小窗），**不上架 Mac App Store**。
- **Windows（Authenticode）**：在 `tauri.conf.json` 配 `bundle.windows.certificateThumbprint`，或在 release.yml 加 signtool/Azure Trusted Signing 步骤接你的证书。
- **release 能力审计**：4 个 capability 的 `windows` label 与窗口 label 必须全匹配（改名仅在 release 暴露）——当前 main/popover/mini/settings 已对齐。
- **字体本地化（生产必做）**：当前 DSEG7 走 jsDelivr CDN、中文用 DotGothic16（日文集，部分简体缺字）。打包前应改为本地 `@font-face`：DSEG7 本地 woff2 + 简体像素字体（Fusion Pixel / Zpix）。
