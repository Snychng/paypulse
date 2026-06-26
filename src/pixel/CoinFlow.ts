/* ============================================================
   CoinFlow — "money floating in" 引擎（React 移植）
   从 design/sprites.js 的 CoinFlow() 忠实移植：
   从舞台边缘生成像素硬币/钞票，沿抛物线飞向目标并被吸收（脉冲环）。

   提供两种用法：
   1. createCoinFlow(stage, target, opts) — framework-agnostic 工厂，
      返回 { start, stop, burst } 句柄（与原型 API 一致）。
   2. useCoinFlow(targetRef, opts) — React hook：把硬币飞向 targetRef，
      stage 默认取 targetRef 最近的 `position: relative` 容器（offsetParent）。

   说明：这是运行时动画（非 workflow），保留原实现的 Math.random 用法。
   ============================================================ */
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { spriteSVG } from "./sprites";

/** 目标：可以是元素，或返回元素的函数（原型支持后者以应对目标位置变化） */
export type CoinFlowTarget = HTMLElement | (() => HTMLElement | null);

export interface CoinFlowOptions {
  /** 两次生成之间的最小间隔（ms） */
  minGap?: number;
  /** 两次生成之间的最大间隔（ms） */
  maxGap?: number;
  /** 精灵放大倍数 */
  scale?: number;
  /** 生成钞票（而非硬币）的概率 0–1 */
  billChance?: number;
  /** 允许的生成边：0=上 1=右 2=下 3=左 */
  edges?: readonly number[];
}

/** CoinFlow 实例句柄（与原型 start/stop/burst 对齐） */
export interface CoinFlowHandle {
  /** 开始周期性生成 */
  start: () => void;
  /** 一次性爆发 n 个（用于里程碑） */
  burst: (n?: number) => void;
  /** 停止生成（不影响已在途的动画自行结束） */
  stop: () => void;
}

const DEFAULTS: Required<CoinFlowOptions> = {
  minGap: 220,
  maxGap: 620,
  scale: 3,
  billChance: 0.18,
  edges: [0, 1, 2, 3],
};

interface Point {
  x: number;
  y: number;
}

/**
 * framework-agnostic 工厂：把硬币从 stage 边缘抛向 target 并吸收。
 * 不修改传入的 opts 对象（不可变：用展开合并默认值）。
 */
export function createCoinFlow(
  stage: HTMLElement,
  target: CoinFlowTarget,
  opts: CoinFlowOptions = {},
): CoinFlowHandle {
  const o: Required<CoinFlowOptions> = { ...DEFAULTS, ...opts };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;

  const center = (el: HTMLElement): Point => {
    const s = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  };

  const resolveTarget = (): HTMLElement | null =>
    typeof target === "function" ? target() : target;

  const pop = (tgt: Point): void => {
    const s = document.createElement("div");
    s.className = "absorb";
    // 吸收脉冲环：尺寸/定位走内联样式，动画（pulseRing）由 .absorb class 提供
    s.style.cssText = `left:${tgt.x}px;top:${tgt.y}px;width:10px;height:10px;margin:-5px;`;
    stage.appendChild(s);
    setTimeout(() => s.remove(), 420);
  };

  const spawn = (): void => {
    if (!alive) return;
    // M8: pause while the window is hidden (save CPU) and honor reduced-motion.
    // The loop keeps scheduling, so spawning resumes once visible / motion allowed.
    if (typeof document !== "undefined" && document.hidden) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const targetEl = resolveTarget();
    if (!targetEl) return;
    const tgt = center(targetEl);
    const sb = stage.getBoundingClientRect();
    const edge = o.edges[Math.floor(Math.random() * o.edges.length)] ?? 0;
    let sx: number;
    let sy: number;
    if (edge === 0) {
      sx = Math.random() * sb.width;
      sy = -16;
    } else if (edge === 1) {
      sx = sb.width + 16;
      sy = Math.random() * sb.height;
    } else if (edge === 2) {
      sx = Math.random() * sb.width;
      sy = sb.height + 16;
    } else {
      sx = -16;
      sy = Math.random() * sb.height;
    }

    const isBill = Math.random() < o.billChance;
    const el = document.createElement("div");
    el.className = "coinflow";
    el.innerHTML = isBill ? spriteSVG("bill", o.scale) : spriteSVG("coin", o.scale);
    stage.appendChild(el);

    const apexX = (sx + tgt.x) / 2 + (Math.random() * 40 - 20);
    const apexY = Math.min(sy, tgt.y) - (40 + Math.random() * 40);
    const dur = 820 + Math.random() * 620;
    const anim = el.animate(
      [
        { transform: `translate(${sx}px,${sy}px) scale(1)`, opacity: 0 },
        { transform: `translate(${apexX}px,${apexY}px) scale(1.1)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${tgt.x}px,${tgt.y}px) scale(.5)`, opacity: 0 },
      ],
      { duration: dur, easing: "cubic-bezier(.4,.05,.6,1)", fill: "forwards" },
    );
    // 像素自旋：作用于内部 <svg>
    const svg = el.firstElementChild as HTMLElement | null;
    if (svg) svg.style.animation = `spin3d ${260 + Math.random() * 200}ms steps(1) infinite`;
    anim.onfinish = () => {
      el.remove();
      pop(tgt);
    };
  };

  const loop = (): void => {
    if (!alive) return;
    spawn();
    timer = setTimeout(loop, o.minGap + Math.random() * (o.maxGap - o.minGap));
  };

  return {
    start() {
      alive = true;
      loop();
    },
    burst(n = 6) {
      for (let i = 0; i < n; i++) setTimeout(spawn, i * 80);
    },
    stop() {
      alive = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export interface UseCoinFlowOptions extends CoinFlowOptions {
  /**
   * 舞台容器：硬币在其坐标系内绝对定位（应为 position:relative/absolute）。
   * 省略时取 targetRef 的 offsetParent，再退化到 document.body。
   */
  stageRef?: RefObject<HTMLElement | null>;
  /** 是否自动随挂载 start（默认 true）；为 false 时通过返回的 handle 手动控制 */
  autoStart?: boolean;
}

/**
 * React hook：把像素硬币流飞向 targetRef 指向的元素。
 * 返回一个 ref，持有当前 CoinFlowHandle（可在事件回调里调用 burst/stop/start）。
 *
 * 注意：handle 仅在 effect 内创建，故返回 ref 的 .current 在首帧后才可用；
 * 上层应在用户交互（如里程碑）时再读取，而非渲染期间。
 */
export function useCoinFlow(
  targetRef: RefObject<HTMLElement | null>,
  opts: UseCoinFlowOptions = {},
): RefObject<CoinFlowHandle | null> {
  const handleRef = useRef<CoinFlowHandle | null>(null);
  // 把 opts 拆成稳定的依赖，避免对象字面量每帧触发重建
  const { stageRef, autoStart = true, minGap, maxGap, scale, billChance, edges } = opts;

  useEffect(() => {
    const targetEl = targetRef.current;
    if (!targetEl) return;
    const stage =
      stageRef?.current ?? (targetEl.offsetParent as HTMLElement | null) ?? document.body;

    const flowOpts: CoinFlowOptions = {};
    if (minGap !== undefined) flowOpts.minGap = minGap;
    if (maxGap !== undefined) flowOpts.maxGap = maxGap;
    if (scale !== undefined) flowOpts.scale = scale;
    if (billChance !== undefined) flowOpts.billChance = billChance;
    if (edges !== undefined) flowOpts.edges = edges;

    const handle = createCoinFlow(stage, () => targetRef.current, flowOpts);
    handleRef.current = handle;
    if (autoStart) handle.start();

    return () => {
      handle.stop();
      handleRef.current = null;
    };
    // edges 为数组，按引用比较；上层若内联请用稳定引用（useMemo）以避免重建
  }, [targetRef, stageRef, autoStart, minGap, maxGap, scale, billChance, edges]);

  return handleRef;
}
