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
import type {
  CSSProperties,
  JSX,
  PointerEvent as ReactPointerEvent,
} from "react";
import { motion, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";
import { cursorPosition, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

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

const MINI_MIN_WIDTH = 170;
const MINI_MIN_HEIGHT = 56;
const MINI_FALLBACK_PEEK_HEIGHT = 74;
const MINI_FALLBACK_EXPANDED_HEIGHT = 320;
const MINI_EXPANDED_SHADOW_PAD = 12;
const EXPANDED_SIZE_STORAGE_KEY = "paypulse:mini:expanded-size";
const LEGACY_EXPANDED_HEIGHT_STORAGE_KEY = "paypulse:mini:expanded-height";

type MiniWindowMode = "peek" | "expanded";

interface MiniSize {
  width: number;
  height: number;
}

/* ---------- 小工具 ---------- */
/** 把整数秒格式化为 HH:MM:SS（session 计时显示） */
function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function clampMiniWidth(width: number): number {
  return Math.max(MINI_MIN_WIDTH, Math.round(width));
}

function clampMiniHeight(height: number): number {
  return Math.max(MINI_MIN_HEIGHT, Math.round(height));
}

function normalizeMiniSize(size: MiniSize): MiniSize {
  return {
    width: clampMiniWidth(size.width),
    height: clampMiniHeight(size.height),
  };
}

function isSameMiniSize(a: MiniSize | null, b: MiniSize): boolean {
  return a?.width === b.width && a.height === b.height;
}

function readStoredExpandedSize(): MiniSize | null {
  try {
    const raw = window.localStorage.getItem(EXPANDED_SIZE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MiniSize>;
      if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
        return {
          width: clampMiniWidth(parsed.width ?? 300),
          height: clampMiniHeight(parsed.height ?? MINI_FALLBACK_EXPANDED_HEIGHT),
        };
      }
    }

    // 兼容上一版只保存高度的数据，避免用户已有偏好丢失。
    const legacyRaw = window.localStorage.getItem(LEGACY_EXPANDED_HEIGHT_STORAGE_KEY);
    const legacyHeight = legacyRaw ? Number.parseInt(legacyRaw, 10) : Number.NaN;
    if (Number.isFinite(legacyHeight)) {
      return {
        width: 300,
        height: clampMiniHeight(legacyHeight),
      };
    }

    return null;
  } catch {
    return null;
  }
}

function storeExpandedSize(size: MiniSize): void {
  const normalized = {
    width: clampMiniWidth(size.width),
    height: clampMiniHeight(size.height),
  };
  try {
    window.localStorage.setItem(EXPANDED_SIZE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* localStorage 在极少数受限环境下不可用，运行期 ref 仍能保留。 */
  }
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
  const winRef = useRef<HTMLDivElement>(null);
  const [windowMode, setWindowMode] = useState<MiniWindowMode>("peek");
  const [miniSize, setMiniSize] = useState<MiniSize>({
    width: 300,
    height: MINI_FALLBACK_PEEK_HEIGHT,
  });
  const visualModeRef = useRef<MiniWindowMode>("peek");
  const targetModeRef = useRef<MiniWindowMode>("peek");
  const cursorInsideRef = useRef(false);
  const nativeTransitionSeqRef = useRef(0);
  const nativeResizingRef = useRef(false);
  const preferredExpandedSizeRef = useRef<MiniSize | null>(readStoredExpandedSize());
  const saveExpandedSizeTimerRef = useRef<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

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

  const rememberExpandedSize = useCallback(
    (size: MiniSize, options?: { persistNow?: boolean }): void => {
      const next = normalizeMiniSize(size);
      const changed = !isSameMiniSize(preferredExpandedSizeRef.current, next);
      preferredExpandedSizeRef.current = next;

      if (options?.persistNow) {
        if (saveExpandedSizeTimerRef.current !== null) {
          window.clearTimeout(saveExpandedSizeTimerRef.current);
          saveExpandedSizeTimerRef.current = null;
        }
        storeExpandedSize(next);
        return;
      }

      if (!changed) return;
      if (saveExpandedSizeTimerRef.current !== null) {
        window.clearTimeout(saveExpandedSizeTimerRef.current);
        saveExpandedSizeTimerRef.current = null;
      }
      saveExpandedSizeTimerRef.current = window.setTimeout(() => {
        saveExpandedSizeTimerRef.current = null;
        const latest = preferredExpandedSizeRef.current;
        if (latest) storeExpandedSize(latest);
      }, 160);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (saveExpandedSizeTimerRef.current !== null) {
        window.clearTimeout(saveExpandedSizeTimerRef.current);
        saveExpandedSizeTimerRef.current = null;
      }
    };
  }, []);

  /* ---------- 实时尺寸观测：拖拽过程中也同步进入布局分档 ---------- */
  useEffect(() => {
    const el = winRef.current;
    if (!el) return;

    const applyObservedSize = (next: MiniSize): void => {
      setMiniSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );

      // 只记录 expanded/手动拖拽下的真实尺寸；peek 的自动收缩高度不能污染用户偏好。
      if (visualModeRef.current === "expanded" || nativeResizingRef.current) {
        rememberExpandedSize(next);
      }
    };

    const read = (): void => {
      const rect = el.getBoundingClientRect();
      applyObservedSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    read();
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) {
        read();
        return;
      }
      applyObservedSize({
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    });
    ro.observe(el);

    return () => ro.disconnect();
  }, [rememberExpandedSize]);

  /* ---------- 原生窗口 peek：对齐原型的 hover 收放 ----------
     这里不能让 CSS :hover 和 Tauri setSize 各走各的：setSize 是异步的，二者
     不同步就会出现「视觉已展开但窗口还没长高」的裁切。改为单一 mode 驱动，
     并用隐藏克隆按当前宽度测自然高度，避免手写高度常量继续漂。 */
  const setVisualWindowMode = useCallback((mode: MiniWindowMode): void => {
    visualModeRef.current = mode;
    setWindowMode(mode);
  }, []);

  const measureMiniHeight = useCallback((mode: MiniWindowMode, width: number): number => {
    const winEl = winRef.current;
    if (!winEl) {
      return mode === "expanded"
        ? MINI_FALLBACK_EXPANDED_HEIGHT
        : MINI_FALLBACK_PEEK_HEIGHT;
    }

    const clone = winEl.cloneNode(true) as HTMLElement;
    clone.classList.remove(
      "is-peek",
      "is-expanded",
      "is-w-compact",
      "is-w-tiny",
      "is-h-compact",
      "is-h-short",
      "is-h-tight",
      "is-h-tiny",
      "is-h-micro",
    );
    clone.classList.add(mode === "expanded" ? "is-expanded" : "is-peek");
    clone.style.position = "fixed";
    clone.style.left = "-10000px";
    clone.style.top = "0";
    clone.style.width = `${width}px`;
    clone.style.height = "auto";
    clone.style.minWidth = `${MINI_MIN_WIDTH}px`;
    clone.style.visibility = "hidden";
    clone.style.pointerEvents = "none";
    clone.style.opacity = "1";
    clone.style.transition = "none";
    clone.querySelectorAll<HTMLElement>(".titlebar, .statusline, .submeta, .goalrow, .ctrls")
      .forEach((el) => {
        el.style.transition = "none";
      });

    document.body.appendChild(clone);
    const measured = Math.ceil(clone.getBoundingClientRect().height);
    clone.remove();

    const shadowPad = mode === "expanded" ? MINI_EXPANDED_SHADOW_PAD : 0;
    const fallback =
      mode === "expanded" ? MINI_FALLBACK_EXPANDED_HEIGHT : MINI_FALLBACK_PEEK_HEIGHT;
    const naturalHeight = Math.max(1, measured || fallback) + shadowPad;
    return mode === "peek" ? Math.max(fallback, naturalHeight) : naturalHeight;
  }, []);

  const setNativeWindowMode = useCallback(
    async (mode: MiniWindowMode, options?: { force?: boolean }): Promise<void> => {
      if (nativeResizingRef.current) return;
      if (
        !options?.force &&
        targetModeRef.current === mode &&
        visualModeRef.current === mode
      ) {
        return;
      }

      targetModeRef.current = mode;
      const seq = ++nativeTransitionSeqRef.current;

      try {
        const win = getCurrentWindow();
        const [physicalSize, scaleFactor] = await Promise.all([
          win.innerSize(),
          win.scaleFactor(),
        ]);
        const logicalSize = physicalSize.toLogical(scaleFactor);
        const currentWidth = clampMiniWidth(logicalSize.width);
        const preferredSize = preferredExpandedSizeRef.current;
        const width =
          mode === "expanded" && preferredSize
            ? clampMiniWidth(preferredSize.width)
            : currentWidth;
        const height =
          mode === "expanded"
            ? clampMiniHeight(preferredSize?.height ?? measureMiniHeight("expanded", width))
            : measureMiniHeight("peek", width);

        // 收缩时先切视觉状态，避免小窗变矮时仍显示完整控制区导致裁切。
        if (mode === "peek") setVisualWindowMode("peek");

        if (seq !== nativeTransitionSeqRef.current) return;
        await win.setSize(new LogicalSize(width, height));
        if (seq !== nativeTransitionSeqRef.current || targetModeRef.current !== mode) return;

        // 展开时先长高原生窗口，再显示完整 UI，彻底规避图二的中间态。
        setVisualWindowMode(mode);
      } catch {
        // 浏览器预览环境没有 Tauri window，仍允许用视觉状态检查布局。
        setVisualWindowMode(mode);
      }
    },
    [measureMiniHeight, setVisualWindowMode],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void setNativeWindowMode("peek", { force: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [setNativeWindowMode]);

  /* WebView 在窗口未激活时不一定收到 mouseenter；轮询系统光标位置兜底。 */
  useEffect(() => {
    let disposed = false;
    let busy = false;

    const tick = async (): Promise<void> => {
      if (disposed || busy || nativeResizingRef.current) return;
      busy = true;
      try {
        const win = getCurrentWindow();
        const [pos, size, cursor] = await Promise.all([
          win.outerPosition(),
          win.outerSize(),
          cursorPosition(),
        ]);
        const inside =
          cursor.x >= pos.x &&
          cursor.x <= pos.x + size.width &&
          cursor.y >= pos.y &&
          cursor.y <= pos.y + size.height;
        const nextMode: MiniWindowMode = inside ? "expanded" : "peek";
        const crossedWindowEdge = cursorInsideRef.current !== inside;
        cursorInsideRef.current = inside;

        if (
          crossedWindowEdge ||
          targetModeRef.current !== nextMode ||
          visualModeRef.current !== nextMode
        ) {
          await setNativeWindowMode(nextMode, { force: crossedWindowEdge });
        }
      } catch {
        /* 浏览器预览/权限边界下不可用，保留 DOM mouseenter/mouseleave。 */
      } finally {
        busy = false;
      }
    };

    const id = window.setInterval(() => {
      void tick();
    }, 140);
    void tick();

    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [setNativeWindowMode]);

  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();

      const grip = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      nativeResizingRef.current = true;
      setIsResizing(true);

      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* 浏览器/Tauri 某些边界下可能不支持，后续 window 监听仍能兜住拖拽。 */
      }

      void (async () => {
        let win: ReturnType<typeof getCurrentWindow>;
        try {
          win = getCurrentWindow();
        } catch {
          nativeResizingRef.current = false;
          setIsResizing(false);
          return;
        }
        let startWidth = 0;
        let startHeight = 0;
        let nextWidth = 0;
        let nextHeight = 0;
        let latestDx = 0;
        let latestDy = 0;
        let ready = false;
        let finished = false;
        let raf = 0;

        const applyWidth = (): void => {
          raf = 0;
          if (!ready || finished) return;
          void win.setSize(new LogicalSize(nextWidth, nextHeight));
        };
        const queueSize = (dx: number, dy: number): void => {
          latestDx = dx;
          latestDy = dy;
          if (!ready) return;
          nextWidth = clampMiniWidth(startWidth + latestDx);
          nextHeight = clampMiniHeight(startHeight + latestDy);
          rememberExpandedSize({
            width: nextWidth,
            height: nextHeight,
          });
          if (raf === 0) raf = window.requestAnimationFrame(applyWidth);
        };
        const finishResize = (): void => {
          if (finished) return;
          finished = true;
          if (raf !== 0) {
            window.cancelAnimationFrame(raf);
            if (ready) void win.setSize(new LogicalSize(nextWidth, nextHeight));
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", finishResize);
          window.removeEventListener("pointercancel", finishResize);
          window.removeEventListener("blur", finishResize);
          nativeResizingRef.current = false;
          setIsResizing(false);
          if (ready) {
            rememberExpandedSize({
              width: nextWidth,
              height: nextHeight,
            }, { persistNow: true });
          }
          const stillHovering = document.getElementById("win")?.matches(":hover") ?? false;
          targetModeRef.current = stillHovering ? "expanded" : "peek";
          setVisualWindowMode(targetModeRef.current);
        };
        const onMove = (ev: PointerEvent): void => {
          queueSize(ev.clientX - startX, ev.clientY - startY);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", finishResize, { once: true });
        window.addEventListener("pointercancel", finishResize, { once: true });
        window.addEventListener("blur", finishResize, { once: true });

        try {
          const [physicalSize, scaleFactor] = await Promise.all([
            win.innerSize(),
            win.scaleFactor(),
          ]);
          if (finished) return;
          const logicalSize = physicalSize.toLogical(scaleFactor);
          startWidth = logicalSize.width;
          startHeight = logicalSize.height;
          nextWidth = startWidth;
          nextHeight = startHeight;
          ready = true;
          queueSize(latestDx, latestDy);
        } catch {
          finishResize();
        }
      })();
    },
    [rememberExpandedSize, setVisualWindowMode],
  );

  const handleWindowDragPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (nativeResizingRef.current || e.button !== 0) return;
      if (
        e.target instanceof Element &&
        e.target.closest(".nodrag, button, input, textarea, select, a, [contenteditable='true']")
      ) {
        return;
      }

      e.preventDefault();
      if (visualModeRef.current !== "expanded") {
        cursorInsideRef.current = true;
        void setNativeWindowMode("expanded", { force: true });
        return;
      }

      try {
        void getCurrentWindow().startDragging();
      } catch {
        /* 浏览器预览环境没有原生窗口，禁选中文案即可。 */
      }
    },
    [setNativeWindowMode],
  );

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
  const moneySize = Math.round(
    Math.max(
      20,
      Math.min(
        58,
        miniSize.width * 0.14,
        miniSize.height * (windowMode === "peek" ? 0.58 : 0.22),
      ),
    ),
  );
  const sizeClasses = [
    isResizing ? "is-resizing" : "",
    miniSize.width <= 250 ? "is-w-compact" : "",
    miniSize.width <= 210 ? "is-w-tiny" : "",
    miniSize.height <= 300 ? "is-h-compact" : "",
    miniSize.height <= 270 ? "is-h-short" : "",
    miniSize.height <= 220 ? "is-h-tight" : "",
    miniSize.height <= 175 ? "is-h-tiny" : "",
    miniSize.height <= 135 ? "is-h-micro" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const miniStyle = {
    opacity: miniOpacity,
    "--mini-money-size": `${moneySize}px`,
  } as CSSProperties;

  return (
    <>
      <style>{MINI_CSS}</style>

      <div
        ref={winRef}
        className={`mini crt ${
          windowMode === "expanded" ? "is-expanded" : "is-peek"
        } ${sizeClasses}`}
        id="win"
        style={miniStyle}
        onMouseEnter={() => {
          cursorInsideRef.current = true;
          void setNativeWindowMode("expanded", { force: true });
        }}
        onPointerMove={() => {
          if (nativeResizingRef.current) return;
          cursorInsideRef.current = true;
          if (targetModeRef.current !== "expanded" || visualModeRef.current !== "expanded") {
            void setNativeWindowMode("expanded", { force: true });
          }
        }}
        onMouseLeave={() => {
          cursorInsideRef.current = false;
          void setNativeWindowMode("peek");
        }}
      >
        {/* ---------- 标题栏（可拖拽） ---------- */}
        <div
          className="titlebar"
          data-tauri-drag-region
          onPointerDown={handleWindowDragPointerDown}
        >
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
          <div
            className="readout"
            data-tauri-drag-region
            onPointerDown={handleWindowDragPointerDown}
          >
            <div className="money-wrap" data-tauri-drag-region>
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

            <div className="submeta" data-tauri-drag-region>
              <span className="meta-item meta-rate" data-tauri-drag-region>
                <span className="label meta-label" data-tauri-drag-region>
                  {cur}
                  {t("perSec")}
                </span>
                <b className="meta-value" data-tauri-drag-region>
                  {(perSecondCents / 100).toFixed(3)}
                </b>
              </span>
              <span className="meta-item meta-session" data-tauri-drag-region>
                <span className="label meta-label" data-tauri-drag-region>
                  {t("session")}
                </span>
                <b className="meta-value font-term sess" data-tauri-drag-region>
                  {formatDuration(elapsedSecs)}
                </b>
              </span>
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
              <span className="btn-label">{toggleLabel}</span>
            </button>
            <button type="button" ref={stopRef} className="btn stop hold">
              <Icon name="stop" size={13} />
              <span className="btn-label">{t("clockOut")}</span>
            </button>
          </div>
        </main>

        {/* 右下角缩放 grip：原生窗口缩放（SouthEast 方向） */}
        <div
          className="resize nodrag"
          aria-label="resize"
          onPointerDown={handleResizePointerDown}
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
  display: flex;
  flex-direction: column;
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
  -webkit-user-select: none;
  user-select: none;
}

/* 右下角像素缩放 grip（hover 显示） */
.resize {
  position: absolute; right: 2px; bottom: 2px; width: 15px; height: 15px; z-index: 30;
  cursor: nwse-resize; opacity: 0; transition: opacity .15s ease;
  background: linear-gradient(135deg, transparent 0 42%, var(--ink-dim) 42% 56%, transparent 56% 70%, var(--ink-dim) 70% 84%, transparent 84%);
}
#win.is-expanded .resize { opacity: .8; }
.resize:hover { opacity: 1 !important; }

.titlebar {
  flex: none;
  display: flex; align-items: center; gap: 7px; padding: 6px 7px;
  background: var(--inset); border-bottom: var(--b) solid var(--ink); cursor: grab;
  min-height: 0;
  -webkit-user-select: none;
  user-select: none;
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

main.body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 16px 16px;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  overflow: hidden;
}
.statusline { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.readout {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  text-align: center;
  padding: 4px 0 2px;
  cursor: grab;
  display: flex;
  flex-direction: column;
  justify-content: center;
  -webkit-user-select: none;
  user-select: none;
}
.readout:active { cursor: grabbing; }
.money-wrap { position: relative; display: inline-block; }
.ripple {
  position: absolute; left: 50%; top: 52%; width: 50px; height: 50px; margin: -25px;
  border: var(--b) solid var(--gain); border-radius: 50%; opacity: 0; pointer-events: none;
}
.ripple.go { animation: pulseRing .6s steps(6) forwards; }
.money.big { font-size: var(--mini-money-size, clamp(22px, 14cqw, 58px)); letter-spacing: 1px; }
.money.big .digits { display: inline-block; }
.gainlayer { position: absolute; left: 0; right: 0; top: 0; pointer-events: none; }
.gain {
  position: absolute; left: 50%; top: 0; transform: translateX(-50%);
  font-family: 'Pixelify Sans'; font-weight: 700; font-size: 15px; color: var(--gain);
  text-shadow: 2px 2px 0 var(--inset); pointer-events: none;
}
.gain.run { animation: gainFloat 1.1s steps(11) forwards; }
.submeta {
  width: 100%;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 12px;
  margin-top: 8px;
  color: var(--ink-dim);
  white-space: nowrap;
}
.submeta .meta-item {
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.submeta .meta-label {
  flex: none;
}
.submeta .meta-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.submeta b { color: var(--accentA); font-family: 'VT323'; font-size: 16px; }

.goalrow { margin: 12px 0 6px; }
.goalrow .lbl { display: flex; justify-content: space-between; margin-bottom: 4px; }
.ctrls { display: flex; gap: 8px; margin-top: 12px; }
.ctrls .btn {
  flex: 1;
  min-width: 0;
  justify-content: center;
  white-space: nowrap;
  overflow: hidden;
}
.ctrls .btn svg { flex: none; }
.ctrls .btn .btn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.btn.hold svg { position: relative; z-index: 2; }

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
#win.is-peek .titlebar,
#win.is-peek .statusline,
#win.is-peek .submeta,
#win.is-peek .goalrow,
#win.is-peek .ctrls {
  opacity: 0; max-height: 0; margin-top: 0; margin-bottom: 0;
  padding-top: 0; padding-bottom: 0; pointer-events: none;
}
#win.is-peek .titlebar { border-bottom-width: 0; }
#win.is-peek main.body {
  padding: 0 18px;
  justify-content: center;
}
#win.is-peek .readout {
  width: 100%;
  padding: 0;
  display: grid;
  place-items: center;
}
#win.is-peek .money-wrap {
  width: 100%;
  display: grid;
  place-items: center;
  transform: translateY(2px);
}
#win.is-peek .money.big {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
  line-height: 1;
}
#win.is-peek .money.big .cur {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
#win.is-peek .submeta {
  display: none;
}
#win { transition: opacity .12s steps(2); }

/* ---- 实时尺寸自适应：高度/宽度不足时逐级让出空间，避免拖拽中溢出 ---- */
#win.is-h-compact .statusline,
#win.is-w-compact .statusline {
  display: none;
}
#win.is-h-short .submeta .meta-label,
#win.is-w-compact .submeta .meta-label {
  display: none;
}
#win.is-h-tight .submeta {
  display: none;
}
#win.is-h-tight .goalrow .lbl,
#win.is-w-compact .goalrow .lbl {
  display: none;
}
#win.is-h-tight main.body,
#win.is-w-compact main.body {
  padding: 10px 12px 12px;
  gap: 6px;
}
#win.is-h-tight .goalrow {
  margin: 4px 0 2px;
}
#win.is-h-tight .gain,
#win.is-w-compact .gain {
  display: none;
}
#win.is-resizing .gainlayer,
#win.is-resizing .coinflow,
#win.is-resizing .absorb,
#win.is-resizing .ripple,
#win.is-h-tight .coinflow,
#win.is-h-tight .absorb,
#win.is-w-compact .coinflow,
#win.is-w-compact .absorb {
  display: none;
}
#win.is-h-tiny .goalrow {
  display: none;
}
#win.is-h-tight .ctrls .btn-label,
#win.is-w-tiny .ctrls .btn-label {
  display: none;
}
#win.is-h-tight .ctrls,
#win.is-w-tiny .ctrls {
  gap: 6px;
  margin-top: 4px;
}
#win.is-h-tight .ctrls .btn,
#win.is-w-tiny .ctrls .btn {
  flex: 1 1 0;
  min-width: 0;
  height: 34px;
  padding: 0 8px;
  justify-content: center;
}
#win.is-h-micro .titlebar {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-bottom-width: 0;
  pointer-events: none;
}
#win.is-h-micro main.body {
  padding: 6px 8px;
  gap: 4px;
}
#win.is-h-micro .readout {
  padding: 0;
}
#win.is-h-micro .ctrls .btn {
  height: 30px;
  padding: 0 6px;
}

/* ---- compact 模式：窄窗只留 标题栏 + 数字 + 纯进度条 + 暂停/下班 ---- */
@container (max-width: 250px) {
  .statusline { display: none; }
  .submeta .meta-label { display: none; }
  .goalrow .lbl { display: none; }
  .goalrow { margin: 10px 0 4px; }
  main.body { padding: 10px 12px 12px; gap: 6px; }
  .ctrls .btn { font-size: 11px; padding: 8px; }
  .titlebar .name { font-size: 12px; }
}

@container (max-width: 210px) {
  .titlebar .name { display: none; }
  .tb-btns { gap: 3px; }
  .tb-btn { width: 20px; height: 20px; }
  .submeta { gap: 8px; }
  .ctrls .btn-label { display: none; }
  .ctrls { gap: 6px; }
  .ctrls .btn {
    flex: 1 1 0;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    justify-content: center;
  }
}
`;
