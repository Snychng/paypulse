/* ============================================================
   money.ts — 像素金额格式化（进位安全）
   复刻 design/sprites.js 的 splitMoney(n, decimals)。

   ⚠️ 单位差异，切勿混用：
   - 本文件的 `splitMoney(n, decimals)` 接收【货币单位数值】（如 238.71 元），
     与原型 sprites.js 完全一致——用于直接对接原型驱动逻辑（earnings 浮点累加）。
   - src/shared/format.ts 的 `moneyParts(cents, decimals)` 接收【整数分】
     （如 23871 分），是引擎/IPC 层的权威实现（避免浮点累计误差）。

   两者算法同构（floor + 四舍五入 + 进位边界处理），仅输入单位不同。
   生产代码若数据源是整数分，请用 `moneyParts`；若是原型式浮点元，用 `splitMoney`。
   ============================================================ */
import { moneyParts, ghostFor } from "../shared/format";
import type { MoneyParts } from "../shared/format";

/** 与 shared/format 对齐的返回类型（whole 已分组、dec 为定长小数串） */
export type { MoneyParts };

/**
 * 把【货币单位数值】拆分为显示用的整数 + 小数部分（进位安全）。
 * 等价于原型 sprites.js 的 splitMoney。
 *
 * @param n        货币单位数值（如 238.71）
 * @param decimals 小数位数 0–4，默认 2
 * @example splitMoney(238.71, 3) // => { whole: "238", dec: "710" }
 * @example splitMoney(0.9996, 3) // => { whole: "1",   dec: "000" } （进位边界）
 */
export function splitMoney(n: number, decimals = 2): MoneyParts {
  let whole = Math.floor(n);
  const f = Math.pow(10, decimals);
  let frac = Math.round((n - whole) * f);
  if (frac >= f) {
    // 四舍五入进位边界（如 .9996 → +1）
    whole += 1;
    frac -= f;
  }
  const dec = decimals > 0 ? String(frac).padStart(decimals, "0") : "";
  return { whole: whole.toLocaleString("en-US"), dec };
}

/* 复用 shared 的整数分实现与 ghost 串构造（统一出口，避免上层各自 import） */
export { moneyParts, ghostFor };
