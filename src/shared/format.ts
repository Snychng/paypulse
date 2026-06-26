/**
 * Money formatting helpers shared by every window.
 *
 * - `moneyParts` splits an integer-cents amount into grouped whole + fractional
 *   strings for the 7-segment (DSEG7) readout, with carry-safe rounding so the
 *   displayed fraction never shows e.g. "1.000" as "0.1000".
 * - `currencyFormatter` caches one `Intl.NumberFormat` per language so we never
 *   rebuild a formatter on the per-second beat (D2: symbol follows language).
 */
import type { Language } from "./types";

/** Resolve 'system' to a concrete UI language. */
export function resolveLanguage(language: Language): "zh" | "en" {
  if (language === "zh" || language === "en") return language;
  const nav =
    typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  return nav.startsWith("zh") ? "zh" : "en";
}

export interface MoneyParts {
  whole: string; // grouped integer, e.g. "1,204"
  dec: string; // fractional digits of length `decimals` (no dot), "" when decimals=0
}

/** Split integer cents into display parts at `decimals` (0–4) places. */
export function moneyParts(cents: number, decimals = 3): MoneyParts {
  const amount = cents / 100;
  let whole = Math.floor(amount);
  const f = Math.pow(10, decimals);
  let frac = Math.round((amount - whole) * f);
  if (frac >= f) {
    whole += 1;
    frac -= f;
  }
  const dec = decimals > 0 ? String(frac).padStart(decimals, "0") : "";
  return { whole: whole.toLocaleString("en-US"), dec };
}

/** Unlit "8.8.8" ghost string matching a parts' width (classic LCD backdrop). */
export function ghostFor(parts: MoneyParts, decimals: number): string {
  const whole8 = parts.whole.replace(/\d/g, "8");
  return decimals > 0 ? `${whole8}.${"8".repeat(decimals)}` : whole8;
}

export const currencySymbol = (language: Language): "¥" | "$" =>
  resolveLanguage(language) === "zh" ? "¥" : "$";

const fmtCache = new Map<"zh" | "en", Intl.NumberFormat>();

/** Cached currency formatter (symbol follows language; no FX conversion — D2). */
export function currencyFormatter(language: Language): Intl.NumberFormat {
  const key = resolveLanguage(language);
  let f = fmtCache.get(key);
  if (!f) {
    f =
      key === "zh"
        ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          });
    fmtCache.set(key, f);
  }
  return f;
}

/** Full localized currency string from integer cents. */
export function formatMoney(cents: number, language: Language): string {
  return currencyFormatter(language).format(cents / 100);
}
