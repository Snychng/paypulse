/* ============================================================
   src/popover/App.tsx — 托盘 popover 窗口 UI（移植 design/tray.html 的 .popover）

   无边框 popover：窗口定位/显隐由 Rust 负责，这里只画内容。
   - 顶部：今日已赚 label + 大号 .money 英雄数字（spring 平滑 60fps）+ 状态 chip
   - 2×2 网格：本次 ¥ / 每秒 ¥/s / 本周（占位）/ 本月（占位）
   - 控制行：暂停/恢复（toggle）+ 下班（长按确认 stop）
   - 底部：7 日趋势（占位）+ 设置（开设置窗）

   所有金额来自引擎整数分；React 不持有任何金额权威。
   仅复用共享类（.money/.btn/.chip/.label）；popover 专有布局在本文件顶层 <style> 内。
   ============================================================ */
import { useRef } from "react";
import type { JSX } from "react";
import { motion, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { useEngineTick } from "@/hooks/useEngineTick";
import { useEngineControls } from "@/hooks/useEngineControls";
import { useSettings } from "@/hooks/useSettings";
import { useStats, sumCents } from "@/hooks/useStats";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { Icon, useHoldToConfirm, moneyParts, ghostFor } from "@/pixel";
import { openSettingsWindow } from "@/shared/ipc";
import { currencySymbol } from "@/shared/format";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { EngineStatus } from "@/shared/types";

/* ---------- 状态 chip 文案 key（working→工作中 / paused→摸鱼 / idle→待机） ---------- */
function chipLabel(t: TFunction, status: EngineStatus): string {
  if (status === "working") return t("status.working");
  if (status === "paused") return t("status.paused");
  return t("status.idle");
}

/* ---------- 暂停/恢复按钮文案 key（working→摸鱼 / paused→恢复 / idle→上班） ---------- */
function toggleLabel(t: TFunction, status: EngineStatus): string {
  if (status === "working") return t("toggle.working");
  if (status === "paused") return t("toggle.paused");
  return t("toggle.idle");
}

/**
 * 把【整数分】格式化为「¥X / $X」紧凑串（网格小格用，无小数，进位安全）。
 * 货币符号随语言（symbol 由调用方按 settings.language 计算）。
 * 例：4879 分 → "¥48"。
 */
function compactYuan(t: TFunction, symbol: string, cents: number): string {
  const value = moneyParts(Math.max(0, cents), 0).whole;
  return t("money", { symbol, value });
}

/**
 * 把【每秒整数分】格式化为「+¥0.048 / +$0.048」串（3 位小数，正向收益绿色）。
 * 注意 perSecondCents 是「每秒分」，/100 得到「每秒元」；货币符号随语言。
 */
function perSecondYuan(
  t: TFunction,
  symbol: string,
  perSecondCents: number,
): string {
  const yuanPerSec = Math.max(0, perSecondCents) / 100;
  return t("perSecMoney", { symbol, value: yuanPerSec.toFixed(3) });
}

export default function App(): JSX.Element {
  const { sessionCents, perSecondCents, status, todaySpring } = useEngineTick();
  const { toggle, stop } = useEngineControls();
  const { settings } = useSettings();
  const { t } = useTranslation("popover");

  /* ---------- 语言同步（M7）：把 settings.language 写入 i18next 活动语言 ---------- */
  useI18n(settings?.language);

  /* ---------- 货币符号随语言（D2，不做汇率换算）：system 退化到 OS 语言 ---------- */
  const symbol = currencySymbol(settings?.language ?? "system");

  /* ---------- 主题应用（M6）：把已保存的 settings.theme 写入 <html data-theme> ---------- */
  useTheme(settings?.theme);

  // 真实统计：本周 / 本月聚合（整数分）→ 紧凑整数元（货币符号随语言）
  const week = useStats("week");
  const month = useStats("month");
  const weekYuan = t("money", {
    symbol,
    value: Math.round(sumCents(week.stats) / 100),
  });
  const monthYuan = t("money", {
    symbol,
    value: Math.round(sumCents(month.stats) / 100),
  });

  // 小数位数（同 mini）：默认 3 位
  const decimals = settings?.displayDecimals ?? 3;

  // 英雄数字：spring → 整数部分 / 小数部分 / ghost 串（全部经由 MotionValue，不触发 React 重渲染）
  const whole = useTransform(todaySpring, (v) =>
    moneyParts(Math.max(0, v), decimals).whole,
  );
  const dec = useTransform(todaySpring, (v) =>
    moneyParts(Math.max(0, v), decimals).dec,
  );
  const ghost = useTransform(todaySpring, (v) =>
    ghostFor(moneyParts(Math.max(0, v), decimals), decimals),
  );

  // 下班按钮：长按 800ms 确认（防误触）→ engine_stop
  const stopRef = useRef<HTMLButtonElement>(null);
  useHoldToConfirm(stopRef, { ms: 800, onConfirm: () => void stop() });

  const isWorking = status === "working";

  return (
    <div className="pop-root crt">
      {/* popover 专有布局样式（从设计稿 .popover/.pop-* 适配，不含 .scene/.menubar/.taskbar/.osbar） */}
      <style>{`
        html, body, #root { width: 100%; height: 100%; margin: 0; }
        /* 无边框透明窗口：覆盖 pixel.css 的不透明 body 背景（用 .popover-body 提升优先级） */
        body.popover-body { background: transparent; }
        /* 根容器铺满整个无边框窗口，像素面板风格 */
        .pop-root {
          width: 100%;
          min-height: 100vh;
          box-sizing: border-box;
          background: var(--panel);
          border: var(--b) solid var(--ink);
          box-shadow: 5px 5px 0 var(--hard);
          background-image: linear-gradient(45deg, var(--dither) 25%, transparent 25% 75%, var(--dither) 75%);
          background-size: var(--px) var(--px);
          display: flex;
          flex-direction: column;
        }
        /* 顶部英雄区 */
        .pop-top {
          padding: 12px 14px 8px;
          text-align: center;
          position: relative;
          border-bottom: 2px dashed var(--line);
        }
        .pop-top .money { font-size: 34px; }
        /* 2×2 指标网格 */
        .pop-grid { display: grid; grid-template-columns: 1fr 1fr; }
        .pop-grid .cell {
          padding: 9px 12px;
          border-right: 2px dashed var(--line);
          border-bottom: 2px dashed var(--line);
        }
        .pop-grid .cell:nth-child(2n) { border-right: none; }
        .cell .k {
          font-family: 'Silkscreen', sans-serif; font-size: 8px;
          letter-spacing: 1px; color: var(--ink-dim);
        }
        .cell .v { font-family: 'VT323', monospace; font-size: 19px; color: var(--ink); }
        .cell .v.g { color: var(--gain); }
        /* 控制行 */
        .pop-ctrls { display: flex; gap: 7px; padding: 11px 12px; }
        .pop-ctrls .btn { flex: 1; justify-content: center; font-size: 11px; padding: 8px; }
        /* 底部链接行 */
        .pop-foot { display: flex; gap: 7px; padding: 0 12px 12px; }
        .pop-foot .lk {
          flex: 1; justify-content: center; font-size: 10px; padding: 7px;
          background: var(--panel-2); color: var(--ink-dim);
        }
      `}</style>

      {/* ---------- 顶部：今日已赚 + 英雄数字 + 状态 chip ---------- */}
      <div className="pop-top">
        <div className="label">{t("today")}</div>
        <div className="money" style={{ marginTop: 4 }}>
          {/* 英雄数字货币符号随语言（zh→¥ / en→$） */}
          <span className="cur">{symbol}</span>
          {/* whole + dot + dec 必须都在 .lit 内，.lit 宽度才能与绝对定位的 ghost 对齐
              （否则 .digits 仅含整数、过窄，ghost 会向左溢出叠到 ¥ 上） */}
          <span className="digits">
            <motion.span className="seg-off" aria-hidden>
              {ghost}
            </motion.span>
            <span className="lit">
              <motion.span>{whole}</motion.span>
              {decimals > 0 ? (
                <>
                  <span className="dot">.</span>
                  <motion.span className="dec">{dec}</motion.span>
                </>
              ) : null}
            </span>
          </span>
        </div>
        <div
          className={`chip${isWorking ? " live" : ""}`}
          style={{ marginTop: 8, display: "inline-block" }}
        >
          {chipLabel(t, status)}
        </div>
      </div>

      {/* ---------- 2×2 指标网格 ---------- */}
      <div className="pop-grid">
        <div className="cell">
          <div className="k">{t("grid.session")}</div>
          {/* 本次会话累计（货币符号随语言，时长留待后续） */}
          <div className="v">{compactYuan(t, symbol, sessionCents)}</div>
        </div>
        <div className="cell">
          <div className="k">{t("grid.perSec")}</div>
          <div className="v g">{perSecondYuan(t, symbol, perSecondCents)}</div>
        </div>
        <div className="cell">
          <div className="k">{t("grid.week")}</div>
          {/* 本周聚合：get_stats("week") → 紧凑整数元 */}
          <div className="v">{weekYuan}</div>
        </div>
        <div className="cell">
          <div className="k">{t("grid.month")}</div>
          {/* 本月聚合：get_stats("month") → 紧凑整数元 */}
          <div className="v">{monthYuan}</div>
        </div>
      </div>

      {/* ---------- 控制行：暂停/恢复 + 下班（长按确认） ---------- */}
      <div className="pop-ctrls">
        <button
          className={`btn ${isWorking ? "pause" : "go"}`}
          onClick={() => void toggle(status)}
        >
          <Icon name={isWorking ? "pause" : "play"} size={12} />
          <span>{toggleLabel(t, status)}</span>
        </button>
        <button ref={stopRef} className="btn stop hold">
          <span>{t("clockOut")}</span>
        </button>
      </div>

      {/* ---------- 底部链接：7 日趋势（占位）+ 设置 ---------- */}
      <div className="pop-foot">
        {/* TODO：7 日趋势应打开主窗趋势页；当前先隐藏 popover 占位 */}
        <button className="lk btn" onClick={() => void getCurrentWindow().hide()}>
          <span>{t("trend")}</span>
        </button>
        <button className="lk btn" onClick={() => void openSettingsWindow()}>
          <span>{t("settings")}</span>
        </button>
      </div>
    </div>
  );
}
