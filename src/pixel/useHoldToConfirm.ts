/* ============================================================
   useHoldToConfirm — 长按确认（防误触）React hook
   从 design/sprites.js 的 holdToConfirm() 移植。

   行为：
   - 按住约 ms 毫秒触发 onConfirm（默认 800ms）
   - 斜纹 `.hold-fill` 用 WAAPI 从 0%→100% 充能
   - 松手 / 移出 / 取消 即中断，不触发
   - 单击（未按满）无效——click 事件被吞掉，防止误触
   - 充能完成后短暂 `.confirmed` 高亮再复位

   样式复用 design/pixel.css 的 `.btn.hold` / `.hold-fill` / `.holding` / `.confirmed`。
   目标按钮需带 `.btn.hold` class，内部文本建议包一层 <span>（见 .btn.hold > span 规则）。
   ============================================================ */
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export interface HoldToConfirmOptions {
  /** 长按时长（ms），默认 800 */
  ms?: number;
  /** 充能满后的回调 */
  onConfirm: () => void;
}

/**
 * 给一个 `.btn.hold` 按钮挂上长按确认逻辑。
 * @param ref 指向目标 <button> 的 ref
 */
export function useHoldToConfirm(
  ref: RefObject<HTMLElement | null>,
  { ms = 800, onConfirm }: HoldToConfirmOptions,
): void {
  const onConfirmRef = useRef(onConfirm);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    const btn = ref.current;
    if (!btn) return;

    // 确保存在充能条 .hold-fill（原型：若无则插到最前）
    let fill = btn.querySelector<HTMLElement>(".hold-fill");
    let injected = false;
    if (!fill) {
      fill = document.createElement("i");
      fill.className = "hold-fill";
      btn.insertBefore(fill, btn.firstChild);
      injected = true;
    }
    const fillEl = fill;

    let anim: Animation | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let confirmed = false;

    const reset = (): void => {
      btn.classList.remove("holding");
      if (anim) {
        anim.cancel();
        anim = null;
      }
    };

    const start = (e: PointerEvent): void => {
      // 仅响应鼠标左键；触控/笔放行
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      confirmed = false;
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
      btn.classList.remove("confirmed");
      if (anim) {
        anim.cancel();
        anim = null;
      }
      btn.classList.add("holding");
      anim = fillEl.animate([{ width: "0%" }, { width: "100%" }], {
        duration: ms,
        easing: "linear",
        fill: "forwards",
      });
      anim.onfinish = () => {
        if (confirmed) return;
        confirmed = true;
        btn.classList.remove("holding");
        btn.classList.add("confirmed");
        resetTimer = setTimeout(() => {
          btn.classList.remove("confirmed");
          if (anim) {
            anim.cancel();
            anim = null;
          }
        }, 460);
        onConfirmRef.current();
      };
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture 在某些环境下可能抛错，忽略即可 */
      }
    };

    // 单击什么都不做（吞掉 click，防误触）
    const swallowClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
    };

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", reset);
    btn.addEventListener("pointercancel", reset);
    btn.addEventListener("pointerleave", reset);
    btn.addEventListener("click", swallowClick);

    return () => {
      btn.removeEventListener("pointerdown", start);
      btn.removeEventListener("pointerup", reset);
      btn.removeEventListener("pointercancel", reset);
      btn.removeEventListener("pointerleave", reset);
      btn.removeEventListener("click", swallowClick);
      if (resetTimer) clearTimeout(resetTimer);
      if (anim) anim.cancel();
      btn.classList.remove("holding", "confirmed");
      // 仅清理本 hook 注入的充能条，避免影响外部预置的 .hold-fill
      if (injected) fillEl.remove();
    };
  }, [ref, ms]);
}
