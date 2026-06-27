/**
 * useTheme — apply the user's theme to `<html data-theme>` so pixel.css's
 * token sets take effect app-wide (M6). `system` follows the OS
 * `prefers-color-scheme` and reacts to live OS changes.
 */
import { useEffect } from "react";
import type { Theme } from "@/shared/types";

export function useTheme(theme: Theme | undefined): void {
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    const apply = (t: Exclude<Theme, "system">) => root.setAttribute("data-theme", t);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const handler = () => apply(mq.matches ? "light" : "dark");
      handler();
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }

    apply(theme);
    return undefined;
  }, [theme]);
}
