/* ============================================================
   src/pixel — PayPulse 像素设计系统（React + TS）barrel
   统一导出：全局样式、精灵/图标组件、CoinFlow 引擎、长按确认 hook、金额格式化。

   使用前请在窗口入口导入一次全局样式：
     import "@/pixel/pixel.css";
   ============================================================ */

/* ---------- sprites & icons ---------- */
export { Sprite, Icon, ICON_NAMES, spriteSVG } from "./sprites";
export type {
  SpriteName,
  SpriteProps,
  IconName,
  IconProps,
} from "./sprites";

/* ---------- CoinFlow 引擎 ---------- */
export { createCoinFlow, useCoinFlow } from "./CoinFlow";
export type {
  CoinFlowTarget,
  CoinFlowOptions,
  CoinFlowHandle,
  UseCoinFlowOptions,
} from "./CoinFlow";

/* ---------- 长按确认 hook ---------- */
export { useHoldToConfirm } from "./useHoldToConfirm";
export type { HoldToConfirmOptions } from "./useHoldToConfirm";

/* ---------- 金额格式化 ---------- */
export { splitMoney, moneyParts, ghostFor } from "./money";
export type { MoneyParts } from "./money";
