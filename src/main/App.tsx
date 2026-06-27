/* ============================================================
   PayPulse 薪跳 — 主窗口仪表盘 (main) React UI
   逐像素移植自 design/main.html。
   - 英雄 DSEG7 数字走 todaySpring（MotionValue），useTransform 绑定，60fps 不重渲。
   - 金额一律整数分；只读引擎，不持有任何金钱权威。
   - 占位项（本周/本月/累计、7 日趋势、streak、目标）均标注 TODO M5。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { motion, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";

import { useEngineTick } from "@/hooks/useEngineTick";
import { useEngineControls } from "@/hooks/useEngineControls";
import { useSettings } from "@/hooks/useSettings";
import { useStats, sumCents, fillTrend } from "@/hooks/useStats";
import { useTheme } from "@/hooks/useTheme";
import { useMilestone } from "@/hooks/useMilestone";
import { useI18n } from "@/hooks/useI18n";

import "@/pixel/pixel.css";
import {
  Sprite,
  Icon,
  useCoinFlow,
  useHoldToConfirm,
  moneyParts,
  ghostFor,
} from "@/pixel";
import type { EngineStatus } from "@/shared/types";
import { openSettingsWindow } from "@/shared/ipc";
import { currencySymbol } from "@/shared/format";
import { getCurrentWindow } from "@tauri-apps/api/window";

/* ---------- 文案 key 映射（值由 t() 在组件内解析，跟随语言） ---------- */
/* 状态 chip / sess-pill 文案：状态 → i18n key */
const STATUS_KEY: Readonly<Record<EngineStatus, string>> = {
  working: "statusWorking",
  paused: "statusPaused",
  idle: "statusIdle",
};

/* 切换按钮文案：working→摸鱼(暂停)，paused→恢复，idle→上班 */
const TOGGLE_KEY: Readonly<Record<EngineStatus, string>> = {
  working: "toggleSlack",
  paused: "toggleResume",
  idle: "toggleClockIn",
};

/* 星期缩写 → i18n key（getDay() 0=周日；中英 JSON 均保留 Sun..Sat 缩写） */
const WEEKDAY_KEYS: ReadonlyArray<string> = [
  "weekday.sun",
  "weekday.mon",
  "weekday.tue",
  "weekday.wed",
  "weekday.thu",
  "weekday.fri",
  "weekday.sat",
];

/* ---------- 占位常量（TODO M5：接 streak / goal） ---------- */
const BAR_MAX_PX = 84; // 柱子最大像素高度（设计稿坑：用 px 高度，避免被压扁）

const COFFEE_PRICE = 38; // 一杯精品手冲单价（元）
const DAILY_GOAL_YUAN = 383; // 占位每日目标（元）——TODO M5：由 settings 推算
const STREAK_DAYS = 5; // 占位连续打卡天数——TODO M5：接真实统计
const STREAK_TOTAL = 7;

/** 由 ISO 'YYYY-MM-DD' 推算星期 i18n key（本地午夜解析，避免时区漂移到前一天）。
 *  返回 key（如 'weekday.mon'），由调用方用 t() 解析为缩写文案。 */
function weekdayKey(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00`);
  return WEEKDAY_KEYS[d.getDay()];
}

/* ---------- 单柱组件 ---------- */
function TrendBar({
  day,
  yuan,
  maxYuan,
  isToday,
  cur,
}: {
  day: string;
  yuan: number;
  maxYuan: number; // 归一化分母（trend 元值与今日元值的最大值，避免今日柱溢出）
  isToday: boolean;
  cur: string; // 货币符号（随语言：zh→¥ / en→$）
}) {
  // 柱子像素高度（对最大值归一化 + 限幅，避免溢出容器；max 为 0 时高度归 0）
  const heightPx =
    maxYuan > 0 ? Math.min(BAR_MAX_PX, (yuan / maxYuan) * BAR_MAX_PX) : 0;
  return (
    <div className={`bcol${isToday ? " today" : ""}`}>
      <div className="val">
        {cur}
        {Math.floor(yuan).toLocaleString("en-US")}
      </div>
      <div className="bar" style={{ height: `${heightPx}px` }} />
      <div className="day">{day}</div>
    </div>
  );
}

export function App() {
  const {
    todayCents,
    perSecondCents,
    status,
    todaySpring,
    localDate,
  } = useEngineTick();
  const { toggle, stop } = useEngineControls();
  const { settings } = useSettings();
  const { t } = useTranslation("main");

  /* ---------- 语言同步（M7）：把 settings.language 写入 i18next 当前语言 ---------- */
  useI18n(settings?.language);
  /* 货币符号随语言（D2：不做汇率换算，仅符号）；zh→¥ / en→$ */
  const cur = currencySymbol(settings?.language ?? "system");

  /* ---------- 主题应用（M6）：把已保存的 settings.theme 写入 <html data-theme> ---------- */
  useTheme(settings?.theme);

  /* ---------- 真实统计：本周 / 本月聚合（整数分） ---------- */
  const week = useStats("week");
  const month = useStats("month");

  const decimals = settings?.displayDecimals ?? 3;
  const isWorking = status === "working";

  /* ---------- 英雄数字：MotionValue → 文本，60fps 平滑，勿每帧重渲 ---------- */
  const whole = useTransform(todaySpring, (v) =>
    moneyParts(Math.max(0, v), decimals).whole,
  );
  const dec = useTransform(todaySpring, (v) =>
    moneyParts(Math.max(0, v), decimals).dec,
  );
  const ghost = useTransform(todaySpring, (v) =>
    ghostFor(moneyParts(Math.max(0, v), decimals), decimals),
  );

  /* ---------- 派生展示值（1Hz 级别，随 meta 重渲即可） ---------- */
  const perSecondYuan = perSecondCents / 100;
  // 时薪：每秒 × 3600（最精确）；引擎未就绪时退化为占位
  const hourlyYuan = perSecondCents > 0 ? (perSecondCents * 3600) / 100 : 0;
  const todayYuan = todayCents / 100;
  const coffeeCups = todayYuan / COFFEE_PRICE;
  const todayWhole = moneyParts(Math.max(0, todayCents), 0).whole;
  const goalPct = Math.min(100, Math.round((todayYuan / DAILY_GOAL_YUAN) * 100));

  /* ---------- 本周 / 本月 / 累计 stat 卡（整数分 → 千分位整数串） ---------- */
  const weekWhole = moneyParts(sumCents(week.stats), 0).whole;
  const monthWhole = moneyParts(sumCents(month.stats), 0).whole;
  // 累计：暂无 all-time 查询——先用本月聚合作「近 30 日近似」展示。
  // TODO：需 get_total_cents all-time 查询，届时替换为真实累计。
  const totalWhole = moneyParts(sumCents(month.stats), 0).whole;

  /* ---------- 7 日趋势：截至今日的最近 7 个日历日，缺失补 0 ---------- */
  // endDate 取引擎 localDate（'YYYY-MM-DD'），为空时退化为本地今天
  const todayISO = new Date().toISOString().slice(0, 10);
  const trend = fillTrend(week.stats, localDate || todayISO, 7);
  // 每根柱的元值；最后一根（今日）用实时 todayYuan 覆盖，让今日柱随计酬增长
  const trendBars = trend.map((d, i) => ({
    key: d.localDate,
    label: t(weekdayKey(d.localDate)),
    yuan: i === trend.length - 1 ? todayYuan : d.totalCents / 100,
    isToday: i === trend.length - 1,
  }));
  // 归一化分母：取 trend 元值与今日元值的最大值，避免今日柱溢出
  const trendMaxYuan = trendBars.reduce((m, b) => Math.max(m, b.yuan), 0);

  /* ---------- CoinFlow 飞入 hero 数字 ---------- */
  const moneyRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useCoinFlow(moneyRef, {
    minGap: 520,
    maxGap: 1200,
    scale: 3,
    autoStart: false, // 由 working 状态驱动 start/stop
  });

  // 工作时启动金币流，非工作时停止（卸载时一并停止，避免悬挂定时器）
  useEffect(() => {
    const handle = flowRef.current;
    if (!handle) return;
    if (isWorking) handle.start();
    else handle.stop();
    return () => handle.stop();
  }, [isWorking, flowRef]);

  /* ---------- 里程碑庆祝（M6）：命中里程碑时触发一次硬币爆发 ---------- */
  // flowRef 是稳定 ref，无需进依赖数组（避免 exhaustive-deps 误加依赖）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const celebrate = useCallback(() => {
    flowRef.current?.burst(14);
  }, []);
  useMilestone(celebrate);

  /* ---------- 每秒 numJump 跳动（仅工作时） ---------- */
  useEffect(() => {
    if (!isWorking) return;
    const el = moneyRef.current;
    if (!el) return;
    const id = window.setInterval(() => {
      el.style.animation = "none";
      // 强制重排以重启动画
      void el.offsetWidth;
      el.style.animation = "numJump .42s steps(7)";
    }, 1000);
    return () => window.clearInterval(id);
  }, [isWorking]);

  /* ---------- 下班长按确认 ---------- */
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const holdOpts = useMemo(
    () => ({ ms: 800, onConfirm: () => void stop() }),
    [stop],
  );
  useHoldToConfirm(stopRef, holdOpts);

  /* ---------- 标题栏按钮 ---------- */
  const onSettings = () => void openSettingsWindow();
  const onMinimize = () => {
    // 隐藏窗口（非 Tauri 环境下安全降级）
    try {
      void getCurrentWindow().hide();
    } catch {
      /* 浏览器预览环境无 Tauri window，忽略 */
    }
  };

  return (
    <div className="window crt">
      {/* 标题栏 */}
      <div className="titlebar" data-tauri-drag-region>
        <span className="logo">
          <Sprite name="coin" scale={3} />
        </span>
        <span className="name">
          Pay<span>Pulse</span> · 薪跳
        </span>
        <span className={`chip${isWorking ? " live" : ""} status-chip`}>
          {t(STATUS_KEY[status])}
        </span>
        <div className="tb-btns nodrag">
          <button
            type="button"
            className="tb-btn"
            data-tip={t("settings")}
            aria-label={t("settings")}
            onClick={onSettings}
          >
            <Icon name="settings" size={13} />
          </button>
          <button
            type="button"
            className="tb-btn"
            data-tip={t("minimize")}
            aria-label={t("minimize")}
            onClick={onMinimize}
          >
            <Icon name="minimize" size={13} />
          </button>
        </div>
      </div>

      <div className="content">
        {/* hero */}
        <div className="hero">
          <div className="left">
            <div className="label">{t("earnedToday")}</div>
            <div className="money" ref={moneyRef} style={{ marginTop: 4 }}>
              <span className="cur">{cur}</span>
              <span className="digits">
                <motion.span className="seg-off">{ghost}</motion.span>
                <span className="lit">
                  <motion.span>{whole}</motion.span>
                  {decimals > 0 && <span className="dot">.</span>}
                  {decimals > 0 && <motion.span className="dec">{dec}</motion.span>}
                </span>
              </span>
            </div>
            <div className="meta">
              <span>
                <span className="label">{t("perSec")}</span>{" "}
                <b>
                  {cur}
                  {perSecondYuan.toFixed(3)}/s
                </b>
              </span>
              <span>
                <span className="label">{t("hourly")}</span>{" "}
                <b>
                  {cur}
                  {Math.round(hourlyYuan).toLocaleString("en-US")}
                </b>
              </span>
            </div>
            <div className="coffee">
              {t("coffee", { n: coffeeCups.toFixed(1) })}
            </div>
          </div>
        </div>

        {/* controls */}
        <div className="controls">
          <button
            type="button"
            className={`btn ${isWorking ? "pause" : "go"}`}
            onClick={() => void toggle(status)}
          >
            <Icon name={isWorking ? "pause" : "play"} size={13} />
            <span>{t(TOGGLE_KEY[status])}</span>
          </button>
          <button type="button" ref={stopRef} className="btn stop hold">
            <Icon name="stop" size={13} />
            <span>{t("clockOut")}</span>
          </button>
          <div className="sess-pill">
            <span className="label">{t("statusLabel")}</span>
            <span className="v">{t(STATUS_KEY[status])}</span>
          </div>
        </div>

        {/* stat 四宫格 */}
        <div className="stats">
          <div className="stat a">
            <div className="k">{t("today")}</div>
            <div className="v">
              <span className="cur">{cur}</span>
              {todayWhole}
            </div>
          </div>
          {/* 本周：get_stats('week') 聚合 */}
          <div className="stat b">
            <div className="k">{t("week")}</div>
            <div className="v">
              <span className="cur">{cur}</span>
              {weekWhole}
            </div>
          </div>
          {/* 本月：get_stats('month') 聚合 */}
          <div className="stat c">
            <div className="k">{t("month")}</div>
            <div className="v">
              <span className="cur">{cur}</span>
              {monthWhole}
            </div>
          </div>
          {/* 累计：暂无 all-time 查询，先用本月聚合作近 30 日近似。
              TODO：需 get_total_cents all-time 查询，届时替换为真实累计。 */}
          <div className="stat d">
            <div className="k">{t("allTime")}</div>
            <div className="v">
              <span className="cur">{cur}</span>
              {totalWhole}
            </div>
          </div>
        </div>

        {/* 7 日趋势 — get_stats('week') 真实数据，今日柱实时覆盖 */}
        <div className="card">
          <div className="hd">
            <span className="label">{t("trend7d")}</span>
            <span className="chip">{t("perDayUnit", { cur })}</span>
          </div>
          <div className="chart">
            {trendBars.map((b) => (
              <TrendBar
                key={b.key}
                day={b.label}
                yuan={b.yuan}
                maxYuan={trendMaxYuan}
                isToday={b.isToday}
                cur={cur}
              />
            ))}
          </div>
        </div>

        {/* 目标进度 + streak */}
        <div className="card goal">
          <div className="hd">
            <span className="label">{t("dailyGoal")}</span>
            <span className="label" style={{ color: "var(--money)" }}>
              {goalPct}%
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${goalPct}%` }} />
          </div>
          <div className="hd" style={{ margin: "12px 0 0" }}>
            {/* TODO M5：streak 接真实连续打卡天数 */}
            <span className="label">{t("streak", { n: STREAK_DAYS })}</span>
            <div className="streak">
              {Array.from({ length: STREAK_TOTAL }, (_, i) => (
                <span
                  key={i}
                  className={`d${i < STREAK_DAYS ? " on" : ""}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        /* ---------- main 专有布局（从 design/main.html 适配） ---------- */
        body {
          display: grid;
          place-items: center;
          background: var(--bg-solid);
          background-image: var(--app-backdrop);
          padding: 18px;
        }
        .window {
          width: 560px;
          margin: 0 auto;
          background: var(--panel);
          border: var(--b) solid var(--ink);
          box-shadow: 7px 7px 0 var(--hard);
          position: relative;
          background-image: linear-gradient(45deg, var(--dither) 25%, transparent 25% 75%, var(--dither) 75%);
          background-size: var(--px) var(--px);
        }

        /* titlebar */
        .titlebar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 9px;
          background: var(--inset);
          border-bottom: var(--b) solid var(--ink);
        }
        .titlebar .logo { display: inline-flex; line-height: 0; }
        .titlebar .name {
          font-family: 'Pixelify Sans';
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 1px;
        }
        .titlebar .name span { color: var(--money); }
        .titlebar .status-chip { margin-left: 8px; }
        .tb-btns { margin-left: auto; display: flex; gap: 5px; }
        .tb-btn {
          width: 22px; height: 22px;
          display: grid; place-items: center;
          background: var(--panel-2);
          border: 2px solid var(--ink);
          color: var(--ink-dim);
        }
        .tb-btn:hover { color: var(--money); }

        .content { padding: 16px; display: grid; gap: 14px; }

        /* hero */
        .hero { display: flex; align-items: center; gap: 16px; }
        .hero .left { flex: 1; }
        .hero .money { font-size: 46px; }
        .hero .money .digits { display: inline-block; }
        .hero .meta { display: flex; gap: 14px; margin-top: 6px; }
        .hero .meta .label { color: var(--ink-dim); }
        .hero .meta b {
          color: var(--accentA);
          font-family: 'VT323';
          font-size: 17px;
        }
        .coffee {
          font-family: 'DotGothic16';
          font-size: 11px;
          color: var(--gain);
          margin-top: 4px;
        }

        /* controls */
        .controls { display: flex; gap: 10px; }
        .controls .btn { flex: 1; justify-content: center; font-size: 14px; padding: 11px; }
        .sess-pill {
          display: flex; align-items: center; gap: 7px;
          padding: 0 12px;
          background: var(--inset);
          border: var(--b) solid var(--ink);
        }
        .sess-pill .v {
          font-family: 'VT323'; font-size: 20px; color: var(--money);
        }

        /* stat grid */
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .stat {
          padding: 10px;
          background: var(--panel-2);
          border: var(--b) solid var(--ink);
          box-shadow: var(--px) var(--px) 0 var(--hard);
        }
        .stat .k {
          font-family: 'Silkscreen'; font-size: 8px; letter-spacing: 1px; color: var(--ink-dim);
        }
        .stat .v {
          font-family: 'DSEG7-Classic', 'VT323', monospace;
          font-weight: 700; font-size: 17px; letter-spacing: 1px;
          margin-top: 6px; white-space: nowrap;
        }
        .stat .v .cur {
          font-family: 'Pixelify Sans', sans-serif;
          margin-right: 3px; font-size: 15px;
        }
        .stat.a .v { color: var(--money); }
        .stat.b .v { color: var(--accentA); }
        .stat.c .v { color: var(--gain); }
        .stat.d .v { color: var(--accentB); }

        /* trend card */
        .card {
          padding: 14px;
          background: var(--inset);
          border: var(--b) solid var(--ink);
        }
        .card .hd {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 12px;
        }
        .chart {
          display: flex; align-items: flex-end; gap: 10px;
          height: 110px; padding: 0 2px;
        }
        /* 设计稿坑：bcol 撑满高度并底对齐，bar 用固定 px 高度且 flex:none 不被压扁 */
        .chart .bcol {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: flex-end; gap: 5px; height: 100%;
        }
        .chart .bar {
          width: 100%; flex: none;
          background: repeating-linear-gradient(0deg, var(--accentA) 0 5px, var(--inset) 5px 6px);
          border: 2px solid var(--ink);
          transition: height .5s steps(10);
          position: relative;
        }
        .chart .bcol .val { margin-top: auto; }
        .chart .bcol.today .bar {
          background: repeating-linear-gradient(0deg, var(--money) 0 5px, var(--inset) 5px 6px);
        }
        .chart .bcol .day {
          font-family: 'Silkscreen'; font-size: 8px; color: var(--ink-dim);
        }
        .chart .bcol.today .day { color: var(--money); }
        .chart .bcol .val {
          font-family: 'VT323'; font-size: 12px; color: var(--ink-dim);
        }

        /* goal + streak */
        .goal .hd { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .streak { display: flex; gap: 5px; align-items: center; }
        .streak .d {
          width: 12px; height: 12px;
          background: var(--inset); border: 2px solid var(--ink);
        }
        .streak .d.on { background: var(--gain-2); }
      `}</style>
    </div>
  );
}
