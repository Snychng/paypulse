/* ============================================================
   src/mini/App.tsx — PayPulse 薪跳「置顶小窗 (mini)」React UI
   逐像素对齐 design/mini-window.html。本文件只负责 mini 窗口本体：
   - 标题栏（金币 + PayPulse + 设置/最小化）
   - 英雄数字（DSEG7 7 段，经 MotionValue 弹簧 60fps 平滑）
   - 状态 chip / ¥每秒 / session 子行 / 目标进度条 / 控制行
   - peek（不 hover 只露数字）/ compact（窄窗收起非核心）两种自适应
   - 原生拖拽 (data-tauri-drag-region) + 右下角缩放 grip
   - 每秒「心跳」：numJump + 波纹 + +¥rate 漂浮，工作时 CoinFlow 飞币

   数据流：全部金额为整数分，引擎为唯一真相源，本窗口零金额权威。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { motion, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useEngineTick } from "@/hooks/useEngineTick";
import { useSettings } from "@/hooks/useSettings";
import { useEngineControls } from "@/hooks/useEngineControls";
import { useTheme } from "@/hooks/useTheme";
import { useMilestone } from "@/hooks/useMilestone";
import { useI18n } from "@/hooks/useI18n";
import { openSettingsWindow } from "@/shared/ipc";
import { currencySymbol } from "@/shared/format";
import {
  Sprite,
  Icon,
  useCoinFlow,
  useHoldToConfirm,
  moneyParts,
  ghostFor,
} from "@/pixel";
import type { EngineStatus } from "@/shared/types";

/* ---------- 状态 → 文案 key 映射（值随 i18n 命名空间 "mini" 翻译） ---------- */
/** 状态 chip 文案 key：工作中 / 摸鱼中 / 待机 */
const STATUS_KEY: Readonly<Record<EngineStatus, "working" | "paused" | "idle">> =
  {
    idle: "idle",
    working: "working",
    paused: "paused",
  };

/** 切换按钮文案 key：随当前状态显示「下一步动作」标签 */
const TOGGLE_KEY: Readonly<
  Record<EngineStatus, "clockIn" | "slack" | "resume">
> = {
  idle: "clockIn",
  working: "slack",
  paused: "resume",
};

/* ---------- 小工具 ---------- */
/** 把整数秒格式化为 HH:MM:SS（session 计时显示） */
function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** 一条短暂的 +¥ 漂浮记录（用 key 自然销毁，不可变追加） */
interface GainFloater {
  id: number;
  text: string;
}

export default function App(): JSX.Element {
  const { todayCents, perSecondCents, status, sessionId, todaySpring } =
    useEngineTick();
  const { settings } = useSettings();
  const { toggle, stop } = useEngineControls();

  /* ---------- i18n（M7）：mini 命名空间 + 语言随设置切换 ---------- */
  const { t } = useTranslation("mini");
  useI18n(settings?.language);

  /* 货币符号随语言（D2：仅换符号，不做汇率换算） */
  const cur = currencySymbol(settings?.language ?? "system");
  const decimals = settings?.displayDecimals ?? 3;

  /* ---------- 主题应用（M6）：把已保存的 settings.theme 写入 <html data-theme> ---------- */
  useTheme(settings?.theme);

  /* ---------- 英雄数字：MotionValue → useTransform，避免每帧重渲 ---------- */
  const whole = useTransform(
    todaySpring,
    (v) => moneyParts(Math.max(0, v), decimals).whole,
  );
  const dec = useTransform(
    todaySpring,
    (v) => moneyParts(Math.max(0, v), decimals).dec,
  );
  /* ghost：定长 8 串，宽度跟随当前整数位宽度（同样走 MotionValue，零额外重渲） */
  const ghost = useTransform(todaySpring, (v) =>
    ghostFor(moneyParts(Math.max(0, v), decimals), decimals),
  );

  /* ---------- 每秒心跳：numJump + 波纹 + +¥rate 漂浮 ---------- */
  const moneyRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const [gains, setGains] = useState<readonly GainFloater[]>([]);
  const gainSeq = useRef(0);
  const gainTimers = useRef<Set<number>>(new Set());
  const lastTodayRef = useRef<number>(todayCents);

  useEffect(() => {
    // 仅在「工作中」且今日累计分发生变化（即 1Hz tick 推进）时触发节拍
    if (status !== "working") {
      lastTodayRef.current = todayCents;
      return;
    }
    if (todayCents === lastTodayRef.current) return;
    lastTodayRef.current = todayCents;

    // 数字弹跳（CSS numJump）：重置 animation 强制重放
    const moneyEl = moneyRef.current;
    if (moneyEl) {
      moneyEl.style.animation = "none";
      // 强制 reflow 以便重新触发动画
      void moneyEl.offsetWidth;
      moneyEl.style.animation = "numJump .42s steps(7)";
    }

    // 波纹脉冲环
    const rip = rippleRef.current;
    if (rip) {
      rip.classList.remove("go");
      void rip.offsetWidth;
      rip.classList.add("go");
    }

    // +货币rate 漂浮（金额取每秒分 → 货币单位，按小数位呈现；符号随语言）
    const rateText = `+${cur}${(perSecondCents / 100).toFixed(decimals)}`;
    const id = gainSeq.current++;
    setGains((prev) => [...prev, { id, text: rateText }]);
    // 自管理生命周期：到点后从 state 移除（不绑定到 effect 清理，避免每秒重渲取消上一条）
    const timer = window.setTimeout(() => {
      setGains((prev) => prev.filter((g) => g.id !== id));
      gainTimers.current.delete(timer);
    }, 1150);
    gainTimers.current.add(timer);
  }, [todayCents, status, perSecondCents, decimals, cur]);

  // 组件卸载时统一清理所有未到点的漂浮移除计时器
  useEffect(() => {
    const timers = gainTimers.current;
    return () => {
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  /* ---------- CoinFlow：工作时飞币吸向数字 ---------- */
  const coinOpts = useMemo(
    () => ({ minGap: 480, maxGap: 1100, scale: 3, autoStart: false }),
    [],
  );
  const flow = useCoinFlow(moneyRef, coinOpts);
  useEffect(() => {
    const handle = flow.current;
    if (!handle) return;
    if (status === "working") handle.start();
    else handle.stop();
    return () => handle.stop();
  }, [status, flow]);

  /* ---------- 里程碑庆祝（M6）：命中里程碑时触发一次硬币爆发 ---------- */
  // flow 是稳定 ref，无需进依赖数组（避免 exhaustive-deps 误加依赖）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const celebrate = useCallback(() => {
    flow.current?.burst(14);
  }, []);
  useMilestone(celebrate);

  /* ---------- 下班：长按确认（防误触） ---------- */
  const stopRef = useRef<HTMLButtonElement>(null);
  useHoldToConfirm(stopRef, { ms: 800, onConfirm: () => void stop() });

  /* ---------- 目标进度：今日已赚 / 日目标（占位 38300 分 = ¥383） ---------- */
  const goalCents = useMemo<number>(() => {
    // 优先用设置推算：月薪 / 月工作日 = 日目标；缺省回退占位值
    if (settings && settings.workdaysPerMonth > 0) {
      return Math.round(settings.monthlySalaryCents / settings.workdaysPerMonth);
    }
    return 38_300;
  }, [settings]);
  const goalPct = useMemo<number>(() => {
    if (goalCents <= 0) return 0;
    return Math.min(100, Math.round((todayCents / goalCents) * 100));
  }, [todayCents, goalCents]);

  /* ---------- session 计时：本地展示用计数器（非金额权威） ----------
     引擎未在 tick/snapshot 中提供 session 时长字段，故本地计时：
     - 仅在「工作中」每秒 +1；摸鱼/下班时冻结
     - sessionId 变化（新一段工作）时归零
     纯展示，不参与任何金额计算，符合「零金额权威」约束。 */
  const [elapsedSecs, setElapsedSecs] = useState<number>(0);
  const sessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    if (sessionId !== sessionIdRef.current) {
      sessionIdRef.current = sessionId;
      setElapsedSecs(0);
    }
    if (status !== "working") return;
    const timer = window.setInterval(() => {
      setElapsedSecs((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status, sessionId]);

  /* ---------- 透明度：跟随设置（透明开启时用 miniOpacityX100/100） ---------- */
  const miniOpacity =
    settings?.transparencyEnabled && typeof settings.miniOpacityX100 === "number"
      ? Math.max(0, Math.min(1, settings.miniOpacityX100 / 100))
      : 1;

  /* ---------- 控制按钮：图标 + 文案随状态切换 ---------- */
  const toggleIcon = status === "working" ? "pause" : "play";
  const toggleLabel = t(TOGGLE_KEY[status]);
  const statusLabel = t(STATUS_KEY[status]);
  const isLive = status === "working";

  return (
    <>
      <style>{MINI_CSS}</style>

      <div className="mini crt" id="win" style={{ opacity: miniOpacity }}>
        {/* ---------- 标题栏（可拖拽） ---------- */}
        <div className="titlebar" data-tauri-drag-region>
          <span className="logo" data-tauri-drag-region>
            <Sprite name="coin" scale={3} />
          </span>
          <span className="name" data-tauri-drag-region>
            Pay<span className="jp">Pulse</span>
          </span>
          <div className="tb-btns nodrag">
            <button
              type="button"
              className="tb-btn"
              data-tip={t("settings")}
              aria-label={t("settings")}
              onClick={(e) => {
                e.stopPropagation();
                void openSettingsWindow();
              }}
            >
              <Icon name="settings" size={13} />
            </button>
            <button
              type="button"
              className="tb-btn x"
              data-tip={t("minimize")}
              aria-label={t("minimize")}
              onClick={(e) => {
                e.stopPropagation();
                void getCurrentWindow().hide();
              }}
            >
              <Icon name="minimize" size={13} />
            </button>
          </div>
        </div>

        {/* ---------- 主体 ---------- */}
        <main className="body">
          <div className="statusline">
            <span className={`chip${isLive ? " live" : ""}`}>{statusLabel}</span>
            <span className="label grow" style={{ textAlign: "right" }}>
              {t("earnedToday")}
            </span>
          </div>

          {/* 英雄数字 + 波纹 + gain 漂浮（数字区也参与拖拽） */}
          <div className="readout" data-tauri-drag-region>
            <div className="money-wrap">
              <span className="ripple" ref={rippleRef} />
              <div className="money big" id="money" ref={moneyRef} data-tauri-drag-region>
                <span className="cur">{cur}</span>
                <span className="digits">
                  <motion.span className="seg-off" aria-hidden>
                    {ghost}
                  </motion.span>
                  <span className="lit">
                    <motion.span>{whole}</motion.span>
                    <span className="dot">.</span>
                    <motion.span className="dec">{dec}</motion.span>
                  </span>
                </span>
              </div>
              <div className="gainlayer">
                {gains.map((g) => (
                  <div key={g.id} className="gain run">
                    {g.text}
                  </div>
                ))}
              </div>
            </div>

            <div className="submeta">
              <span className="label">
                {cur}
                {t("perSec")} <b>{(perSecondCents / 100).toFixed(3)}</b>
              </span>
              <span className="label">{t("session")}</span>
              <b className="font-term sess">{formatDuration(elapsedSecs)}</b>
            </div>
          </div>

          {/* 目标进度条 */}
          <div className="goalrow">
            <div className="lbl">
              <span className="label">{t("dailyGoal")}</span>
              <span className="label">{goalPct}%</span>
            </div>
            <div className="bar">
              <i style={{ width: `${goalPct}%` }} />
            </div>
          </div>

          {/* 控制行：暂停/恢复 + 下班（长按确认） */}
          <div className="ctrls nodrag">
            <button
              type="button"
              className={`btn ${status === "working" ? "pause" : "go"}`}
              onClick={(e) => {
                e.stopPropagation();
                void toggle(status);
              }}
            >
              <Icon name={toggleIcon} size={13} />
              <span>{toggleLabel}</span>
            </button>
            <button type="button" ref={stopRef} className="btn stop hold">
              <Icon name="stop" size={13} />
              <span>{t("clockOut")}</span>
            </button>
          </div>
        </main>

        {/* 右下角缩放 grip：原生窗口缩放（SouthEast 方向） */}
        <div
          className="resize nodrag"
          aria-label="resize"
          onPointerDown={(e) => {
            e.stopPropagation();
            // ResizeDirection 在 @tauri-apps/api 未导出为值，直接传字符串字面量
            void getCurrentWindow().startResizeDragging("SouthEast");
          }}
        />
      </div>
    </>
  );
}

/* ============================================================
   mini 专有布局样式（适配自 design/mini-window.html 的 <style>）
   仅保留窗口本体相关；演示用桌面壁纸 (.wall/.desk-hint/body.desktop)
   一律不搬——真实窗口透明叠在桌面之上。
   共享组件类（.money/.btn/.chip/.bar/.label…）来自 pixel.css。
   ============================================================ */
const MINI_CSS = `
/* 让透明窗口铺满整个 webview，且本身透明（叠在桌面上） */
#win.mini {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 170px;
  container-type: inline-size;
  background: var(--panel);
  border: var(--b) solid var(--ink);
  box-shadow: 6px 6px 0 0 var(--hard), 0 0 0 1px #0006;
  background-image: linear-gradient(45deg, var(--dither) 25%, transparent 25% 75%, var(--dither) 75%);
  background-size: var(--px) var(--px);
  transition: opacity .12s steps(2);
  overflow: hidden;
}

/* 右下角像素缩放 grip（hover 显示） */
.resize {
  position: absolute; right: 2px; bottom: 2px; width: 15px; height: 15px; z-index: 30;
  cursor: nwse-resize; opacity: 0; transition: opacity .15s ease;
  background: linear-gradient(135deg, transparent 0 42%, var(--ink-dim) 42% 56%, transparent 56% 70%, var(--ink-dim) 70% 84%, transparent 84%);
}
#win:hover .resize { opacity: .8; }
.resize:hover { opacity: 1 !important; }

.titlebar {
  display: flex; align-items: center; gap: 7px; padding: 6px 7px;
  background: var(--inset); border-bottom: var(--b) solid var(--ink); cursor: grab;
}
.titlebar:active { cursor: grabbing; }
.titlebar .logo { display: inline-flex; line-height: 0; }
.titlebar .name { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 13px; letter-spacing: 1px; }
.titlebar .name .jp { color: var(--money); }
.tb-btns { display: flex; gap: 4px; margin-left: auto; }
.tb-btn {
  width: 22px; height: 22px; display: grid; place-items: center; color: var(--ink-dim);
  background: var(--panel-2); border: 2px solid var(--ink);
}
.tb-btn:hover { color: var(--money); }
.tb-btn.x:hover { color: var(--danger); }

main.body { padding: 14px 16px 16px; position: relative; }
.statusline { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.readout { position: relative; text-align: center; padding: 6px 0 2px; cursor: grab; }
.money-wrap { position: relative; display: inline-block; }
.ripple {
  position: absolute; left: 50%; top: 52%; width: 50px; height: 50px; margin: -25px;
  border: var(--b) solid var(--gain); border-radius: 50%; opacity: 0; pointer-events: none;
}
.ripple.go { animation: pulseRing .6s steps(6) forwards; }
.money.big { font-size: clamp(22px, 14cqw, 58px); letter-spacing: 1px; }
.money.big .digits { display: inline-block; }
.gainlayer { position: absolute; left: 0; right: 0; top: 0; pointer-events: none; }
.gain {
  position: absolute; left: 50%; top: 0; transform: translateX(-50%);
  font-family: 'Pixelify Sans'; font-weight: 700; font-size: 15px; color: var(--gain);
  text-shadow: 2px 2px 0 var(--inset); pointer-events: none;
}
.gain.run { animation: gainFloat 1.1s steps(11) forwards; }
.submeta { display: flex; justify-content: center; align-items: baseline; gap: 12px; margin-top: 8px; color: var(--ink-dim); }
.submeta b { color: var(--accentA); font-family: 'VT323'; font-size: 16px; }

.goalrow { margin: 12px 0 6px; }
.goalrow .lbl { display: flex; justify-content: space-between; margin-bottom: 4px; }
.ctrls { display: flex; gap: 8px; margin-top: 12px; }
.ctrls .btn { flex: 1; justify-content: center; }

/* ---- peek 模式：不 hover 时只露 ¥+数字+动效，hover 展开完整 UI ---- */
.titlebar, .statusline, .submeta, .goalrow, .ctrls {
  transition: opacity .16s ease, max-height .22s ease, margin .22s ease, padding .18s ease, border-width .18s ease;
  overflow: hidden;
}
.titlebar { max-height: 48px; }
.statusline { max-height: 36px; }
.submeta { max-height: 44px; }
.goalrow { max-height: 52px; }
.ctrls { max-height: 60px; }
#win:not(:hover) .titlebar,
#win:not(:hover) .statusline,
#win:not(:hover) .submeta,
#win:not(:hover) .goalrow,
#win:not(:hover) .ctrls {
  opacity: 0; max-height: 0; margin-top: 0; margin-bottom: 0;
  padding-top: 0; padding-bottom: 0; pointer-events: none;
}
#win:not(:hover) .titlebar { border-bottom-width: 0; }
#win:not(:hover) main.body { padding: 12px 18px; }
#win { transition: opacity .12s steps(2); }

/* ---- compact 模式：窄窗只留 标题栏 + 数字 + 纯进度条 + 暂停/下班 ---- */
@container (max-width: 250px) {
  .statusline { display: none; }
  .submeta { display: none; }
  .goalrow .lbl { display: none; }
  .goalrow { margin: 10px 0 4px; }
  main.body { padding: 12px 12px 12px; }
  .ctrls .btn { font-size: 11px; padding: 8px; }
  .titlebar .name { font-size: 12px; }
}
`;
